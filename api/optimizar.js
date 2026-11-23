/* Ruta del día: ordena las visitas por calles reales con OpenRouteService.
   Corre en Vercel. La clave vive en la variable de entorno ORS_API_KEY y nunca llega al navegador.
   Solo responde a usuarios con sesión iniciada en Supabase que además sean miembros de la app 'ruta' (F-05). */
const CONFIG = require('../config.js');

const SERVICIOS = [
  process.env.ORS_URL,
  'https://api.openrouteservice.org/optimization',
  'https://api.heigit.org/openrouteservice/optimization'
].filter(Boolean);

const MAX_PARADAS = 48; // el plan gratis admite 50 puntos por ruta
const ESPERA_MS = 12000;

// F-05: endurecimiento de borde.
// Orígenes permitidos. Para añadir el dominio propio, agrégalo aquí (p. ej. 'https://ruta.midominio.com').
// Decisión: el Origin es OBLIGATORIO. La app siempre lo envía desde el navegador (fetch POST); curl o scripts
// sin Origin quedan rechazados. No es autenticación (un cliente no-navegador puede falsificarlo): solo reduce abuso casual.
const ORIGENES = ['https://ruta.nivo-pe.workers.dev'];
const MAX_CUERPO = 16 * 1024; // bytes
// Cuota por usuario y día en Cloudflare KV (binding CUOTA_ORS, ver wrangler.jsonc).
// Si el binding no existe (p. ej. en Vercel o sin configurar), la cuota NO se aplica (mejor esfuerzo, con advertencia
// en el log); la verificación de pertenencia a 'ruta' es siempre obligatoria.
const CUOTA_DIARIA = 50;
const TTL_CUOTA = 86400;
// Caché en memoria (por instancia del worker) del resultado de pertenencia, por token.
const TTL_PERTENENCIA_MS = 60000;
const MAX_CACHE = 500;
const cachePertenencia = new Map();

function coordenadaValida(p) {
  return p && typeof p.lat === 'number' && typeof p.lng === 'number' &&
    isFinite(p.lat) && isFinite(p.lng) && Math.abs(p.lat) <= 90 && Math.abs(p.lng) <= 180;
}

async function pedir(url, opciones) {
  const control = new AbortController();
  const reloj = setTimeout(() => control.abort(), ESPERA_MS);
  try {
    return await fetch(url, Object.assign({}, opciones, { signal: control.signal }));
  } finally {
    clearTimeout(reloj);
  }
}

// Devuelve el usuario de Supabase ({ id, ... }) o null si el token no vale.
async function sesionValida(token) {
  if (!CONFIG.SUPABASE_URL || !CONFIG.SUPABASE_ANON_KEY) return null;
  try {
    const r = await pedir(CONFIG.SUPABASE_URL.replace(/\/$/, '') + '/auth/v1/user', {
      headers: { apikey: CONFIG.SUPABASE_ANON_KEY, Authorization: 'Bearer ' + token }
    });
    if (!r.ok) return null;
    const u = await r.json();
    return u && typeof u.id === 'string' ? u : null;
  } catch (e) {
    return null;
  }
}

// ¿El usuario es miembro activo de la app 'ruta'? Llama a ruta.soy_de_ruta() (sql/03_optimizar.sql) con SU token.
// En POST de PostgREST el esquema se elige con Content-Profile.
async function esDeRuta(token) {
  const ahora = Date.now();
  const previo = cachePertenencia.get(token);
  if (previo && previo.hasta > ahora) return previo.ok;
  let ok = false;
  try {
    const r = await pedir(CONFIG.SUPABASE_URL.replace(/\/$/, '') + '/rest/v1/rpc/soy_de_ruta', {
      method: 'POST',
      headers: {
        apikey: CONFIG.SUPABASE_ANON_KEY,
        Authorization: 'Bearer ' + token,
        'Content-Type': 'application/json',
        'Content-Profile': CONFIG.ESQUEMA || 'ruta'
      },
      body: '{}'
    });
    ok = r.ok && (await r.json()) === true;
  } catch (e) {
    return false; // ante la duda, sin acceso (y sin cachear el fallo)
  }
  if (cachePertenencia.size >= MAX_CACHE) cachePertenencia.clear();
  cachePertenencia.set(token, { ok, hasta: ahora + TTL_PERTENENCIA_MS });
  return ok;
}

function claveCuota(userId) {
  return 'ors:' + userId + ':' + new Date().toISOString().slice(0, 10);
}

function minutos(x) { return typeof x === 'number' && isFinite(x) && x >= 0 && x <= 2880 ? Math.round(x) : null; }

