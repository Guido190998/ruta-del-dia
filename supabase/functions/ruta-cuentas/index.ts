// Función segura "ruta-cuentas" · Ruta del día (multiempresa)
// Crea y administra cuentas. Corre en el servidor de Supabase con permisos de administrador;
// el navegador nunca ve esa clave.
//
// Cuentas:
// - Administrador de cada empresa: entra con su correo (puede recuperar su clave por correo).
// - Transportistas: entran con un usuario sin correo, generado con la regla de Guido. Por dentro se guarda
//   como "<usuario>@<enlace>.usuarios.ruta-del-dia.app" (un identificador; nunca se envía nada).
// - Nadie comparte contraseñas (F-03): las altas y los reseteos devuelven un token de invitación de un solo uso
//   (48 h) y la persona crea su propia clave en /invitacion (función ruta-invitacion).
import { createClient } from "npm:@supabase/supabase-js@2";

const URL = Deno.env.get("SUPABASE_URL")!;
const SERVICIO = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
// Clave pública (anon): Supabase la inyecta sola en las Edge Functions. Sirve para verificar la contraseña actual sin privilegios.
const ANON = Deno.env.get("SUPABASE_ANON_KEY") ?? "";
const DOMINIO = "usuarios.ruta-del-dia.app";
const SLUG_RESERVADOS = [
  "privacidad", "terminos", "cookies", "aviso-legal", "index", "admin", "panel", "api", "app", "login",
  "ingresar", "soporte", "404", "manifest", "config", "orden", "favicon", "invitacion", "recuperar",
];
const COLOR = /^#[0-9A-Fa-f]{6}$/;

// Orígenes permitidos para CORS. Añadir aquí el dominio propio cuando se compre.
const ORIGENES = ["https://ruta.nivo-pe.workers.dev"];
function cabeceras(req: Request) {
  const origen = req.headers.get("Origin") || "";
  const h: Record<string, string> = {
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Vary": "Origin",
  };
  if (ORIGENES.includes(origen)) h["Access-Control-Allow-Origin"] = origen;
  return h;
}

const validarClave = (c: unknown) => (String(c ?? "").length >= 12 && String(c).length <= 72 ? null : "La contraseña debe tener al menos 12 caracteres.");
const validarNombre = (n: unknown) => (String(n ?? "").trim().length >= 2 ? null : "Escribe el nombre.");
const limpio = (s: unknown, max = 80) => String(s ?? "").trim().slice(0, max);
function validarCorreo(c: unknown): string | null {
  const x = String(c ?? "").trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(x) || x.length > 120) return null;
  if (x.endsWith(DOMINIO)) return null;
  return x;
}
const sinTildes = (t: unknown) => String(t ?? "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");
const letras = (t: unknown) => sinTildes(t).replace(/[^a-z]/g, "");
const inicial = (t: unknown) => letras(String(t ?? "").trim().split(/\s+/)[0]).charAt(0);
const slugDe = (t: unknown) => sinTildes(t).replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40).replace(/-+$/g, "");

// Regla del usuario: inicial del 1er nombre + inicial del 2do nombre + 1er apellido + inicial del 2do apellido.
// Si ya existe, se separa con punto entre nombre y apellido; si también existe, se le suma un número.
function elegirUsuario(n1: unknown, n2: unknown, a1: unknown, a2: unknown, existentes: Set<string>): string {
  const pre = inicial(n1) + inicial(n2), ap = letras(a1);
  if (!inicial(n1) || ap.length < 2) throw new Error("Escribe al menos el primer nombre y el primer apellido.");
  const fin = ap + inicial(a2);
  const base = (pre + fin).slice(0, 30), punto = (pre + "." + fin).slice(0, 30);
  if (!existentes.has(base)) return base;
  if (!existentes.has(punto)) return punto;
  for (let n = 2; n < 1000; n++) {
    const c = punto.slice(0, 30 - String(n).length) + n;
    if (!existentes.has(c)) return c;
  }
  throw new Error("No se pudo generar un usuario libre.");
}

