import optimizar from "./api/optimizar.js";

const API = { "/api/optimizar": optimizar };
const DESPUES = [
  [/^\/panel$/, "/app"],
  [/^\/(?!api$|panel$)[a-z0-9]+(?:-[a-z0-9]+)*$/, "/app"],
];
const CABECERAS = [
  [/.*/, {
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "strict-origin-when-cross-origin",
    "Permissions-Policy": "geolocation=(self), camera=(), microphone=()",
    "Strict-Transport-Security": "max-age=63072000; includeSubDomains",
    "Content-Security-Policy": "default-src 'self'; script-src 'self' https://cdn.jsdelivr.net; style-src 'self' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' data: blob:; connect-src 'self' https://*.supabase.co; frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
  }],
  [/\.(css|js)$/, { "Cache-Control": "public, max-age=0, must-revalidate" }],
  [/\.(svg|png|webmanifest)$/, { "Cache-Control": "public, max-age=86400, stale-while-revalidate=604800" }],
];

// Servidor de Nivo en Cloudflare: reproduce las rutas, cabeceras y funciones /api que antes daba Vercel.

export default {
  async fetch(request, env) {
    // Las claves secretas de Cloudflare llegan en env; las funciones de /api las leen en process.env.
    for (const [k, v] of Object.entries(env)) if (typeof v === "string") process.env[k] = v;
    const url = new URL(request.url);
    const ruta = url.pathname;
    let res;
    const funcion = API[ruta];
    if (funcion) {
      res = await comoVercel(funcion, request);
    } else {
      res = await env.ASSETS.fetch(request);
      if (res.status === 404) {
        const destino = buscar(DESPUES, ruta);
        res = destino ? await servir(env, request, destino) : await noEncontrado(env, request);
      }
    }
    return conCabeceras(res, ruta);
  },
};

// Ejecuta una función escrita para Vercel (req, res) y devuelve una respuesta de Cloudflare.
async function comoVercel(funcion, request) {
  const url = new URL(request.url);
  const headers = {};
  for (const [k, v] of request.headers) headers[k.toLowerCase()] = v;
  let body;
  if (request.method !== "GET" && request.method !== "HEAD") {
    const texto = await request.text();
    body = texto;
    if ((headers["content-type"] || "").includes("application/json")) {
      try { body = texto ? JSON.parse(texto) : {}; } catch (e) { body = texto; }
    }
  }
  const req = { method: request.method, headers, body, query: Object.fromEntries(url.searchParams), url: url.pathname + url.search };
  let estado = 200, salida = null;
  const cab = new Headers();
  const res = {
    statusCode: 200,
    status(c) { estado = c; this.statusCode = c; return this; },
    setHeader(k, v) { cab.set(k, Array.isArray(v) ? v.join(", ") : String(v)); return this; },
    getHeader(k) { return cab.get(k); },
    json(o) { if (!cab.has("content-type")) cab.set("content-type", "application/json; charset=utf-8"); salida = JSON.stringify(o); return this; },
    send(b) { if (b !== null && typeof b === "object" && !(b instanceof Uint8Array)) return this.json(b); salida = b; return this; },
    end(b) { if (b !== undefined) salida = b; return this; },
  };
  try {
    await funcion(req, res);
  } catch (e) {
    console.error(e);
    return new Response(JSON.stringify({ error: "servidor" }), { status: 500, headers: { "content-type": "application/json" } });
  }
  return new Response(estado === 204 || estado === 304 ? null : salida, { status: estado, headers: cab });
}

function buscar(reglas, ruta) {
  for (const [patron, destino] of reglas) if (patron.test(ruta)) return destino;
  return null;
}

function servir(env, request, destino) {
  const u = new URL(request.url);
  u.pathname = destino;
  return env.ASSETS.fetch(new Request(u, request));
}

async function noEncontrado(env, request) {
  const r = await servir(env, request, "/404");
  return new Response(r.body, { status: 404, headers: r.headers });
}

function conCabeceras(res, ruta) {
  const r = new Response(res.body, res);
  for (const [patron, cabeceras] of CABECERAS) {
    if (patron.test(ruta)) for (const [k, v] of Object.entries(cabeceras)) r.headers.set(k, v);
  }
  return r;
}
