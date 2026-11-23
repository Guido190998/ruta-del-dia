-- Prueba de aislamiento multiempresa del esquema `ruta` (hallazgo F-01).
-- ============================================================================================
-- NO CORRER CONTRA PRODUCCIÓN. Correr a mano en una rama de Supabase (branch) o en una base
-- de staging que ya tenga `core` + sql/00_esquema_ruta.sql + sql/01_multiempresa.sql.
--
-- Todo ocurre dentro de una transacción que termina en ROLLBACK: no deja datos. Aun así, los
-- INSERT en auth.users / core.* escriben de verdad hasta el ROLLBACK; por eso solo en staging.
--
-- Cómo correrla: pegar el archivo entero en el SQL Editor (conectado como `postgres`) o
--   psql "$STAGING_URL" -v ON_ERROR_STOP=1 -f sql/tests/rls_aislamiento.sql
-- Si TODO está bien, cada bloque DO termina sin error y se ven mensajes NOTICE "OK ...".
-- Si algo falla, el bloque lanza EXCEPTION con el texto "FALLA ..." y la transacción aborta.
--
-- Datos de prueba:
--   Negocio A y negocio B.
--   Roles:  transportista (rol 'transporte'), administrador (rol 'admin'), superadmin (core.superadmins).
--   Usuarios: a_tr, a_ad (de A) · b_tr, b_ad (de B) · sup (superadmin, sin membresía en ruta) · nomem (sin membresía).
--
-- Supuestos sobre `core` (no se pudo ver su DDL completo desde este repo; ajustar si difiere):
--   * core.negocios acepta insert (id, nombre, slug, dueno_id) con activa = true por defecto.
--   * core.miembros(usuario_id, negocio_id, app, rol, nombre).
--   * core.es_superadmin() reconoce al usuario por su correo en core.superadmins (insert (email)).
--   * auth.users acepta insert mínimo (id, email); si exige más columnas en tu proyecto, añádelas.
-- Si el seed se hace con FORCE RLS ya activo, correrlo con un rol con BYPASSRLS.
-- ============================================================================================

begin;

-- ───────────────────────── Datos de prueba (como postgres) ─────────────────────────

insert into auth.users (id, email) values
  ('a0000000-0000-0000-0000-0000000000a1', 'a_tr@prueba.local'),
  ('a0000000-0000-0000-0000-0000000000a2', 'a_ad@prueba.local'),
  ('b0000000-0000-0000-0000-0000000000b1', 'b_tr@prueba.local'),
  ('b0000000-0000-0000-0000-0000000000b2', 'b_ad@prueba.local'),
  ('c0000000-0000-0000-0000-0000000000c1', 'sup@prueba.local'),
  ('d0000000-0000-0000-0000-0000000000d1', 'nomem@prueba.local');

insert into core.negocios (id, nombre, slug, dueno_id) values
  ('aaaaaaaa-0000-0000-0000-000000000001', 'Empresa A (prueba)', 'prueba-a', 'a0000000-0000-0000-0000-0000000000a2'),
  ('bbbbbbbb-0000-0000-0000-000000000001', 'Empresa B (prueba)', 'prueba-b', 'b0000000-0000-0000-0000-0000000000b2');

insert into ruta.marcas (negocio_id) values
  ('aaaaaaaa-0000-0000-0000-000000000001'), ('bbbbbbbb-0000-0000-0000-000000000001');

insert into core.miembros (usuario_id, negocio_id, app, rol, nombre) values
  ('a0000000-0000-0000-0000-0000000000a1', 'aaaaaaaa-0000-0000-0000-000000000001', 'ruta', 'transporte', 'A transportista'),
  ('a0000000-0000-0000-0000-0000000000a2', 'aaaaaaaa-0000-0000-0000-000000000001', 'ruta', 'admin',      'A administrador'),
  ('b0000000-0000-0000-0000-0000000000b1', 'bbbbbbbb-0000-0000-0000-000000000001', 'ruta', 'transporte', 'B transportista'),
  ('b0000000-0000-0000-0000-0000000000b2', 'bbbbbbbb-0000-0000-0000-000000000001', 'ruta', 'admin',      'B administrador');