function leerRespuesta(datos, paradas) {
  const ruta = datos && datos.routes && datos.routes[0];
  if (!ruta || !Array.isArray(ruta.steps)) return null;
  const orden = [];
  const tramos = {};
  let distPrev = 0, durPrev = 0, hayDistancia = true;
  ruta.steps.forEach((paso) => {
    if (paso.type !== 'job') return;
    const idx = (paso.id != null ? paso.id : paso.job) - 1;
    const parada = paradas[idx];
    if (!parada) return;
    orden.push(parada.id);
    const tramo = { km: null, min: null };
    if (typeof paso.distance === 'number') {
      tramo.km = Math.max(0, (paso.distance - distPrev) / 1000);
      distPrev = paso.distance;
    } else {
      hayDistancia = false;
    }
    if (typeof paso.duration === 'number') {
      tramo.min = Math.max(0, (paso.duration - durPrev) / 60);
      durPrev = paso.duration;
    }
    // Hora de llegada (minutos desde la medianoche) cuando se pidieron horarios.
    if (typeof paso.arrival === 'number') tramo.llegada = paso.arrival / 60;
    tramos[parada.id] = tramo;
  });
  if (!orden.length) return null;
  const sinRuta = (datos.unassigned || [])
    .map((u) => paradas[u.id - 1])
    .filter(Boolean)
    .map((p) => p.id);
  return {
    orden,
    tramos,
    km: hayDistancia ? distPrev / 1000 : null,
    min: durPrev ? durPrev / 60 : null,
    sinRuta
  };
}

module.exports = async function optimizar(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'metodo' });
  }

  const clave = process.env.ORS_API_KEY;
  if (!clave) return res.status(503).json({ error: 'sin-clave' });

  // Comprobaciones baratas primero (sin tocar Supabase): Origin y tamaño.
  if (!ORIGENES.includes(String(req.headers.origin || ''))) return res.status(403).json({ error: 'origen' });
  const largo = Number(req.headers['content-length']);
  const crudo = req.body;
  const bytes = typeof crudo === 'string' ? Buffer.byteLength(crudo)
    : crudo && typeof crudo === 'object' ? Buffer.byteLength(JSON.stringify(crudo)) : 0;
  if ((isFinite(largo) && largo > MAX_CUERPO) || bytes > MAX_CUERPO) return res.status(413).json({ error: 'grande' });

  // Sesión -> pertenencia a 'ruta' -> cuota.
  const token = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  const usuario = token ? await sesionValida(token) : null;
  if (!usuario) return res.status(401).json({ error: 'sin-sesion' });
  if (!(await esDeRuta(token))) return res.status(403).json({ error: 'sin-acceso' });

  const kv = req.env && req.env.CUOTA_ORS;
  const claveKV = claveCuota(usuario.id);
  let usadas = 0;
  if (kv) {
    try { usadas = parseInt(await kv.get(claveKV), 10) || 0; } catch (e) { console.warn('optimizar: KV no responde, cuota omitida'); }
    if (usadas >= CUOTA_DIARIA) return res.status(429).json({ error: 'cuota' });
  } else {
    console.warn('optimizar: falta el binding KV CUOTA_ORS; cuota por usuario DESACTIVADA (solo pertenencia)');
  }

  let cuerpo = req.body;
  if (typeof cuerpo === 'string') {
    try { cuerpo = JSON.parse(cuerpo); } catch (e) { cuerpo = null; }
  }
  const origen = cuerpo && cuerpo.origen;
  const paradas = cuerpo && Array.isArray(cuerpo.paradas) ? cuerpo.paradas : null;
  if (!coordenadaValida(origen) || !paradas || paradas.length < 2 || paradas.length > MAX_PARADAS ||
      !paradas.every((p) => coordenadaValida(p) && (typeof p.id === 'string' || typeof p.id === 'number'))) {
    return res.status(400).json({ error: 'datos' });
  }

  // Horarios (opcionales): salida y ventana de atención en minutos desde la medianoche; servicio = minutos de visita.
  const salida = minutos(cuerpo.salida);
  const conHorario = salida != null;
  const pedido = {
    jobs: paradas.map((p, i) => {
      const job = { id: i + 1, location: [p.lng, p.lat] };
      if (conHorario) {
        const serv = minutos(p.servicio);
        if (serv) job.service = serv * 60;
        const v = Array.isArray(p.ventana) ? p.ventana.map(minutos) : null;
        if (v && v[0] != null && v[1] != null && v[1] > v[0]) job.time_windows = [[v[0] * 60, v[1] * 60]];
      }
      return job;
    }),
    // Sin "end": la ruta termina en la última visita.
    vehicles: [Object.assign({ id: 1, profile: 'driving-car', start: [origen.lng, origen.lat] },
      conHorario ? { time_window: [salida * 60, 2 * 24 * 3600] } : {})],
    options: { g: true }
  };

  let ultimoError = 'servicio';
  for (const url of SERVICIOS) {
    try {
      const r = await pedir(url, {
        method: 'POST',
        headers: { Authorization: clave, 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify(pedido)
      });
      if (r.status === 401 || r.status === 403) return res.status(502).json({ error: 'clave-rechazada' });
      if (r.status === 429) return res.status(429).json({ error: 'cuota' });
      if (!r.ok) { ultimoError = 'servicio-' + r.status; continue; }
      const resultado = leerRespuesta(await r.json(), paradas);
      if (resultado) {
        // Cuenta la optimización exitosa (lectura+escritura no atómica: aceptable como tope de abuso, no de facturación).
        if (kv) { try { await kv.put(claveKV, String(usadas + 1), { expirationTtl: TTL_CUOTA }); } catch (e) { console.warn('optimizar: no se pudo contar en KV'); } }
        return res.status(200).json(resultado);
      }
      ultimoError = 'respuesta';
    } catch (e) {
      ultimoError = e && e.name === 'AbortError' ? 'tiempo' : 'red';
    }
  }
  return res.status(502).json({ error: ultimoError });
};

module.exports.leerRespuesta = leerRespuesta;
