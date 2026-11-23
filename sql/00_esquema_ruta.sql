-- 00 · Esquema `ruta` COMPLETO (proyecto Supabase "Microapps", project_id uvotorqggfqaadijpvte)
-- ============================================================================================
-- Hallazgo F-01 de la auditoría de seguridad: el repo solo versionaba un delta (01_multiempresa.sql)
-- y asumía que las tablas base, las políticas y varias funciones ya existían en la base.
--
-- FUENTE: extraído de la BASE VIVA "Microapps" (esquema `ruta`) con consultas de solo lectura al
--         catálogo (pg_attribute, pg_constraint, pg_indexes, pg_policies, pg_get_functiondef, aclexplode)
--         el 2026-11-23. Es un reflejo del estado real, no un diseño nuevo.
--
-- ORDEN: correr ANTES de 01_multiempresa.sql. Es idempotente (se puede correr más de una vez).
--        Sobre la base viva actual, las tablas/índices ya existen y solo se reaplican funciones,
--        políticas y permisos (idénticos a los vigentes).
--
-- DEPENDENCIAS EXTERNAS (NO se definen aquí; viven fuera de este repo y las comparten otras apps):
--   * core.negocios(id, nombre, slug, activa, dueno_id, creado_en)   -- FK de las 4 tablas
--   * core.miembros(usuario_id, negocio_id, app, rol, nombre)        -- app = 'ruta'; rol 'admin' | 'transporte'
--   * core.superadmins(email, creado_en)
--   * core.suscripciones(negocio_id, app, plan, prueba_fin)
--   * funciones core.es_superadmin(), core.es_superadmin_id(uuid), core.estado_plan(text), core.set_plan(uuid,text,text)
--   * auth.users y auth.uid() (Supabase Auth)
--   `core` y sus funciones deben existir ANTES de correr este archivo: las FK, las funciones de lenguaje
--   sql y las políticas las referencian y Postgres las valida al crearlas.
--
-- FORCE ROW LEVEL SECURITY (mejora nueva de F-01): la sentencia está versionada en la sección 5 pero
--   COMENTADA. En la base viva relforcerowsecurity = false en las 4 tablas. NO se aplica automáticamente:
--   debe aplicarse con revisión (ver nota en esa sección: las funciones security definer pertenecen a
--   `postgres`, que es el dueño de las tablas; con FORCE dejarían de saltarse RLS y las tablas
--   marcas/aprobaciones, que no tienen políticas, quedarían inaccesibles para ellas).
--
-- NOTA DE FORMATO: los cuerpos de función vienen de pg_get_functiondef y en la base usan fin de línea
--   CRLF; aquí se normalizaron a LF (no cambia el comportamiento).
--
-- ORDEN INTERNO: 1 esquema · 2 tablas · 3 índices · 4 funciones · 5 RLS · 6 políticas · 7 permisos.
--   (Las funciones van antes que las políticas porque las políticas las usan.)
-- ============================================================================================

-- ───────────────────────── 1. Esquema ─────────────────────────

create schema if not exists ruta;

-- ───────────────────────── 2. Tablas ─────────────────────────
-- Se declaran en su forma FINAL vigente (negocio_id NOT NULL, PK de rutas con negocio_id).
-- Las FK a core.negocios dependen de que `core` exista (ver cabecera).

-- Marca (logo y colores) de cada empresa. Sin políticas: se accede solo vía funciones security definer.
create table if not exists ruta.marcas (
  negocio_id uuid        not null,
  logo       text,
  tinta      text        not null default '#10231C',
  acento     text        not null default '#D7F25A',
  creado_en  timestamptz not null default now(),
  constraint marcas_pkey primary key (negocio_id),
  constraint marcas_negocio_id_fkey foreign key (negocio_id) references core.negocios(id) on delete cascade,
  constraint marcas_logo_check   check (logo is null or length(logo) <= 300000),
  constraint marcas_tinta_check  check (tinta  ~ '^#[0-9A-Fa-f]{6}$'),
  constraint marcas_acento_check check (acento ~ '^#[0-9A-Fa-f]{6}$')
);

