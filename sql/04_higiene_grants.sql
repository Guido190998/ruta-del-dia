-- 04 · Higiene de permisos (hallazgo nuevo visto en la base viva)
-- ruta.estado_plan() y ruta.set_plan(uuid,text) heredaron EXECUTE para PUBLIC/anon al crearse
-- después del revoke masivo de 01_multiempresa.sql. No es explotable hoy (set_plan exige
-- core.es_superadmin() por dentro y estado_plan usa auth.uid()), pero se cierra por higiene.
-- authenticated conserva el permiso porque la app los usa tras iniciar sesión.
-- Correr en el SQL Editor; se puede correr más de una vez.

revoke execute on function ruta.estado_plan()        from public, anon;
revoke execute on function ruta.set_plan(uuid, text)  from public, anon;

notify pgrst, 'reload schema';
