/* Ruta del día: cálculo propio del orden de visitas (en línea recta).
   Se usa como respaldo cuando el servicio de calles no responde.
   Funciona en el navegador (window.Orden) y en Node (module.exports). */
(function (raiz) {
  'use strict';

  var RADIO_TIERRA_KM = 6371;
  var LIMITE_EXACTO = 12; // hasta 12 paradas se prueban todas las combinaciones

  function km(a, b) {
    var rad = Math.PI / 180;
    var dLat = (b.lat - a.lat) * rad;
    var dLng = (b.lng - a.lng) * rad;
    var h = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
      Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLng / 2) * Math.sin(dLng / 2);
    return 2 * RADIO_TIERRA_KM * Math.asin(Math.min(1, Math.sqrt(h)));
  }

  /* Largo total del recorrido: origen (opcional) y luego los puntos en ese orden. */
  function largo(origen, puntos) {
    var total = 0;
    var previo = origen || null;
    for (var i = 0; i < puntos.length; i++) {
      if (previo) total += km(previo, puntos[i]);
      previo = puntos[i];
    }
    return total;
  }

  function matriz(puntos) {
    var n = puntos.length, d = [];
    for (var i = 0; i < n; i++) {
      d.push(new Array(n));
      for (var j = 0; j < n; j++) d[i][j] = i === j ? 0 : km(puntos[i], puntos[j]);
    }
    return d;
  }

  /* Exacto: prueba todas las combinaciones (programación dinámica). */
  function exacto(d0, d) {
    var n = d.length, total = 1 << n;
    var costo = new Float64Array(total * n).fill(Infinity);
    var desde = new Int8Array(total * n).fill(-1);
    var j, k, m;
    for (j = 0; j < n; j++) costo[(1 << j) * n + j] = d0[j];
    for (m = 1; m < total; m++) {
      for (j = 0; j < n; j++) {
        if (!(m & (1 << j))) continue;
        var c = costo[m * n + j];
        if (c === Infinity) continue;
        for (k = 0; k < n; k++) {
          if (m & (1 << k)) continue;
          var m2 = m | (1 << k);
          var nuevo = c + d[j][k];
          if (nuevo < costo[m2 * n + k]) { costo[m2 * n + k] = nuevo; desde[m2 * n + k] = j; }
        }
      }
    }
    var fin = 0, lleno = total - 1;
    for (j = 1; j < n; j++) if (costo[lleno * n + j] < costo[lleno * n + fin]) fin = j;
    var orden = [], mask = lleno, actual = fin;
    while (actual !== -1) {
      orden.push(actual);
      var previo = desde[mask * n + actual];
      mask &= ~(1 << actual);
      actual = previo;
    }
    return orden.reverse();
  }

  /* Aproximado: ir siempre a la más cercana y luego deshacer cruces (2-opt). */
  function aproximado(d0, d, hayOrigen) {
    var n = d.length, libres = [], orden = [], i, j;
    for (i = 0; i < n; i++) libres.push(i);
    var mejor = 0;
    if (hayOrigen) for (i = 1; i < n; i++) if (d0[i] < d0[mejor]) mejor = i;
    orden.push(libres.splice(mejor, 1)[0]);
    while (libres.length) {
      var ult = orden[orden.length - 1], bi = 0;
      for (i = 1; i < libres.length; i++) if (d[ult][libres[i]] < d[ult][libres[bi]]) bi = i;
      orden.push(libres.splice(bi, 1)[0]);
    }
    var inicio = hayOrigen ? 0 : 1; // sin origen, la primera parada queda fija
    var mejoro = true, vueltas = 0;
    while (mejoro && vueltas < 60) {
      mejoro = false; vueltas++;
      for (i = inicio; i < n - 1; i++) {
        for (j = i + 1; j < n; j++) {
          var antes = (i === 0 ? d0[orden[i]] : d[orden[i - 1]][orden[i]]) + (j + 1 < n ? d[orden[j]][orden[j + 1]] : 0);
          var despues = (i === 0 ? d0[orden[j]] : d[orden[i - 1]][orden[j]]) + (j + 1 < n ? d[orden[i]][orden[j + 1]] : 0);
          if (despues + 1e-9 < antes) {
            var a = i, b = j;
            while (a < b) { var t = orden[a]; orden[a] = orden[b]; orden[b] = t; a++; b--; }
            mejoro = true;
          }
        }
      }
    }
    return orden;
  }

  /* Devuelve los índices de `puntos` en el mejor orden de visita.
     origen: {lat, lng} o null (sin origen, empieza en la parada que más convenga). */
  function ordenar(origen, puntos) {
    var n = puntos.length;
    if (n === 0) return [];
    if (n === 1) return [0];
    var d = matriz(puntos), d0 = [];
    for (var i = 0; i < n; i++) d0.push(origen ? km(origen, puntos[i]) : 0);
    if (n <= LIMITE_EXACTO) return exacto(d0, d);
    return aproximado(d0, d, !!origen);
  }

  var api = { km: km, largo: largo, ordenar: ordenar, LIMITE_EXACTO: LIMITE_EXACTO };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else raiz.Orden = api;
})(typeof window !== 'undefined' ? window : this);