-- Clientes de cada transportista (user_id) dentro de una empresa (negocio_id).
create table if not exists ruta.clientes (
  id           uuid             not null default gen_random_uuid(),
  user_id      uuid             not null default auth.uid(),
  nombre       text             not null,
  direccion    text,
  referencia   text,
  lat          double precision,
  lng          double precision,
  precision_m  integer,
  ubicado_en   timestamptz,
  creado_en    timestamptz      not null default now(),
  dias         smallint[]       not null default '{}'::smallint[],
  fechas       date[]           not null default '{}'::date[],
  negocio_id   uuid             not null,
  horario      jsonb            not null default '{}'::jsonb,   -- {"1":{"desde":"08:00","hasta":"12:30"}, ...} (0 = domingo)
  duracion_min integer          not null default 15,
  constraint clientes_pkey primary key (id),
  constraint clientes_user_id_fkey    foreign key (user_id)    references auth.users(id)    on delete cascade,
  constraint clientes_negocio_id_fkey foreign key (negocio_id) references core.negocios(id) on delete cascade,
  constraint clientes_nombre_check       check (char_length(nombre) >= 1 and char_length(nombre) <= 80),
  constraint clientes_direccion_check    check (direccion  is null or char_length(direccion)  <= 120),
  constraint clientes_referencia_check   check (referencia is null or char_length(referencia) <= 120),
  constraint clientes_lat_check          check (lat is null or (lat >= -90  and lat <= 90)),
  constraint clientes_lng_check          check (lng is null or (lng >= -180 and lng <= 180)),
  constraint clientes_duracion_min_check check (duracion_min >= 1 and duracion_min <= 480)
);

-- Ruta de un transportista en una empresa y un día.
-- OJO: la PK vigente es (negocio_id, user_id, fecha). La original (antes de la multiempresa) era (user_id, fecha).
create table if not exists ruta.rutas (
  user_id        uuid        not null default auth.uid(),
  fecha          date        not null,
  orden          uuid[]      not null default '{}'::uuid[],
  visitados      uuid[]      not null default '{}'::uuid[],
  modo           text        not null default 'manual',
  tramos         jsonb,
  actualizado_en timestamptz not null default now(),
  negocio_id     uuid        not null,
  salida         text,
  fuera          jsonb,                                       -- clientes que no entran en su horario
  saltados       uuid[]      not null default '{}'::uuid[],
  constraint rutas_pkey primary key (negocio_id, user_id, fecha),
  constraint rutas_user_id_fkey    foreign key (user_id)    references auth.users(id)    on delete cascade,
  constraint rutas_negocio_id_fkey foreign key (negocio_id) references core.negocios(id) on delete cascade,
  constraint rutas_modo_check   check (modo = any (array['manual'::text, 'calles'::text, 'recta'::text])),
  constraint rutas_salida_check check (salida is null or salida ~ '^\d{2}:\d{2}$')
);

-- Pedidos de aprobación (ir igual / saltar) de los transportistas al administrador. Sin políticas.
create table if not exists ruta.aprobaciones (
  id             uuid        not null default gen_random_uuid(),
  negocio_id     uuid        not null,
  user_id        uuid        not null,                        -- transportista que pide
  cliente_id     uuid        not null,
  fecha          date        not null,
  tipo           text        not null,
  llegada        text,
  hasta          text,
  estado         text        not null default 'pendiente',
  creado_en      timestamptz not null default now(),
  respondido_por uuid,
  respondido_en  timestamptz,
  constraint aprobaciones_pkey primary key (id),
  constraint aprobaciones_negocio_id_fkey     foreign key (negocio_id)     references core.negocios(id)  on delete cascade,
  constraint aprobaciones_user_id_fkey        foreign key (user_id)        references auth.users(id)     on delete cascade,
  constraint aprobaciones_cliente_id_fkey     foreign key (cliente_id)     references ruta.clientes(id)  on delete cascade,
  constraint aprobaciones_respondido_por_fkey foreign key (respondido_por) references auth.users(id)     on delete set null,
  constraint aprobaciones_tipo_check   check (tipo   = any (array['ir'::text, 'saltar'::text])),
  constraint aprobaciones_estado_check check (estado = any (array['pendiente'::text, 'aprobado'::text, 'rechazado'::text]))
);

-- ───────────────────────── 3. Índices ─────────────────────────
-- (los de PK ya los crea cada constraint primary key)

create index        if not exists clientes_negocio        on ruta.clientes (negocio_id, user_id);
create index        if not exists clientes_user_idx       on ruta.clientes (user_id, nombre);
create index        if not exists rutas_negocio_fecha     on ruta.rutas (negocio_id, fecha);
create index        if not exists aprobaciones_negocio    on ruta.aprobaciones (negocio_id, fecha, estado);
create unique index if not exists aprobaciones_una_por_dia on ruta.aprobaciones (cliente_id, fecha, user_id);

