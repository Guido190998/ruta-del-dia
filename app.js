/* Ruta del día: lógica de la app.
   Sin configurar Supabase (config.js vacío) funciona en modo de prueba, guardando en el dispositivo. */
(function () {
  'use strict';

  var CFG = window.RUTA_CONFIG || {};
  var Orden = window.Orden;
  var DEMO = !(CFG.SUPABASE_URL && CFG.SUPABASE_ANON_KEY);
  var CDN_SUPABASE = 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2';
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
    acceso: 'entrar'
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

  function fechaLarga() {
    try {
      var t = new Intl.DateTimeFormat('es-PE', { weekday: 'long', day: 'numeric', month: 'long', timeZone: zona() }).format(new Date());
      return t.charAt(0).toUpperCase() + t.slice(1);
    } catch (e) { return 'Hoy'; }
  }

  function km1(n) { return (Math.round(n * 10) / 10).toFixed(1); }
  function plural(n, uno, varios) { return n + ' ' + (n === 1 ? uno : varios); }
  function rutaVacia() { return { fecha: hoy(), orden: [], visitados: [], modo: 'manual', tramos: null }; }
  function tieneUbicacion(c) { return c && typeof c.lat === 'number' && typeof c.lng === 'number'; }
  function clienteDe(id) { return estado.clientes.filter(function (c) { return c.id === id; })[0] || null; }
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
      return sb.from('clientes').select('id,nombre,direccion,referencia,lat,lng,precision_m,ubicado_en').order('nombre').then(revisar);
    },
    guardarCliente: function (c) {
      var campos = { nombre: c.nombre, direccion: c.direccion || null, referencia: c.referencia || null };
      ['lat', 'lng', 'precision_m', 'ubicado_en'].forEach(function (k) { if (k in c) campos[k] = c[k]; });
      var q = c.id ? sb.from('clientes').update(campos).eq('id', c.id) : sb.from('clientes').insert(campos);
      return q.select().single().then(revisar);
    },
    borrarCliente: function (id) { return sb.from('clientes').delete().eq('id', id).then(revisar); },
    ruta: function (fecha) { return sb.from('rutas').select('fecha,orden,visitados,modo,tramos').eq('fecha', fecha).maybeSingle().then(revisar); },
    guardarRuta: function (r) {
      return sb.from('rutas').upsert({
        user_id: estado.usuario.id, fecha: r.fecha, orden: r.orden, visitados: r.visitados,
        modo: r.modo, tramos: r.tramos, actualizado_en: new Date().toISOString()
      }, { onConflict: 'user_id,fecha' }).then(revisar);
    }
  };

  function datos() { return DEMO ? datosLocal : datosNube; }

  function guardarRuta() {
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

  function cambioManual() {
    estado.ruta.modo = 'manual';
    estado.ruta.tramos = null;
    estado.previa = null;
  }

  function alternarCliente(id, marcado) {
    var r = estado.ruta;
    r.orden = r.orden.filter(function (x) { return x !== id; });
    r.visitados = r.visitados.filter(function (x) { return x !== id; });
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
          paradas: conUbicacion.map(function (c) { return { id: c.id, lat: c.lat, lng: c.lng }; })
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

    ubicar().then(function (p) { estado.pos = p; return p; }, function (e) { sinPosicion = e.message; return null; })
      .then(function (pos) {
        if (DEMO || !pos || con.length > 48) return null;
        return pedirCalles(pos, con).catch(function () { return null; });
      })
      .then(function (calles) {
        var antes = posiciones(), r = estado.ruta, mensaje;
        if (calles && calles.orden && calles.orden.length) {
          var fuera = con.map(function (c) { return c.id; }).filter(function (id) { return calles.orden.indexOf(id) < 0; });
          r.orden = calles.orden.concat(fuera, sin.map(function (c) { return c.id; }));
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

  function pintarRuta() {
    var panel = $('#panel-ruta'), r = estado.ruta;
    var pend = pendientes(), total = pend.length + r.visitados.length;
    var info = tramosDe(pend);
    var html = '';

    /* cabecera */
    html += '<div class="hero">';
    html += '<p class="rotulo rotulo-hero">' + esc(fechaLarga()) + (pend.length && info.km != null ? ' · por recorrer' : '') + '</p>';
    if (!total) {
      html += '<h2 class="hero-titulo" id="t-ruta">Ruta de hoy</h2><p class="hero-sub">Aún no marcas a quién visitas hoy.</p>';
    } else if (!pend.length) {
      html += '<h2 class="hero-titulo" id="t-ruta">Ruta terminada</h2><p class="hero-sub">Visitaste a ' + (total === 1 ? 'tu cliente' : 'tus ' + total + ' clientes') + ' de hoy.</p>';
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
      html += '<p class="vacio">Elige a tus clientes de hoy y vuelve aquí para ordenar el recorrido.</p>' +
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
      '<h2 class="titulo-panel" id="t-clientes">¿A quién visitas hoy?</h2></div>';

    html += '<div class="clientes-cuerpo">';
    if (!estado.clientes.length) {
      html += '<p class="vacio">Todavía no tienes clientes. Agrega el primero y guarda su ubicación cuando estés en su local.</p>' +
        '<a class="btn btn-acento" href="#/cliente/nuevo">Agregar cliente</a></div>';
      panel.innerHTML = html;
      return;
    }

    html += '<ul class="lista-clientes">';
    estado.clientes.forEach(function (c) {
      var marcado = enRuta.indexOf(c.id) >= 0;
      html += '<li class="cli">' +
        '<label class="cli-marca"><input type="checkbox" data-accion="alternar" data-id="' + esc(c.id) + '"' + (marcado ? ' checked' : '') + '>' +
        '<span class="cli-texto"><span class="cli-nombre">' + esc(c.nombre) + '</span>' +
        '<span class="cli-dir">' + (tieneUbicacion(c) ? esc(c.direccion || 'Con ubicación guardada') : '<span class="alerta">Sin ubicación</span>' + (c.direccion ? ' · ' + esc(c.direccion) : '')) + '</span></span></label>' +
        '<a class="cli-editar" href="#/cliente/' + esc(c.id) + '" aria-label="Ver y editar ' + esc(c.nombre) + '">Editar</a>' +
        '</li>';
    });
    html += '</ul>';
    html += '<a class="btn btn-linea" href="#/cliente/nuevo">Agregar cliente</a>';

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

    if (!nuevo) {
      html += '<section class="ubicacion" aria-labelledby="t-ubic">' +
        '<h2 class="rotulo" id="t-ubic">Ubicación</h2>';
      if (conUbic) {
        html += '<dl class="ubic-datos">' +
          '<div><dt>Coordenadas</dt><dd>' + c.lat.toFixed(5) + ', ' + c.lng.toFixed(5) + '</dd></div>' +
          (c.precision_m ? '<div><dt>Precisión del GPS</dt><dd>' + c.precision_m + ' m</dd></div>' : '') +
          '</dl>' +
          '<div class="ubic-botones"><button type="button" class="btn btn-linea" data-accion="guardar-ubicacion" data-id="' + esc(c.id) + '">Tomarla de nuevo</button>' +
          '<a class="enlace" href="https://www.google.com/maps/search/?api=1&query=' + c.lat + ',' + c.lng + '" target="_blank" rel="noopener">Verla en Google Maps</a></div>';
      } else {
        html += '<p class="ubic-texto">Este cliente aún no tiene ubicación. Guárdala cuando estés en la puerta del local: se hace una sola vez y desde ahí la ruta lo ordena solo.</p>' +
          '<button type="button" class="btn btn-acento" data-accion="guardar-ubicacion" data-id="' + esc(c.id) + '">Guardar mi ubicación actual</button>';
      }
      html += '</section>';
    }

    html += '<form class="formulario" id="form-cliente" data-id="' + esc(nuevo ? '' : c.id) + '" novalidate>' +
      (nuevo ? '' : '<h2 class="rotulo">Datos</h2>') +
      campo('nombre', 'Nombre del negocio', c.nombre, 'text', 'required maxlength="80" autocomplete="off"') +
      campo('direccion', 'Dirección', c.direccion, 'text', 'maxlength="120" autocomplete="off"', 'Opcional. Sirve para abrirla en Google Maps mientras no tenga ubicación.') +
      campo('referencia', 'Referencia', c.referencia, 'text', 'maxlength="120" autocomplete="off"', 'Opcional. Por ejemplo: frente al mercado.') +
      '<p class="error" id="error-cliente" role="alert" hidden></p>' +
      '<button type="submit" class="btn ' + (nuevo || conUbic ? 'btn-acento' : 'btn-fuerte') + '">' + (nuevo ? 'Guardar cliente' : 'Guardar cambios') + '</button>' +
      '</form>';

    if (!nuevo) html += '<button type="button" class="btn-texto peligro" data-accion="eliminar-cliente" data-id="' + esc(c.id) + '">Eliminar cliente</button>';
    vista.innerHTML = html;
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
    var boton = $('button[type="submit"]', form);
    boton.disabled = true;
    var c = { nombre: nombre, direccion: form.direccion.value.trim(), referencia: form.referencia.value.trim() };
    if (id) c.id = id;
    datos().guardarCliente(c).then(function (guardado) {
      return recargarClientes().then(function () {
        if (id) { avisar('Cambios guardados.'); pintarFicha(id); }
        else { avisar('Cliente guardado. Si estás en su local, guarda su ubicación.'); location.hash = '#/cliente/' + guardado.id; }
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
        pintarFicha(id);
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

  /* ---------- acceso (solo con Supabase) ---------- */

  function pintarAcceso(modo, correo) {
    estado.acceso = modo;
    var vista = $('#vista-acceso');
    var intro = '<div class="acceso-texto"><p class="rotulo">Para vendedores en ruta</p>' +
      '<h1>Tus visitas de hoy, en el orden más corto</h1>' +
      '<p>Marca a quién visitas, toca “Ordenar ruta” y la app arma el recorrido por calles desde donde estás.</p></div>';
    var form = '';

    if (modo === 'enviado' || modo === 'enviado-clave') {
      form = '<div class="tarjeta" role="status"><h2 tabindex="-1" id="t-acceso">Revisa tu correo</h2>' +
        '<p>' + (modo === 'enviado'
          ? 'Te enviamos un enlace a <strong>' + esc(correo) + '</strong> para confirmar tu cuenta. Ábrelo y vuelve a entrar.'
          : 'Si <strong>' + esc(correo) + '</strong> tiene una cuenta, te llegará un enlace para crear una contraseña nueva.') + '</p>' +
        '<button type="button" class="btn btn-fuerte" data-accion="modo-acceso" data-modo="entrar">Volver a entrar</button></div>';
    } else {
      var titulo = { entrar: 'Entrar', crear: 'Crear cuenta', recuperar: 'Recuperar contraseña', 'nueva-clave': 'Crea tu contraseña nueva' }[modo];
      var boton = { entrar: 'Entrar', crear: 'Crear cuenta', recuperar: 'Enviar enlace', 'nueva-clave': 'Guardar contraseña' }[modo];
      form = '<form class="tarjeta formulario" id="form-acceso" data-modo="' + modo + '" novalidate>' +
        '<h2 tabindex="-1" id="t-acceso">' + titulo + '</h2>';
      if (modo !== 'nueva-clave') form += campo('correo', 'Correo', correo || '', 'email', 'required autocomplete="email" inputmode="email"');
      if (modo !== 'recuperar') form += campo('clave', modo === 'nueva-clave' ? 'Contraseña nueva' : 'Contraseña', '', 'password',
        'required minlength="8" autocomplete="' + (modo === 'entrar' ? 'current-password' : 'new-password') + '"',
        modo === 'entrar' ? '' : 'Mínimo 8 caracteres.');
      if (modo === 'crear') {
        form += '<div class="trampa" aria-hidden="true"><label for="c-web">No completar</label><input id="c-web" name="web" type="text" tabindex="-1" autocomplete="off"></div>' +
          '<label class="acepto"><input type="checkbox" name="acepto" required><span>Acepto los <a href="/terminos" target="_blank" rel="noopener">Términos</a> y la <a href="/privacidad" target="_blank" rel="noopener">Política de privacidad</a>.</span></label>';
      }
      form += '<p class="error" id="error-acceso" role="alert" hidden></p>' +
        '<button type="submit" class="btn btn-acento">' + boton + '</button>';
      if (modo === 'entrar') {
        form += '<div class="acceso-enlaces"><button type="button" class="btn-texto" data-accion="modo-acceso" data-modo="crear">Crear una cuenta</button>' +
          '<button type="button" class="btn-texto" data-accion="modo-acceso" data-modo="recuperar">Olvidé mi contraseña</button></div>';
      } else if (modo !== 'nueva-clave') {
        form += '<div class="acceso-enlaces"><button type="button" class="btn-texto" data-accion="modo-acceso" data-modo="entrar">Ya tengo cuenta</button></div>';
      }
      form += '</form>';
    }
    vista.innerHTML = '<div class="acceso-in">' + intro + form + '</div>';
    mostrar('acceso');
  }

  function errorAcceso(e) {
    var m = (e && e.message) || '';
    if (/Invalid login credentials/i.test(m)) return 'Correo o contraseña incorrectos.';
    if (/Email not confirmed/i.test(m)) return 'Aún no confirmas tu correo. Revisa tu bandeja y abre el enlace.';
    if (/already registered/i.test(m)) return 'Ese correo ya tiene una cuenta. Entra o recupera tu contraseña.';
    if (/rate limit|too many/i.test(m)) return 'Demasiados intentos. Espera unos minutos y vuelve a probar.';
    if (/password/i.test(m) && /least|short|weak/i.test(m)) return 'La contraseña es muy corta o débil. Usa al menos 8 caracteres.';
    return 'No se pudo completar. Revisa tu conexión e inténtalo otra vez.';
  }

  function enviarAcceso(form) {
    var modo = form.getAttribute('data-modo'), error = $('#error-acceso'), boton = $('button[type="submit"]', form);
    var correo = form.correo ? form.correo.value.trim() : '', clave = form.clave ? form.clave.value : '';
    function fallar(texto, campoMalo) {
      error.textContent = texto; error.hidden = false;
      if (campoMalo) { campoMalo.setAttribute('aria-invalid', 'true'); campoMalo.focus(); }
    }
    error.hidden = true;
    $$('[aria-invalid]', form).forEach(function (el) { el.removeAttribute('aria-invalid'); });

    if (form.correo && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(correo)) return fallar('Escribe un correo válido.', form.correo);
    if (form.clave && clave.length < (modo === 'entrar' ? 1 : 8)) return fallar(modo === 'entrar' ? 'Escribe tu contraseña.' : 'La contraseña debe tener al menos 8 caracteres.', form.clave);
    if (modo === 'crear') {
      if (form.web.value) return; // trampa para robots
      if (!form.acepto.checked) return fallar('Para crear la cuenta debes aceptar los Términos y la Política de privacidad.', form.acepto);
    }

    boton.disabled = true;
    var destino = location.origin + '/';
    var pedido =
      modo === 'entrar' ? sb.auth.signInWithPassword({ email: correo, password: clave }) :
      modo === 'crear' ? sb.auth.signUp({ email: correo, password: clave, options: { emailRedirectTo: destino } }) :
      modo === 'recuperar' ? sb.auth.resetPasswordForEmail(correo, { redirectTo: destino }) :
      sb.auth.updateUser({ password: clave });

    pedido.then(function (res) {
      if (res.error) throw res.error;
      if (modo === 'crear' && !(res.data && res.data.session)) pintarAcceso('enviado', correo);
      else if (modo === 'recuperar') pintarAcceso('enviado-clave', correo);
      else if (modo === 'nueva-clave') { avisar('Contraseña actualizada.'); entrar(res.data.user); }
      /* entrar y crear con sesión: lo maneja onAuthStateChange */
    }).catch(function (e) {
      boton.disabled = false;
      fallar(errorAcceso(e));
    });
  }

  /* ---------- vistas y navegación ---------- */

  function mostrar(vista) {
    $('#vista-carga').hidden = vista !== 'carga';
    $('#vista-acceso').hidden = vista !== 'acceso';
    $('#vista-app').hidden = vista !== 'app';
    $('#vista-cliente').hidden = vista !== 'cliente';
    var dentro = vista === 'app' || vista === 'cliente';
    $('#tabs').hidden = !dentro;
    $('#cuenta').hidden = !dentro || DEMO;
    document.body.setAttribute('data-vista', vista);
    if (vista === 'acceso') { var t = $('#t-acceso'); if (t && document.activeElement && document.activeElement !== document.body) t.focus(); }
  }

  function navegar() {
    if (!estado.usuario) return;
    var h = location.hash || '#/ruta';
    if (h.indexOf('#/') !== 0) h = '#/ruta'; // enlaces de Supabase u otros
    var partes = h.slice(2).split('/');
    if (partes[0] === 'cliente' && partes[1]) {
      pintarFicha(partes[1]);
      if (!clienteDe(partes[1]) && partes[1] !== 'nuevo') return;
      mostrar('cliente');
      marcarTab('clientes');
      window.scrollTo(0, 0);
      var titulo = $('#t-ficha'); if (titulo) titulo.focus({ preventScroll: true });
      return;
    }
    var tab = partes[0] === 'clientes' ? 'clientes' : 'ruta';
    pintarApp();
    mostrar('app');
    marcarTab(tab);
    $('#vista-app').setAttribute('data-tab', tab);
    window.scrollTo(0, 0);
  }

  function marcarTab(tab) {
    $$('#tabs a').forEach(function (a) {
      if (a.getAttribute('data-tab') === tab) a.setAttribute('aria-current', 'page');
      else a.removeAttribute('aria-current');
    });
  }

  /* ---------- carga de datos ---------- */

  function recargarClientes() {
    return datos().clientes().then(function (lista) {
      estado.clientes = (lista || []).slice().sort(function (a, b) { return a.nombre.localeCompare(b.nombre, 'es'); });
    });
  }

  function cargarTodo() {
    return recargarClientes().then(function () { return datos().ruta(hoy()); }).then(function (r) {
      var ruta = rutaVacia();
      if (r) {
        var existe = function (id) { return !!clienteDe(id); };
        ruta.orden = (r.orden || []).filter(existe);
        ruta.visitados = (r.visitados || []).filter(existe);
        ruta.modo = r.modo || 'manual';
        ruta.tramos = r.tramos || null;
      }
      estado.ruta = ruta;
      estado.previa = null;
    });
  }

  function entrar(usuario) {
    if (estado.usuario && estado.usuario.id === usuario.id) return;
    estado.acceso = 'entrar';
    estado.usuario = usuario;
    $('#cuenta-correo').textContent = usuario.email || '';
    mostrar('carga');
    cargarTodo().then(navegar).catch(function () {
      $('#vista-carga').innerHTML = '<p>No pudimos cargar tus datos. Revisa tu conexión.</p><button type="button" class="btn btn-fuerte" data-accion="recargar">Reintentar</button>';
    });
  }

  function salir() {
    estado.usuario = null;
    estado.clientes = [];
    estado.ruta = rutaVacia();
    sb.auth.signOut().catch(function () {});
    pintarAcceso('entrar');
  }

  /* ---------- eventos ---------- */

  document.addEventListener('click', function (ev) {
    var el = ev.target.closest('[data-accion]');
    if (!el || el.tagName === 'INPUT') return;
    var accion = el.getAttribute('data-accion'), id = el.getAttribute('data-id');
    if (accion === 'ordenar') ordenarRuta();
    else if (accion === 'visitar') visitar();
    else if (accion === 'subir') mover(id, -1);
    else if (accion === 'bajar') mover(id, 1);
    else if (accion === 'guardar-ubicacion') guardarUbicacion(id, el);
    else if (accion === 'eliminar-cliente') eliminarCliente(id);
    else if (accion === 'modo-acceso') { pintarAcceso(el.getAttribute('data-modo')); var t = $('#t-acceso'); if (t) t.focus(); }
    else if (accion === 'salir') salir();
    else if (accion === 'recargar') location.reload();
    else if (accion === 'aceptar-aviso') { guardarLocal('ruta.aviso', 1); $('#aviso-cookies').hidden = true; }
  });

  document.addEventListener('change', function (ev) {
    var el = ev.target;
    if (el.matches && el.matches('input[data-accion="alternar"]')) {
      var id = el.getAttribute('data-id');
      alternarCliente(id, el.checked);
      var nuevo = $('input[data-accion="alternar"][data-id="' + id + '"]');
      if (nuevo) nuevo.focus();
    }
  });

  document.addEventListener('submit', function (ev) {
    if (ev.target.id === 'form-cliente') { ev.preventDefault(); guardarFicha(ev.target); }
    else if (ev.target.id === 'form-acceso') { ev.preventDefault(); enviarAcceso(ev.target); }
  });

  document.addEventListener('keydown', function (ev) { if (ev.key === 'Escape' && !$('#toast').hidden) ocultarToast(); });
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
    if (DEMO) {
      $('#aviso-demo').hidden = false;
      entrar({ id: 'demo', email: '' });
      return;
    }
    cargarScript(CDN_SUPABASE).then(function () {
      sb = window.supabase.createClient(CFG.SUPABASE_URL, CFG.SUPABASE_ANON_KEY, { db: { schema: CFG.ESQUEMA || 'ruta' } });
      sb.auth.onAuthStateChange(function (evento, sesion) {
        // Fuera del callback para no bloquear a Supabase
        setTimeout(function () {
          if (evento === 'PASSWORD_RECOVERY') pintarAcceso('nueva-clave');
          else if (evento === 'SIGNED_OUT') { if (estado.usuario) { estado.usuario = null; pintarAcceso('entrar'); } }
          else if (sesion && sesion.user && estado.acceso !== 'nueva-clave') entrar(sesion.user);
        }, 0);
      });
      return sb.auth.getSession();
    }).then(function (res) {
      if (!(res.data && res.data.session) && !estado.usuario && estado.acceso !== 'nueva-clave') pintarAcceso('entrar');
    }).catch(function () {
      $('#vista-carga').innerHTML = '<p>No se pudo conectar. Revisa tu conexión a internet.</p><button type="button" class="btn btn-fuerte" data-accion="recargar">Reintentar</button>';
    });
  }

  iniciar();
})();
