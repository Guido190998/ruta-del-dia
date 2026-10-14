/* Ruta del día: lógica de la app.
   Sin configurar Supabase (config.js vacío) funciona en modo de prueba, guardando en el dispositivo. */
(function () {
  'use strict';

  var CFG = window.RUTA_CONFIG || {};
  var Orden = window.Orden;
  var DEMO = !(CFG.SUPABASE_URL && CFG.SUPABASE_ANON_KEY);
  var CDN_SUPABASE = 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.4/dist/umd/supabase.js';
  var DOMINIO = 'usuarios.ruta-del-dia.app';
  var RESERVADAS = ['panel', 'privacidad', 'terminos', 'cookies', 'aviso-legal', 'api', '404'];
  var SLUG = (function () {
    var s = (location.pathname.replace(/^\/+|\/+$/g, '').split('/')[0] || '').toLowerCase();
    return s && RESERVADAS.indexOf(s) < 0 && /^[a-z0-9]+(-[a-z0-9]+)*$/.test(s) ? s : '';
  })();
  // Panel general (/panel): marca Nivo. Las empresas y sus transportistas conservan su diseño.
  var NIVO_MARCA = '<svg class="nivo-simbolo" viewBox="0 0 106 80" aria-hidden="true"><rect x="0" y="42" width="40" height="38" rx="6" fill="#F4F1EA"/><rect x="34" y="22" width="36" height="58" rx="6" fill="#BFD9D2"/><path d="M34 40 L34 80 L70 80 Z" fill="#081A30"/><rect x="70" y="0" width="36" height="80" rx="8" fill="#4FAF7C"/><path d="M70 29 L70 80 L106 80 Z" fill="#081A30" opacity=".75"/></svg><b>NIVO</b><span class="nivo-chip">Ruta</span>';
  if (!SLUG) {
    document.documentElement.classList.add('nivo');
    var icoNivo = document.querySelector('link[rel="icon"]'); if (icoNivo) icoNivo.href = '/nivo-icono.svg';
    var marcaNivo = document.getElementById('marca'); if (marcaNivo) { marcaNivo.innerHTML = NIVO_MARCA; marcaNivo.setAttribute('aria-label', 'Nivo Ruta · panel general'); }
  }
  var VELOCIDAD_KMH = 25;    // para estimar horas cuando no hay cálculo por calles
  var MAX_PARADAS_MAPS = 10; // Google Maps admite 9 paradas intermedias en un enlace
  var PRECISION_BAJA_M = 60;

  var sb = null;
  var estado = {
    usuario: null,
    clientes: [],
    ruta: rutaVacia(),
    previa: null,      // copia de la ruta antes de ordenar, para "Deshacer"
    pos: null,         // última ubicación conocida del usuario
    ocupado: false,
    propuesta: null,   // punto elegido para un cliente, aún sin guardar
    dia: hoy(),        // día cuya ruta se está viendo (AAAA-MM-DD)
    agenda: null,      // días de visita del cliente abierto en la ficha
    acceso: 'entrar',
    emp: null,         // empresa de esta sesión: negocio_id, nombre, slug, rol, yo, marca
    pub: null,         // datos públicos de la empresa del enlace (para el ingreso)
    superadmin: false,
    todos: null,       // administrador: clientes de toda la empresa
    equipo: null,      // administrador: personas de la empresa
    filtro: '',        // administrador: de quién son los clientes que se ven
    aprob: [],         // pedidos de aprobación del día
    hoyAdmin: null,    // administrador: rutas del día de todo el equipo
    cred: null,        // datos de acceso recién creados, para entregar
    quitar: null,      // administrador: a quién se está quitando
    general: { empresas: null, detalle: null, admins: null, nueva: null }
  };

  /* ---------- utilidades ---------- */

  function $(sel, raiz) { return (raiz || document).querySelector(sel); }
  function $$(sel, raiz) { return Array.prototype.slice.call((raiz || document).querySelectorAll(sel)); }

  function esc(v) {
    return String(v == null ? '' : v).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function zona() { return CFG.ZONA_HORARIA || 'America/Lima'; }

  function hoy() {
    try { return new Intl.DateTimeFormat('en-CA', { timeZone: zona() }).format(new Date()); }
    catch (e) { return new Date().toISOString().slice(0, 10); }
  }

  /* Fechas como texto AAAA-MM-DD, siempre en hora local (sin saltos por zona horaria). */
  function aFecha(dia) { var p = String(dia).split('-'); return new Date(Number(p[0]), Number(p[1]) - 1, Number(p[2]), 12); }
  function aTexto(d) { return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); }
  function sumarDias(dia, n) { var d = aFecha(dia); d.setDate(d.getDate() + n); return aTexto(d); }
  function diaSemana(dia) { return aFecha(dia).getDay(); } // 0 = domingo
  function fechaValida(t) { return /^\d{4}-\d{2}-\d{2}$/.test(String(t)) && !isNaN(aFecha(t).getTime()); }
  function fechaLarga(dia) {
    try {
      var t = new Intl.DateTimeFormat('es-PE', { weekday: 'long', day: 'numeric', month: 'long' }).format(aFecha(dia || hoy()));
      return t.charAt(0).toUpperCase() + t.slice(1);
    } catch (e) { return String(dia || 'Hoy'); }
  }
  function fechaCorta(dia) {
    try { return new Intl.DateTimeFormat('es-PE', { weekday: 'short', day: 'numeric', month: 'short' }).format(aFecha(dia)).replace(/\./g, ''); }
    catch (e) { return String(dia); }
  }

  /* Agenda de un cliente: días fijos de la semana (0 = domingo … 6 = sábado) y fechas puntuales. */
  var DIAS = [[1, 'Lun', 'lunes'], [2, 'Mar', 'martes'], [3, 'Mié', 'miércoles'], [4, 'Jue', 'jueves'], [5, 'Vie', 'viernes'], [6, 'Sáb', 'sábado'], [0, 'Dom', 'domingo']];
  function diasDe(c) { return (c && Array.isArray(c.dias) ? c.dias : []).map(Number); }
  function fechasDe(c) { return (c && Array.isArray(c.fechas) ? c.fechas : []).map(String).filter(function (f) { return fechaValida(f) && f >= hoy(); }).sort(); }
  function tocaVisita(c, dia) { return diasDe(c).indexOf(diaSemana(dia)) >= 0 || (c && Array.isArray(c.fechas) ? c.fechas : []).map(String).indexOf(dia) >= 0; }
  function agendados(dia) { return estado.clientes.filter(function (c) { return tocaVisita(c, dia); }); }
  function textoAgenda(c) {
    var d = diasDe(c), partes = DIAS.filter(function (x) { return d.indexOf(x[0]) >= 0; }).map(function (x) { return x[1]; });
    return partes.concat(fechasDe(c).slice(0, 3).map(fechaCorta)).join(' · ');
  }

  /* Horario de atención: {"1": {"desde": "08:00", "hasta": "12:30"}, ...}; sin horario ese día = todo el día. */
  function aMin(t) { var m = /^(\d{1,2}):(\d{2})$/.exec(String(t || '')); return m ? Number(m[1]) * 60 + Number(m[2]) : null; }
  function aHora(min) { if (min == null || !isFinite(min)) return ''; min = Math.round(min); var h = Math.floor(min / 60) % 24, m = min % 60; return h + ':' + String(m).padStart(2, '0'); }
  function ventana(c, dia) {
    var h = c && c.horario && c.horario[String(diaSemana(dia))];
    var a = h ? aMin(h.desde) : null, b = h ? aMin(h.hasta) : null;
    return a != null && b != null && b > a ? { desde: a, hasta: b } : null;
  }
  function duracion(c) { var d = Number(c && c.duracion_min); return d > 0 ? d : 15; }
  function textoVentana(v) { return v ? 'atiende ' + aHora(v.desde) + '–' + aHora(v.hasta) : 'atiende todo el día'; }
  function ahoraMin() {
    try {
      var p = new Intl.DateTimeFormat('en-GB', { timeZone: zona(), hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date()).split(':');
      return Number(p[0]) * 60 + Number(p[1]);
    } catch (e) { var d = new Date(); return d.getHours() * 60 + d.getMinutes(); }
  }
  /* Hora desde la que se calcula: hoy, desde ahora; otro día, la hora de salida (8:00 si no se eligió). */
  function salidaDe(r) {
    var s = aMin(r.salida);
    if (r.fecha === hoy()) return Math.max(ahoraMin(), s != null ? s : 7 * 60);
    return s != null ? s : 8 * 60;
  }
  function esAdmin() { return !!(estado.emp && estado.emp.rol === 'admin'); }

  /* Recorre la ruta en orden y calcula a qué hora se llega a cada parada (con esperas si se llega antes de que abra). */
  function simular(r, ids) {
    var t = salidaDe(r), previo = estado.pos, horas = {};
    ids.forEach(function (id) {
      var c = clienteDe(id); if (!c) return;
      var tr = r.tramos && r.tramos[id], min = null;
      if (tr && typeof tr.min === 'number') min = tr.min;
      else if (previo && tieneUbicacion(c)) min = Orden.km(previo, c) / VELOCIDAD_KMH * 60;
      if (min != null) t += min;
      var v = ventana(c, r.fecha), llegada = t;
      if (v && t < v.desde) t = v.desde;          // espera a que abra
      horas[id] = { llegada: llegada, inicio: t, ventana: v, tarde: !!(v && llegada > v.hasta) };
      t += duracion(c);
      if (tieneUbicacion(c)) previo = c;
    });
    return horas;
  }

  function km1(n) { return (Math.round(n * 10) / 10).toFixed(1); }
  function plural(n, uno, varios) { return n + ' ' + (n === 1 ? uno : varios); }
  function rutaVacia(dia) { return { fecha: dia || hoy(), orden: [], visitados: [], modo: 'manual', tramos: null, salida: null, fuera: [], saltados: [], guardada: false }; }
  function tieneUbicacion(c) { return c && typeof c.lat === 'number' && typeof c.lng === 'number'; }
  function clienteDe(id) {
    return estado.clientes.filter(function (c) { return c.id === id; })[0] ||
      (estado.todos || []).filter(function (c) { return c.id === id; })[0] || null;
  }
  function nombrePersona(uid) {
    var p = (estado.equipo || []).filter(function (x) { return x.usuario_id === uid; })[0];
    return p ? (p.yo ? 'ti' : p.nombre) : '';
  }
  function copia(o) { return JSON.parse(JSON.stringify(o)); }
  function movimientoReducido() { return window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches; }

  function uid() {
    if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
    return 'c-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
  }

  function leerLocal(clave, defecto) {
    try { var t = localStorage.getItem(clave); return t ? JSON.parse(t) : defecto; }
    catch (e) { return defecto; }
  }
  function guardarLocal(clave, valor) {
    try { localStorage.setItem(clave, JSON.stringify(valor)); } catch (e) { /* sin almacenamiento: sigue en memoria */ }
  }

  /* ---------- datos: modo de prueba (dispositivo) ---------- */

  var EJEMPLOS = [
    { nombre: 'Bodega La Esquina', direccion: 'Av. Belaunde 870, Comas', lat: -11.9440, lng: -77.0625 },
    { nombre: 'Bodega San Martín', direccion: 'Av. Túpac Amaru 1420, Comas', lat: -11.9390, lng: -77.0560 },
    { nombre: 'Minimarket El Sol', direccion: 'Jr. Los Pinos 233, Comas', lat: null, lng: null },
    { nombre: 'Bodega Doña Julia', direccion: 'Jr. Puno 415, Comas', lat: -11.9560, lng: -77.0660 },
    { nombre: 'Agroveterinaria Campo', direccion: 'Av. Universitaria 5560, Los Olivos', lat: -11.9655, lng: -77.0745 }
  ];

  var datosLocal = {
    clientes: function () {
      var lista = leerLocal('ruta.demo.clientes', null);
      if (!lista) {
        lista = EJEMPLOS.map(function (e) {
          return { id: uid(), nombre: e.nombre, direccion: e.direccion, referencia: '', lat: e.lat, lng: e.lng, precision_m: e.lat ? 15 : null, ubicado_en: null };
        });
        guardarLocal('ruta.demo.clientes', lista);
      }
      return Promise.resolve(lista);
    },
    guardarCliente: function (c) {
      var lista = leerLocal('ruta.demo.clientes', []);
      var i = lista.map(function (x) { return x.id; }).indexOf(c.id);
      if (!c.id) { c = Object.assign({}, c, { id: uid() }); lista.push(c); }
      else if (i >= 0) lista[i] = Object.assign({}, lista[i], c);
      guardarLocal('ruta.demo.clientes', lista);
      return Promise.resolve(i >= 0 ? lista[i] : c);
    },
    borrarCliente: function (id) {
      guardarLocal('ruta.demo.clientes', leerLocal('ruta.demo.clientes', []).filter(function (x) { return x.id !== id; }));
      return Promise.resolve();
    },
    ruta: function (fecha) { return Promise.resolve(leerLocal('ruta.demo.ruta.' + fecha, null)); },
    guardarRuta: function (r) { guardarLocal('ruta.demo.ruta.' + r.fecha, r); return Promise.resolve(); }
  };

  /* ---------- datos: Supabase ---------- */

  function revisar(res) { if (res.error) throw res.error; return res.data; }

  var datosNube = {
    clientes: function () {
      return sb.from('clientes').select('*').eq('negocio_id', estado.emp.negocio_id).eq('user_id', estado.usuario.id).order('nombre').then(revisar);
    },
    todos: function () {
      return sb.from('clientes').select('*').eq('negocio_id', estado.emp.negocio_id).order('nombre').then(revisar);
    },
    guardarCliente: function (c) {
      var campos = { nombre: c.nombre, direccion: c.direccion || null, referencia: c.referencia || null };
      ['lat', 'lng', 'precision_m', 'ubicado_en', 'dias', 'fechas', 'horario', 'duracion_min', 'user_id'].forEach(function (k) { if (k in c) campos[k] = c[k]; });
      if (!c.id) campos.negocio_id = estado.emp.negocio_id;
      var q = c.id ? sb.from('clientes').update(campos).eq('id', c.id) : sb.from('clientes').insert(campos);
      return q.select().single().then(revisar);
    },
    borrarCliente: function (id) { return sb.from('clientes').delete().eq('id', id).then(revisar); },
    ruta: function (fecha) {
      return sb.from('rutas').select('fecha,orden,visitados,modo,tramos,salida,fuera,saltados')
        .eq('negocio_id', estado.emp.negocio_id).eq('user_id', estado.usuario.id).eq('fecha', fecha).maybeSingle().then(revisar);
    },
    guardarRuta: function (r) {
      return sb.from('rutas').upsert({
        negocio_id: estado.emp.negocio_id, user_id: estado.usuario.id, fecha: r.fecha, orden: r.orden, visitados: r.visitados,
        modo: r.modo, tramos: r.tramos, salida: r.salida || null, fuera: r.fuera && r.fuera.length ? r.fuera : null,
        saltados: r.saltados || [], actualizado_en: new Date().toISOString()
      }, { onConflict: 'negocio_id,user_id,fecha' }).then(revisar);
    }
  };

  function datos() { return DEMO ? datosLocal : datosNube; }

  function guardarRuta() {
    estado.ruta.guardada = true;
    return datos().guardarRuta(estado.ruta).catch(function () {
      avisar('No se pudo guardar el cambio. Revisa tu conexión.');
    });
  }

  /* ---------- avisos, diálogo ---------- */

  var relojToast = null;
  function avisar(texto, accion) {
    var caja = $('#toast'), boton = $('#toast-accion');
    $('#toast-texto').textContent = texto;
    if (accion) {
      boton.textContent = accion.texto;
      boton.hidden = false;
      boton.onclick = function () { ocultarToast(); accion.hacer(); };
    } else {
      boton.hidden = true;
      boton.onclick = null;
    }
    caja.hidden = false;
    caja.classList.remove('sale');
    clearTimeout(relojToast);
    relojToast = setTimeout(ocultarToast, accion ? 7000 : 4500);
  }
  function ocultarToast() { clearTimeout(relojToast); $('#toast').hidden = true; }

  function confirmar(titulo, texto, textoSi) {
    var d = $('#dialogo');
    $('#dialogo-titulo').textContent = titulo;
    $('#dialogo-texto').textContent = texto;
    $('#dialogo-si').textContent = textoSi || 'Eliminar';
    return new Promise(function (ok) {
      if (!d.showModal) { ok(window.confirm(titulo + '\n' + texto)); return; }
      d.returnValue = 'no';
      d.addEventListener('close', function alCerrar() {
        d.removeEventListener('close', alCerrar);
        ok(d.returnValue === 'si');
      });
      d.showModal();
    });
  }

  /* ---------- ubicación ---------- */

  /* reciente: true exige una lectura nueva del GPS (para guardar el local de un cliente). */
  function ubicar(reciente) {
    return new Promise(function (ok, falla) {
      if (!navigator.geolocation) { falla(new Error('Este navegador no permite obtener la ubicación.')); return; }
      navigator.geolocation.getCurrentPosition(function (p) {
        ok({ lat: p.coords.latitude, lng: p.coords.longitude, precision: Math.round(p.coords.accuracy) });
      }, function (e) {
        falla(new Error(e && e.code === 1
          ? 'No tenemos permiso para ver tu ubicación. Actívalo en los ajustes del navegador.'
          : 'No pudimos obtener tu ubicación. Sal a un lugar abierto e inténtalo otra vez.'));
      }, { enableHighAccuracy: true, timeout: 15000, maximumAge: reciente ? 0 : 5000 });
    });
  }

  /* ---------- enlaces a Google Maps ---------- */

  function puntoMaps(c) {
    return tieneUbicacion(c) ? c.lat + ',' + c.lng : encodeURIComponent(c.direccion || c.nombre);
  }
  function urlComoLlegar(c) {
    return 'https://www.google.com/maps/dir/?api=1&travelmode=driving&destination=' + puntoMaps(c);
  }
  function urlRuta(pendientes) {
    var pts = pendientes.slice(0, MAX_PARADAS_MAPS).map(puntoMaps);
    var url = 'https://www.google.com/maps/dir/?api=1&travelmode=driving&destination=' + pts[pts.length - 1];
    if (pts.length > 1) url += '&waypoints=' + pts.slice(0, -1).join('%7C');
    return url;
  }

  /* ---------- ruta del día ---------- */

  function pendientes() { return estado.ruta.orden.map(clienteDe).filter(Boolean); }

  /* Distancia de cada parada pendiente respecto de la anterior. */
  function tramosDe(pend) {
    var r = estado.ruta, hayVisitas = r.visitados.length > 0;
    var porCalles = r.modo === 'calles' && r.tramos;
    var lista = [], totalKm = 0, totalMin = 0, hayKm = false, primero = true;
    var previo = null;
    if (!porCalles) {
      if (hayVisitas) {
        for (var v = r.visitados.length - 1; v >= 0 && !previo; v--) {
          var cv = clienteDe(r.visitados[v]);
          if (tieneUbicacion(cv)) previo = cv;
        }
      } else if (estado.pos) {
        previo = estado.pos;
      }
    }
    pend.forEach(function (c) {
      var t = { km: null, min: null, desde: '' };
      if (porCalles) {
        var guardado = r.tramos[c.id];
        if (guardado && typeof guardado.km === 'number') {
          t.km = guardado.km; t.min = typeof guardado.min === 'number' ? guardado.min : null;
          t.desde = primero ? (hayVisitas ? 'desde tu última visita' : 'desde donde estás') : 'desde la parada anterior';
        }
      } else if (tieneUbicacion(c)) {
        if (previo) {
          t.km = Orden.km(previo, c);
          t.desde = primero ? (hayVisitas ? 'desde tu última visita' : 'desde donde estás') : 'desde la parada anterior';
        }
        previo = c;
      }
      if (t.km != null) { totalKm += t.km; hayKm = true; }
      if (t.min != null) totalMin += t.min;
      primero = false;
      lista.push(t);
    });
    return { lista: lista, km: hayKm ? totalKm : null, min: porCalles && totalMin ? totalMin : null, porCalles: !!porCalles };
  }

  /* ---------- fuera de horario y aprobaciones ---------- */

  function pedidoDe(id) {
    var r = estado.ruta;
    return estado.aprob.filter(function (a) { return a.cliente_id === id && a.user_id === estado.usuario.id && a.fecha === r.fecha; })[0] ||
      estado.aprob.filter(function (a) { return a.cliente_id === id && a.user_id === estado.usuario.id; })[0] || null;
  }
  /* 'ir' (va igual), 'saltar', 'pendiente' o null si aún no se pidió nada. */
  function decision(id) {
    var a = pedidoDe(id);
    if (!a) return null;
    if (a.estado === 'pendiente') return 'pendiente';
    var aprobado = a.estado === 'aprobado';
    return (a.tipo === 'ir') === aprobado ? 'ir' : 'saltar';
  }
  /* Aplica las respuestas del administrador a la ruta: vuelve a la lista o queda saltado. */
  function aplicarDecisiones() {
    var r = estado.ruta, cambio = false;
    (r.fuera || []).slice().forEach(function (f) {
      var d = decision(f.id);
      if (d !== 'ir' && d !== 'saltar') return;
      r.fuera = r.fuera.filter(function (x) { return x.id !== f.id; });
      if (d === 'ir') { if (r.orden.indexOf(f.id) < 0) r.orden.push(f.id); }
      else if (r.saltados.indexOf(f.id) < 0) r.saltados.push(f.id);
      cambio = true;
    });
    return cambio;
  }
  function cargarAprobaciones() {
    if (DEMO || !estado.emp) return Promise.resolve();
    return sb.rpc('aprobaciones_del_dia', { p_negocio: estado.emp.negocio_id, p_fecha: estado.ruta.fecha }).then(revisar)
      .then(function (l) { estado.aprob = (l || []).map(function (a) { a.fecha = estado.ruta.fecha; return a; }); });
  }
  function pedirAprobacion(id, tipo, boton) {
    var r = estado.ruta, f = (r.fuera || []).filter(function (x) { return x.id === id; })[0];
    if (!f) return;
    if (esAdmin()) {
      // El administrador decide su propia ruta sin pedir permiso.
      r.fuera = r.fuera.filter(function (x) { return x.id !== id; });
      if (tipo === 'ir') r.orden.push(id); else r.saltados.push(id);
      pintarApp(); guardarRuta();
      avisar(tipo === 'ir' ? 'Lo agregaste al final de tu ruta.' : 'Lo saltaste por hoy.');
      return;
    }
    boton.disabled = true;
    sb.rpc('pedir_aprobacion', { p_negocio: estado.emp.negocio_id, p_cliente: id, p_fecha: r.fecha, p_tipo: tipo, p_llegada: f.llegada || null, p_hasta: f.hasta || null })
      .then(revisar).then(function (a) {
        a.fecha = r.fecha;
        estado.aprob = estado.aprob.filter(function (x) { return x.id !== a.id; }).concat([a]);
        pintarRuta();
        avisar('Pedido enviado al administrador. Mientras responde, sigue con el siguiente cliente.');
      }).catch(function (e) { boton.disabled = false; avisar(mensajeError(e)); });
  }
  function mensajeError(e) {
    var m = String((e && e.message) || '');
    if (/fetch|network/i.test(m)) return 'No hay conexión. Revisa tu internet e inténtalo otra vez.';
    return m && m.length < 140 && !/[A-Z_]{8,}|PGRST|violates/.test(m) ? m : 'No se pudo completar. Inténtalo otra vez.';
  }

  function cambioManual() {
    estado.ruta.modo = 'manual';
    estado.ruta.tramos = null;
    estado.previa = null;
  }

  function alternarCliente(id, marcado) {
    var r = estado.ruta;
    r.orden = r.orden.filter(function (x) { return x !== id; });
    r.visitados = r.visitados.filter(function (x) { return x !== id; });
    r.fuera = (r.fuera || []).filter(function (x) { return x.id !== id; });
    r.saltados = (r.saltados || []).filter(function (x) { return x !== id; });
    if (marcado) r.orden.push(id);
    cambioManual();
    pintarApp();
    guardarRuta();
  }

  function mover(id, paso) {
    var o = estado.ruta.orden, i = o.indexOf(id), j = i + paso;
    if (i < 0 || j < 0 || j >= o.length) return;
    var antes = posiciones();
    o[i] = o[j]; o[j] = id;
    cambioManual();
    pintarRuta();
    animar(antes);
    var destino = $('#panel-ruta [data-flip="' + id + '"] [data-accion="' + (paso < 0 ? 'subir' : 'bajar') + '"]:not([disabled])') ||
      $('#panel-ruta [data-flip="' + id + '"] button, #panel-ruta [data-flip="' + id + '"] a');
    if (destino) destino.focus();
    guardarRuta();
  }

  function visitar() {
    var r = estado.ruta;
    if (!r.orden.length) return;
    var antes = copia(r), previaAntes = estado.previa, id = r.orden[0], c = clienteDe(id);
    var pos = posiciones();
    r.orden = r.orden.slice(1);
    r.visitados = r.visitados.concat([id]);
    estado.previa = null;
    pintarApp();
    animar(pos);
    guardarRuta();
    avisar('Visita marcada: ' + (c ? c.nombre : '') + '.', {
      texto: 'Deshacer',
      hacer: function () { estado.ruta = antes; estado.previa = previaAntes; pintarApp(); guardarRuta(); }
    });
  }

  function pedirCalles(pos, conUbicacion) {
    return sb.auth.getSession().then(function (s) {
      var token = s.data && s.data.session && s.data.session.access_token;
      if (!token) throw new Error('sin-sesion');
      return fetch('/api/optimizar', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
        body: JSON.stringify({
          origen: { lat: pos.lat, lng: pos.lng },
          salida: salidaDe(estado.ruta),
          paradas: conUbicacion.map(function (c) {
            var v = ventana(c, estado.ruta.fecha);
            return { id: c.id, lat: c.lat, lng: c.lng, servicio: duracion(c), ventana: v ? [v.desde, v.hasta] : null };
          })
        })
      });
    }).then(function (r) {
      if (!r.ok) throw new Error('servicio-' + r.status);
      return r.json();
    });
  }

  function ordenarRuta() {
    if (estado.ocupado) return;
    if (estado.previa) { deshacerOrden(); return; }

    var pend = pendientes();
    var con = pend.filter(tieneUbicacion), sin = pend.filter(function (c) { return !tieneUbicacion(c); });
    if (con.length < 2) {
      avisar(pend.length < 2
        ? 'Marca al menos 2 clientes para ordenar la ruta.'
        : 'Para ordenar necesitas al menos 2 clientes con ubicación guardada.');
      return;
    }

    estado.ocupado = true;
    pintarRuta();
    var previa = copia(estado.ruta), sinPosicion = '';
    if (!estado.ruta.salida && estado.ruta.fecha !== hoy()) estado.ruta.salida = '08:00';

    ubicar().then(function (p) { estado.pos = p; return p; }, function (e) { sinPosicion = e.message; return null; })
      .then(function (pos) {
        if (DEMO || !pos || con.length > 48) return null;
        return pedirCalles(pos, con).catch(function () { return null; });
      })
      .then(function (calles) {
        var antes = posiciones(), r = estado.ruta, mensaje, fuera = [];
        if (calles && calles.orden && calles.orden.length) {
          fuera = con.map(function (c) { return c.id; }).filter(function (id) { return calles.orden.indexOf(id) < 0; });
          r.orden = calles.orden.concat(sin.map(function (c) { return c.id; }));
          r.modo = 'calles';
          r.tramos = calles.tramos || null;
          mensaje = 'Ruta ordenada por calles' + (typeof calles.km === 'number' ? ': ' + km1(calles.km) + ' km.' : '.');
        } else {
          var idx = Orden.ordenar(estado.pos, con);
          r.orden = idx.map(function (i) { return con[i].id; }).concat(sin.map(function (c) { return c.id; }));
          r.modo = 'recta';
          r.tramos = null;
          mensaje = DEMO ? 'Ruta ordenada en línea recta (modo de prueba).'
            : 'Ruta ordenada en línea recta: no se pudo usar el cálculo por calles.';
        }
        // Quien no alcanza a ser atendido en su horario sale de la ruta y queda para pedir aprobación.
        var horas = simular(r, r.orden);
        r.orden.forEach(function (id) { if (horas[id] && horas[id].tarde && decision(id) !== 'ir') fuera.push(id); });
        if (fuera.length) {
          r.orden = r.orden.filter(function (id) { return fuera.indexOf(id) < 0; });
          var conFuera = simular(r, r.orden.concat(fuera));
          r.fuera = (r.fuera || []).filter(function (f) { return fuera.indexOf(f.id) < 0; }).concat(fuera.map(function (id) {
            var h = conFuera[id] || {}, v = ventana(clienteDe(id), r.fecha);
            return { id: id, llegada: aHora(h.llegada), hasta: v ? aHora(v.hasta) : '' };
          }));
          mensaje += ' ' + (fuera.length === 1 ? '1 cliente queda fuera de horario.' : fuera.length + ' clientes quedan fuera de horario.');
        }
        if (sinPosicion) mensaje += ' ' + sinPosicion;
        estado.previa = previa;
        estado.ocupado = false;
        pintarApp();
        animar(antes);
        guardarRuta();
        avisar(mensaje);
        var boton = $('[data-accion="ordenar"]');
        if (boton) boton.focus();
      });
  }

  function deshacerOrden() {
    var antes = posiciones(), r = estado.previa;
    var vivos = estado.ruta.orden;
    r.orden = r.orden.filter(function (id) { return vivos.indexOf(id) >= 0; });
    r.visitados = estado.ruta.visitados;
    estado.ruta = r;
    estado.previa = null;
    pintarApp();
    animar(antes);
    guardarRuta();
    avisar('Volviste al orden anterior.');
  }

  /* ---------- animación de reordenado ---------- */

  function posiciones() {
    var m = {};
    $$('#panel-ruta [data-flip]').forEach(function (el) { m[el.getAttribute('data-flip')] = el.getBoundingClientRect().top; });
    return m;
  }
  function animar(antes) {
    if (movimientoReducido() || !antes) return;
    $$('#panel-ruta [data-flip]').forEach(function (el) {
      var a = antes[el.getAttribute('data-flip')];
      if (a == null || !el.animate) return;
      var d = a - el.getBoundingClientRect().top;
      if (Math.abs(d) < 2) return;
      el.animate([{ transform: 'translateY(' + d + 'px)' }, { transform: 'none' }], { duration: 220, easing: 'cubic-bezier(0.2, 0.8, 0.2, 1)' });
    });
  }

  /* ---------- pintar: ruta ---------- */

  var ICONO_SUBIR = '<svg aria-hidden="true" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M12 19V5"/><path d="M6 11l6-6 6 6"/></svg>';
  var ICONO_BAJAR = '<svg aria-hidden="true" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M12 5v14"/><path d="M6 13l6 6 6-6"/></svg>';

  function textoTramo(t) {
    if (t.km == null) return '';
    return 'A ' + km1(t.km) + ' km ' + t.desde;
  }
  function textoHorario(c, h) {
    var partes = [];
    if (h && h.llegada != null) partes.push('Llegas ' + aHora(h.llegada) + (h.inicio > h.llegada + 1 ? ' (abre ' + aHora(h.inicio) + ')' : ''));
    partes.push(textoVentana(h ? h.ventana : ventana(c, estado.ruta.fecha)));
    partes.push(duracion(c) + ' min');
    return partes.join(' · ');
  }

  function pintarRuta() {
    var panel = $('#panel-ruta'), r = estado.ruta;
    var pend = pendientes(), total = pend.length + r.visitados.length + (r.fuera || []).length;
    var info = tramosDe(pend);
    var horas = simular(r, pend.map(function (c) { return c.id; }));
    var html = '';

    /* cabecera */
    var esHoy = estado.dia === hoy();
    html += '<div class="hero">';
    html += '<div class="dia-nav">' +
      '<button type="button" class="dia-btn" data-accion="dia-paso" data-paso="-1" aria-label="Día anterior"><svg aria-hidden="true" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M15 5l-7 7 7 7"/></svg></button>' +
      '<input type="date" class="dia-fecha" id="dia-fecha" aria-label="Fecha de la ruta" value="' + esc(estado.dia) + '">' +
      '<button type="button" class="dia-btn" data-accion="dia-paso" data-paso="1" aria-label="Día siguiente"><svg aria-hidden="true" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M9 5l7 7-7 7"/></svg></button>' +
      (esHoy ? '' : '<button type="button" class="dia-hoy" data-accion="dia-hoy">Volver a hoy</button>') + '</div>';
    html += '<p class="rotulo rotulo-hero">' + esc(fechaLarga(estado.dia)) + (esHoy ? ' · hoy' : '') + (pend.length && info.km != null ? ' · por recorrer' : '') + '</p>';
    if (!total) {
      html += '<h2 class="hero-titulo" id="t-ruta">' + (esHoy ? 'Ruta de hoy' : 'Ruta del día') + '</h2><p class="hero-sub">' + (esHoy ? 'Aún no hay visitas para hoy.' : 'No hay visitas agendadas para este día.') + '</p>';
    } else if (!pend.length && (r.fuera || []).length) {
      html += '<h2 class="hero-titulo" id="t-ruta">Esperando respuesta</h2><p class="hero-sub">' + plural(r.fuera.length, 'cliente queda', 'clientes quedan') + ' fuera de horario.</p>';
    } else if (!pend.length) {
      html += '<h2 class="hero-titulo" id="t-ruta">Ruta terminada</h2><p class="hero-sub">Visitaste a ' + (total === 1 ? 'tu cliente' : 'tus ' + total + ' clientes') + ' de este día.</p>';
    } else {
      var modoTexto = info.porCalles
        ? 'por calles' + (info.min ? ', unos ' + Math.max(1, Math.round(info.min)) + ' min manejando' : '')
        : 'en línea recta';
      if (info.km != null) {
        html += '<h2 class="hero-num" id="t-ruta">' + km1(info.km) + ' km<span class="oculto"> por recorrer hoy</span></h2>';
        html += '<p class="hero-sub">' + r.visitados.length + ' de ' + total + ' visitadas · ' + modoTexto + '</p>';
      } else {
        html += '<h2 class="hero-titulo" id="t-ruta">' + plural(pend.length, 'visita', 'visitas') + ' por hacer</h2>';
        html += '<p class="hero-sub">' + r.visitados.length + ' de ' + total + ' visitadas · toca “Ordenar ruta” para ver los kilómetros</p>';
      }
    }
    html += '</div>';

    html += '<div class="ruta-cuerpo">';
    if (!total) {
      html += '<p class="vacio">Marca a quién visitas este día, o agenda a tus clientes en “Días de visita” para que aparezcan solos.</p>' +
        '<a class="btn btn-acento solo-celular" href="#/clientes">Elegir clientes</a>';
    } else if (pend.length) {
      var sig = pend[0], tSig = info.lista[0];
      var estadoOrden = r.modo === 'calles' ? 'Ordenada por calles' : r.modo === 'recta' ? 'Ordenada en línea recta' : 'En el orden que armaste';
      var etiqueta = estado.ocupado ? 'Ordenando…' : estado.previa ? 'Deshacer' : 'Ordenar ruta';

      html += '<div class="fila-titulo">' +
        '<div><h3 class="rotulo">Siguiente parada</h3><p class="estado-orden">' + estadoOrden + '</p></div>' +
        '<button type="button" class="btn btn-fuerte" data-accion="ordenar"' + (estado.ocupado ? ' disabled' : '') + '>' + etiqueta + '</button>' +
        '</div>';

      html += '<article class="siguiente" data-flip="' + esc(sig.id) + '">' +
        '<div class="sig-datos"><div class="sig-num" aria-hidden="true">1</div><div class="sig-texto">' +
        '<h4 class="sig-nombre">' + esc(sig.nombre) + '</h4>' +
        (sig.direccion ? '<p class="sig-dir">' + esc(sig.direccion) + '</p>' : '') +
        (sig.referencia ? '<p class="sig-dir">' + esc(sig.referencia) + '</p>' : '') +
        '<p class="sig-meta">' + esc(textoHorario(sig, horas[sig.id])) + '</p>' +
        (horas[sig.id] && horas[sig.id].tarde ? '<p class="sig-meta alerta">Llegarías después de que cierre.</p>' : '') +
        (tieneUbicacion(sig)
          ? (tSig.km != null ? '<p class="sig-meta">' + textoTramo(tSig) + '</p>' : '')
          : '<a class="enlace enlace-alerta" href="#/cliente/' + esc(sig.id) + '">Sin ubicación · Guardarla</a>') +
        '</div></div>' +
        '<div class="sig-botones">' +
        '<button type="button" class="btn btn-linea" data-accion="visitar">Ya la visité</button>' +
        '<a class="btn btn-acento" href="' + urlComoLlegar(sig) + '" target="_blank" rel="noopener">Cómo llegar</a>' +
        '</div></article>';

      if (pend.length > 1) {
        html += '<div class="fila-titulo"><h3 class="rotulo">Después</h3>' +
          '<a class="enlace" href="' + urlRuta(pend) + '" target="_blank" rel="noopener">' +
          (pend.length > MAX_PARADAS_MAPS ? 'Ver las próximas ' + MAX_PARADAS_MAPS + ' en Google Maps' : 'Ver toda la ruta en Google Maps') + '</a></div>';
        html += '<ol class="paradas" start="2">';
        pend.slice(1).forEach(function (c, i) {
          var t = info.lista[i + 1], ultimo = i === pend.length - 2;
          html += '<li class="parada" data-flip="' + esc(c.id) + '">' +
            '<span class="parada-num" aria-hidden="true">' + (i + 2) + '</span>' +
            '<span class="parada-texto"><span class="parada-nombre">' + esc(c.nombre) + '</span>' +
            '<span class="parada-meta">' + esc(textoHorario(c, horas[c.id])) + (horas[c.id] && horas[c.id].tarde ? ' · <b class="alerta">llegarías tarde</b>' : '') + '</span>' +
            (tieneUbicacion(c)
              ? '<span class="parada-meta">' + (t.km != null ? textoTramo(t) : esc(c.direccion || '')) + '</span>'
              : '<a class="enlace enlace-alerta" href="#/cliente/' + esc(c.id) + '">Sin ubicación · Guardarla</a>') +
            '</span>' +
            '<span class="parada-mover">' +
            '<button type="button" class="btn-icono" data-accion="subir" data-id="' + esc(c.id) + '" aria-label="Subir ' + esc(c.nombre) + '">' + ICONO_SUBIR + '</button>' +
            '<button type="button" class="btn-icono" data-accion="bajar" data-id="' + esc(c.id) + '" aria-label="Bajar ' + esc(c.nombre) + '"' + (ultimo ? ' disabled' : '') + '>' + ICONO_BAJAR + '</button>' +
            '</span></li>';
        });
        html += '</ol>';
      }
    }

    var fuera = (r.fuera || []).filter(function (f) { return clienteDe(f.id); });
    if (fuera.length) {
      html += '<section class="fuera" aria-labelledby="t-fuera"><h3 class="rotulo" id="t-fuera">Fuera de horario</h3><ul class="fuera-lista">';
      fuera.forEach(function (f) {
        var c = clienteDe(f.id), d = decision(f.id);
        html += '<li class="fuera-item"><strong>' + esc(c.nombre) + '</strong>' +
          '<span>' + (f.llegada ? 'Llegarías ' + esc(f.llegada) : 'No alcanzas a llegar') + (f.hasta ? ' y atiende hasta ' + esc(f.hasta) : '') + '.</span>' +
          (d === 'pendiente'
            ? '<span class="fuera-espera">Esperando respuesta del administrador · sigue con el siguiente cliente.</span>'
            : '<span class="fuera-botones"><button type="button" class="btn btn-fuerte" data-accion="pedir-ir" data-id="' + esc(f.id) + '">' + (esAdmin() ? 'Ir igual' : 'Pedir ir igual') + '</button>' +
              '<button type="button" class="btn btn-linea" data-accion="pedir-saltar" data-id="' + esc(f.id) + '">' + (esAdmin() ? 'Saltarlo hoy' : 'Pedir saltarlo') + '</button></span>') +
          '</li>';
      });
      html += '</ul></section>';
    }
    var saltados = (r.saltados || []).map(clienteDe).filter(Boolean);
    if (saltados.length) {
      html += '<p class="visitadas"><strong>' + plural(saltados.length, 'saltado', 'saltados') + ' hoy:</strong> ' + saltados.map(function (c) { return esc(c.nombre); }).join(', ') + '</p>';
    }

    if (r.visitados.length) {
      var nombres = r.visitados.map(clienteDe).filter(Boolean).map(function (c) { return esc(c.nombre); });
      html += '<p class="visitadas"><strong>' + plural(r.visitados.length, 'visitada', 'visitadas') + ' hoy:</strong> ' + nombres.join(', ') + '</p>';
    }
    html += '</div>';
    panel.innerHTML = html;
  }

  /* ---------- pintar: clientes ---------- */

  function pintarClientes() {
    var panel = $('#panel-clientes'), r = estado.ruta;
    var enRuta = r.orden.concat(r.visitados);
    var html = '<div class="clientes-cab"><p class="rotulo">Tus clientes · ' + estado.clientes.length + '</p>' +
      '<h2 class="titulo-panel" id="t-clientes">' + (estado.dia === hoy() ? '¿A quién visitas hoy?' : '¿A quién visitas el ' + esc(fechaCorta(estado.dia)) + '?') + '</h2></div>';

    html += '<div class="clientes-cuerpo">';
    var lista = estado.clientes;
    if (esAdmin() && estado.todos) {
      html += '<div class="campo filtro-cli"><label for="filtro-cli">Clientes de</label><select id="filtro-cli" class="selector">' +
        '<option value="">Mi ruta (' + estado.clientes.length + ')</option>' +
        (estado.equipo || []).filter(function (p) { return !p.yo; }).map(function (p) {
          return '<option value="' + esc(p.usuario_id) + '"' + (estado.filtro === p.usuario_id ? ' selected' : '') + '>' + esc(p.nombre) + ' (' + p.clientes + ')</option>';
        }).join('') + '<option value="*"' + (estado.filtro === '*' ? ' selected' : '') + '>Toda la empresa</option></select></div>';
      if (estado.filtro) lista = estado.todos.filter(function (c) { return estado.filtro === '*' || c.user_id === estado.filtro; });
    }
    if (!lista.length) {
      html += '<p class="vacio">' + (estado.filtro ? 'Esta persona todavía no tiene clientes.' : 'Todavía no tienes clientes. Agrega el primero y guarda su ubicación cuando estés en su local.') + '</p>' +
        '<a class="btn btn-acento" href="#/cliente/nuevo">Agregar cliente</a></div>';
      panel.innerHTML = html;
      return;
    }
    html += '<ul class="lista-clientes">';
    lista.forEach(function (c) {
      var marcado = enRuta.indexOf(c.id) >= 0, mio = c.user_id === estado.usuario.id || !c.user_id;
      if (!mio) {
        html += '<li class="cli"><span class="cli-texto cli-ajeno"><span class="cli-nombre">' + esc(c.nombre) + '</span>' +
          '<span class="cli-dir">De ' + esc(nombrePersona(c.user_id)) + (textoAgenda(c) ? ' · visita: ' + esc(textoAgenda(c)) : '') + '</span></span>' +
          '<a class="cli-editar" href="#/cliente/' + esc(c.id) + '" aria-label="Ver y editar ' + esc(c.nombre) + '">Editar</a></li>';
        return;
      }
      html += '<li class="cli">' +
        '<label class="cli-marca"><input type="checkbox" data-accion="alternar" data-id="' + esc(c.id) + '"' + (marcado ? ' checked' : '') + '>' +
        '<span class="cli-texto"><span class="cli-nombre">' + esc(c.nombre) + '</span>' +
        '<span class="cli-dir">' + (tieneUbicacion(c) ? esc(c.direccion || 'Con ubicación guardada') : '<span class="alerta">Sin ubicación</span>' + (c.direccion ? ' · ' + esc(c.direccion) : '')) + '</span>' +
        (textoAgenda(c) ? '<span class="cli-agenda">Visita: ' + esc(textoAgenda(c)) + '</span>' : '') + '</span></label>' +
        '<a class="cli-editar" href="#/cliente/' + esc(c.id) + '" aria-label="Ver y editar ' + esc(c.nombre) + '">Editar</a>' +
        '</li>';
    });
    html += '</ul>';
    html += '<a class="btn btn-linea" href="#/cliente/nuevo">Agregar cliente</a>';
    if (!DEMO) html += '<button type="button" class="btn-texto solo-celular" data-accion="mi-clave">Cambiar mi contraseña</button>';

    var n = enRuta.length;
    var sinUbic = enRuta.map(clienteDe).filter(function (c) { return c && !tieneUbicacion(c); }).length;
    html += '<div class="clientes-pie solo-celular">' +
      '<p class="resumen" aria-live="polite">' + (n === 0 ? 'Marca al menos un cliente.'
        : sinUbic ? (sinUbic === 1 ? '1 cliente sin ubicación irá al final de la ruta.' : sinUbic + ' clientes sin ubicación irán al final de la ruta.')
        : 'Todos tienen ubicación guardada.') + '</p>' +
      (n ? '<a class="btn btn-acento" href="#/ruta">Ver ruta con ' + plural(n, 'cliente', 'clientes') + '</a>' : '') +
      '</div></div>';
    panel.innerHTML = html;
  }

  function pintarApp() { pintarClientes(); pintarRuta(); }

  /* ---------- pintar: ficha de cliente ---------- */

  function pintarFicha(id) {
    var vista = $('#vista-cliente'), nuevo = id === 'nuevo', c = nuevo ? { nombre: '', direccion: '', referencia: '' } : clienteDe(id);
    if (!c) { location.hash = '#/clientes'; return; }
    var conUbic = tieneUbicacion(c);
    var html = '<a class="volver" href="#/clientes"><svg aria-hidden="true" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M19 12H5"/><path d="M11 6l-6 6 6 6"/></svg>Volver a clientes</a>' +
      '<p class="rotulo">' + (nuevo ? 'Nuevo cliente' : 'Cliente') + '</p>' +
      '<h1 class="ficha-titulo" id="t-ficha" tabindex="-1">' + (nuevo ? 'Agregar cliente' : esc(c.nombre)) + '</h1>';

    var cid = nuevo ? 'nuevo' : String(c.id);
    if (!estado.agenda || estado.agenda.cid !== cid) estado.agenda = { cid: cid, dias: diasDe(c), fechas: fechasDe(c) };
    var seccion = '<section class="ubicacion" id="ubic-caja" aria-labelledby="t-ubic">' + cajaUbic(nuevo ? null : c) + '</section>' +
      '<section class="ubicacion" id="agenda-caja" aria-labelledby="t-agenda">' + cajaAgenda() + '</section>';
    if (!nuevo) html += seccion;

    html += '<form class="formulario" id="form-cliente" data-id="' + esc(nuevo ? '' : c.id) + '" novalidate>' +
      (nuevo ? '' : '<h2 class="rotulo">Datos</h2>') +
      campo('nombre', 'Nombre del negocio', c.nombre, 'text', 'required maxlength="80" autocomplete="off"') +
      campo('direccion', 'Dirección', c.direccion, 'text', 'maxlength="120" autocomplete="off"', 'Con distrito. Sirve para buscar el local en Google Maps.') +
      campo('referencia', 'Referencia', c.referencia, 'text', 'maxlength="120" autocomplete="off"', 'Opcional. Por ejemplo: frente al mercado.') +
      (nuevo ? seccion : '') +
      cajaHorario(c) +
      (esAdmin() ? campoAsignado(c) : '') +
      '<p class="error" id="error-cliente" role="alert" hidden></p>' +
      '<button type="submit" class="btn ' + (nuevo || conUbic ? 'btn-acento' : 'btn-fuerte') + '">' + (nuevo ? 'Guardar cliente' : 'Guardar cambios') + '</button>' +
      '</form>';

    if (!nuevo) html += '<button type="button" class="btn-texto peligro" data-accion="eliminar-cliente" data-id="' + esc(c.id) + '">Eliminar cliente</button>';
    vista.innerHTML = html;
  }

  /* Horario de atención por día de la semana y duración de la visita. Se guardan con "Guardar". */
  function cajaHorario(c) {
    var h = (c && c.horario) || {};
    return '<section class="ubicacion" aria-labelledby="t-horario"><h2 class="rotulo" id="t-horario">Horario de atención</h2>' +
      '<p class="ubic-texto">Puede ser distinto cada día. Déjalo vacío si atiende todo el día.</p>' +
      '<div class="horario">' + DIAS.map(function (d) {
        var x = h[String(d[0])] || {};
        return '<span class="horario-dia" id="hd-' + d[0] + '">' + d[2].charAt(0).toUpperCase() + d[2].slice(1) + '</span>' +
          '<input type="time" name="hd-' + d[0] + '" aria-labelledby="hd-' + d[0] + ' hl-desde" value="' + esc(x.desde || '') + '">' +
          '<input type="time" name="hh-' + d[0] + '" aria-labelledby="hd-' + d[0] + ' hl-hasta" value="' + esc(x.hasta || '') + '">';
      }).join('') + '</div><span class="oculto" id="hl-desde">desde</span><span class="oculto" id="hl-hasta">hasta</span>' +
      '<button type="button" class="btn-texto" data-accion="copiar-horario">Copiar el horario del lunes a los demás días</button>' +
      '<div class="campo"><label for="c-duracion">Duración de la visita (minutos)</label>' +
      '<input id="c-duracion" name="duracion" type="number" inputmode="numeric" min="1" max="480" value="' + esc(duracion(c)) + '" aria-describedby="a-duracion">' +
      '<p class="ayuda" id="a-duracion">La ruta suma este tiempo para calcular a qué hora llegas al siguiente cliente.</p></div></section>';
  }
  function leerHorario(form) {
    var h = {}, error = '';
    DIAS.forEach(function (d) {
      var a = form['hd-' + d[0]].value, b = form['hh-' + d[0]].value;
      if (!a && !b) return;
      if (!a || !b || aMin(b) <= aMin(a)) { error = 'Revisa el horario del ' + d[2] + ': la hora de cierre debe ser después de la de apertura.'; return; }
      h[String(d[0])] = { desde: a, hasta: b };
    });
    return { horario: h, error: error };
  }
  function campoAsignado(c) {
    var dueno = (c && c.user_id) || estado.usuario.id;
    return '<div class="campo"><label for="c-asignado">Cliente de</label><select id="c-asignado" name="asignado" class="selector">' +
      (estado.equipo || []).map(function (p) {
        return '<option value="' + esc(p.usuario_id) + '"' + (p.usuario_id === dueno ? ' selected' : '') + '>' + esc(p.nombre + (p.yo ? ' (tú)' : '')) + '</option>';
      }).join('') + '</select></div>';
  }

  /* Días de visita: días fijos de la semana y fechas puntuales. Con eso el cliente aparece solo en la ruta de esos días. */
  function cajaAgenda() {
    var a = estado.agenda, nuevo = a.cid === 'nuevo';
    var h = '<h2 class="rotulo" id="t-agenda">Días de visita</h2>' +
      '<p class="ubic-texto">Marca los días fijos o agrega fechas puntuales. El cliente aparecerá solo en la ruta de esos días' + (nuevo ? '; se guarda junto con el cliente.' : '.') + '</p>' +
      '<fieldset class="dias"><legend>Cada semana</legend><div class="dias-fila">' +
      DIAS.map(function (d) {
        return '<label class="dia-chip"><input type="checkbox" data-accion="dia-semana" value="' + d[0] + '"' + (a.dias.indexOf(d[0]) >= 0 ? ' checked' : '') + '>' +
          '<span aria-hidden="true">' + d[1] + '</span><span class="oculto">' + d[2] + '</span></label>';
      }).join('') + '</div></fieldset>' +
      '<div class="campo"><label for="c-fecha">Una fecha puntual</label><div class="fecha-fila">' +
      '<input type="date" id="c-fecha" min="' + hoy() + '">' +
      '<button type="button" class="btn btn-linea" data-accion="agregar-fecha">Agregar fecha</button></div></div>';
    if (a.fechas.length) {
      h += '<ul class="fechas">' + a.fechas.map(function (f) {
        return '<li><span>' + esc(fechaLarga(f)) + '</span><button type="button" class="btn-texto" data-accion="quitar-fecha" data-fecha="' + esc(f) + '" aria-label="Quitar ' + esc(fechaLarga(f)) + '">Quitar</button></li>';
      }).join('') + '</ul>';
    }
    return h;
  }

  function repintarAgenda(enfocar) {
    var caja = $('#agenda-caja');
    if (!caja) return;
    caja.innerHTML = cajaAgenda();
    var el = enfocar && $(enfocar, caja); if (el) el.focus();
  }

  /* Aplica un cambio a la agenda del cliente abierto. En un cliente nuevo solo queda anotado hasta guardarlo. */
  function cambiarAgenda(cambio, enfocar) {
    var a = estado.agenda, antes = { dias: a.dias.slice(), fechas: a.fechas.slice() };
    cambio(a);
    a.dias.sort(); a.fechas.sort();
    if (a.cid === 'nuevo') { repintarAgenda(enfocar); return; }
    var c = clienteDe(a.cid);
    if (!c) return;
    var tocaba = tocaVisita(c, estado.dia);
    repintarAgenda(enfocar);
    datos().guardarCliente({ id: c.id, nombre: c.nombre, direccion: c.direccion, referencia: c.referencia, dias: a.dias, fechas: a.fechas })
      .then(recargarClientes).then(function () {
        // Si el cambio afecta al día que se está viendo, la ruta de ese día se actualiza.
        var ahora = tocaVisita(clienteDe(a.cid), estado.dia), r = estado.ruta, id = c.id;
        var enRuta = r.orden.indexOf(id) >= 0 || r.visitados.indexOf(id) >= 0;
        if (!tocaba && ahora && !enRuta) { r.orden.push(id); cambioManual(); if (r.guardada) guardarRuta(); }
        else if (tocaba && !ahora && r.orden.indexOf(id) >= 0) { r.orden = r.orden.filter(function (x) { return x !== id; }); cambioManual(); if (r.guardada) guardarRuta(); }
        avisar('Días de visita guardados.');
      }).catch(function (e) {
        a.dias = antes.dias; a.fechas = antes.fechas;
        repintarAgenda(enfocar);
        var m = String((e && e.message) || '');
        avisar(/dias|fechas|PGRST204|schema cache/i.test(m + ' ' + ((e && e.code) || ''))
          ? 'Falta actualizar la base de datos: corre el archivo supabase-ruta-agenda.sql en Supabase.'
          : 'No se pudieron guardar los días de visita. Revisa tu conexión.');
      });
  }

  function agregarFecha() {
    var campoFecha = $('#c-fecha'), f = campoFecha.value;
    if (!fechaValida(f)) { avisar('Elige una fecha en el calendario.'); campoFecha.focus(); return; }
    if (f < hoy()) { avisar('Esa fecha ya pasó. Elige una de hoy en adelante.'); campoFecha.focus(); return; }
    if (estado.agenda.fechas.indexOf(f) >= 0) { avisar('Esa fecha ya está agendada.'); return; }
    cambiarAgenda(function (a) { a.fechas.push(f); }, '#c-fecha');
  }

  /* Ubicación del local: con el GPS en el local, o con coordenadas copiadas de Google Maps.
     El punto siempre se puede comprobar en Google Maps antes de guardarlo.
     c = null cuando el cliente todavía se está creando. */
  function cajaUbic(c) {
    var nuevo = !c, id = nuevo ? 'nuevo' : c.id, conUbic = tieneUbicacion(c);
    var p = estado.propuesta && estado.propuesta.cid === String(id) ? estado.propuesta : null;
    var h = '<h2 class="rotulo" id="t-ubic">Ubicación del local</h2>';
    if (p) {
      var ver = '<a class="btn btn-linea" href="https://www.google.com/maps/search/?api=1&query=' + p.lat + ',' + p.lng + '" target="_blank" rel="noopener">Ver este punto en Google Maps</a>';
      var datosPunto = '<dl class="ubic-datos"><div><dt>Coordenadas</dt><dd>' + p.lat.toFixed(5) + ', ' + p.lng.toFixed(5) + '</dd></div>' +
        (p.precision ? '<div><dt>Precisión del GPS</dt><dd>' + p.precision + ' m</dd></div>' : '') + '</dl>';
      if (nuevo) {
        return h + '<p class="ubic-texto"><strong>Ubicación lista.</strong> Ábrela en Google Maps y confirma que cae en el local. Se guarda junto con el cliente.</p>' + datosPunto +
          '<div class="ubic-botones">' + ver + '<button type="button" class="btn-texto" data-accion="descartar-punto" data-id="nuevo">Cambiar la ubicación</button></div>';
      }
      return h + '<p class="ubic-texto"><strong>Punto propuesto, aún sin guardar.</strong> Ábrelo en Google Maps y confirma que cae en el local.</p>' + datosPunto +
        '<div class="ubic-botones">' + ver + '</div>' +
        '<div class="ubic-botones"><button type="button" class="btn ' + (conUbic ? 'btn-fuerte' : 'btn-acento') + '" data-accion="guardar-punto" data-id="' + esc(id) + '">Guardar este punto</button>' +
        '<button type="button" class="btn-texto" data-accion="descartar-punto" data-id="' + esc(id) + '">No es correcto</button></div>';
    }
    if (conUbic) {
      h += '<dl class="ubic-datos">' +
        '<div><dt>Coordenadas</dt><dd>' + c.lat.toFixed(5) + ', ' + c.lng.toFixed(5) + '</dd></div>' +
        '<div><dt>Origen</dt><dd>' + (c.precision_m ? 'GPS, con ' + c.precision_m + ' m de precisión' : 'Coordenadas de Google Maps') + '</dd></div>' +
        '</dl>' +
        '<div class="ubic-botones"><a class="btn btn-linea" href="https://www.google.com/maps/search/?api=1&query=' + c.lat + ',' + c.lng + '" target="_blank" rel="noopener">Ver el punto guardado en Google Maps</a>' +
        '<button type="button" class="btn-texto" data-accion="guardar-ubicacion" data-id="' + esc(id) + '">Tomarla de nuevo con el GPS</button></div>';
    } else {
      h += '<p class="ubic-texto">' + (nuevo
          ? 'Déjala confirmada desde ahora para que la ruta ordene a este cliente. Sin ubicación, irá al final de la ruta.'
          : 'Aún sin ubicación: este cliente va al final de la ruta hasta que la guardes.') + '</p>' +
        '<div class="ubic-botones"><button type="button" class="btn btn-fuerte" data-accion="' + (nuevo ? 'ubicar-nuevo' : 'guardar-ubicacion') + '" data-id="' + esc(id) + '">Estoy en el local: ' + (nuevo ? 'usar' : 'guardar') + ' mi ubicación</button></div>';
    }
    return h + '<h3 class="rotulo rotulo-sub">Si no estás en el local</h3>' +
      '<ol class="pasos">' +
      '<li><span>Busca el local en Google Maps.</span>' +
      '<button type="button" class="btn btn-linea" data-accion="ver-dir">Buscar en Google Maps</button></li>' +
      '<li><span>Copia sus coordenadas. En computadora: clic derecho sobre el local y clic en los números. En celular: mantén el dedo sobre el local y copia los números que aparecen.</span></li>' +
      '<li><div class="campo"><label for="c-coords">Pega aquí las coordenadas</label>' +
      '<input id="c-coords" type="text" autocomplete="off" placeholder="-12.0464, -77.0428"></div>' +
      '<button type="button" class="btn btn-linea" data-accion="usar-coords" data-id="' + esc(id) + '">Usar estas coordenadas</button></li></ol>';
  }

  function repintarUbic(id) {
    var caja = $('#ubic-caja');
    if (!caja) return;
    caja.innerHTML = cajaUbic(id === 'nuevo' ? null : clienteDe(id));
  }

  /* Acepta "-12.0464, -77.0428" o un enlace de Google Maps que traiga las coordenadas. */
  function leerCoordenadas(texto) {
    var t = String(texto || '').trim();
    var m = t.match(/!3d(-?\d+(?:\.\d+)?)!4d(-?\d+(?:\.\d+)?)/) || t.match(/(-?\d{1,2}(?:\.\d+)?)\s*,\s*(-?\d{1,3}(?:\.\d+)?)/);
    if (!m) return null;
    var lat = Number(m[1]), lng = Number(m[2]);
    if (!isFinite(lat) || !isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180 || (lat === 0 && lng === 0)) return null;
    return { lat: lat, lng: lng };
  }

  function usarCoordenadas(id) {
    var campoCoords = $('#c-coords'), c = leerCoordenadas(campoCoords.value);
    if (!c) {
      avisar('No reconozco esas coordenadas. Deben verse así: -12.0464, -77.0428');
      campoCoords.setAttribute('aria-invalid', 'true');
      campoCoords.focus();
      return;
    }
    estado.propuesta = { cid: String(id), lat: c.lat, lng: c.lng, precision: null };
    repintarUbic(id);
  }

  function ubicarNuevo(boton) {
    var texto = boton.textContent;
    boton.disabled = true;
    boton.textContent = 'Buscando tu ubicación…';
    ubicar(true).then(function (p) {
      estado.pos = p;
      estado.propuesta = { cid: 'nuevo', lat: p.lat, lng: p.lng, precision: p.precision };
      repintarUbic('nuevo');
      if (p.precision > PRECISION_BAJA_M) avisar('Poca precisión del GPS (' + p.precision + ' m). Comprueba el punto en Google Maps.');
    }).catch(function (e) { boton.disabled = false; boton.textContent = texto; avisar(e.message); });
  }

  function guardarPunto(id, boton) {
    var p = estado.propuesta, c = clienteDe(id);
    if (!p || !c) return;
    boton.disabled = true;
    boton.textContent = 'Guardando…';
    datos().guardarCliente({ id: id, nombre: c.nombre, direccion: c.direccion, referencia: c.referencia,
      lat: p.lat, lng: p.lng, precision_m: p.precision || null, ubicado_en: new Date().toISOString() })
      .then(recargarClientes).then(function () {
        estado.propuesta = null;
        repintarUbic(id);
        avisar('Ubicación guardada.');
      }).catch(function () {
        boton.disabled = false;
        boton.textContent = 'Guardar este punto';
        avisar('No se pudo guardar la ubicación. Revisa tu conexión.');
      });
  }

  function verDireccion() {
    var campoDir = $('#c-direccion'), dir = campoDir ? campoDir.value.trim() : '';
    if (!dir) { avisar('Escribe primero la dirección.'); if (campoDir) campoDir.focus(); return; }
    window.open('https://www.google.com/maps/search/?api=1&query=' + encodeURIComponent(dir), '_blank', 'noopener');
  }

  function campo(nombre, etiqueta, valor, tipo, extras, ayuda) {
    return '<div class="campo"><label for="c-' + nombre + '">' + etiqueta + '</label>' +
      '<input id="c-' + nombre + '" name="' + nombre + '" type="' + tipo + '" value="' + esc(valor || '') + '" ' + (extras || '') +
      (ayuda ? ' aria-describedby="a-' + nombre + '"' : '') + '>' +
      (ayuda ? '<p class="ayuda" id="a-' + nombre + '">' + ayuda + '</p>' : '') + '</div>';
  }

  function guardarFicha(form) {
    var id = form.getAttribute('data-id'), error = $('#error-cliente');
    var nombre = form.nombre.value.trim();
    if (!nombre) {
      error.textContent = 'Escribe el nombre del negocio.';
      error.hidden = false;
      form.nombre.setAttribute('aria-invalid', 'true');
      form.nombre.focus();
      return;
    }
    var hor = leerHorario(form), dur = parseInt(form.duracion.value, 10);
    if (hor.error) { error.textContent = hor.error; error.hidden = false; return; }
    if (!(dur >= 1 && dur <= 480)) { error.textContent = 'La duración de la visita debe estar entre 1 y 480 minutos.'; error.hidden = false; form.duracion.focus(); return; }
    var boton = $('button[type="submit"]', form);
    boton.disabled = true;
    var c = { nombre: nombre, direccion: form.direccion.value.trim(), referencia: form.referencia.value.trim(), horario: hor.horario, duracion_min: dur };
    if (form.asignado) c.user_id = form.asignado.value;
    var p = !id && estado.propuesta && estado.propuesta.cid === 'nuevo' ? estado.propuesta : null;
    if (id) c.id = id;
    if (p) { c.lat = p.lat; c.lng = p.lng; c.precision_m = p.precision || null; c.ubicado_en = new Date().toISOString(); }
    var ag = !id && estado.agenda && estado.agenda.cid === 'nuevo' ? estado.agenda : null;
    if (ag && (ag.dias.length || ag.fechas.length)) { c.dias = ag.dias; c.fechas = ag.fechas; }
    datos().guardarCliente(c).then(function (guardado) {
      if (id && c.user_id && c.user_id !== estado.usuario.id) {
        // Pasó a otra persona: sale de mi ruta.
        var r0 = estado.ruta;
        r0.orden = r0.orden.filter(function (x) { return x !== id; });
        r0.fuera = (r0.fuera || []).filter(function (x) { return x.id !== id; });
      }
      return recargarClientes().then(function () {
        if (!id) {
          estado.agenda = null;
          // Si al cliente nuevo le toca visita el día que se está viendo, entra a esa ruta.
          var creado = clienteDe(guardado.id), r = estado.ruta;
          if (creado && tocaVisita(creado, estado.dia) && r.orden.indexOf(creado.id) < 0) { r.orden.push(creado.id); cambioManual(); if (r.guardada) guardarRuta(); }
        }
        if (id) { avisar('Cambios guardados.'); pintarFicha(id); }
        else if (p) { estado.propuesta = null; avisar('Cliente guardado con su ubicación.'); location.hash = '#/clientes'; }
        else { avisar('Cliente guardado sin ubicación. Irá al final de la ruta hasta que la guardes.'); location.hash = '#/cliente/' + guardado.id; }
      });
    }).catch(function () {
      boton.disabled = false;
      error.textContent = 'No se pudo guardar. Revisa tu conexión e inténtalo otra vez.';
      error.hidden = false;
    });
  }

  function guardarUbicacion(id, boton) {
    var texto = boton.textContent;
    boton.disabled = true;
    boton.textContent = 'Buscando tu ubicación…';
    ubicar(true).then(function (p) {
      estado.pos = p;
      return datos().guardarCliente({ id: id, nombre: clienteDe(id).nombre, direccion: clienteDe(id).direccion, referencia: clienteDe(id).referencia,
        lat: p.lat, lng: p.lng, precision_m: p.precision, ubicado_en: new Date().toISOString() }).then(function () { return p; });
    }).then(function (p) {
      return recargarClientes().then(function () {
        estado.propuesta = null;
        repintarUbic(id);
        avisar(p.precision > PRECISION_BAJA_M
          ? 'Ubicación guardada, pero con poca precisión (' + p.precision + ' m). Si puedes, tómala de nuevo en la puerta del local.'
          : 'Ubicación guardada.');
        var t = $('#t-ubic'); if (t) t.scrollIntoView({ block: 'nearest' });
      });
    }).catch(function (e) {
      boton.disabled = false;
      boton.textContent = texto;
      avisar(e && e.message && e.message.indexOf('ubicación') >= 0 ? e.message : 'No se pudo guardar la ubicación. Revisa tu conexión.');
    });
  }

  function eliminarCliente(id) {
    var c = clienteDe(id);
    if (!c) return;
    confirmar('¿Eliminar a ' + c.nombre + '?', 'Se borra de tu lista y de la ruta de hoy. No se puede deshacer.', 'Eliminar').then(function (si) {
      if (!si) return;
      datos().borrarCliente(id).then(function () {
        estado.ruta.orden = estado.ruta.orden.filter(function (x) { return x !== id; });
        estado.ruta.visitados = estado.ruta.visitados.filter(function (x) { return x !== id; });
        return recargarClientes();
      }).then(function () {
        guardarRuta();
        avisar('Cliente eliminado.');
        location.hash = '#/clientes';
      }).catch(function () { avisar('No se pudo eliminar. Revisa tu conexión.'); });
    });
  }

  /* ---------- cuentas (función segura del servidor) ---------- */

  function cuentas(accion, datosPedido) {
    return sb.functions.invoke('ruta-cuentas', { body: Object.assign({ accion: accion }, datosPedido || {}) }).then(function (r) {
      if (r.error) {
        var ctx = r.error.context;
        return (ctx && ctx.json ? ctx.json().catch(function () { return {}; }) : Promise.resolve({})).then(function (j) {
          throw new Error(j && j.error ? j.error : /fetch/i.test(r.error.message || '') ? 'No hay conexión. Revisa tu internet e inténtalo otra vez.' : 'No se pudo completar. Inténtalo otra vez.');
        });
      }
      if (r.data && r.data.error) throw new Error(r.data.error);
      return r.data;
    });
  }
  /* Cierra la sesión sin esperar a Supabase y vuelve a la pantalla de ingreso con un aviso. */
  function volverAlIngreso(msg) {
    try { if (msg) sessionStorage.setItem('ruta.aviso-ingreso', msg); } catch (e) {}
    try { Object.keys(localStorage).forEach(function (k) { if (/^sb-.*-auth-token/.test(k)) localStorage.removeItem(k); }); } catch (e) {}
    location.replace(location.pathname);
  }
  var LETRAS_CLAVE = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';
  function claveTemporal() {
    var buf = new Uint32Array(8), t = ''; crypto.getRandomValues(buf);
    for (var i = 0; i < 8; i++) { t += LETRAS_CLAVE[buf[i] % LETRAS_CLAVE.length]; if (i === 3) t += '-'; }
    return t;
  }
  function sinTildes(t) { return String(t || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, ''); }
  function soloLetras(t) { return sinTildes(t).replace(/[^a-z]/g, ''); }
  function inicial(t) { return soloLetras(String(t || '').trim().split(/\s+/)[0]).charAt(0); }
  function slugDe(t) { return sinTildes(t).replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40).replace(/-+$/g, ''); }
  function usuarioPrevio(n1, n2, a1, a2) {
    var ap = soloLetras(a1);
    return !inicial(n1) || ap.length < 2 ? '' : (inicial(n1) + inicial(n2) + ap + inicial(a2)).slice(0, 30);
  }
  function esCuentaUsuario(correo) { return /\.usuarios\.ruta-del-dia\.app$/.test(String(correo || '')); }
  function usuarioVisible(correo) { return esCuentaUsuario(correo) ? String(correo).split('@')[0] : String(correo || ''); }
  function enlaceDe(slug) { return location.origin + '/' + slug; }
  function hex(c) { return /^#[0-9A-Fa-f]{6}$/.test(String(c || '')) ? c : null; }
  function luz(h) {
    var n = parseInt(h.slice(1), 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255].map(function (v) { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); })
      .reduce(function (a, v, i) { return a + v * [0.2126, 0.7152, 0.0722][i]; }, 0);
  }
  function contraste(a, b) { var x = luz(a), y = luz(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); }
  function aplicarMarca(m) {
    if (!m) return;
    var raiz = document.documentElement.style, t = hex(m.tinta), a = hex(m.acento);
    if (t) raiz.setProperty('--tinta', t);
    if (a) raiz.setProperty('--acento', a);
    var tema = $('meta[name="theme-color"]'); if (tema && t) tema.setAttribute('content', t);
    var marca = $('#marca');
    if (marca && m.nombre) marca.innerHTML = logoDe(m, 'logo-chico') + '<span>' + esc(m.nombre) + '</span>';
  }
  function logoDe(m, clase) {
    if (!m) return '';
    if (m.logo) return '<img class="logo ' + (clase || '') + '" src="' + esc(m.logo) + '" alt="">';
    var ini = String(m.nombre || '').split(/\s+/).filter(Boolean).slice(0, 2).map(function (p) { return p.charAt(0); }).join('').toUpperCase();
    return '<span class="logo logo-letras ' + (clase || '') + '" aria-hidden="true">' + esc(ini || '•') + '</span>';
  }
  /* Tarjeta con datos de acceso para entregar. La contraseña es temporal y no se vuelve a mostrar. */
  function credencial(titulo, filas, aviso) {
    var texto = filas.map(function (f) { return f[0] + ': ' + f[1]; }).join('\n') + (aviso ? '' : '\n(Al entrar te pedirá crear tu propia contraseña)');
    return '<div class="cred" role="status"><p class="rotulo">' + esc(titulo) + '</p><dl>' +
      filas.map(function (f) { return '<div><dt>' + esc(f[0]) + '</dt><dd>' + esc(f[1]) + '</dd></div>'; }).join('') + '</dl>' +
      '<div class="ubic-botones"><button type="button" class="btn btn-acento" data-accion="copiar" data-texto="' + esc(texto) + '">Copiar todo</button>' +
      '<a class="btn btn-linea" href="https://wa.me/?text=' + encodeURIComponent(texto) + '" target="_blank" rel="noopener">Enviar por WhatsApp</a></div>' +
      '<p class="ayuda">' + esc(aviso || 'La contraseña es temporal: al entrar deberá crear la suya. No se vuelve a mostrar.') + '</p></div>';
  }
  /* Reduce el logo para guardarlo dentro de la base (máximo 320 × 160). */
  function prepararLogo(file) {
    return new Promise(function (ok, mal) {
      if (!/^image\/(png|jpeg|webp)$/.test(file.type)) return mal(new Error('El logo debe ser PNG, JPG o WEBP.'));
      var lector = new FileReader();
      lector.onload = function () {
        var img = new Image();
        img.onload = function () {
          var k = Math.min(1, 320 / img.width, 160 / img.height), c = document.createElement('canvas');
          c.width = Math.max(1, Math.round(img.width * k)); c.height = Math.max(1, Math.round(img.height * k));
          c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
          var d = c.toDataURL('image/png'); if (d.length > 280000) d = c.toDataURL('image/webp', 0.85);
          if (d.length > 290000) return mal(new Error('El logo es muy pesado. Prueba con una imagen más pequeña.'));
          ok(d);
        };
        img.onerror = function () { mal(new Error('No se pudo leer la imagen.')); };
        img.src = lector.result;
      };
      lector.onerror = function () { mal(new Error('No se pudo leer la imagen.')); };
      lector.readAsDataURL(file);
    });
  }

  /* ---------- acceso ---------- */

  function pintarAcceso(modo, correo) {
    estado.acceso = modo;
    var vista = $('#vista-acceso'), pub = estado.pub;
    var intro = '<div class="acceso-texto">' + (pub ? logoDe(pub, 'logo-grande') : '') +
      '<p class="rotulo">' + (pub ? esc(pub.nombre) + ' · Ruta del día' : SLUG ? 'Ruta del día' : 'Nivo Ruta · panel general') + '</p>' +
      '<h1>' + (pub ? 'Tu ruta, en orden y a tiempo' : 'Las rutas de tu equipo, en orden y a tiempo') + '</h1>' +
      '<p>La app arma el recorrido por calles desde donde estás, respetando el horario de cada cliente.</p></div>';
    var form;
    if (modo === 'enviado-clave') {
      form = '<div class="tarjeta" role="status"><h2 tabindex="-1" id="t-acceso">Revisa tu correo</h2>' +
        '<p>Si <strong>' + esc(correo) + '</strong> tiene una cuenta, te llegará un enlace para crear una contraseña nueva.</p>' +
        '<button type="button" class="btn btn-fuerte" data-accion="modo-acceso" data-modo="entrar">Volver a entrar</button></div>';
    } else {
      var rec = modo === 'recuperar', conUsuario = !!SLUG && !rec;
      form = '<form class="tarjeta formulario" id="form-acceso" data-modo="' + modo + '" novalidate>' +
        '<h2 tabindex="-1" id="t-acceso">' + (rec ? 'Recuperar contraseña' : 'Entrar') + '</h2>' +
        (rec ? '<p class="ubic-texto">Escribe el correo del administrador y te enviaremos un enlace para crear una contraseña nueva.</p>' : '') +
        campo('correo', conUsuario ? 'Usuario o correo' : 'Correo', correo || '', conUsuario ? 'text' : 'email',
          'required autocomplete="username" autocapitalize="none" spellcheck="false" maxlength="120" inputmode="' + (conUsuario ? 'text' : 'email') + '"') +
        (rec ? '' : campo('clave', 'Contraseña', '', 'password', 'required autocomplete="current-password"')) +
        '<p class="error" id="error-acceso" role="alert" hidden></p>' +
        '<button type="submit" class="btn btn-acento">' + (rec ? 'Enviarme el enlace' : 'Entrar') + '</button>' +
        '<div class="acceso-enlaces">' + (rec ? '<button type="button" class="btn-texto" data-accion="modo-acceso" data-modo="entrar">Volver a entrar</button>'
          : '<button type="button" class="btn-texto" data-accion="modo-acceso" data-modo="recuperar">¿Olvidaste tu contraseña?</button>') + '</div>' +
        '<div class="nota-ingreso"><span><b>Administrador:</b> escribe tu correo y toca «¿Olvidaste tu contraseña?»; te llega un enlace.</span>' +
        (SLUG ? '<span><b>Transporte:</b> pide al administrador una contraseña nueva.</span>' : '<span><b>Transporte:</b> entra desde el enlace de tu empresa.</span>') + '</div>' +
        '</form>';
    }
    vista.innerHTML = '<div class="acceso-in">' + intro + form + '</div>';
    mostrar('acceso');
  }

  function errorAcceso(e) {
    var m = (e && e.message) || '';
    if (/Invalid login credentials/i.test(m)) return SLUG ? 'Usuario o contraseña incorrectos.' : 'Correo o contraseña incorrectos.';
    if (/banned/i.test(m)) return 'Esta cuenta ya no tiene acceso. Habla con el administrador.';
    if (/Email not confirmed/i.test(m)) return 'Aún no confirmas tu correo. Revisa tu bandeja y abre el enlace.';
    if (/rate limit|too many|seconds/i.test(m)) return 'Demasiados intentos. Espera un minuto y vuelve a probar.';
    if (/failed to fetch|network/i.test(m)) return 'No se pudo conectar. Revisa tu conexión e inténtalo otra vez.';
    return 'No se pudo completar. Revisa tu conexión e inténtalo otra vez.';
  }

  function enviarAcceso(form) {
    var modo = form.getAttribute('data-modo'), error = $('#error-acceso'), boton = $('button[type="submit"]', form);
    var dato = form.correo.value.trim().toLowerCase(), clave = form.clave ? form.clave.value : '';
    function fallar(texto, campoMalo) {
      error.textContent = texto; error.hidden = false;
      if (campoMalo) { campoMalo.setAttribute('aria-invalid', 'true'); campoMalo.focus(); }
    }
    error.hidden = true;
    $$('[aria-invalid]', form).forEach(function (el) { el.removeAttribute('aria-invalid'); });
    var correo = dato.indexOf('@') >= 0 ? dato : (SLUG && modo === 'entrar' && dato ? dato + '@' + SLUG + '.' + DOMINIO : '');
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(correo)) return fallar(SLUG && modo === 'entrar' ? 'Escribe tu usuario o tu correo.' : 'Escribe un correo válido.', form.correo);
    if (modo === 'recuperar' && esCuentaUsuario(correo)) return fallar('El equipo de transporte no recupera por correo: pide una contraseña nueva al administrador.');
    if (form.clave && !clave) return fallar('Escribe tu contraseña.', form.clave);

    boton.disabled = true;
    var pedido = modo === 'entrar' ? sb.auth.signInWithPassword({ email: correo, password: clave })
      : sb.auth.resetPasswordForEmail(correo, { redirectTo: location.origin + location.pathname });
    pedido.then(function (res) {
      if (res.error) throw res.error;
      if (modo === 'recuperar') pintarAcceso('enviado-clave', correo);
      /* entrar: lo maneja onAuthStateChange */
    }).catch(function (e) {
      boton.disabled = false;
      fallar(errorAcceso(e));
    });
  }

  /* ---------- contraseña: primer ingreso, recuperación o cambio voluntario ---------- */

  function debeCambiar(u) { return !!(u && u.app_metadata && u.app_metadata.debe_cambiar_clave); }
  function pintarClave(motivo) {
    var u = estado.usuario || {}, meta = u.user_metadata || {}, nombre = String(meta.nombre || '').split(/\s+/)[0];
    var obligatoria = motivo !== 'voluntaria', terminos = obligatoria && !esCuentaUsuario(u.email) && !meta.terminos_aceptados_en;
    estado.cambioClave = motivo;
    $('#vista-pagina').innerHTML = '<div class="ficha">' +
      '<p class="rotulo">' + (motivo === 'recuperacion' ? 'Recuperación de contraseña' : obligatoria ? 'Primer ingreso' : 'Tu cuenta') + '</p>' +
      '<h1 class="ficha-titulo" id="t-pagina" tabindex="-1">Crea tu nueva contraseña</h1>' +
      '<p class="ubic-texto">' + (nombre ? 'Hola, ' + esc(nombre) + '. ' : '') + (motivo === 'recuperacion' ? 'Elige una contraseña nueva para entrar.'
        : obligatoria ? 'La contraseña que te entregaron era temporal. Antes de continuar debes cambiarla; nadie más conocerá la nueva.'
        : 'Elige tu nueva contraseña. Después volverás a entrar con ella.') + '</p>' +
      '<form class="formulario" id="form-clave" novalidate>' +
      campo('k1', 'Nueva contraseña', '', 'password', 'required minlength="8" maxlength="72" autocomplete="new-password"', 'Mínimo 8 caracteres.') +
      campo('k2', 'Repite la nueva contraseña', '', 'password', 'required maxlength="72" autocomplete="new-password"') +
      (terminos ? '<label class="acepto"><input type="checkbox" name="acepto"><span>Soy mayor de 18 años y acepto los <a href="/terminos" target="_blank" rel="noopener">Términos</a> y la <a href="/privacidad" target="_blank" rel="noopener">Política de privacidad</a>.</span></label>' : '') +
      '<p class="error" id="error-clave" role="alert" hidden></p>' +
      '<button type="submit" class="btn btn-acento">Guardar</button></form>' +
      '<button type="button" class="btn-texto" data-accion="' + (obligatoria ? 'salir' : 'clave-volver') + '">' + (obligatoria ? 'Salir' : 'Volver') + '</button></div>';
    mostrar('pagina');
    var t = $('#t-pagina'); if (t) t.focus();
  }
  function guardarClave(form) {
    var a = form.k1.value, b = form.k2.value, error = $('#error-clave'), boton = $('button[type="submit"]', form);
    var fallar = function (m) { error.textContent = m; error.hidden = false; };
    if (a.length < 8) return fallar('Usa al menos 8 caracteres.');
    if (a !== b) return fallar('Las dos contraseñas no coinciden.');
    if (form.acepto && !form.acepto.checked) return fallar('Para continuar debes aceptar los Términos y la Política de privacidad.');
    error.hidden = true; boton.disabled = true; boton.textContent = 'Guardando…';
    // Los términos se guardan antes: al cambiar la contraseña, Supabase cierra esta sesión.
    (form.acepto ? sb.auth.updateUser({ data: { terminos_aceptados_en: new Date().toISOString() } }).then(function (r) { if (r.error) throw r.error; }) : Promise.resolve())
      .then(function () { return cuentas('cambiar_mi_clave', { clave: a }); })
      .then(function () { volverAlIngreso('Contraseña guardada. Entra con tu nueva contraseña.'); })
      .catch(function (e) {
        if (/sesi[oó]n venci|session/i.test(e.message || '')) return volverAlIngreso('Tu sesión terminó. Si ya guardaste tu contraseña nueva, entra con ella.');
        boton.disabled = false; boton.textContent = 'Guardar'; fallar(e.message || 'No se pudo guardar.');
      });
  }

  /* ---------- administrador: hoy ---------- */

  function cargarHoyAdmin() {
    var neg = estado.emp.negocio_id, dia = hoy();
    return Promise.all([
      sb.rpc('mi_equipo', { p_negocio: neg }).then(revisar),
      sb.from('rutas').select('user_id,orden,visitados,tramos,fuera,saltados,modo').eq('negocio_id', neg).eq('fecha', dia).then(revisar),
      sb.rpc('aprobaciones_del_dia', { p_negocio: neg, p_fecha: dia }).then(revisar)
    ]).then(function (r) {
      estado.equipo = r[0] || [];
      estado.hoyAdmin = { rutas: r[1] || [], pedidos: r[2] || [] };
      if (vistaActual() === 'hoy') pintarHoyAdmin();
    });
  }
  function kmDeRuta(r) {
    var t = 0, hay = false;
    (r.visitados || []).concat(r.orden || []).forEach(function (id) { var x = r.tramos && r.tramos[id]; if (x && typeof x.km === 'number') { t += x.km; hay = true; } });
    return hay ? t : null;
  }
  function pintarHoyAdmin() {
    var d = estado.hoyAdmin, html = '<div class="pagina-in"><p class="rotulo">' + esc(fechaLarga(hoy())) + '</p>' +
      '<h1 class="ficha-titulo" id="t-pagina" tabindex="-1">Rutas de hoy</h1>';
    if (!d) { $('#vista-pagina').innerHTML = html + '<p class="vacio">Cargando…</p></div>'; return; }
    var pend = d.pedidos.filter(function (p) { return p.estado === 'pendiente'; });
    html += '<div class="columnas"><section class="col-ancha"><div class="tarjetas">';
    var gente = (estado.equipo || []).filter(function (p) { return p.rol === 'transporte' || d.rutas.some(function (r) { return r.user_id === p.usuario_id; }); });
    if (!gente.length) html += '<p class="vacio">Aún no hay transportistas. Agrégalos en Equipo.</p>';
    gente.forEach(function (p) {
      var r = d.rutas.filter(function (x) { return x.user_id === p.usuario_id; })[0];
      var vis = r ? (r.visitados || []).length : 0, total = r ? vis + (r.orden || []).length : 0, km = r ? kmDeRuta(r) : null;
      var pide = pend.filter(function (x) { return x.user_id === p.usuario_id; }).length;
      html += '<article class="tarjeta tarjeta-persona"><div class="fila-titulo"><strong>' + esc(p.nombre + (p.yo ? ' (tú)' : '')) + '</strong><span class="ayuda">' + esc(p.usuario) + '</span></div>' +
        (r ? '<p class="cifra-persona"><b>' + vis + '/' + total + '</b> visitados' + (km != null ? ' · ' + km1(km) + ' km' : '') + '</p>' +
          '<div class="barrita"><i data-ancho="' + (total ? Math.round(vis / total * 100) : 0) + '"></i></div>' +
          (pide ? '<p class="alerta">' + plural(pide, 'pedido', 'pedidos') + ' esperando tu respuesta</p>' :
            total && vis === total ? '<p class="ok">Ruta terminada</p>' : '')
          : '<p class="ayuda">Todavía no arma su ruta de hoy.</p>') + '</article>';
    });
    html += '</div></section><aside class="col-lateral tarjeta"><h2>Pedidos pendientes</h2>';
    if (!pend.length) html += '<p class="ayuda">No hay pedidos por responder.</p>';
    pend.forEach(function (x) {
      html += '<div class="pedido"><strong>' + esc(x.cliente) + ' · ' + (x.tipo === 'ir' ? 'ir igual' : 'saltar') + '</strong>' +
        '<span class="ayuda">' + esc(x.transportista) + (x.tipo === 'ir' ? ' llegaría ' : ' pide saltarlo: llegaría ') + esc(x.llegada || '?') + (x.hasta ? '; atiende hasta ' + esc(x.hasta) : '') + '.</span>' +
        '<span class="ubic-botones"><button type="button" class="btn btn-fuerte" data-accion="responder" data-id="' + esc(x.id) + '" data-si="1">Aprobar</button>' +
        '<button type="button" class="btn btn-linea" data-accion="responder" data-id="' + esc(x.id) + '" data-si="0">Rechazar</button></span></div>';
    });
    var resueltos = d.pedidos.filter(function (p) { return p.estado !== 'pendiente'; });
    if (resueltos.length) html += '<p class="ayuda">' + plural(resueltos.length, 'pedido respondido', 'pedidos respondidos') + ' hoy.</p>';
    html += '<p class="ayuda">Al responder, la ruta del transportista se actualiza sola.</p></aside></div></div>';
    $('#vista-pagina').innerHTML = html;
    medidas();
  }
  function medidas() { $$('[data-ancho]').forEach(function (el) { el.style.width = el.getAttribute('data-ancho') + '%'; }); $$('[data-fondo]').forEach(function (el) { el.style.backgroundColor = el.getAttribute('data-fondo'); }); $$('[data-color]').forEach(function (el) { el.style.color = el.getAttribute('data-color'); }); }

  /* ---------- administrador: equipo ---------- */

  function pintarEquipo() {
    var html = '<div class="pagina-in"><h1 class="ficha-titulo" id="t-pagina" tabindex="-1">Equipo</h1><div class="columnas"><section class="col-ancha">';
    if (!estado.equipo) { $('#vista-pagina').innerHTML = html + '<p class="vacio">Cargando…</p></section></div></div>'; return; }
    html += '<ul class="lista-clientes">' + estado.equipo.map(function (p) {
      var q = estado.quitar === p.usuario_id;
      var otros = estado.equipo.filter(function (x) { return x.usuario_id !== p.usuario_id; });
      return '<li class="cli persona"><span class="cli-texto"><span class="cli-nombre">' + esc(p.nombre + (p.yo ? ' (tú)' : '')) + '</span>' +
        '<span class="cli-dir">' + (p.rol === 'admin' ? 'Administrador' : 'Transporte') + ' · ' + esc(p.usuario) + ' · ' + plural(p.clientes, 'cliente', 'clientes') + '</span>' +
        (p.pendiente ? '<span class="etiqueta-alerta">Aún no cambia su clave</span>' : '') + '</span>' +
        (p.rol !== 'transporte' ? '' : q
          ? '<span class="quitar-caja"><label class="ayuda" for="pasar-' + esc(p.usuario_id) + '">Sus clientes pasan a</label><select class="selector" id="pasar-' + esc(p.usuario_id) + '">' +
              otros.map(function (x) { return '<option value="' + esc(x.usuario_id) + '">' + esc(x.nombre + (x.yo ? ' (tú)' : '')) + '</option>'; }).join('') + '</select>' +
              '<span class="ubic-botones"><button type="button" class="btn btn-peligro" data-accion="quitar-si" data-id="' + esc(p.usuario_id) + '">Quitar acceso</button><button type="button" class="btn-texto" data-accion="quitar-no">Cancelar</button></span></span>'
          : '<span class="ubic-botones"><button type="button" class="btn btn-linea" data-accion="nueva-clave" data-id="' + esc(p.usuario_id) + '" data-usuario="' + esc(p.usuario) + '">Nueva clave</button>' +
              '<button type="button" class="btn-texto peligro" data-accion="quitar" data-id="' + esc(p.usuario_id) + '">Quitar</button></span>') + '</li>';
    }).join('') + '</ul>' + (estado.cred && estado.cred.vista === 'equipo' ? estado.cred.html : '') +
      '<p class="ayuda">El equipo entra en <strong>' + esc(enlaceDe(estado.emp.slug).replace(/^https?:\/\//, '')) + '</strong> con su usuario.</p></section>' +
      '<aside class="col-lateral"><form class="tarjeta formulario" id="form-persona" novalidate><h2>Agregar transportista</h2>' +
      '<div class="dos">' + campo('n1', 'Primer nombre', '', 'text', 'maxlength="40" autocomplete="off" data-previo="1"') + campo('n2', 'Segundo nombre (opcional)', '', 'text', 'maxlength="40" autocomplete="off" data-previo="1"') +
      campo('a1', 'Primer apellido', '', 'text', 'maxlength="40" autocomplete="off" data-previo="1"') + campo('a2', 'Segundo apellido (opcional)', '', 'text', 'maxlength="40" autocomplete="off" data-previo="1"') + '</div>' +
      '<div class="previo"><p class="rotulo">Su usuario será</p><p class="previo-usuario" id="usuario-previo">—</p><p class="ayuda">Si ya existe, se agrega un punto o un número.</p></div>' +
      campo('clave', 'Contraseña temporal', claveTemporal(), 'text', 'maxlength="72" autocomplete="off"', 'La cambiará en su primer ingreso.') +
      '<p class="error" id="error-persona" role="alert" hidden></p><button type="submit" class="btn btn-acento">Crear transportista</button></form></aside></div></div>';
    $('#vista-pagina').innerHTML = html;
  }
  function cargarEquipo() {
    return sb.rpc('mi_equipo', { p_negocio: estado.emp.negocio_id }).then(revisar).then(function (l) { estado.equipo = l || []; });
  }

  /* ---------- panel general (administradores generales) ---------- */

  function pintarGeneral(ruta, extra) {
    var g = estado.general, html = '<div class="pagina-in">', credAqui = estado.cred && estado.cred.vista === ruta ? estado.cred.html : '';
    if (ruta === 'nueva') {
      var n = g.nueva || (g.nueva = { tinta: '#10231C', acento: '#D7F25A', logo: null, clave: claveTemporal(), slugTocado: false });
      html += '<h1 class="ficha-titulo" id="t-pagina" tabindex="-1">Nueva empresa</h1><div class="columnas"><form class="col-ancha tarjeta formulario" id="form-empresa" novalidate>' +
        '<div class="dos">' + campo('negocio', 'Nombre de la empresa', '', 'text', 'maxlength="80" required data-empresa="nombre"') +
        campo('slug', 'Enlace', '', 'text', 'maxlength="40" autocapitalize="none" spellcheck="false" data-empresa="slug"', 'Se arma solo con el nombre; puedes cambiarlo.') +
        campo('nombre', 'Nombre del administrador', '', 'text', 'maxlength="80" autocomplete="off"') +
        campo('correo', 'Correo del administrador', '', 'email', 'maxlength="120" autocomplete="off"') + '</div>' +
        campo('clave', 'Contraseña temporal', n.clave, 'text', 'maxlength="72" autocomplete="off"', 'La cambiará en su primer ingreso. Si su correo ya tiene cuenta en otra microapp, no se usa: sigue con su contraseña de siempre.') +
        '<div class="ubic-botones"><div class="campo"><label for="e-logo">Logo (PNG o JPG, opcional)</label><input id="e-logo" type="file" accept="image/png,image/jpeg,image/webp"></div>' +
        '<div class="campo"><label for="e-tinta">Color principal</label><input class="color" id="e-tinta" type="color" value="' + esc(n.tinta) + '" data-empresa="tinta"></div>' +
        '<div class="campo"><label for="e-acento">Color de acento</label><input class="color" id="e-acento" type="color" value="' + esc(n.acento) + '" data-empresa="acento"></div></div>' +
        '<div id="e-avisos"></div><p class="error" id="error-empresa" role="alert" hidden></p>' +
        '<button type="submit" class="btn btn-acento">Crear empresa</button></form>' +
        '<aside class="col-lateral"><p class="rotulo">Así se verá</p><div id="e-previa"></div></aside></div>';
    } else if (ruta === 'admins') {
      html += '<h1 class="ficha-titulo" id="t-pagina" tabindex="-1">Administradores generales</h1>' + credAqui + '<div class="columnas"><section class="col-ancha">' +
        '<p class="ayuda">Ven todas las empresas de todas las webs. Es la misma lista en todas las apps.</p>';
      html += !g.admins ? '<p class="vacio">Cargando…</p>' : '<ul class="lista-clientes">' + g.admins.map(function (a) {
        return '<li class="cli"><span class="cli-texto"><span class="cli-nombre">' + esc(a.correo) + '</span><span class="cli-dir">' + (a.cuenta ? (a.pendiente ? 'Aún no cambia su clave' : 'Cuenta activa') : 'Sin cuenta todavía') + '</span></span>' +
          (a.cuenta && a.correo !== String(estado.usuario.email || '').toLowerCase() ? '<button type="button" class="btn btn-linea" data-accion="admin-clave" data-correo="' + esc(a.correo) + '">Restablecer clave</button>' : '') + '</li>';
      }).join('') + '</ul>';
      html += '</section><aside class="col-lateral"><form class="tarjeta formulario" id="form-admin" novalidate><h2>Agregar administrador</h2>' +
        campo('correo', 'Correo', '', 'email', 'autocomplete="off"') + campo('clave', 'Contraseña temporal', claveTemporal(), 'text', 'autocomplete="off"', 'Solo se usa si ese correo aún no tiene cuenta.') +
        '<p class="error" id="error-admin" role="alert" hidden></p><button type="submit" class="btn btn-fuerte">Agregar</button></form></aside></div>';
    } else if (ruta === 'empresa') {
      var d = g.detalle;
      html += '<a class="volver" href="#/empresas">← Empresas</a>';
      if (!d || d.empresa.id !== extra) html += '<p class="vacio">Cargando…</p>';
      else {
        var e = d.empresa, c = d.cifras;
        html += '<div class="encabezado-empresa">' + logoDe(e, 'logo-grande') + '<div><p class="rotulo">/' + esc(e.slug) + ' · ' + esc(e.dueno_correo || '') + '</p><h1 class="ficha-titulo" id="t-pagina" tabindex="-1">' + esc(e.nombre) + '</h1></div></div>' +
          '<div class="cifras"><div><span>Clientes</span><strong>' + c.clientes + '</strong></div><div><span>Visitas este mes</span><strong>' + c.visitas_mes + '</strong></div>' +
          '<div><span>Km este mes</span><strong>' + km1(Number(c.km_mes)) + '</strong></div><div><span>Pedidos fuera de horario</span><strong>' + c.pedidos_mes + '</strong></div></div>' +
          '<div class="columnas"><section class="col-ancha"><h2 class="titulo-panel">Equipo</h2><ul class="lista-clientes">' + d.equipo.map(function (p) {
            return '<li class="cli"><span class="cli-texto"><span class="cli-nombre">' + esc(p.nombre) + '</span><span class="cli-dir">' + (p.rol === 'admin' ? 'Administrador' : 'Transporte') + ' · ' + esc(p.usuario) + ' · ' + plural(p.clientes, 'cliente', 'clientes') + '</span>' +
              (p.pendiente ? '<span class="etiqueta-alerta">Aún no cambia su clave</span>' : '') + '</span></li>';
          }).join('') + '</ul><p class="ubic-botones"><a class="btn btn-linea" href="/' + esc(e.slug) + '" target="_blank" rel="noopener">Ver ingreso de la empresa</a></p></section>' +
          '<aside class="col-lateral"><form class="tarjeta formulario" id="form-marca" data-id="' + esc(e.id) + '" novalidate><h2>Marca</h2>' +
          '<div class="ubic-botones"><div class="campo"><label for="m-tinta">Color principal</label><input class="color" id="m-tinta" name="tinta" type="color" value="' + esc(e.tinta) + '"></div>' +
          '<div class="campo"><label for="m-acento">Color de acento</label><input class="color" id="m-acento" name="acento" type="color" value="' + esc(e.acento) + '"></div></div>' +
          '<div class="campo"><label for="m-logo">Cambiar logo (PNG o JPG)</label><input id="m-logo" name="logo" type="file" accept="image/png,image/jpeg,image/webp"></div>' +
          (e.logo ? '<label class="acepto"><input type="checkbox" name="sinlogo"><span>Quitar el logo actual</span></label>' : '') +
          '<button type="submit" class="btn btn-fuerte">Guardar marca</button></form></aside></div>';
      }
    } else {
      var l = g.empresas;
      html += '<div class="fila-titulo"><h1 class="ficha-titulo" id="t-pagina" tabindex="-1">Empresas</h1><a class="btn btn-acento" href="#/nueva">+ Nueva empresa</a></div>' + credAqui;
      if (!l) html += '<p class="vacio">Cargando…</p>';
      else {
        var suma = function (k) { return l.reduce(function (a, x) { return a + Number(x[k] || 0); }, 0); };
        html += '<div class="cifras"><div><span>Empresas activas</span><strong>' + l.filter(function (x) { return x.activa; }).length + '</strong></div>' +
          '<div><span>Transportistas</span><strong>' + suma('transportistas') + '</strong></div><div><span>Visitas este mes</span><strong>' + suma('visitas_mes') + '</strong></div>' +
          '<div><span>Km este mes</span><strong>' + km1(suma('km_mes')) + '</strong></div></div>';
        html += l.length ? '<ul class="lista-clientes">' + l.map(function (x) {
          return '<li class="cli"><span class="muestra" data-fondo="' + esc(x.tinta) + '" aria-hidden="true"><i data-fondo="' + esc(x.acento) + '"></i></span>' +
            '<span class="cli-texto"><span class="cli-nombre">' + esc(x.nombre) + '</span><span class="cli-dir">/' + esc(x.slug) + ' · ' + esc(x.dueno_correo || '—') + ' · ' +
            plural(Number(x.transportistas), 'transportista', 'transportistas') + ' · ' + plural(Number(x.clientes), 'cliente', 'clientes') + ' · ' + x.visitas_mes + ' visitas este mes</span>' +
            (x.dueno_pendiente ? '<span class="etiqueta-alerta">Aún no cambia su clave</span>' : '') + '</span>' +
            '<span class="ubic-botones"><a class="btn btn-linea" href="#/empresa/' + esc(x.id) + '">Ver detalle</a>' +
            '<button type="button" class="btn btn-linea" data-accion="dueno-clave" data-id="' + esc(x.id) + '" data-correo="' + esc(x.dueno_correo || '') + '" data-slug="' + esc(x.slug) + '">Restablecer clave</button></span></li>';
        }).join('') + '</ul>' : '<p class="vacio">Aún no hay empresas.</p>';
        html += '<p class="ayuda">Solo cifras y equipo: las direcciones y datos de los clientes los ve únicamente cada empresa.</p>';
      }
    }
    $('#vista-pagina').innerHTML = html + '</div>';
    if (ruta === 'nueva') pintarPrevia();
    medidas();
  }
  function pintarPrevia() {
    var n = estado.general.nueva, caja = $('#e-previa'), av = $('#e-avisos'), nombre = ($('#c-negocio') && $('#c-negocio').value) || 'Tu empresa';
    if (caja) caja.innerHTML = '<div class="previa"><div class="previa-cab" data-fondo="' + esc(n.tinta) + '">' + logoDe({ nombre: nombre, logo: n.logo }, 'logo-chico') + '<b>' + esc(nombre) + '</b></div>' +
      '<div class="previa-cuerpo"><b>Ruta de hoy</b><span class="previa-boton" data-fondo="' + esc(n.acento) + '" data-color="' + esc(n.tinta) + '">Ordenar ruta</span></div></div>';
    if (av) av.innerHTML = (contraste(n.tinta, '#FFFFFF') < 4.5 ? '<p class="error">El color principal es muy claro: el texto blanco no se leería. Elige uno más oscuro.</p>' : '') +
      (contraste(n.tinta, n.acento) < 3 ? '<p class="error">Los dos colores se parecen mucho. Prueba un acento más claro.</p>' : '');
    medidas();
  }
  function cargarGeneral(ruta, extra) {
    var g = estado.general;
    var p = ruta === 'admins' ? sb.rpc('panel_admins').then(revisar).then(function (l) { g.admins = l; })
      : ruta === 'empresa' ? sb.rpc('panel_empresa', { p_id: extra }).then(revisar).then(function (d) { g.detalle = d; })
      : ruta === 'nueva' ? Promise.resolve()
      : sb.rpc('panel_empresas').then(revisar).then(function (l) { g.empresas = l; });
    return p.then(function () { if (vistaActual() === ruta) pintarGeneral(ruta, extra); }).catch(function (e) { avisar(mensajeError(e)); });
  }

  /* ---------- vistas y navegación ---------- */

  function mostrar(vista) {
    $('#vista-carga').hidden = vista !== 'carga';
    $('#vista-acceso').hidden = vista !== 'acceso';
    $('#vista-app').hidden = vista !== 'app';
    $('#vista-cliente').hidden = vista !== 'cliente';
    $('#vista-pagina').hidden = vista !== 'pagina';
    var dentro = (vista === 'app' || vista === 'cliente' || vista === 'pagina') && !estado.cambioClave && !!(estado.emp || estado.superadmin);
    $('#tabs').hidden = !dentro;
    $('#cuenta').hidden = !estado.usuario || DEMO;
    var mi = $('#mi-clave'); if (mi) mi.hidden = !!estado.cambioClave;
    document.body.setAttribute('data-vista', vista === 'pagina' ? 'cliente' : vista);
    if (vista === 'acceso') { var t = $('#t-acceso'); if (t && document.activeElement && document.activeElement !== document.body) t.focus(); }
  }
  function vistaActual() { return estado.rutaActual || ''; }
  function partesHash() {
    var h = location.hash || '';
    if (h.indexOf('#/') !== 0) h = '';
    return h.slice(2).split('/');
  }
  function pintarTabs() {
    var tabs = estado.emp
      ? [['ruta', 'Ruta'], ['clientes', 'Clientes']].concat(esAdmin() ? [['hoy', 'Hoy'], ['equipo', 'Equipo']] : [])
      : [['empresas', 'Empresas'], ['nueva', 'Nueva empresa'], ['admins', 'Administradores']];
    $('#tabs').innerHTML = tabs.map(function (t) { return '<a href="#/' + t[0] + '" data-tab="' + t[0] + '">' + t[1] + '</a>'; }).join('');
    $('#tabs').setAttribute('data-n', tabs.length);
  }

  function navegar() {
    if (!estado.usuario || estado.cambioClave) return;
    var partes = partesHash();
    estado.propuesta = null; // un punto propuesto y no guardado se descarta al cambiar de pantalla
    estado.agenda = null;
    window.scrollTo(0, 0);
    if (!estado.emp) {
      if (!estado.superadmin) return;
      var rg = ['nueva', 'admins', 'empresa'].indexOf(partes[0]) >= 0 ? partes[0] : 'empresas';
      estado.rutaActual = rg;
      pintarGeneral(rg, partes[1]);
      mostrar('pagina');
      marcarTab(rg === 'empresa' ? 'empresas' : rg);
      cargarGeneral(rg, partes[1]);
      return;
    }
    if (partes[0] === 'hoy' && esAdmin()) {
      estado.rutaActual = 'hoy'; pintarHoyAdmin(); mostrar('pagina'); marcarTab('hoy'); cargarHoyAdmin().catch(function (e) { avisar(mensajeError(e)); });
      return;
    }
    if (partes[0] === 'equipo' && esAdmin()) {
      estado.rutaActual = 'equipo'; pintarEquipo(); mostrar('pagina'); marcarTab('equipo');
      cargarEquipo().then(function () { if (vistaActual() === 'equipo') pintarEquipo(); }).catch(function (e) { avisar(mensajeError(e)); });
      return;
    }
    if (partes[0] === 'cliente' && partes[1]) {
      estado.rutaActual = 'cliente';
      pintarFicha(partes[1]);
      if (!clienteDe(partes[1]) && partes[1] !== 'nuevo') return;
      mostrar('cliente');
      marcarTab('clientes');
      var titulo = $('#t-ficha'); if (titulo) titulo.focus({ preventScroll: true });
      return;
    }
    var tab = partes[0] === 'clientes' ? 'clientes' : 'ruta';
    estado.rutaActual = tab;
    pintarApp();
    mostrar('app');
    marcarTab(tab);
    $('#vista-app').setAttribute('data-tab', tab);
  }

  function marcarTab(tab) {
    $$('#tabs a').forEach(function (a) {
      if (a.getAttribute('data-tab') === tab) a.setAttribute('aria-current', 'page');
      else a.removeAttribute('aria-current');
    });
  }
  function pintarMensaje(titulo, texto, conSalir) {
    $('#vista-pagina').innerHTML = '<div class="ficha"><h1 class="ficha-titulo" id="t-pagina" tabindex="-1">' + titulo + '</h1><p class="ubic-texto">' + texto + '</p>' +
      (conSalir ? '<button type="button" class="btn btn-fuerte" data-accion="salir">Salir</button>' : '') + '</div>';
    mostrar('pagina');
  }

  /* ---------- carga de datos ---------- */

  function recargarClientes() {
    var ordenar = function (l) { return (l || []).slice().sort(function (a, b) { return a.nombre.localeCompare(b.nombre, 'es'); }); };
    return datos().clientes().then(function (lista) {
      estado.clientes = ordenar(lista);
      if (!DEMO && esAdmin()) return datos().todos().then(function (t) { estado.todos = ordenar(t); });
    });
  }

  /* Ruta de un día: la que ya se guardó; si no hay, los clientes agendados para ese día. */
  function cargarRuta(dia) {
    return datos().ruta(dia).then(function (r) {
      var ruta = rutaVacia(dia);
      if (r) {
        var existe = function (id) { return !!clienteDe(id); };
        ruta.orden = (r.orden || []).filter(existe);
        ruta.visitados = (r.visitados || []).filter(existe);
        ruta.modo = r.modo || 'manual';
        ruta.tramos = r.tramos || null;
        ruta.salida = r.salida || null;
        ruta.fuera = (Array.isArray(r.fuera) ? r.fuera : []).filter(function (f) { return f && existe(f.id); });
        ruta.saltados = (r.saltados || []).filter(existe);
        ruta.guardada = true;
      } else {
        ruta.orden = agendados(dia).map(function (c) { return c.id; });
      }
      estado.dia = dia;
      estado.ruta = ruta;
      estado.previa = null;
      return cargarAprobaciones().then(function () { if (aplicarDecisiones() && ruta.guardada) guardarRuta(); }).catch(function () {});
    });
  }

  function cargarTodo() {
    return recargarClientes().then(function () { return cargarRuta(estado.dia); });
  }

  function cambiarDia(dia) {
    if (!fechaValida(dia) || dia === estado.dia || estado.ocupado) { pintarRuta(); return; }
    cargarRuta(dia).then(function () {
      pintarApp();
      var campoDia = $('#dia-fecha'); if (campoDia) campoDia.focus();
    }).catch(function () { pintarRuta(); avisar('No se pudo cargar ese día. Revisa tu conexión.'); });
  }

  function entrar(usuario) {
    if (estado.usuario && estado.usuario.id === usuario.id) return;
    estado.acceso = 'entrar';
    estado.usuario = usuario;
    $('#cuenta-correo').textContent = usuarioVisible(usuario.email || '');
    if (DEMO) { estado.emp = null; mostrar('carga'); cargarTodo().then(navegar); return; }
    if (estado.recuperacion) { pintarClave('recuperacion'); return; }
    if (debeCambiar(usuario)) { pintarClave('primer'); return; }
    mostrar('carga');
    sb.rpc('mi_sesion', { p_slug: SLUG || '' }).then(revisar).then(function (s) {
      estado.superadmin = !!s.admin;
      if (SLUG) {
        if (!s.empresa) {
          pintarMensaje('Tu cuenta no tiene acceso a esta empresa', 'Entraste como ' + esc(usuarioVisible(usuario.email)) + '. Si trabajas aquí, pide al administrador que te agregue en Equipo.', true);
          return;
        }
        estado.emp = s.empresa;
        aplicarMarca(s.empresa);
        return (esAdmin() ? cargarEquipo() : Promise.resolve()).then(cargarTodo).then(function () { pintarTabs(); navegar(); });
      }
      if (s.admin) { $('#marca').innerHTML = NIVO_MARCA; $('#marca').setAttribute('aria-label', 'Nivo Ruta · panel general'); pintarTabs(); navegar(); return; }
      if (s.empresas.length === 1) { location.replace('/' + s.empresas[0].slug); return; }
      if (s.empresas.length > 1) {
        pintarMensaje('Elige la empresa', 'Tu cuenta trabaja en más de una empresa:</p><ul class="lista-clientes">' + s.empresas.map(function (e) {
          return '<li class="cli"><span class="cli-texto"><span class="cli-nombre">' + esc(e.nombre) + '</span><span class="cli-dir">/' + esc(e.slug) + '</span></span><a class="btn btn-linea" href="/' + esc(e.slug) + '">Entrar</a></li>';
        }).join('') + '</ul><p>', true);
        return;
      }
      pintarMensaje('Tu cuenta no tiene acceso todavía', 'Entra desde el enlace de tu empresa o pide acceso al administrador.', true);
    }).catch(function () {
      $('#vista-carga').innerHTML = '<p>No pudimos cargar tus datos. Revisa tu conexión.</p><button type="button" class="btn btn-fuerte" data-accion="recargar">Reintentar</button>';
      mostrar('carga');
    });
  }

  function salir() {
    if (sb) sb.auth.signOut().catch(function () {});
    volverAlIngreso();
  }

  /* ---------- acciones del administrador y del panel general ---------- */

  function accionCuenta(el, accion, id) {
    if (accion === 'mi-clave') { pintarClave('voluntaria'); return true; }
    if (accion === 'clave-volver') { estado.cambioClave = null; navegar(); return true; }
    if (accion === 'copiar') {
      var texto = el.getAttribute('data-texto');
      (navigator.clipboard ? navigator.clipboard.writeText(texto) : Promise.reject()).then(function () { avisar('Copiado.'); })
        .catch(function () { window.prompt('Copia estos datos:', texto); });
      return true;
    }
    if (accion === 'responder') {
      el.disabled = true;
      sb.rpc('responder_aprobacion', { p_id: id, p_aprobar: el.getAttribute('data-si') === '1' }).then(revisar)
        .then(function () { avisar('Respuesta enviada.'); return cargarHoyAdmin(); })
        .catch(function (e) { el.disabled = false; avisar(mensajeError(e)); });
      return true;
    }
    if (accion === 'quitar') { estado.quitar = id; pintarEquipo(); return true; }
    if (accion === 'quitar-no') { estado.quitar = null; pintarEquipo(); return true; }
    if (accion === 'quitar-si') {
      var destino = $('#pasar-' + id);
      el.disabled = true;
      cuentas('quitar_transportista', { negocio_id: estado.emp.negocio_id, usuario_id: id, pasar_a: destino ? destino.value : null })
        .then(function () { estado.quitar = null; estado.cred = null; avisar('Acceso quitado. Sus clientes ya pasaron.'); return cargarEquipo(); })
        .then(recargarClientes).then(function () { if (vistaActual() === 'equipo') pintarEquipo(); })
        .catch(function (e) { el.disabled = false; avisar(e.message); });
      return true;
    }
    if (accion === 'nueva-clave') {
      var nueva = claveTemporal(), usuario = el.getAttribute('data-usuario');
      el.disabled = true;
      cuentas('cambiar_clave', { negocio_id: estado.emp.negocio_id, usuario_id: id, clave: nueva }).then(function () {
        estado.cred = { vista: 'equipo', html: credencial('Nueva contraseña para ' + usuario, [['Enlace', enlaceDe(estado.emp.slug)], ['Usuario', usuario], ['Contraseña temporal', nueva]]) };
        return cargarEquipo();
      }).then(function () { pintarEquipo(); }).catch(function (e) { el.disabled = false; avisar(e.message); });
      return true;
    }
    if (accion === 'dueno-clave') {
      var nd = claveTemporal(), correoD = el.getAttribute('data-correo'), slugD = el.getAttribute('data-slug');
      el.disabled = true;
      cuentas('restablecer_dueno', { negocio_id: id, clave: nd }).then(function () {
        estado.cred = { vista: 'empresas', html: credencial('Nueva contraseña del administrador', [['Enlace', enlaceDe(slugD)], ['Correo', correoD], ['Contraseña temporal', nd]]) };
        pintarGeneral('empresas'); window.scrollTo(0, 0);
      }).catch(function (e) { el.disabled = false; avisar(e.message); });
      return true;
    }
    if (accion === 'admin-clave') {
      var na = claveTemporal(), correoA = el.getAttribute('data-correo');
      el.disabled = true;
      cuentas('restablecer_superadmin', { correo: correoA, clave: na }).then(function () {
        estado.cred = { vista: 'admins', html: credencial('Nueva contraseña de administrador', [['Panel', location.origin + '/panel'], ['Correo', correoA], ['Contraseña temporal', na]]) };
        pintarGeneral('admins');
      }).catch(function (e) { el.disabled = false; avisar(e.message); });
      return true;
    }
    return false;
  }

  function enviarFormularioCuenta(form) {
    var boton = $('button[type="submit"]', form);
    var fallar = function (sel, m) { var e = $(sel); e.textContent = m; e.hidden = false; boton.disabled = false; };
    if (form.id === 'form-clave') { guardarClave(form); return true; }
    if (form.id === 'form-persona') {
      if (!form.n1.value.trim() || soloLetras(form.a1.value).length < 2) return fallar('#error-persona', 'Escribe al menos el primer nombre y el primer apellido.'), true;
      if (form.clave.value.length < 8) return fallar('#error-persona', 'La contraseña temporal debe tener al menos 8 caracteres.'), true;
      boton.disabled = true;
      var claveP = form.clave.value;
      cuentas('crear_transportista', { negocio_id: estado.emp.negocio_id, n1: form.n1.value, n2: form.n2.value, a1: form.a1.value, a2: form.a2.value, clave: claveP })
        .then(function (r) {
          estado.cred = { vista: 'equipo', html: credencial('Transportista creado: ' + r.nombre, [['Enlace', enlaceDe(estado.emp.slug)], ['Usuario', r.usuario], ['Contraseña temporal', claveP]]) };
          return cargarEquipo();
        }).then(function () { pintarEquipo(); }).catch(function (e) { fallar('#error-persona', e.message); });
      return true;
    }
    if (form.id === 'form-empresa') {
      var n = estado.general.nueva;
      if (contraste(n.tinta, '#FFFFFF') < 4.5) return fallar('#error-empresa', 'El color principal es muy claro: elige uno más oscuro.'), true;
      boton.disabled = true;
      var nombreE = form.negocio.value.trim(), claveE = form.clave.value;
      cuentas('crear_empresa', { negocio: nombreE, slug: form.slug.value, nombre: form.nombre.value, correo: form.correo.value.trim().toLowerCase(), clave: claveE, tinta: n.tinta, acento: n.acento, logo: n.logo })
        .then(function (r) {
          estado.cred = { vista: 'empresas', html: r.existente
            ? credencial(nombreE + ' creada', [['Enlace', enlaceDe(r.slug)], ['Correo', r.correo], ['Contraseña', 'la misma que ya usa en sus otras apps']], 'Esta persona ya tenía cuenta en otra microapp: entra con su misma contraseña de siempre.')
            : credencial(nombreE + ' creada', [['Enlace', enlaceDe(r.slug)], ['Correo', r.correo], ['Contraseña temporal', claveE]]) };
          estado.general.nueva = null; estado.general.empresas = null; location.hash = '#/empresas';
        }).catch(function (e) { fallar('#error-empresa', e.message); });
      return true;
    }
    if (form.id === 'form-marca') {
      var idM = form.getAttribute('data-id'), archivo = form.logo.files && form.logo.files[0];
      boton.disabled = true;
      (archivo ? prepararLogo(archivo) : Promise.resolve(null)).then(function (logo) {
        return sb.rpc('guardar_marca', { p_negocio: idM, p_logo: logo, p_tinta: form.tinta.value, p_acento: form.acento.value,
          p_cambiar_logo: !!logo || !!(form.sinlogo && form.sinlogo.checked) }).then(revisar);
      }).then(function () { avisar('Marca guardada.'); return cargarGeneral('empresa', idM); })
        .catch(function (e) { boton.disabled = false; avisar(e.message || mensajeError(e)); });
      return true;
    }
    if (form.id === 'form-admin') {
      boton.disabled = true;
      var claveA = form.clave.value;
      cuentas('crear_superadmin', { correo: form.correo.value, clave: claveA }).then(function (r) {
        estado.cred = { vista: 'admins', html: r.existente ? '<p class="cred">' + esc(r.correo) + ' ya tenía cuenta: ahora también es administrador general.</p>'
          : credencial('Administrador agregado', [['Panel', location.origin + '/panel'], ['Correo', r.correo], ['Contraseña temporal', claveA]]) };
        estado.general.admins = null; pintarGeneral('admins'); return cargarGeneral('admins');
      }).catch(function (e) { fallar('#error-admin', e.message); });
      return true;
    }
    return false;
  }

  /* ---------- eventos ---------- */

  document.addEventListener('click', function (ev) {
    var el = ev.target.closest('[data-accion]');
    if (!el || el.tagName === 'INPUT') return;
    var accion = el.getAttribute('data-accion'), id = el.getAttribute('data-id');
    if (accionCuenta(el, accion, id)) return;
    if (accion === 'ordenar') ordenarRuta();
    else if (accion === 'copiar-horario') {
      var fh = $('#form-cliente'), d0 = fh['hd-1'].value, h0 = fh['hh-1'].value;
      if (!d0 || !h0) { avisar('Primero escribe el horario del lunes.'); return; }
      DIAS.forEach(function (d) { if (d[0] !== 1) { fh['hd-' + d[0]].value = d0; fh['hh-' + d[0]].value = h0; } });
      avisar('Horario copiado. Borra los días que no atiende y toca Guardar.');
    }
    else if (accion === 'pedir-ir') pedirAprobacion(id, 'ir', el);
    else if (accion === 'pedir-saltar') pedirAprobacion(id, 'saltar', el);
    else if (accion === 'visitar') visitar();
    else if (accion === 'subir') mover(id, -1);
    else if (accion === 'bajar') mover(id, 1);
    else if (accion === 'guardar-ubicacion') guardarUbicacion(id, el);
    else if (accion === 'eliminar-cliente') eliminarCliente(id);
    else if (accion === 'dia-paso') cambiarDia(sumarDias(estado.dia, Number(el.getAttribute('data-paso'))));
    else if (accion === 'dia-hoy') cambiarDia(hoy());
    else if (accion === 'agregar-fecha') agregarFecha();
    else if (accion === 'quitar-fecha') { var quitar = el.getAttribute('data-fecha'); cambiarAgenda(function (a) { a.fechas = a.fechas.filter(function (f) { return f !== quitar; }); }, '#c-fecha'); }
    else if (accion === 'ver-dir') verDireccion();
    else if (accion === 'usar-coords') usarCoordenadas(id);
    else if (accion === 'ubicar-nuevo') ubicarNuevo(el);
    else if (accion === 'guardar-punto') guardarPunto(id, el);
    else if (accion === 'descartar-punto') { estado.propuesta = null; repintarUbic(id); }
    else if (accion === 'modo-acceso') { pintarAcceso(el.getAttribute('data-modo')); var t = $('#t-acceso'); if (t) t.focus(); }
    else if (accion === 'salir') salir();
    else if (accion === 'recargar') location.reload();
    else if (accion === 'aceptar-aviso') { guardarLocal('ruta.aviso', 1); $('#aviso-cookies').hidden = true; }
  });

  document.addEventListener('change', function (ev) {
    var el = ev.target;
    if (el.id === 'e-logo') {
      var archivo = el.files && el.files[0], n = estado.general.nueva;
      if (!archivo) { n.logo = null; pintarPrevia(); return; }
      prepararLogo(archivo).then(function (d) { n.logo = d; pintarPrevia(); }).catch(function (e) { el.value = ''; n.logo = null; avisar(e.message); });
      return;
    }
    if (el.matches && el.matches('input[data-accion="alternar"]')) {
      var id = el.getAttribute('data-id');
      alternarCliente(id, el.checked);
      var nuevo = $('input[data-accion="alternar"][data-id="' + id + '"]');
      if (nuevo) nuevo.focus();
    } else if (el.id === 'filtro-cli') {
      estado.filtro = el.value; pintarClientes(); var f = $('#filtro-cli'); if (f) f.focus();
    } else if (el.id === 'dia-fecha') {
      cambiarDia(el.value);
    } else if (el.matches && el.matches('input[data-accion="dia-semana"]')) {
      var n = Number(el.value), marcado = el.checked;
      cambiarAgenda(function (a) { a.dias = a.dias.filter(function (d) { return d !== n; }); if (marcado) a.dias.push(n); }, 'input[data-accion="dia-semana"][value="' + n + '"]');
    }
  });

  document.addEventListener('submit', function (ev) {
    if (ev.target.id === 'form-cliente') { ev.preventDefault(); guardarFicha(ev.target); }
    else if (ev.target.id === 'form-acceso') { ev.preventDefault(); enviarAcceso(ev.target); }
    else if (ev.target.id) { if (enviarFormularioCuenta(ev.target)) ev.preventDefault(); }
  });

  document.addEventListener('keydown', function (ev) {
    if (ev.key === 'Escape' && !$('#toast').hidden) ocultarToast();
    // Enter en el campo de coordenadas las usa; no envía el formulario.
    if (ev.key === 'Enter' && ev.target.id === 'c-coords') {
      ev.preventDefault();
      var boton = $('[data-accion="usar-coords"]'); if (boton) boton.click();
    }
  });
  document.addEventListener('input', function (ev) {
    var t = ev.target;
    if (t.id === 'c-coords') t.removeAttribute('aria-invalid');
    if (t.getAttribute('data-previo')) {
      var f = t.form, u = $('#usuario-previo');
      if (f && u) u.textContent = usuarioPrevio(f.n1.value, f.n2.value, f.a1.value, f.a2.value) || '—';
    }
    var e = t.getAttribute('data-empresa'), n = estado.general.nueva;
    if (e && n) {
      if (e === 'nombre') { var sl = $('#c-slug'); if (sl && !n.slugTocado) sl.value = slugDe(t.value); pintarPrevia(); }
      else if (e === 'slug') n.slugTocado = true;
      else { n[e] = t.value; pintarPrevia(); }
    }
  });
  window.addEventListener('hashchange', navegar);

  /* ---------- arranque ---------- */

  function aplicarConfig() {
    var raiz = document.documentElement.style;
    if (CFG.TINTA) raiz.setProperty('--tinta', CFG.TINTA);
    if (CFG.ACENTO) raiz.setProperty('--acento', CFG.ACENTO);
    var tema = $('meta[name="theme-color"]');
    if (tema && CFG.TINTA) tema.setAttribute('content', CFG.TINTA);
    var numero = String(CFG.WHATSAPP_SOPORTE || '').replace(/\D/g, '');
    if (numero) {
      var a = $('#enlace-soporte');
      a.href = 'https://wa.me/' + numero + '?text=' + encodeURIComponent('Hola, necesito ayuda con Ruta del día.');
      a.hidden = false;
    }
    if (!leerLocal('ruta.aviso', 0)) $('#aviso-cookies').hidden = false;
  }

  function cargarScript(src) {
    return new Promise(function (ok, falla) {
      var s = document.createElement('script');
      s.src = src; s.onload = ok; s.onerror = function () { falla(new Error('script')); };
      document.head.appendChild(s);
    });
  }

  function iniciar() {
    aplicarConfig();
    try {
      var aviso = sessionStorage.getItem('ruta.aviso-ingreso');
      if (aviso) { sessionStorage.removeItem('ruta.aviso-ingreso'); setTimeout(function () { avisar(aviso); }, 400); }
    } catch (e) {}
    if (DEMO) {
      $('#aviso-demo').hidden = false;
      entrar({ id: 'demo', email: '' });
      return;
    }
    cargarScript(CDN_SUPABASE).then(function () {
      // Tolera que la dirección se haya pegado con /rest/v1/ al final
      var urlBase = String(CFG.SUPABASE_URL).trim().replace(/\/(rest|auth)\/v1\/?$/, '').replace(/\/+$/, '');
      sb = window.supabase.createClient(urlBase, CFG.SUPABASE_ANON_KEY, {
        db: { schema: CFG.ESQUEMA || 'ruta' },
        // Sin bloqueo entre pestañas: evita que la sesión se quede colgada.
        auth: { lock: function (nombre, espera, fn) { return fn(); } }
      });
      sb.auth.onAuthStateChange(function (evento, sesion) {
        // Fuera del callback para no bloquear a Supabase
        setTimeout(function () {
          if (evento === 'PASSWORD_RECOVERY') { estado.recuperacion = true; if (sesion && sesion.user) { estado.usuario = sesion.user; pintarClave('recuperacion'); } }
          else if (evento === 'SIGNED_OUT') { if (estado.usuario) volverAlIngreso(); }
          else if (evento === 'USER_UPDATED') { /* nada: el cambio de contraseña vuelve al ingreso */ }
          else if (sesion && sesion.user) entrar(sesion.user);
        }, 0);
      });
      if (!SLUG) return null;
      return sb.rpc('negocio_por_slug', { p_slug: SLUG }).then(revisar).then(function (n) {
        if (!n) throw new Error('no-existe');
        estado.pub = n; aplicarMarca(n);
      });
    }).then(function () { return sb.auth.getSession(); }).then(function (res) {
      if (!(res.data && res.data.session) && !estado.usuario) pintarAcceso('entrar');
    }).catch(function (e) {
      if (e && e.message === 'no-existe') {
        $('#vista-carga').innerHTML = '<p class="rotulo">Enlace no encontrado</p><h1 class="ficha-titulo">Esta empresa no existe o ya no está activa</h1><p>Revisa que el enlace esté bien escrito o pide el enlace correcto al administrador.</p>';
        return;
      }
      $('#vista-carga').innerHTML = '<p>No se pudo conectar. Revisa tu conexión a internet.</p><button type="button" class="btn btn-fuerte" data-accion="recargar">Reintentar</button>';
    });

    // Revisa respuestas del administrador y el avance del equipo sin recargar.
    setInterval(function () {
      if (!estado.emp || document.hidden || estado.ocupado) return;
      if (vistaActual() === 'hoy') { cargarHoyAdmin().catch(function () {}); return; }
      if (vistaActual() !== 'ruta' && vistaActual() !== 'clientes') return;
      if (!(estado.ruta.fuera || []).some(function (f) { return decision(f.id) === 'pendiente'; })) return;
      cargarAprobaciones().then(function () { if (aplicarDecisiones()) { guardarRuta(); pintarApp(); avisar('El administrador respondió tu pedido.'); } else pintarRuta(); }).catch(function () {});
    }, 30000);
  }

  iniciar();
})();