insert into core.superadmins (email) values ('sup@prueba.local') on conflict do nothing;

-- Clientes: A tiene 2 (uno por cada miembro) y B tiene 2.
insert into ruta.clientes (id, user_id, negocio_id, nombre) values
  ('a1000000-0000-0000-0000-000000000001', 'a0000000-0000-0000-0000-0000000000a1', 'aaaaaaaa-0000-0000-0000-000000000001', 'Cliente A del transportista'),
  ('a1000000-0000-0000-0000-000000000002', 'a0000000-0000-0000-0000-0000000000a2', 'aaaaaaaa-0000-0000-0000-000000000001', 'Cliente A del administrador'),
  ('b1000000-0000-0000-0000-000000000001', 'b0000000-0000-0000-0000-0000000000b1', 'bbbbbbbb-0000-0000-0000-000000000001', 'Cliente B del transportista'),
  ('b1000000-0000-0000-0000-000000000002', 'b0000000-0000-0000-0000-0000000000b2', 'bbbbbbbb-0000-0000-0000-000000000001', 'Cliente B del administrador');

-- Rutas: una por usuario/negocio, de hoy.
insert into ruta.rutas (user_id, negocio_id, fecha) values
  ('a0000000-0000-0000-0000-0000000000a1', 'aaaaaaaa-0000-0000-0000-000000000001', current_date),
  ('a0000000-0000-0000-0000-0000000000a2', 'aaaaaaaa-0000-0000-0000-000000000001', current_date),
  ('b0000000-0000-0000-0000-0000000000b1', 'bbbbbbbb-0000-0000-0000-000000000001', current_date),
  ('b0000000-0000-0000-0000-0000000000b2', 'bbbbbbbb-0000-0000-0000-000000000001', current_date);

-- ───────────────────────── (a) RLS activado y forzado en las 4 tablas ─────────────────────────
-- relrowsecurity debe ser true SIEMPRE.
-- relforcerowsecurity debe ser true una vez aplicada la mejora F-01 (hoy en la base viva es false:
-- esta comprobación FALLARÁ hasta que se aplique, con revisión, el bloque comentado de 00_esquema_ruta.sql §5).

do $$
declare r record; v_fallas text := '';
begin
  for r in select c.relname, c.relrowsecurity, c.relforcerowsecurity
             from pg_class c where c.relnamespace = 'ruta'::regnamespace and c.relkind = 'r'
              and c.relname in ('clientes','rutas','marcas','aprobaciones') order by 1
  loop
    if not r.relrowsecurity      then v_fallas := v_fallas || format(' [%s: relrowsecurity=false]', r.relname); end if;
    if not r.relforcerowsecurity then v_fallas := v_fallas || format(' [%s: relforcerowsecurity=false]', r.relname); end if;
  end loop;
  if (select count(*) from pg_class where relnamespace = 'ruta'::regnamespace and relkind = 'r'
         and relname in ('clientes','rutas','marcas','aprobaciones')) <> 4 then
    v_fallas := v_fallas || ' [faltan tablas]';
  end if;
  if v_fallas <> '' then raise exception 'FALLA (a) RLS:%', v_fallas; end if;
  raise notice 'OK (a) relrowsecurity y relforcerowsecurity = true en las 4 tablas';
end $$;

-- ───────────────────────── (b) Aislamiento entre negocios ─────────────────────────
-- Cada bloque se hace pasar por un usuario: rol `authenticated` + claim sub (lo que lee auth.uid()).

