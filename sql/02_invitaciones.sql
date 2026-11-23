-- 02 · Enlaces de invitación de un solo uso (hallazgo F-03)
-- Reemplaza la contraseña temporal compartida por WhatsApp: ahora se comparte un enlace que caduca
-- (48 h) y sirve una sola vez; la persona crea su propia contraseña.
-- Correr DESPUÉS de 00_esquema_ruta.sql y 01_multiempresa.sql. Se puede correr más de una vez.
-- Solo se guarda el HASH (SHA-256) del token, nunca el token. El acceso es únicamente desde las
-- Edge Functions (service_role): la tabla tiene RLS activo, sin políticas y sin permisos para anon/authenticated.

create table if not exists ruta.invitaciones (
  id          uuid primary key default gen_random_uuid(),
  usuario_id  uuid not null references auth.users(id) on delete cascade,
  token_hash  text not null unique,
  tipo        text not null default 'alta' check (tipo in ('alta','reset')),
  expira_en   timestamptz not null,
  usado_en    timestamptz,
  creado_por  uuid,
  creado_en   timestamptz not null default now()
);

-- token_hash ya tiene índice único por su constraint
create index if not exists invitaciones_usuario_idx on ruta.invitaciones (usuario_id);

alter table ruta.invitaciones enable row level security;
revoke all on ruta.invitaciones from anon, authenticated;

-- Cierra todas las sesiones de un usuario (se usa al estrenar o cambiar la contraseña con un enlace).
-- Solo la puede ejecutar service_role (Edge Functions).
create or replace function ruta.srv_cerrar_sesiones(p_user uuid) returns void
language sql security definer set search_path = '' as $$
  delete from auth.sessions where user_id = p_user
$$;
revoke execute on function ruta.srv_cerrar_sesiones(uuid) from public, anon, authenticated;
grant execute on function ruta.srv_cerrar_sesiones(uuid) to service_role;

notify pgrst, 'reload schema';
