-- 01 · Ruta del día multiempresa (proyecto "Microapps", esquema "ruta")
-- Cada empresa tiene su enlace (/<enlace>), su marca, un administrador y su equipo de transporte.
-- Cada transportista maneja sus propios clientes; el administrador ve y edita los de todos.
-- Horario de atención por día y duración de visita por cliente; las visitas fuera de horario
-- se piden al administrador (ir igual o saltar).
-- Usa el núcleo compartido: core.negocios, core.miembros (app 'ruta') y core.superadmins.
-- Lo que ya existe (clientes y rutas de Guido) pasa a una primera empresa de prueba: no se borra nada.
-- Se puede correr más de una vez. NO toca Dandu, el CRM, Pedidos mayoristas ni Fidelización.

-- ───────────────────────── 1. Tablas ─────────────────────────

create table if not exists ruta.marcas (
  negocio_id uuid primary key references core.negocios(id) on delete cascade,
  logo       text check (logo is null or length(logo) <= 300000),
  tinta      text not null default '#10231C' check (tinta ~ '^#[0-9A-Fa-f]{6}$'),
  acento     text not null default '#D7F25A' check (acento ~ '^#[0-9A-Fa-f]{6}$'),
  creado_en  timestamptz not null default now()
);
alter table ruta.marcas enable row level security;

alter table ruta.clientes add column if not exists negocio_id uuid references core.negocios(id) on delete cascade;
alter table ruta.clientes add column if not exists horario jsonb not null default '{}'::jsonb;   -- {"1":{"desde":"08:00","hasta":"12:30"}, ...} (0 = domingo)
alter table ruta.clientes add column if not exists duracion_min int not null default 15 check (duracion_min between 1 and 480);
alter table ruta.rutas    add column if not exists negocio_id uuid references core.negocios(id) on delete cascade;
alter table ruta.rutas    add column if not exists salida text check (salida is null or salida ~ '^\d{2}:\d{2}$');
alter table ruta.rutas    add column if not exists fuera jsonb;                               -- clientes que no entran en su horario
alter table ruta.rutas    add column if not exists saltados uuid[] not null default '{}';

create table if not exists ruta.aprobaciones (
  id             uuid primary key default gen_random_uuid(),
  negocio_id     uuid not null references core.negocios(id) on delete cascade,
  user_id        uuid not null references auth.users(id) on delete cascade,     -- transportista que pide
  cliente_id     uuid not null references ruta.clientes(id) on delete cascade,
  fecha          date not null,
  tipo           text not null check (tipo in ('ir', 'saltar')),
  llegada        text,
  hasta          text,
  estado         text not null default 'pendiente' check (estado in ('pendiente', 'aprobado', 'rechazado')),
  creado_en      timestamptz not null default now(),
  respondido_por uuid references auth.users(id) on delete set null,
  respondido_en  timestamptz
);
create unique index if not exists aprobaciones_una_por_dia on ruta.aprobaciones (cliente_id, fecha, user_id);
create index if not exists aprobaciones_negocio on ruta.aprobaciones (negocio_id, fecha, estado);
alter table ruta.aprobaciones enable row level security;

-- ───────────────────────── 2. Lo existente pasa a una empresa de prueba ─────────────────────────