-- b.1 Transportista de A: ve solo SU cliente y SU ruta de A; ninguna fila de B.
do $$
declare n_cli int; n_cli_b int; n_rut int; n_rut_b int;
begin
  perform set_config('request.jwt.claims', '{"sub":"a0000000-0000-0000-0000-0000000000a1","role":"authenticated"}', true);
  perform set_config('request.jwt.claim.sub', 'a0000000-0000-0000-0000-0000000000a1', true);
  set local role authenticated;
  select count(*) into n_cli   from ruta.clientes;
  select count(*) into n_cli_b from ruta.clientes where negocio_id = 'bbbbbbbb-0000-0000-0000-000000000001';
  select count(*) into n_rut   from ruta.rutas;
  select count(*) into n_rut_b from ruta.rutas    where negocio_id = 'bbbbbbbb-0000-0000-0000-000000000001';
  reset role;
  if n_cli_b <> 0 or n_rut_b <> 0 then raise exception 'FALLA (b.1) transportista A ve filas de B (clientes=%, rutas=%)', n_cli_b, n_rut_b; end if;
  if n_cli <> 1 or n_rut <> 1 then raise exception 'FALLA (b.1) transportista A debía ver solo lo suyo (clientes=% esperado 1, rutas=% esperado 1)', n_cli, n_rut; end if;
  raise notice 'OK (b.1) transportista A: ve solo lo propio y 0 filas de B';
end $$;

-- b.2 Administrador de A: ve todo A (2 clientes, 2 rutas) y nada de B.
do $$
declare n_cli int; n_cli_b int; n_rut int; n_rut_b int;
begin
  perform set_config('request.jwt.claims', '{"sub":"a0000000-0000-0000-0000-0000000000a2","role":"authenticated"}', true);
  perform set_config('request.jwt.claim.sub', 'a0000000-0000-0000-0000-0000000000a2', true);
  set local role authenticated;
  select count(*) into n_cli   from ruta.clientes;
  select count(*) into n_cli_b from ruta.clientes where negocio_id = 'bbbbbbbb-0000-0000-0000-000000000001';
  select count(*) into n_rut   from ruta.rutas;
  select count(*) into n_rut_b from ruta.rutas    where negocio_id = 'bbbbbbbb-0000-0000-0000-000000000001';
  reset role;
  if n_cli_b <> 0 or n_rut_b <> 0 then raise exception 'FALLA (b.2) administrador A ve filas de B (clientes=%, rutas=%)', n_cli_b, n_rut_b; end if;
  if n_cli <> 2 or n_rut <> 2 then raise exception 'FALLA (b.2) administrador A debía ver todo A (clientes=% esperado 2, rutas=% esperado 2)', n_cli, n_rut; end if;
  raise notice 'OK (b.2) administrador A: ve todo A y 0 filas de B';
end $$;

-- b.3 Simétrico: transportista y administrador de B no ven nada de A.
do $$
declare n_a int;
begin
  perform set_config('request.jwt.claims', '{"sub":"b0000000-0000-0000-0000-0000000000b1","role":"authenticated"}', true);
  perform set_config('request.jwt.claim.sub', 'b0000000-0000-0000-0000-0000000000b1', true);
  set local role authenticated;
  select (select count(*) from ruta.clientes where negocio_id = 'aaaaaaaa-0000-0000-0000-000000000001')
       + (select count(*) from ruta.rutas    where negocio_id = 'aaaaaaaa-0000-0000-0000-000000000001') into n_a;
  reset role;
  if n_a <> 0 then raise exception 'FALLA (b.3) transportista B ve % filas de A', n_a; end if;

  perform set_config('request.jwt.claims', '{"sub":"b0000000-0000-0000-0000-0000000000b2","role":"authenticated"}', true);
  perform set_config('request.jwt.claim.sub', 'b0000000-0000-0000-0000-0000000000b2', true);
  set local role authenticated;
  select (select count(*) from ruta.clientes where negocio_id = 'aaaaaaaa-0000-0000-0000-000000000001')
       + (select count(*) from ruta.rutas    where negocio_id = 'aaaaaaaa-0000-0000-0000-000000000001') into n_a;
  reset role;
  if n_a <> 0 then raise exception 'FALLA (b.3) administrador B ve % filas de A', n_a; end if;
  raise notice 'OK (b.3) usuarios de B: 0 filas de A';