-- ───────────────────────── 4. Funciones (24) ─────────────────────────
-- Definiciones reales (pg_get_functiondef). Todas pertenecen a `postgres`.
-- Las security definer usan search_path vacío (''), salvo estado_plan/set_plan que usan 'core, ruta, public'.

-- 4.1 Auxiliares puras (no security definer)

CREATE OR REPLACE FUNCTION ruta._km(r ruta.rutas)
 RETURNS numeric
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO ''
AS $function$
  select coalesce(sum((r.tramos -> v::text ->> 'km')::numeric), 0) from unnest(r.visitados) v
   where jsonb_typeof(r.tramos -> v::text -> 'km') = 'number'
$function$;

CREATE OR REPLACE FUNCTION ruta._usuario(p_email text)
 RETURNS text
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO ''
AS $function$
  select case when p_email like '%.usuarios.ruta-del-dia.app' then split_part(p_email, '@', 1) else p_email end
$function$;

-- 4.2 Pertenencia (las usan las políticas RLS)

CREATE OR REPLACE FUNCTION ruta.es_miembro(p_negocio uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  select exists (select 1 from core.miembros m join core.negocios n on n.id = m.negocio_id
                  where m.usuario_id = auth.uid() and m.negocio_id = p_negocio and m.app = 'ruta' and n.activa)
$function$;

CREATE OR REPLACE FUNCTION ruta.es_admin(p_negocio uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  select exists (select 1 from core.miembros m join core.negocios n on n.id = m.negocio_id
                  where m.usuario_id = auth.uid() and m.negocio_id = p_negocio and m.app = 'ruta' and m.rol = 'admin' and n.activa)
$function$;

CREATE OR REPLACE FUNCTION ruta.es_del_equipo(p_negocio uuid, p_user uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  select exists (select 1 from core.miembros m where m.usuario_id = p_user and m.negocio_id = p_negocio and m.app = 'ruta')
$function$;

-- 4.3 Sesión y marca (expuestas a la app)

CREATE OR REPLACE FUNCTION ruta.negocio_por_slug(p_slug text)
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  select jsonb_build_object('nombre', n.nombre, 'slug', n.slug, 'logo', mk.logo, 'tinta', mk.tinta, 'acento', mk.acento)
    from core.negocios n join ruta.marcas mk on mk.negocio_id = n.id
   where n.slug = lower(btrim(coalesce(p_slug, ''))) and n.activa
$function$;

CREATE OR REPLACE FUNCTION ruta.mi_sesion(p_slug text)
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
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
$function$;

CREATE OR REPLACE FUNCTION ruta.mi_equipo(p_negocio uuid)
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  select coalesce(jsonb_agg(jsonb_build_object(
           'usuario_id', m.usuario_id, 'nombre', coalesce(nullif(btrim(m.nombre), ''), split_part(u.email, '@', 1)), 'rol', m.rol,
           'usuario', ruta._usuario(u.email), 'yo', m.usuario_id = auth.uid(),
           'pendiente', coalesce((u.raw_app_meta_data ->> 'debe_cambiar_clave')::boolean, false),
           'clientes', (select count(*) from ruta.clientes c where c.negocio_id = m.negocio_id and c.user_id = m.usuario_id))
         order by case m.rol when 'admin' then 0 else 1 end, m.nombre), '[]'::jsonb)
    from core.miembros m join auth.users u on u.id = m.usuario_id
   where m.negocio_id = p_negocio and m.app = 'ruta'
     and (ruta.es_admin(p_negocio) or m.usuario_id = auth.uid())
$function$;

CREATE OR REPLACE FUNCTION ruta.guardar_marca(p_negocio uuid, p_logo text, p_tinta text, p_acento text, p_cambiar_logo boolean)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  if not core.es_superadmin() then raise exception 'Solo para administradores generales'; end if;
  if not exists (select 1 from ruta.marcas where negocio_id = p_negocio) then raise exception 'No se encontró la empresa'; end if;
  if p_tinta !~ '^#[0-9A-Fa-f]{6}$' or p_acento !~ '^#[0-9A-Fa-f]{6}$' then raise exception 'Color no válido'; end if;
  if p_cambiar_logo and p_logo is not null and p_logo !~ '^data:image/(png|jpeg|webp);base64,' then raise exception 'Logo no válido'; end if;
  update ruta.marcas set tinta = p_tinta, acento = p_acento, logo = case when p_cambiar_logo then p_logo else logo end
   where negocio_id = p_negocio;
end $function$;

-- 4.4 Aprobaciones

CREATE OR REPLACE FUNCTION ruta.pedir_aprobacion(p_negocio uuid, p_cliente uuid, p_fecha date, p_tipo text, p_llegada text, p_hasta text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
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
end $function$;

CREATE OR REPLACE FUNCTION ruta.aprobaciones_del_dia(p_negocio uuid, p_fecha date)
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
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
$function$;

CREATE OR REPLACE FUNCTION ruta.responder_aprobacion(p_id uuid, p_aprobar boolean)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare a ruta.aprobaciones;
begin
  select * into a from ruta.aprobaciones where id = p_id;
  if a.id is null or not ruta.es_admin(a.negocio_id) then raise exception 'Solo el administrador responde los pedidos'; end if;
  update ruta.aprobaciones set estado = case when p_aprobar then 'aprobado' else 'rechazado' end,
         respondido_por = auth.uid(), respondido_en = now()
   where id = p_id returning * into a;
  return to_jsonb(a);
end $function$;

-- 4.5 Panel de administradores generales (superadmin)

CREATE OR REPLACE FUNCTION ruta.panel_empresas()
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
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
end $function$;

CREATE OR REPLACE FUNCTION ruta.panel_empresa(p_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
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
end $function$;

CREATE OR REPLACE FUNCTION ruta.panel_admins()
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  if not core.es_superadmin() then raise exception 'Solo para administradores generales'; end if;
  return coalesce((select jsonb_agg(jsonb_build_object('correo', s.email, 'cuenta', u.id is not null,
           'pendiente', coalesce((u.raw_app_meta_data ->> 'debe_cambiar_clave')::boolean, false)) order by s.creado_en)
         from core.superadmins s left join auth.users u on lower(u.email) = s.email), '[]'::jsonb);
end $function$;

-- 4.6 Plan / suscripción (delegan en core; NO estaban en 01_multiempresa.sql)

CREATE OR REPLACE FUNCTION ruta.estado_plan()
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'core', 'ruta', 'public'
AS $function$ select core.estado_plan('ruta') $function$;

CREATE OR REPLACE FUNCTION ruta.set_plan(p_negocio uuid, p_plan text)
 RETURNS void
 LANGUAGE sql
 SECURITY DEFINER
 SET search_path TO 'core', 'ruta', 'public'
AS $function$ select core.set_plan(p_negocio, 'ruta', p_plan) $function$;

-- 4.7 Funciones srv_* (solo service_role: las llama la Edge Function ruta-cuentas con la service key)

CREATE OR REPLACE FUNCTION ruta.srv_contexto(p_user uuid, p_negocio uuid)
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  select jsonb_build_object(
    'admin', core.es_superadmin_id(p_user),
    'rol', (select m.rol from core.miembros m where m.usuario_id = p_user and m.negocio_id = p_negocio and m.app = 'ruta'))
$function$;

CREATE OR REPLACE FUNCTION ruta.srv_negocio(p_negocio uuid)
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  select jsonb_build_object('id', n.id, 'slug', n.slug, 'dueno_id', n.dueno_id, 'nombre', n.nombre,
    'usuarios', coalesce((select jsonb_agg(split_part(u.email, '@', 1)) from auth.users u
                 where u.email like '%@' || n.slug || '.usuarios.ruta-del-dia.app'), '[]'::jsonb))
  from core.negocios n join ruta.marcas mk on mk.negocio_id = n.id where n.id = p_negocio
$function$;

CREATE OR REPLACE FUNCTION ruta.srv_rol(p_negocio uuid, p_user uuid)
 RETURNS text
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  select rol from core.miembros where negocio_id = p_negocio and usuario_id = p_user and app = 'ruta'
$function$;

CREATE OR REPLACE FUNCTION ruta.srv_usuario_por_correo(p_correo text)
 RETURNS uuid
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  select id from auth.users where lower(email) = lower(btrim(p_correo)) limit 1
$function$;

CREATE OR REPLACE FUNCTION ruta.srv_alta_empresa(p_user uuid, p_nombre text, p_slug text, p_nombre_dueno text, p_logo text, p_tinta text, p_acento text)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
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
end $function$;

CREATE OR REPLACE FUNCTION ruta.srv_alta_transportista(p_negocio uuid, p_user uuid, p_nombre text)
 RETURNS void
 LANGUAGE sql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
  insert into core.miembros (usuario_id, negocio_id, app, rol, nombre) values (p_user, p_negocio, 'ruta', 'transporte', left(btrim(coalesce(p_nombre, '')), 80))
$function$;

CREATE OR REPLACE FUNCTION ruta.srv_quitar(p_negocio uuid, p_user uuid, p_a uuid)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  if ruta.srv_rol(p_negocio, p_user) is distinct from 'transporte' then raise exception 'Solo se puede quitar a un transportista de tu equipo'; end if;
  if p_a is null or ruta.srv_rol(p_negocio, p_a) is null or p_a = p_user then raise exception 'Elige a quién pasan sus clientes'; end if;
  update ruta.clientes set user_id = p_a where negocio_id = p_negocio and user_id = p_user;
  delete from ruta.aprobaciones where negocio_id = p_negocio and user_id = p_user and estado = 'pendiente';
  delete from core.miembros where negocio_id = p_negocio and usuario_id = p_user and app = 'ruta';
  return exists (select 1 from core.miembros where usuario_id = p_user) or core.es_superadmin_id(p_user);
end $function$;

CREATE OR REPLACE FUNCTION ruta.srv_agregar_superadmin(p_correo text)
 RETURNS void
 LANGUAGE sql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
  insert into core.superadmins (email) values (lower(btrim(p_correo))) on conflict do nothing
$function$;

-- ───────────────────────── 5. Row Level Security ─────────────────────────
-- Estado vivo: relrowsecurity = true y relforcerowsecurity = false en las 4 tablas.

alter table ruta.clientes     enable row level security;
alter table ruta.rutas        enable row level security;
alter table ruta.marcas       enable row level security;   -- sin políticas: solo vía funciones security definer
alter table ruta.aprobaciones enable row level security;   -- sin políticas: solo vía funciones security definer

-- FORCE ROW LEVEL SECURITY (F-01) — VERSIONADO PERO NO APLICADO. Aplicar solo con revisión.
-- Riesgo a revisar antes de aplicar: el dueño de las tablas es `postgres` y las funciones security definer
-- también lo son; hoy se saltan RLS por ser dueño. Con FORCE, RLS les aplicaría también a ellas:
--   * marcas y aprobaciones no tienen políticas -> las funciones (negocio_por_slug, mi_sesion, guardar_marca,
--     pedir_aprobacion, aprobaciones_del_dia, responder_aprobacion, panel_*, srv_*) verían 0 filas / fallarían.
--   * Antes de activarlo hay que crear políticas explícitas para esas funciones (p. ej. un rol dueño de funciones
--     con BYPASSRLS, o políticas basadas en es_admin/es_miembro/core.es_superadmin) y correr sql/tests/rls_aislamiento.sql.
-- alter table ruta.clientes     force row level security;
-- alter table ruta.rutas        force row level security;
-- alter table ruta.marcas       force row level security;
-- alter table ruta.aprobaciones force row level security;

-- ───────────────────────── 6. Políticas (7) ─────────────────────────
-- Exactas a pg_policies (todas PERMISSIVE, rol authenticated). No hay política DELETE en rutas
-- (aunque `authenticated` tenga el privilegio DELETE, RLS lo bloquea). marcas y aprobaciones: 0 políticas.

drop policy if exists clientes_ver     on ruta.clientes;
drop policy if exists clientes_crear   on ruta.clientes;
drop policy if exists clientes_cambiar on ruta.clientes;
drop policy if exists clientes_borrar  on ruta.clientes;
drop policy if exists rutas_ver        on ruta.rutas;
drop policy if exists rutas_escribir   on ruta.rutas;
drop policy if exists rutas_cambiar    on ruta.rutas;

create policy clientes_ver on ruta.clientes for select to authenticated
  using (((user_id = auth.uid()) and ruta.es_miembro(negocio_id)) or ruta.es_admin(negocio_id));

create policy clientes_crear on ruta.clientes for insert to authenticated
  with check (((user_id = auth.uid()) and ruta.es_miembro(negocio_id))
              or (ruta.es_admin(negocio_id) and ruta.es_del_equipo(negocio_id, user_id)));

create policy clientes_cambiar on ruta.clientes for update to authenticated
  using (((user_id = auth.uid()) and ruta.es_miembro(negocio_id)) or ruta.es_admin(negocio_id))
  with check (((user_id = auth.uid()) and ruta.es_miembro(negocio_id))
              or (ruta.es_admin(negocio_id) and ruta.es_del_equipo(negocio_id, user_id)));

create policy clientes_borrar on ruta.clientes for delete to authenticated
  using (((user_id = auth.uid()) and ruta.es_miembro(negocio_id)) or ruta.es_admin(negocio_id));

create policy rutas_ver on ruta.rutas for select to authenticated
  using (((user_id = auth.uid()) and ruta.es_miembro(negocio_id)) or ruta.es_admin(negocio_id));

create policy rutas_escribir on ruta.rutas for insert to authenticated
  with check ((user_id = auth.uid()) and ruta.es_miembro(negocio_id));

create policy rutas_cambiar on ruta.rutas for update to authenticated
  using (((user_id = auth.uid()) and ruta.es_miembro(negocio_id)) or ruta.es_admin(negocio_id))
  with check (((user_id = auth.uid()) and ruta.es_miembro(negocio_id)) or ruta.es_admin(negocio_id));

-- ───────────────────────── 7. Permisos (GRANT / REVOKE) ─────────────────────────
-- Estado vivo (aclexplode): el esquema `ruta` NO tiene privilegios por defecto para anon/authenticated/service_role
-- (no aparece en pg_default_acl), así que solo existen los grants explícitos siguientes.

grant usage on schema ruta to anon, authenticated, service_role;

-- Tablas: solo clientes y rutas son accesibles directamente por la app (authenticated); lo demás, vía funciones.
revoke all on ruta.clientes, ruta.rutas, ruta.marcas, ruta.aprobaciones from anon, authenticated, service_role;
grant select, insert, update, delete on ruta.clientes, ruta.rutas to authenticated;
-- anon: sin acceso a ninguna tabla. service_role: sin grants directos en tablas (usa las funciones srv_*).

-- Funciones: todo cerrado y se abre lo vigente.
revoke execute on all functions in schema ruta from public, anon, authenticated, service_role;

grant execute on function ruta.negocio_por_slug(text) to anon, authenticated;
grant execute on function ruta.es_miembro(uuid)       to authenticated;
grant execute on function ruta.es_admin(uuid)         to authenticated;
grant execute on function ruta.es_del_equipo(uuid, uuid) to authenticated;
grant execute on function ruta.mi_sesion(text)        to authenticated;
grant execute on function ruta.mi_equipo(uuid)        to authenticated;
grant execute on function ruta.pedir_aprobacion(uuid, uuid, date, text, text, text) to authenticated;
grant execute on function ruta.aprobaciones_del_dia(uuid, date) to authenticated;
grant execute on function ruta.responder_aprobacion(uuid, boolean) to authenticated;
grant execute on function ruta.panel_empresas()       to authenticated;
grant execute on function ruta.panel_empresa(uuid)    to authenticated;
grant execute on function ruta.panel_admins()         to authenticated;
grant execute on function ruta.guardar_marca(uuid, text, text, text, boolean) to authenticated;

-- ATENCIÓN (hallazgo): en la base viva estado_plan() y set_plan(uuid, text) tienen EXECUTE para PUBLIC
-- (y por tanto anon), porque se crearon después del revoke masivo de 01_multiempresa.sql y heredaron el
-- default de Postgres. Se versiona el estado REAL. No es explotable hoy porque core.set_plan exige
-- core.es_superadmin() y core.estado_plan usa auth.uid(), pero conviene cerrarlo (con revisión):
--   revoke execute on function ruta.estado_plan()                  from public, anon;
--   revoke execute on function ruta.set_plan(uuid, text)           from public, anon;
grant execute on function ruta.estado_plan()          to public;
grant execute on function ruta.estado_plan()          to authenticated;
grant execute on function ruta.set_plan(uuid, text)   to public;
grant execute on function ruta.set_plan(uuid, text)   to authenticated;

-- srv_*: solo service_role (Edge Function ruta-cuentas).
grant execute on function ruta.srv_contexto(uuid, uuid)          to service_role;
grant execute on function ruta.srv_negocio(uuid)                 to service_role;
grant execute on function ruta.srv_rol(uuid, uuid)               to service_role;
grant execute on function ruta.srv_usuario_por_correo(text)      to service_role;
grant execute on function ruta.srv_alta_empresa(uuid, text, text, text, text, text, text) to service_role;
grant execute on function ruta.srv_alta_transportista(uuid, uuid, text) to service_role;
grant execute on function ruta.srv_quitar(uuid, uuid, uuid)      to service_role;
grant execute on function ruta.srv_agregar_superadmin(text)      to service_role;

-- _km y _usuario: sin grants para anon/authenticated/service_role (solo owner `postgres`);
-- las usan otras funciones security definer, que corren como owner.