do $$
declare v_neg uuid; v_user uuid;
begin
  if not exists (select 1 from ruta.clientes where negocio_id is null) and not exists (select 1 from ruta.rutas where negocio_id is null) then
    return;
  end if;
  select user_id into v_user from ruta.clientes where negocio_id is null group by user_id order by count(*) desc limit 1;
  if v_user is null then select user_id into v_user from ruta.rutas where negocio_id is null limit 1; end if;
  select id into v_neg from core.negocios where slug = 'ruta-de-prueba';
  if v_neg is null then
    insert into core.negocios (nombre, slug, dueno_id) values ('Ruta de prueba', 'ruta-de-prueba', v_user) returning id into v_neg;
  end if;
  insert into ruta.marcas (negocio_id) values (v_neg) on conflict do nothing;
  -- Quien ya usaba la app queda como administrador de la empresa de prueba (y conserva su ruta).
  insert into core.miembros (usuario_id, negocio_id, app, rol, nombre)
  select distinct x.user_id, v_neg, 'ruta', case when x.user_id = v_user then 'admin' else 'transporte' end,
         coalesce(nullif(u.raw_user_meta_data ->> 'nombre', ''), split_part(u.email, '@', 1))
    from (select user_id from ruta.clientes where negocio_id is null union select user_id from ruta.rutas where negocio_id is null) x
    join auth.users u on u.id = x.user_id
  on conflict do nothing;
  update ruta.clientes set negocio_id = v_neg where negocio_id is null;
  update ruta.rutas    set negocio_id = v_neg where negocio_id is null;
end $$;

alter table ruta.clientes alter column negocio_id set not null;
alter table ruta.rutas    alter column negocio_id set not null;

-- Una persona puede trabajar en más de una empresa: la ruta es por empresa, persona y día.
do $$ begin
  if exists (select 1 from pg_constraint where conname = 'rutas_pkey' and conrelid = 'ruta.rutas'::regclass
             and pg_get_constraintdef(oid) = 'PRIMARY KEY (user_id, fecha)') then
    alter table ruta.rutas drop constraint rutas_pkey;
    alter table ruta.rutas add constraint rutas_pkey primary key (negocio_id, user_id, fecha);
  end if;
end $$;
create index if not exists clientes_negocio on ruta.clientes (negocio_id, user_id);
create index if not exists rutas_negocio_fecha on ruta.rutas (negocio_id, fecha);

-- ───────────────────────── 3. Quién es quién ─────────────────────────

create or replace function ruta.es_miembro(p_negocio uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from core.miembros m join core.negocios n on n.id = m.negocio_id
                  where m.usuario_id = auth.uid() and m.negocio_id = p_negocio and m.app = 'ruta' and n.activa)
$$;

create or replace function ruta.es_admin(p_negocio uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from core.miembros m join core.negocios n on n.id = m.negocio_id
                  where m.usuario_id = auth.uid() and m.negocio_id = p_negocio and m.app = 'ruta' and m.rol = 'admin' and n.activa)
$$;

create or replace function ruta.es_del_equipo(p_negocio uuid, p_user uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from core.miembros m where m.usuario_id = p_user and m.negocio_id = p_negocio and m.app = 'ruta')
$$;

-- Datos públicos para la pantalla de ingreso de cada empresa.
create or replace function ruta.negocio_por_slug(p_slug text) returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object('nombre', n.nombre, 'slug', n.slug, 'logo', mk.logo, 'tinta', mk.tinta, 'acento', mk.acento)
    from core.negocios n join ruta.marcas mk on mk.negocio_id = n.id
   where n.slug = lower(btrim(coalesce(p_slug, ''))) and n.activa
$$;

-- Mi sesión en una empresa (por su enlace). Sin enlace: mis empresas, para llevarme a la mía.
create or replace function ruta.mi_sesion(p_slug text) returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'admin', core.es_superadmin(),
    'empresa', (select jsonb_build_object('negocio_id', n.id, 'nombre', n.nombre, 'slug', n.slug, 'rol', m.rol,
                         'yo', coalesce(nullif(btrim(m.nombre), ''), split_part(u.email, '@', 1)),
                         'logo', mk.logo, 'tinta', mk.tinta, 'acento', mk.acento)
                  from core.miembros m join core.negocios n on n.id = m.negocio_id
                  join ruta.marcas mk on mk.negocio_id = n.id join auth.users u on u.id = m.usuario_id
                 where m.usuario_id = auth.uid() and m.app = 'ruta' and n.activa and n.slug = lower(btrim(coalesce(p_slug, '')))),
    'empresas', coalesce((select jsonb_agg(jsonb_build_object('slug', n.slug, 'nombre', n.nombre, 'rol', m.rol) order by n.nombre)
                  from core.miembros m join core.negocios n on n.id = m.negocio_id
                 where m.usuario_id = auth.uid() and m.app = 'ruta' and n.activa), '[]'::jsonb))