end $$;

-- b.4 Escritura cruzada: el administrador de A NO puede crear un cliente en B ni mover un cliente de A a B;
--     el transportista de A NO puede crear un cliente a nombre del administrador.
do $$
declare v_bloqueado boolean;
begin
  perform set_config('request.jwt.claims', '{"sub":"a0000000-0000-0000-0000-0000000000a2","role":"authenticated"}', true);
  perform set_config('request.jwt.claim.sub', 'a0000000-0000-0000-0000-0000000000a2', true);
  set local role authenticated;

  v_bloqueado := false;
  begin
    insert into ruta.clientes (user_id, negocio_id, nombre)
    values ('a0000000-0000-0000-0000-0000000000a2', 'bbbbbbbb-0000-0000-0000-000000000001', 'Intruso en B');
  exception when insufficient_privilege then v_bloqueado := true; end;
  if not v_bloqueado then reset role; raise exception 'FALLA (b.4) administrador A pudo insertar un cliente en B'; end if;

  v_bloqueado := false;
  begin
    update ruta.clientes set negocio_id = 'bbbbbbbb-0000-0000-0000-000000000001'
     where id = 'a1000000-0000-0000-0000-000000000001';
    -- Si no hay error, RLS (with check) debió dejarlo en 0 filas o lanzar; verificamos que no cambió:
    if exists (select 1 from ruta.clientes where id = 'a1000000-0000-0000-0000-000000000001'
                                            and negocio_id = 'bbbbbbbb-0000-0000-0000-000000000001') then
      reset role; raise exception 'FALLA (b.4) administrador A movió un cliente de A a B';
    end if;
    v_bloqueado := true;
  exception when insufficient_privilege then v_bloqueado := true; end;

  reset role;
  raise notice 'OK (b.4) escrituras cruzadas entre A y B bloqueadas';
end $$;

-- b.5 Superadmin sin membresía en ruta: por RLS directo no ve filas de clientes/rutas (lo suyo es el panel,
--     que pasa por funciones security definer y valida core.es_superadmin()).
--     Si decides que el superadmin SÍ debe ver filas directas, esta comprobación documenta que hoy NO es así.
do $$
declare n_cli int; n_rut int; v_panel jsonb;
begin
  perform set_config('request.jwt.claims', '{"sub":"c0000000-0000-0000-0000-0000000000c1","role":"authenticated","email":"sup@prueba.local"}', true);
  perform set_config('request.jwt.claim.sub', 'c0000000-0000-0000-0000-0000000000c1', true);
  set local role authenticated;
  select count(*) into n_cli from ruta.clientes;
  select count(*) into n_rut from ruta.rutas;
  v_panel := ruta.panel_empresas();
  reset role;
  if n_cli <> 0 or n_rut <> 0 then raise exception 'FALLA (b.5) superadmin ve filas directas (clientes=%, rutas=%)', n_cli, n_rut; end if;
  if jsonb_array_length(v_panel) < 2 then raise exception 'FALLA (b.5) panel_empresas() del superadmin no lista las empresas de prueba (%)', v_panel; end if;
  raise notice 'OK (b.5) superadmin: 0 filas directas y panel_empresas() operativo';
end $$;

-- b.6 No-superadmin no puede usar el panel ni cambiar la marca/plan de otra empresa.
do $$
declare v_bloqueado boolean := false;
begin
  perform set_config('request.jwt.claims', '{"sub":"a0000000-0000-0000-0000-0000000000a2","role":"authenticated"}', true);
  perform set_config('request.jwt.claim.sub', 'a0000000-0000-0000-0000-0000000000a2', true);
  set local role authenticated;
  begin perform ruta.panel_empresas(); exception when others then v_bloqueado := true; end;
  if not v_bloqueado then reset role; raise exception 'FALLA (b.6) administrador de empresa pudo llamar panel_empresas()'; end if;
  v_bloqueado := false;
  begin perform ruta.guardar_marca('bbbbbbbb-0000-0000-0000-000000000001', null, '#000000', '#FFFFFF', false);
  exception when others then v_bloqueado := true; end;
  if not v_bloqueado then reset role; raise exception 'FALLA (b.6) administrador de A pudo guardar la marca de B'; end if;
  v_bloqueado := false;
  begin perform ruta.set_plan('bbbbbbbb-0000-0000-0000-000000000001', 'flat'); exception when others then v_bloqueado := true; end;
  reset role;
  if not v_bloqueado then raise exception 'FALLA (b.6) administrador de A pudo cambiar el plan de B'; end if;
  raise notice 'OK (b.6) funciones de superadmin rechazan a un administrador de empresa';