Deno.serve(async (req) => {
  const CORS = cabeceras(req);
  const responder = (cuerpo: unknown, estado = 200) =>
    new Response(JSON.stringify(cuerpo), { status: estado, headers: { ...CORS, "Content-Type": "application/json" } });
  const fallo = (mensaje: string, estado = 400) => responder({ error: mensaje }, estado);

  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return fallo("Método no permitido", 405);

  const admin = createClient(URL, SERVICIO, { auth: { persistSession: false, autoRefreshToken: false } });
  const db = admin.schema("ruta");

  try {
    const token = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
    const { data: quien } = await admin.auth.getUser(token);
    if (!quien?.user) return fallo("Tu sesión venció. Vuelve a ingresar.", 401);
    const yo = quien.user.id;

    const cuerpo = await req.json().catch(() => ({}));
    const accion = String(cuerpo.accion || "");
    const negocioId = cuerpo.negocio_id ? String(cuerpo.negocio_id) : null;
    const { data: ctx, error: eCtx } = await db.rpc("srv_contexto", { p_user: yo, p_negocio: negocioId });
    if (eCtx) throw eCtx;
    const esAdmin = !!ctx?.admin;
    const esDueno = ctx?.rol === "admin";

    async function crearCuenta(email: string, clave: string, nombre: string, extra: Record<string, unknown> = {}) {
      const { data, error } = await admin.auth.admin.createUser({
        email, password: clave, email_confirm: true,
        user_metadata: { nombre, ...extra }, app_metadata: { debe_cambiar_clave: true },
      });
      if (error) {
        if (/already|registered|exists/i.test(error.message)) throw new Error("Ese correo o usuario ya tiene una cuenta.");
        throw error;
      }
      return data.user!.id;
    }
    // F-03: ya no se comparte ninguna contraseña. La cuenta nueva nace con una clave interna aleatoria que nadie ve,
    // y la persona crea la suya con un enlace de invitación de un solo uso (ruta-invitacion).
    const hex = (b: Uint8Array) => Array.from(b).map((x) => x.toString(16).padStart(2, "0")).join("");
    const claveInterna = () => hex(crypto.getRandomValues(new Uint8Array(32)));
    async function crearInvitacion(usuario_id: string, tipo: "alta" | "reset") {
      const token = hex(crypto.getRandomValues(new Uint8Array(32)));
      const hash = hex(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token))));
      const ahora = new Date();
      // Una invitación nueva anula las anteriores que siguieran pendientes para esa persona.
      await db.from("invitaciones").update({ usado_en: ahora.toISOString() }).eq("usuario_id", usuario_id).is("usado_en", null);
      const { error } = await db.from("invitaciones").insert({
        usuario_id, token_hash: hash, tipo, expira_en: new Date(ahora.getTime() + 48 * 3600 * 1000).toISOString(), creado_por: yo,
      });
      if (error) throw error;
      return token;  // se devuelve una sola vez; en la base solo queda el hash
    }
    async function negocio(id: string) {
      const { data, error } = await db.rpc("srv_negocio", { p_negocio: id });
      if (error) throw error;
      if (!data) throw new Error("No se encontró el negocio.");
      return data as { id: string; slug: string; dueno_id: string | null; nombre: string; usuarios: string[] };
    }

    // ---------- Cualquier persona: elegir su propia contraseña ----------
    if (accion === "cambiar_mi_clave") {
      // Solo el primer ingreso forzado (debe_cambiar_clave) salta la confirmación: aún no tiene una contraseña propia.
      // La recuperación por enlace de correo NO pasa por aquí: el cliente usa sb.auth.updateUser con su sesión de recuperación.
      const sinActual = quien.user.app_metadata?.debe_cambiar_clave === true;
      if (!sinActual) {
        if (!ANON) throw new Error("Falta SUPABASE_ANON_KEY en la función.");
        const verif = createClient(URL, ANON, { auth: { persistSession: false, autoRefreshToken: false } });
        const { error: eActual } = await verif.auth.signInWithPassword({ email: String(quien.user.email || ""), password: String(cuerpo.clave_actual ?? "") });
        if (eActual) return fallo("La contraseña actual no es correcta.", 403);
      }
      const m = validarClave(cuerpo.clave);
      if (m) return fallo(m);
      const { error } = await admin.auth.admin.updateUserById(yo, { password: String(cuerpo.clave), app_metadata: { debe_cambiar_clave: false } });
      if (error) throw error;
      // Cierra las demás sesiones abiertas con la clave anterior (la actual se renueva en el cliente).
      try { await db.rpc("srv_cerrar_sesiones", { p_user: yo }); } catch (e) { console.error(String(e)); }
      return responder({ ok: true });
    }

    // ---------- Solo administradores generales ----------
    if (accion === "crear_empresa") {
      if (!esAdmin) return fallo("No tienes permiso.", 403);
      const nombreNeg = limpio(cuerpo.negocio), nombreDueno = limpio(cuerpo.nombre);
      const m = validarNombre(nombreNeg) || validarNombre(nombreDueno);
      if (m) return fallo(m);
      const correo = validarCorreo(cuerpo.correo);
      if (!correo) return fallo("Escribe un correo válido para el administrador.");
      const slug = slugDe(cuerpo.slug || nombreNeg);
      if (slug.length < 3) return fallo("El enlace debe tener al menos 3 letras o números.");
      if (SLUG_RESERVADOS.includes(slug)) return fallo("Ese enlace está reservado. Elige otro.");
      const tinta = COLOR.test(String(cuerpo.tinta)) ? String(cuerpo.tinta) : "#10231C";
      const acento = COLOR.test(String(cuerpo.acento)) ? String(cuerpo.acento) : "#D7F25A";
      const logo = cuerpo.logo ? String(cuerpo.logo) : null;
      if (logo && (!/^data:image\/(png|jpeg|webp);base64,/.test(logo) || logo.length > 300000)) return fallo("El logo no es válido o es muy pesado.");
      // Si el correo ya tiene cuenta (por ejemplo, es dueño en otra microapp), se usa la misma cuenta
      // y la persona sigue entrando con su contraseña de siempre.
      const { data: existe } = await db.rpc("srv_usuario_por_correo", { p_correo: correo });
      let id: string;
      if (existe) {
        id = String(existe);
        const { data: info } = await admin.auth.admin.getUserById(id);
        const suspendida = info?.user?.banned_until && new Date(info.user.banned_until) > new Date();
        if (suspendida) return fallo("Esa cuenta está suspendida. Reactívala a propósito antes de asignarla a una empresa.", 409);
      } else {
        id = await crearCuenta(correo, claveInterna(), nombreDueno);
      }
      const { data: neg, error } = await db.rpc("srv_alta_empresa", {
        p_user: id, p_nombre: nombreNeg, p_slug: slug, p_nombre_dueno: nombreDueno, p_logo: logo, p_tinta: tinta, p_acento: acento,
      });
      if (error) { if (!existe) await admin.auth.admin.deleteUser(id); throw error; }
      const invitacion = existe ? null : await crearInvitacion(id, "alta");
      return responder({ ok: true, negocio_id: neg, slug, correo, existente: !!existe, ...(invitacion ? { token: invitacion } : {}) });
    }

    if (accion === "restablecer_dueno") {
      if (!esAdmin) return fallo("No tienes permiso.", 403);
      const n = await negocio(String(negocioId || ""));
      if (!n.dueno_id) return fallo("Esta empresa no tiene administrador asignado.");
      if (n.dueno_id === yo) return fallo("Para tu propia contraseña usa «Mi contraseña».");
      // TODO (F-02/plataforma): avisar al titular y registrar en auditoría cuando exista email + core.auditoria
      const tokenReset = await crearInvitacion(n.dueno_id, "reset");
      try { await db.rpc("srv_cerrar_sesiones", { p_user: n.dueno_id }); } catch (e) { console.error(String(e)); }
      return responder({ ok: true, token: tokenReset });
    }

    if (accion === "crear_superadmin") {
      if (!esAdmin) return fallo("No tienes permiso.", 403);
      const correo = validarCorreo(cuerpo.correo);
      if (!correo) return fallo("Escribe un correo válido.");
      const { data: existe } = await db.rpc("srv_usuario_por_correo", { p_correo: correo });
      let nuevoId: string | null = null;
      if (!existe) nuevoId = await crearCuenta(correo, claveInterna(), "");
      const { error } = await db.rpc("srv_agregar_superadmin", { p_correo: correo });
      if (error) { if (nuevoId) await admin.auth.admin.deleteUser(nuevoId); throw error; }
      return responder({ ok: true, correo, existente: !!existe, ...(nuevoId ? { token: await crearInvitacion(nuevoId, "alta") } : {}) });
    }

    if (accion === "restablecer_superadmin") {
      if (!esAdmin) return fallo("No tienes permiso.", 403);
      const correo = validarCorreo(cuerpo.correo);
      if (!correo) return fallo("Escribe un correo válido.");
      const { data: id } = await db.rpc("srv_usuario_por_correo", { p_correo: correo });
      if (!id) return fallo("Ese correo todavía no tiene cuenta.");
      const { data: ctx2 } = await db.rpc("srv_contexto", { p_user: id, p_negocio: null });
      if (!ctx2?.admin) return fallo("Ese correo no es administrador general.");
      if (id === yo) return fallo("Para tu propia contraseña usa «Mi contraseña».");
      // TODO (F-02/plataforma): avisar al titular y registrar en auditoría cuando exista email + core.auditoria
      const tokenReset = await crearInvitacion(id, "reset");
      try { await db.rpc("srv_cerrar_sesiones", { p_user: id }); } catch (e) { console.error(String(e)); }
      return responder({ ok: true, token: tokenReset });
    }

    // ---------- Administrador: su equipo ----------
    if (accion === "crear_transportista") {
      if (!negocioId || !esDueno) return fallo("Solo el administrador puede agregar transportistas.", 403);
      const n = await negocio(negocioId);
      const n1 = limpio(cuerpo.n1, 40), n2 = limpio(cuerpo.n2, 40), a1 = limpio(cuerpo.a1, 40), a2 = limpio(cuerpo.a2, 40);
      const usuario = elegirUsuario(n1, n2, a1, a2, new Set((n.usuarios || []).map(String)));
      const nombre = [n1, n2, a1, a2].filter(Boolean).join(" ");
      const correo = `${usuario}@${n.slug}.${DOMINIO}`;
      const id = await crearCuenta(correo, claveInterna(), nombre, { usuario });
      const { error } = await db.rpc("srv_alta_transportista", { p_negocio: negocioId, p_user: id, p_nombre: nombre });
      if (error) { await admin.auth.admin.deleteUser(id); throw error; }
      return responder({ ok: true, usuario, nombre, token: await crearInvitacion(id, "alta") });
    }

    if (accion === "cambiar_clave") {
      if (!negocioId || !esDueno) return fallo("Solo el administrador puede cambiar contraseñas del equipo.", 403);
      const objetivo = String(cuerpo.usuario_id || "");
      if (objetivo === yo) return fallo("Para tu propia contraseña usa «Mi contraseña».");
      const { data: rol } = await db.rpc("srv_rol", { p_negocio: negocioId, p_user: objetivo });
      if (!rol) return fallo("Esa persona no es de tu equipo.", 403);
      if (rol === "admin") return fallo("La contraseña de otro administrador solo la restablece el administrador general.", 403);
      // TODO (F-02/plataforma): avisar al titular y registrar en auditoría cuando exista email + core.auditoria
      const tokenReset = await crearInvitacion(objetivo, "reset");
      try { await db.rpc("srv_cerrar_sesiones", { p_user: objetivo }); } catch (e) { console.error(String(e)); }
      return responder({ ok: true, token: tokenReset });
    }

    if (accion === "quitar_transportista") {
      if (!negocioId || !esDueno) return fallo("Solo el administrador puede quitar transportistas.", 403);
      const objetivo = String(cuerpo.usuario_id || "");
      if (objetivo === yo) return fallo("No puedes quitarte a ti mismo.");
      const destino = cuerpo.pasar_a ? String(cuerpo.pasar_a) : yo;
      const { error } = await db.rpc("srv_quitar", { p_negocio: negocioId, p_user: objetivo, p_a: destino });
      if (error) throw error;
      // F-10: ya no se banea la cuenta global (era ~100 años en el proyecto compartido, afectaba a todas las apps Nivo).
      // srv_quitar ya quitó la membresía de ruta; solo cerramos sus sesiones abiertas para que salga de inmediato.
      try { await db.rpc("srv_cerrar_sesiones", { p_user: objetivo }); } catch (e) { console.error(String(e)); }
      return responder({ ok: true });
    }

    return fallo("Acción no reconocida.");
  } catch (e) {
    const msg = e instanceof Error ? e.message : String((e as { message?: string })?.message ?? e);
    console.error(msg);
    return fallo(msg.length < 200 ? msg : "No se pudo completar la acción.", 400);
  }
});
