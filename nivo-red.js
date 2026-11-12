/* Nivo · une las webs Nivo entre sí.
   Cierra el menú «Apps Nivo» de la cabecera al tocar fuera de él o al pulsar Escape.
   Sin este archivo el menú igual funciona (abre y cierra con su propio botón). */
(function () {
  'use strict';
  document.addEventListener('click', function (e) {
    var abiertos = document.querySelectorAll('details.nivo-apps[open]');
    for (var i = 0; i < abiertos.length; i++) {
      if (!abiertos[i].contains(e.target)) abiertos[i].removeAttribute('open');
    }
  });
  document.addEventListener('keydown', function (e) {
    if (e.key !== 'Escape') return;
    var d = document.querySelector('details.nivo-apps[open]');
    if (!d) return;
    d.removeAttribute('open');
    var s = d.querySelector('summary');
    if (s) s.focus();
  });
})();