end $$;

-- b.7 marcas y aprobaciones no son accesibles por tabla para authenticated/anon (solo vía funciones).
do $$
declare v_bloqueado boolean;
begin
  perform set_config('request.jwt.claims', '{"sub":"a0000000-0000-0000-0000-0000000000a2","role":"authenticated"}', true);
  perform set_config('request.jwt.claim.sub', 'a0000000-0000-0000-0000-0000000000a2', true);
  set local role authenticated;
  v_bloqueado := false;
  begin perform 1 from ruta.marcas limit 1;        exception when insufficient_privilege then v_bloqueado := true; end;
  if not v_bloqueado then reset role; raise exception 'FALLA (b.7) authenticated lee ruta.marcas directamente'; end if;
  v_bloqueado := false;
  begin perform 1 from ruta.aprobaciones limit 1;  exception when insufficient_privilege then v_bloqueado := true; end;
  reset role;
  if not v_bloqueado then raise exception 'FALLA (b.7) authenticated lee ruta.aprobaciones directamente'; end if;

  set local role anon;
  v_bloqueado := false;
  begin perform 1 from ruta.clientes limit 1;      exception when insufficient_privilege then v_bloqueado := true; end;
  reset role;
  if not v_bloqueado then raise exception 'FALLA (b.7) anon lee ruta.clientes'; end if;
  raise notice 'OK (b.7) marcas/aprobaciones cerradas por tabla; anon sin acceso a clientes';
end $$;

-- ───────────────────────── (c) Usuario sin membresía en ruta: 0 filas ─────────────────────────

do $$
declare n_cli int; n_rut int;
begin
  perform set_config('request.jwt.claims', '{"sub":"d0000000-0000-0000-0000-0000000000d1","role":"authenticated"}', true);
  perform set_config('request.jwt.claim.sub', 'd0000000-0000-0000-0000-0000000000d1', true);
  set local role authenticated;
  select count(*) into n_cli from ruta.clientes;
  select count(*) into n_rut from ruta.rutas;
  reset role;
  if n_cli <> 0 or n_rut <> 0 then raise exception 'FALLA (c) usuario sin membresía ve filas (clientes=%, rutas=%)', n_cli, n_rut; end if;
  raise notice 'OK (c) usuario sin membresía: 0 filas en clientes y rutas';
end $$;

-- c.2 Un usuario sin membresía tampoco puede insertar.
do $$
declare v_bloqueado boolean := false;
begin
  perform set_config('request.jwt.claims', '{"sub":"d0000000-0000-0000-0000-0000000000d1","role":"authenticated"}', true);
  perform set_config('request.jwt.claim.sub', 'd0000000-0000-0000-0000-0000000000d1', true);
  set local role authenticated;
  begin
    insert into ruta.clientes (user_id, negocio_id, nombre)
    values ('d0000000-0000-0000-0000-0000000000d1', 'aaaaaaaa-0000-0000-0000-000000000001', 'Intruso sin membresía');
  exception when insufficient_privilege then v_bloqueado := true; end;
  reset role;
  if not v_bloqueado then raise exception 'FALLA (c.2) usuario sin membresía pudo insertar un cliente'; end if;
  raise notice 'OK (c.2) usuario sin membresía no puede insertar';
end $$;

-- Sin dejar rastro.
rollback;
