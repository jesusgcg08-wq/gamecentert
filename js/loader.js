// Pantalla de carga con el logo girando.
// Va justo despues de <div id="gcLoader"> en cada pagina (script normal, no modulo, para que corra al instante).
// - Por defecto se quita cuando la pagina termino de cargar (evento "load").
// - Si el loader tiene data-esperar="app", espera a que el codigo de la pagina llame a window.gcLoaderListo()
//   (en el inicio: cuando ya cargo el catalogo).
// - Siempre se quita a los 10 segundos como maximo, para que nadie quede trabado si algo falla.
//
// Ademas, window.gcCargando("Verificando tu ID…") muestra el mismo logo girando encima de la pagina
// mientras dura una accion (ej. verificar el ID del jugador) y devuelve una funcion para quitarlo.
// Se quita solo a los 30 s como maximo.
(function () {
  window.gcCargando = function (texto) {
    var ov = document.createElement("div");
    ov.className = "gc-loader gc-loader--accion";
    ov.setAttribute("role", "status");
    ov.innerHTML = '<div class="gc-loader-logo"><img src="assets/logo-gc-blanco.png" alt="" /></div><div class="gc-loader-text"></div>';
    ov.querySelector(".gc-loader-text").textContent = texto || "Cargando…";
    document.body.appendChild(ov);
    var quitado = false;
    function quitar() {
      if (quitado) return;
      quitado = true;
      ov.classList.add("gc-loader-hide");
      setTimeout(function () { if (ov.parentNode) ov.parentNode.removeChild(ov); }, 450);
    }
    setTimeout(quitar, 30000);
    return quitar;
  };

  var el = document.getElementById("gcLoader");
  if (!el) { window.gcLoaderListo = function () {}; return; }
  var inicio = Date.now(), listo = false;
  function quitar() {
    if (listo) return;
    listo = true;
    // Minimo 0,6 s en pantalla para que no "parpadee" cuando todo carga muy rapido.
    var espera = Math.max(0, 600 - (Date.now() - inicio));
    setTimeout(function () {
      el.classList.add("gc-loader-hide");
      setTimeout(function () { if (el.parentNode) el.parentNode.removeChild(el); }, 500);
    }, espera);
  }
  window.gcLoaderListo = quitar;
  if (el.getAttribute("data-esperar") !== "app") {
    if (document.readyState === "complete") quitar();
    else window.addEventListener("load", quitar);
  }
  setTimeout(quitar, 10000);
})();
