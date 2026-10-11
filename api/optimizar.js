/* Ruta del día: ordena las visitas por calles reales con OpenRouteService.
   Corre en Vercel. La clave vive en la variable de entorno ORS_API_KEY y nunca llega al navegador.
   Solo responde a usuarios con sesión iniciada en Supabase. */
const CONFIG = require('../config.js');

const SERVICIOS = [
  process.env.ORS_URL,
  'https://api.openrouteservice.org/optimization',
  'https://api.heigit.org/openrouteservice/optimization'
].filter(Boolean);

const MAX_PARADAS = 48; // el plan gratis admite 50 puntos por ruta
const ESPERA_MS = 12000;

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

async function sesionValida(token) {
  if (!CONFIG.SUPABASE_URL || !CONFIG.SUPABASE_ANON_KEY) return false;
  try {
    const r = await pedir(CONFIG.SUPABASE_URL.replace(/\/$/, '') + '/auth/v1/user', {
      headers: { apikey: CONFIG.SUPABASE_ANON_KEY, Authorization: 'Bearer ' + token }
    });
    return r.ok;
  } catch (e) {
    return false;
  }
}

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

  const token = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  if (!token || !(await sesionValida(token))) return res.status(401).json({ error: 'sin-sesion' });

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

  const pedido = {
    jobs: paradas.map((p, i) => ({ id: i + 1, location: [p.lng, p.lat] })),
    // Sin "end": la ruta termina en la última visita.
    vehicles: [{ id: 1, profile: 'driving-car', start: [origen.lng, origen.lat] }],
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
      if (resultado) return res.status(200).json(resultado);
      ultimoError = 'respuesta';
    } catch (e) {
      ultimoError = e && e.name === 'AbortError' ? 'tiempo' : 'red';
    }
  }
  return res.status(502).json({ error: ultimoError });
};

module.exports.leerRespuesta = leerRespuesta;
