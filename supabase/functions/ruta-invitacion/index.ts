// Función "ruta-invitacion" · Ruta del día (F-03)
// PÚBLICA: la usa una persona que aún no tiene contraseña, con el enlace de invitación de un solo uso.
// - estado:  ¿el enlace sigue sirviendo? (solo responde sí/no)
// - redimir: la persona elige su propia contraseña; el enlace queda usado.
// El token nunca se guarda: solo su hash SHA-256 (tabla ruta.invitaciones).
import { createClient } from "npm:@supabase/supabase-js@2";

const URL = Deno.env.get("SUPABASE_URL")!;
const SERVICIO = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
// Orígenes permitidos para CORS. Añadir aquí el dominio propio cuando se compre.
const ORIGENES = ["https://ruta.nivo-pe.workers.dev"];
const MAX_CUERPO = 2048;
const INVALIDO = "El enlace no es válido o ya caducó.";

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
const validarClave = (c: unknown) => (String(c ?? "").length >= 8 && String(c).length <= 72 ? null : "La contraseña debe tener al menos 8 caracteres.");
async function sha256Hex(texto: string) {
  const h = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(texto));
  return Array.from(new Uint8Array(h)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

Deno.serve(async (req) => {
  const CORS = cabeceras(req);
  const responder = (cuerpo: unknown, estado = 200) =>
    new Response(JSON.stringify(cuerpo), { status: estado, headers: { ...CORS, "Content-Type": "application/json" } });
  const fallo = (mensaje: string, estado = 400) => responder({ error: mensaje }, estado);

  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return fallo("Método no permitido", 405);

  try {
    const texto = await req.text();
    if (texto.length > MAX_CUERPO) return fallo("Solicitud demasiado grande.", 413);
    let cuerpo: Record<string, unknown> = {};
    try { cuerpo = JSON.parse(texto || "{}") || {}; } catch { return fallo(INVALIDO); }
    const accion = String(cuerpo.accion || "");
    const token = String(cuerpo.token || "");
    // El token son 32 bytes en hexadecimal (64 caracteres)
    if (!/^[0-9a-f]{64}$/.test(token)) return fallo(INVALIDO);

    const admin = createClient(URL, SERVICIO, { auth: { persistSession: false, autoRefreshToken: false } });
    const db = admin.schema("ruta");
    const hash = await sha256Hex(token);

    if (accion === "estado") {
      const { data, error } = await db.from("invitaciones").select("id")
        .eq("token_hash", hash).is("usado_en", null).gt("expira_en", new Date().toISOString()).maybeSingle();
      if (error) throw error;
      return responder({ valido: !!data });
    }

    if (accion === "redimir") {
      const m = validarClave(cuerpo.clave);
      if (m) return fallo(m);
      // Se "reclama" de forma atómica: solo una petición puede marcarla como usada.
      const { data: inv, error } = await db.from("invitaciones").update({ usado_en: new Date().toISOString() })
        .eq("token_hash", hash).is("usado_en", null).gt("expira_en", new Date().toISOString())
        .select("id, usuario_id, tipo").maybeSingle();
      if (error) throw error;
      if (!inv) return fallo(INVALIDO);
      // En una invitación de ALTA (primer ingreso) se registra la aceptación de términos,
      // como hacía antes el primer login. En un reseteo no se re-estampa.
      const cambios: Record<string, unknown> = {
        password: String(cuerpo.clave), app_metadata: { debe_cambiar_clave: false },
      };
      if (inv.tipo === "alta") cambios.user_metadata = { terminos_aceptados_en: new Date().toISOString() };
      const { error: eU } = await admin.auth.admin.updateUserById(inv.usuario_id, cambios);
      if (eU) {
        // No se pudo guardar la clave: el enlace vuelve a quedar disponible.
        await db.from("invitaciones").update({ usado_en: null }).eq("id", inv.id);
        console.error(eU.message);
        return fallo("No se pudo guardar la contraseña. Inténtalo otra vez.");
      }
      // Cierra las sesiones abiertas con la clave anterior (auth.admin.signOut pide el JWT, no el id: se usa una función SQL).
      try { await db.rpc("srv_cerrar_sesiones", { p_user: inv.usuario_id }); } catch (e) { console.error(String(e)); }
      return responder({ ok: true });
    }

    return fallo(INVALIDO);
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e));
    return fallo("No se pudo completar la acción.", 500);
  }
});