$$;

-- ───────────────────────── 4. Reglas de acceso a las tablas ─────────────────────────
-- Transportista: solo lo suyo. Administrador: todo lo de su empresa.

drop policy if exists "clientes propios" on ruta.clientes;
drop policy if exists "rutas propias" on ruta.rutas;
drop policy if exists clientes_ver on ruta.clientes;
drop policy if exists clientes_crear on ruta.clientes;
drop policy if exists clientes_cambiar on ruta.clientes;
drop policy if exists clientes_borrar on ruta.clientes;
drop policy if exists rutas_ver on ruta.rutas;
drop policy if exists rutas_escribir on ruta.rutas;
drop policy if exists rutas_cambiar on ruta.rutas;

create policy clientes_ver on ruta.clientes for select to authenticated
  using ((user_id = auth.uid() and ruta.es_miembro(negocio_id)) or ruta.es_admin(negocio_id));
create policy clientes_crear on ruta.clientes for insert to authenticated
  with check ((user_id = auth.uid() and ruta.es_miembro(negocio_id))
              or (ruta.es_admin(negocio_id) and ruta.es_del_equipo(negocio_id, user_id)));
create policy clientes_cambiar on ruta.clientes for update to authenticated
  using ((user_id = auth.uid() and ruta.es_miembro(negocio_id)) or ruta.es_admin(negocio_id))
  with check ((user_id = auth.uid() and ruta.es_miembro(negocio_id))
              or (ruta.es_admin(negocio_id) and ruta.es_del_equipo(negocio_id, user_id)));
create policy clientes_borrar on ruta.clientes for delete to authenticated
  using ((user_id = auth.uid() and ruta.es_miembro(negocio_id)) or ruta.es_admin(negocio_id));

create policy rutas_ver on ruta.rutas for select to authenticated
  using ((user_id = auth.uid() and ruta.es_miembro(negocio_id)) or ruta.es_admin(negocio_id));
create policy rutas_escribir on ruta.rutas for insert to authenticated
  with check (user_id = auth.uid() and ruta.es_miembro(negocio_id));
create policy rutas_cambiar on ruta.rutas for update to authenticated
  using ((user_id = auth.uid() and ruta.es_miembro(negocio_id)) or ruta.es_admin(negocio_id))
  with check ((user_id = auth.uid() and ruta.es_miembro(negocio_id)) or ruta.es_admin(negocio_id));

grant select, insert, update, delete on ruta.clientes, ruta.rutas to authenticated;
revoke all on ruta.marcas, ruta.aprobaciones from anon, authenticated;

-- ───────────────────────── 5. Equipo y aprobaciones ─────────────────────────

create or replace function ruta._usuario(p_email text) returns text
language sql immutable set search_path = '' as $$
  select case when p_email like '%.usuarios.ruta-del-dia.app' then split_part(p_email, '@', 1) else p_email end
$$;

-- Equipo de la empresa (lo ve el administrador). El transportista solo se ve a sí mismo.
create or replace function ruta.mi_equipo(p_negocio uuid) returns jsonb
language sql stable security definer set search_path = '' as $$
  select coalesce(jsonb_agg(jsonb_build_object(
           'usuario_id', m.usuario_id, 'nombre', coalesce(nullif(btrim(m.nombre), ''), split_part(u.email, '@', 1)), 'rol', m.rol,
           'usuario', ruta._usuario(u.email), 'yo', m.usuario_id = auth.uid(),
           'pendiente', coalesce((u.raw_app_meta_data ->> 'debe_cambiar_clave')::boolean, false),
           'clientes', (select count(*) from ruta.clientes c where c.negocio_id = m.negocio_id and c.user_id = m.usuario_id))
         order by case m.rol when 'admin' then 0 else 1 end, m.nombre), '[]'::jsonb)
    from core.miembros m join auth.users u on u.id = m.usuario_id
   where m.negocio_id = p_negocio and m.app = 'ruta'
     and (ruta.es_admin(p_negocio) or m.usuario_id = auth.uid())
