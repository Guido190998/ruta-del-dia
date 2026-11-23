-- 03 · Pertenencia a 'ruta' para /api/optimizar (hallazgo F-05)
-- El proyecto Supabase es compartido por todas las microapps Nivo: un usuario autenticado de OTRA app
-- tenía token válido y podía gastar la cuota de OpenRouteService. Esta función deja que api/optimizar.js
-- compruebe, con el token del propio usuario, que es miembro activo de un negocio activo de la app 'ruta'.
-- Correr DESPUÉS de 00_esquema_ruta.sql y 01_multiempresa.sql. Se puede correr más de una vez.

create or replace function ruta.soy_de_ruta() returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from core.miembros m join core.negocios n on n.id = m.negocio_id
                 where m.usuario_id = auth.uid() and m.app = 'ruta' and n.activa)
$$;

revoke execute on function ruta.soy_de_ruta() from public, anon;
grant execute on function ruta.soy_de_ruta() to authenticated;

notify pgrst, 'reload schema';
