/* Nivo · plan de cuenta (prueba 7 días / flat). Componente compartido por las apps.
   Uso, tras iniciar sesión:  NivoPlan.init({ sb, nombre: "<negocio>", appNom: "CRM" });
   Requiere en el esquema de la app una función estado_plan() que envuelva core.estado_plan('<app>'). */
(function () {
  var WA = "51965604732";
  function waURL(nombre, appNom) {
    var msg = encodeURIComponent("Hola, quiero contratar " + (appNom ? "Nivo " + appNom : "el servicio") + (nombre ? " para " + nombre : "") + ".");
    return "https://wa.me/" + WA + "?text=" + msg;
  }
  var NivoPlan = {
    async init(opts) {
      try {
        if (!opts || !opts.sb) return;
        var r = await opts.sb.rpc("estado_plan");
        var p = r && !r.error ? r.data : null;
        if (!p || p.plan !== "prueba") { this.limpiar(); return; }  // flat o sin dato: nada
        this.render(p, opts);
      } catch (e) { /* fail open: nunca bloquea por error */ }
    },
    limpiar() {
      var a = document.getElementById("nivo-plan-cta"); if (a) a.remove();
      var b = document.getElementById("nivo-plan-block"); if (b) b.remove();
    },
    render(p, opts) {
      this.limpiar();
      var a = document.createElement("a");
      a.id = "nivo-plan-cta";
      a.href = waURL(opts.nombre, opts.appNom); a.target = "_blank"; a.rel = "noopener";
      a.textContent = p.vencida ? "Contratar" : ("Te quedan " + p.dias + " día" + (p.dias === 1 ? "" : "s") + " · Contratar");
      a.style.cssText = "position:fixed;top:12px;right:12px;z-index:99998;background:#2E9AA3;color:#06202A;font-weight:700;border-radius:999px;padding:8px 16px;text-decoration:none;font-family:inherit;font-size:14px;line-height:1;box-shadow:0 6px 18px -8px rgba(0,0,0,.45)";
      document.body.appendChild(a);
      if (p.vencida) this.block(opts);
    },
    block(opts) {
      if (document.getElementById("nivo-plan-block")) return;
      var d = document.createElement("div");
      d.id = "nivo-plan-block";
      d.style.cssText = "position:fixed;inset:0;z-index:99999;background:rgba(10,20,35,.78);backdrop-filter:blur(4px);display:flex;align-items:center;justify-content:center;padding:24px;font-family:inherit";
      d.innerHTML = '<div style="max-width:460px;background:#fff;border-radius:18px;padding:34px;text-align:center;box-shadow:0 30px 70px -20px rgba(0,0,0,.55)">' +
        '<h2 style="margin:0 0 10px;font-size:22px;color:#0F2747">Tu prueba de 7 días terminó</h2>' +
        '<p style="margin:0 0 22px;color:#44586e;font-size:15px;line-height:1.5">Contrata para seguir usando ' + (opts.appNom ? "Nivo " + opts.appNom : "la app") + '. Tu información está guardada y segura; al contratar recuperas el acceso completo.</p>' +
        '<a href="' + waURL(opts.nombre, opts.appNom) + '" target="_blank" rel="noopener" style="display:inline-block;background:#2E9AA3;color:#06202A;font-weight:700;border-radius:999px;padding:12px 24px;text-decoration:none">Contratar por WhatsApp</a></div>';
      document.body.appendChild(d);
    }
  };
  window.NivoPlan = NivoPlan;
})();