$$;

-- El transportista pide ir igual o saltar a un cliente fuera de horario.
create or replace function ruta.pedir_aprobacion(p_negocio uuid, p_cliente uuid, p_fecha date, p_tipo text, p_llegada text, p_hasta text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare a ruta.aprobaciones;
begin
  if not ruta.es_miembro(p_negocio) then raise exception 'No tienes acceso a esta empresa'; end if;
  if p_tipo not in ('ir', 'saltar') then raise exception 'Pedido no válido'; end if;
  if not exists (select 1 from ruta.clientes where id = p_cliente and negocio_id = p_negocio and user_id = auth.uid()) then
    raise exception 'Ese cliente no es tuyo';
  end if;
  insert into ruta.aprobaciones (negocio_id, user_id, cliente_id, fecha, tipo, llegada, hasta)
  values (p_negocio, auth.uid(), p_cliente, p_fecha, p_tipo, left(p_llegada, 5), left(p_hasta, 5))
  on conflict (cliente_id, fecha, user_id) do update set tipo = excluded.tipo, llegada = excluded.llegada, hasta = excluded.hasta,
     estado = 'pendiente', creado_en = now(), respondido_por = null, respondido_en = null
  returning * into a;
  return to_jsonb(a);
end $$;

-- Pedidos de un día: el transportista ve los suyos; el administrador, los de todos.
create or replace function ruta.aprobaciones_del_dia(p_negocio uuid, p_fecha date) returns jsonb
language sql stable security definer set search_path = '' as $$
  select coalesce(jsonb_agg(jsonb_build_object(
           'id', a.id, 'cliente_id', a.cliente_id, 'cliente', c.nombre, 'user_id', a.user_id,
           'transportista', coalesce(nullif(btrim(m.nombre), ''), split_part(u.email, '@', 1)),
           'tipo', a.tipo, 'llegada', a.llegada, 'hasta', a.hasta, 'estado', a.estado, 'creado_en', a.creado_en)
         order by a.creado_en), '[]'::jsonb)
    from ruta.aprobaciones a
    join ruta.clientes c on c.id = a.cliente_id
    join auth.users u on u.id = a.user_id
    left join core.miembros m on m.usuario_id = a.user_id and m.negocio_id = a.negocio_id and m.app = 'ruta'
   where a.negocio_id = p_negocio and a.fecha = p_fecha
     and (ruta.es_admin(p_negocio) or (a.user_id = auth.uid() and ruta.es_miembro(p_negocio)))
$$;

create or replace function ruta.responder_aprobacion(p_id uuid, p_aprobar boolean) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare a ruta.aprobaciones;
begin
  select * into a from ruta.aprobaciones where id = p_id;
  if a.id is null or not ruta.es_admin(a.negocio_id) then raise exception 'Solo el administrador responde los pedidos'; end if;
  update ruta.aprobaciones set estado = case when p_aprobar then 'aprobado' else 'rechazado' end,
         respondido_por = auth.uid(), respondido_en = now()
   where id = p_id returning * into a;
  return to_jsonb(a);
end $$;

-- ───────────────────────── 6. Panel general (Guido y Graciafe) ─────────────────────────
-- Solo cifras y equipo: las direcciones de los clientes las ve únicamente cada empresa.

create or replace function ruta._km(r ruta.rutas) returns numeric
language sql immutable set search_path = '' as $$
  select coalesce(sum((r.tramos -> v::text ->> 'km')::numeric), 0) from unnest(r.visitados) v
   where jsonb_typeof(r.tramos -> v::text -> 'km') = 'number'
$$;

create or replace function ruta.panel_empresas() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare v_mes date := date_trunc('month', now() at time zone 'America/Lima')::date;
begin
  if not core.es_superadmin() then raise exception 'Solo para administradores generales'; end if;
  return coalesce((select jsonb_agg(x order by x->>'creado_en') from (
    select jsonb_build_object(
      'id', n.id, 'nombre', n.nombre, 'slug', n.slug, 'activa', n.activa, 'creado_en', n.creado_en,
      'logo', mk.logo, 'tinta', mk.tinta, 'acento', mk.acento,
      'dueno_correo', du.email, 'dueno_pendiente', coalesce((du.raw_app_meta_data ->> 'debe_cambiar_clave')::boolean, false),
      'transportistas', (select count(*) from core.miembros m where m.negocio_id = n.id and m.app = 'ruta' and m.rol = 'transporte'),
      'clientes', (select count(*) from ruta.clientes c where c.negocio_id = n.id),
      'visitas_mes', (select coalesce(sum(cardinality(r.visitados)), 0) from ruta.rutas r where r.negocio_id = n.id and r.fecha >= v_mes),
      'km_mes', (select round(coalesce(sum(ruta._km(r)), 0), 1) from ruta.rutas r where r.negocio_id = n.id and r.fecha >= v_mes)
    ) x
    from core.negocios n join ruta.marcas mk on mk.negocio_id = n.id left join auth.users du on du.id = n.dueno_id) t), '[]'::jsonb);
end $$;

create or replace function ruta.panel_empresa(p_id uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare v_mes date := date_trunc('month', now() at time zone 'America/Lima')::date;
begin
  if not core.es_superadmin() then raise exception 'Solo para administradores generales'; end if;
  if not exists (select 1 from ruta.marcas where negocio_id = p_id) then raise exception 'No se encontró la empresa'; end if;
  return jsonb_build_object(
    'empresa', (select jsonb_build_object('id', n.id, 'nombre', n.nombre, 'slug', n.slug, 'creado_en', n.creado_en, 'dueno_correo', u.email,
                  'logo', mk.logo, 'tinta', mk.tinta, 'acento', mk.acento)
                  from core.negocios n join ruta.marcas mk on mk.negocio_id = n.id left join auth.users u on u.id = n.dueno_id where n.id = p_id),
    'equipo', coalesce((select jsonb_agg(jsonb_build_object('nombre', m.nombre, 'rol', m.rol, 'usuario', ruta._usuario(u.email),
                 'pendiente', coalesce((u.raw_app_meta_data ->> 'debe_cambiar_clave')::boolean, false),
                 'clientes', (select count(*) from ruta.clientes c where c.negocio_id = p_id and c.user_id = m.usuario_id))
                 order by case m.rol when 'admin' then 0 else 1 end, m.nombre)
               from core.miembros m join auth.users u on u.id = m.usuario_id where m.negocio_id = p_id and m.app = 'ruta'), '[]'::jsonb),
    'cifras', jsonb_build_object(
      'clientes', (select count(*) from ruta.clientes where negocio_id = p_id),
      'visitas_mes', (select coalesce(sum(cardinality(r.visitados)), 0) from ruta.rutas r where r.negocio_id = p_id and r.fecha >= v_mes),
      'km_mes', (select round(coalesce(sum(ruta._km(r)), 0), 1) from ruta.rutas r where r.negocio_id = p_id and r.fecha >= v_mes),
      'pedidos_mes', (select count(*) from ruta.aprobaciones a where a.negocio_id = p_id and a.fecha >= v_mes))
  );
end $$;

create or replace function ruta.panel_admins() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
begin
  if not core.es_superadmin() then raise exception 'Solo para administradores generales'; end if;
  return coalesce((select jsonb_agg(jsonb_build_object('correo', s.email, 'cuenta', u.id is not null,
           'pendiente', coalesce((u.raw_app_meta_data ->> 'debe_cambiar_clave')::boolean, false)) order by s.creado_en)
         from core.superadmins s left join auth.users u on lower(u.email) = s.email), '[]'::jsonb);
end $$;

create or replace function ruta.guardar_marca(p_negocio uuid, p_logo text, p_tinta text, p_acento text, p_cambiar_logo boolean) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if not core.es_superadmin() then raise exception 'Solo para administradores generales'; end if;
  if not exists (select 1 from ruta.marcas where negocio_id = p_negocio) then raise exception 'No se encontró la empresa'; end if;
  if p_tinta !~ '^#[0-9A-Fa-f]{6}$' or p_acento !~ '^#[0-9A-Fa-f]{6}$' then raise exception 'Color no válido'; end if;
  if p_cambiar_logo and p_logo is not null and p_logo !~ '^data:image/(png|jpeg|webp);base64,' then raise exception 'Logo no válido'; end if;
  update ruta.marcas set tinta = p_tinta, acento = p_acento, logo = case when p_cambiar_logo then p_logo else logo end
   where negocio_id = p_negocio;
end $$;

-- ───────────────────────── 7. Solo para la función del servidor (clave de servicio) ─────────────────────────

create or replace function ruta.srv_contexto(p_user uuid, p_negocio uuid) returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'admin', core.es_superadmin_id(p_user),
    'rol', (select m.rol from core.miembros m where m.usuario_id = p_user and m.negocio_id = p_negocio and m.app = 'ruta'))
$$;

create or replace function ruta.srv_negocio(p_negocio uuid) returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object('id', n.id, 'slug', n.slug, 'dueno_id', n.dueno_id, 'nombre', n.nombre,
    'usuarios', coalesce((select jsonb_agg(split_part(u.email, '@', 1)) from auth.users u
                 where u.email like '%@' || n.slug || '.usuarios.ruta-del-dia.app'), '[]'::jsonb))
  from core.negocios n join ruta.marcas mk on mk.negocio_id = n.id where n.id = p_negocio
$$;

create or replace function ruta.srv_rol(p_negocio uuid, p_user uuid) returns text
language sql stable security definer set search_path = '' as $$
  select rol from core.miembros where negocio_id = p_negocio and usuario_id = p_user and app = 'ruta'
$$;

create or replace function ruta.srv_usuario_por_correo(p_correo text) returns uuid
language sql stable security definer set search_path = '' as $$
  select id from auth.users where lower(email) = lower(btrim(p_correo)) limit 1
$$;

create or replace function ruta.srv_alta_empresa(p_user uuid, p_nombre text, p_slug text, p_nombre_dueno text, p_logo text, p_tinta text, p_acento text) returns uuid
language plpgsql security definer set search_path = '' as $$
declare v_neg uuid;
begin
  if length(btrim(coalesce(p_nombre, ''))) < 2 then raise exception 'Escribe el nombre de la empresa'; end if;
  if exists (select 1 from core.negocios where slug = p_slug) then raise exception 'Ese enlace ya lo usa otro negocio. Elige otro.'; end if;
  if p_tinta !~ '^#[0-9A-Fa-f]{6}$' or p_acento !~ '^#[0-9A-Fa-f]{6}$' then raise exception 'Color no válido'; end if;
  if p_logo is not null and p_logo !~ '^data:image/(png|jpeg|webp);base64,' then raise exception 'Logo no válido'; end if;
  insert into core.negocios (nombre, slug, dueno_id) values (left(btrim(p_nombre), 80), p_slug, p_user) returning id into v_neg;
  insert into ruta.marcas (negocio_id, logo, tinta, acento) values (v_neg, p_logo, p_tinta, p_acento);
  insert into core.miembros (usuario_id, negocio_id, app, rol, nombre) values (p_user, v_neg, 'ruta', 'admin', left(btrim(coalesce(p_nombre_dueno, '')), 80));
  return v_neg;
end $$;

create or replace function ruta.srv_alta_transportista(p_negocio uuid, p_user uuid, p_nombre text) returns void
language sql security definer set search_path = '' as $$
  insert into core.miembros (usuario_id, negocio_id, app, rol, nombre) values (p_user, p_negocio, 'ruta', 'transporte', left(btrim(coalesce(p_nombre, '')), 80))
$$;

-- Quita a un transportista: sus clientes pasan a otra persona del equipo. Devuelve si sigue en otra app o empresa.
create or replace function ruta.srv_quitar(p_negocio uuid, p_user uuid, p_a uuid) returns boolean
language plpgsql security definer set search_path = '' as $$
begin
  if ruta.srv_rol(p_negocio, p_user) is distinct from 'transporte' then raise exception 'Solo se puede quitar a un transportista de tu equipo'; end if;
  if p_a is null or ruta.srv_rol(p_negocio, p_a) is null or p_a = p_user then raise exception 'Elige a quién pasan sus clientes'; end if;
  update ruta.clientes set user_id = p_a where negocio_id = p_negocio and user_id = p_user;
  delete from ruta.aprobaciones where negocio_id = p_negocio and user_id = p_user and estado = 'pendiente';
  delete from core.miembros where negocio_id = p_negocio and usuario_id = p_user and app = 'ruta';
  return exists (select 1 from core.miembros where usuario_id = p_user) or core.es_superadmin_id(p_user);
end $$;

create or replace function ruta.srv_agregar_superadmin(p_correo text) returns void
language sql security definer set search_path = '' as $$
  insert into core.superadmins (email) values (lower(btrim(p_correo))) on conflict do nothing
$$;

-- ───────────────────────── 8. Permisos ─────────────────────────

grant usage on schema ruta to anon, authenticated, service_role;
revoke execute on all functions in schema ruta from public, anon, authenticated;
grant execute on function ruta.negocio_por_slug(text) to anon, authenticated;
grant execute on function ruta.es_miembro(uuid) to authenticated;
grant execute on function ruta.es_admin(uuid) to authenticated;
grant execute on function ruta.es_del_equipo(uuid, uuid) to authenticated;
grant execute on function ruta.mi_sesion(text) to authenticated;
grant execute on function ruta.mi_equipo(uuid) to authenticated;
grant execute on function ruta.pedir_aprobacion(uuid, uuid, date, text, text, text) to authenticated;
grant execute on function ruta.aprobaciones_del_dia(uuid, date) to authenticated;
grant execute on function ruta.responder_aprobacion(uuid, boolean) to authenticated;
grant execute on function ruta.panel_empresas() to authenticated;
grant execute on function ruta.panel_empresa(uuid) to authenticated;
grant execute on function ruta.panel_admins() to authenticated;
grant execute on function ruta.guardar_marca(uuid, text, text, text, boolean) to authenticated;
do $$
declare f text;
begin
  foreach f in array array[
    'ruta.srv_contexto(uuid, uuid)', 'ruta.srv_negocio(uuid)', 'ruta.srv_rol(uuid, uuid)', 'ruta.srv_usuario_por_correo(text)',
    'ruta.srv_alta_empresa(uuid, text, text, text, text, text, text)', 'ruta.srv_alta_transportista(uuid, uuid, text)',
    'ruta.srv_quitar(uuid, uuid, uuid)', 'ruta.srv_agregar_superadmin(text)']
  loop
    execute format('revoke execute on function %s from public, anon, authenticated', f);
    execute format('grant execute on function %s to service_role', f);
  end loop;
end $$;

notify pgrst, 'reload schema';
