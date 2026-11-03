/* Nivo · Analítica con aviso de cookies.
   Google Analytics solo se carga si la persona acepta. Se usa solo en las páginas públicas de Nivo
   (inicio y páginas legales), nunca en paneles, tiendas de clientes ni el Libro de Reclamaciones.
   A Google solo se le envía la dirección sin parámetros (?...) ni fragmentos (#...), para no compartir códigos ni datos. */
(function () {
  var ID = "G-6318VN7SG7";
  var CLAVE = "nivo-cookies";          // "si" o "no"
  var aviso = null;

  function leer() { try { return localStorage.getItem(CLAVE); } catch (e) { return null; } }
  function guardar(v) { try { localStorage.setItem(CLAVE, v); } catch (e) {} }
  function limpia(u) { try { var x = new URL(u, location.href); return x.origin + x.pathname; } catch (e) { return ""; } }

  function activar() {
    if (window.__nivoGA) return;
    window.__nivoGA = true;
    window.dataLayer = window.dataLayer || [];
    window.gtag = function () { window.dataLayer.push(arguments); };
    window.gtag("js", new Date());
    window.gtag("config", ID, {
      page_location: limpia(location.href),
      page_referrer: document.referrer ? limpia(document.referrer) : ""
    });
    var s = document.createElement("script");
    s.async = true;
    s.src = "https://www.googletagmanager.com/gtag/js?id=" + ID;
    document.head.appendChild(s);
  }

  // Si la persona cambia a "Rechazar", se borran las cookies de Google Analytics.
  function borrarCookies() {
    var partes = location.hostname.split("."), dominios = [""];
    for (var i = 0; i < partes.length - 1; i++) dominios.push("." + partes.slice(i).join("."));
    document.cookie.split(";").forEach(function (c) {
      var n = c.split("=")[0].trim();
      if (!/^_ga/.test(n)) return;
      dominios.forEach(function (d) {
        document.cookie = n + "=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/" + (d ? "; domain=" + d : "");
      });
    });
  }

  function cerrar() { if (aviso) { aviso.remove(); aviso = null; } }

  function decidir(v) {
    var antes = leer();
    guardar(v);
    cerrar();
    if (v === "si") activar();
    else if (antes === "si" || window.__nivoGA) { borrarCookies(); location.reload(); }
  }

  function boton(texto, clase, v) {
    var b = document.createElement("button");
    b.type = "button";
    b.className = "nivo-ck-btn " + clase;
    b.textContent = texto;
    b.addEventListener("click", function () { decidir(v); });
    return b;
  }

  function mostrar() {
    if (aviso) return;
    aviso = document.createElement("section");
    aviso.className = "nivo-ck";
    aviso.setAttribute("role", "region");
    aviso.setAttribute("aria-label", "Aviso de cookies");
    var p = document.createElement("p");
    p.className = "nivo-ck-txt";
    p.appendChild(document.createTextNode("Usamos cookies de Google Analytics para saber cuántas personas visitan esta web y mejorarla. Solo se activan si las aceptas. "));
    var a = document.createElement("a");
    a.href = "/cookies";
    a.textContent = "Más información";
    p.appendChild(a);
    var acciones = document.createElement("div");
    acciones.className = "nivo-ck-acc";
    acciones.appendChild(boton("Rechazar", "nivo-ck-no", "no"));
    acciones.appendChild(boton("Aceptar", "nivo-ck-si", "si"));
    aviso.appendChild(p);
    aviso.appendChild(acciones);
    document.body.appendChild(aviso);
  }

  function iniciar() {
    // Botones «Configurar cookies» de la página de cookies.
    document.querySelectorAll("[data-nivo-cookies]").forEach(function (el) {
      el.addEventListener("click", function (e) { e.preventDefault(); mostrar(); });
    });
    var v = leer();
    if (v === "si") activar();
    else if (v !== "no") mostrar();
  }

  var css = document.createElement("link");
  css.rel = "stylesheet";
  css.href = "/nivo-analitica.css";
  document.head.appendChild(css);

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", iniciar);
  else iniciar();
})();
