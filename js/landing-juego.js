// Paginas para Google: /recargas-<juego>-venezuela
// El texto va fijo en el HTML (para que Google lo lea sin esperar a nada) y
// aqui solo se ponen la imagen y los precios de hoy, leidos del producto que
// indica <main data-producto="...">. Si hay data-extra (ej. un evento de CP
// doble) y ese producto esta activo, se muestra arriba de los precios.

import { db } from "./firebase-config.js";
import { doc, getDoc } from "https://www.gstatic.com/firebasejs/10.14.0/firebase-firestore.js";
import { esc, formatBs, formatUsd } from "./catalog-utils.js";
import { initAccountMenu, getDisplayCurrency } from "./account-menu.js";

const main = document.querySelector("main.lp");
const cfg = main?.dataset || {};

initAccountMenu({ activePage: "landing" });

let principal = null; // { id, data, paquetes }
let extra = null;
let tasa = 0;

function precioTexto(usd) {
  if (getDisplayCurrency() === "bs" && tasa > 0) return formatBs(usd * tasa);
  return formatUsd(usd);
}

function paquetesDe(data) {
  return Object.entries(data.options || {})
    .filter(([, o]) => o && Number(o.priceUsd) > 0 && o.active !== false)
    .map(([id, o]) => [id, { ...o, priceUsd: Number(o.priceUsd) }])
    .sort((a, b) => (Number(a[1].order) || 0) - (Number(b[1].order) || 0));
}

function tarjetas(prod) {
  const base = `/producto.html?id=${encodeURIComponent(prod.id)}`;
  return prod.paquetes
    .map(([id, o]) => {
      const antes = Number(o.oldPriceUsd) > o.priceUsd ? `<s>${precioTexto(Number(o.oldPriceUsd))}</s>` : "";
      return `<a class="lp-price" href="${base}&opt=${encodeURIComponent(id)}">
        <span>${esc(o.label)}</span>
        <b>${precioTexto(o.priceUsd)}${antes}</b>
      </a>`;
    })
    .join("");
}

function pintar() {
  const caja = document.getElementById("lpPrices");
  if (caja && principal?.paquetes.length) caja.innerHTML = tarjetas(principal);

  const ev = document.getElementById("lpExtra");
  if (ev && extra?.paquetes.length) {
    const titulo = extra.data.eventDescription || `${extra.data.name} (evento)`;
    ev.innerHTML = `
      <h2>${esc(titulo)}</h2>
      <p class="lp-sub">Por tiempo limitado. Toca un paquete para comprarlo.</p>
      <div class="lp-prices">${tarjetas(extra)}</div>`;
    ev.hidden = false;
  }

  const nota = document.getElementById("lpRateNote");
  if (nota && getDisplayCurrency() === "bs" && tasa > 0) {
    nota.textContent = `Precios en bolívares a la tasa de hoy (Bs ${tasa.toLocaleString("es-VE")} por dólar). Toca un paquete para comprarlo.`;
  }
}

function datosParaGoogle() {
  const precios = principal.paquetes.map(([, o]) => o.priceUsd);
  if (!precios.length) return;
  const data = {
    "@context": "https://schema.org",
    "@type": "Product",
    name: cfg.nombre || principal.data.name,
    description: cfg.descripcion || "",
    brand: { "@type": "Brand", name: cfg.marca || principal.data.name },
    url: cfg.url || location.href,
    offers: {
      "@type": "AggregateOffer",
      priceCurrency: "USD",
      lowPrice: Math.min(...precios).toFixed(2),
      highPrice: Math.max(...precios).toFixed(2),
      offerCount: precios.length,
      availability: "https://schema.org/InStock",
      seller: { "@type": "Organization", name: "GameCenter" },
    },
  };
  if (principal.data.image) data.image = principal.data.image;
  const s = document.createElement("script");
  s.type = "application/ld+json";
  s.textContent = JSON.stringify(data);
  document.head.appendChild(s);
}

async function leerProducto(id) {
  if (!id) return null;
  const snap = await getDoc(doc(db, "products", id));
  if (!snap.exists() || snap.data().active !== true) return null;
  const data = snap.data();
  return { id, data, paquetes: paquetesDe(data) };
}

async function cargar() {
  try {
    const [p, e, ajustes] = await Promise.all([
      leerProducto(cfg.producto),
      leerProducto(cfg.extra).catch(() => null),
      getDoc(doc(db, "settings", "main")).catch(() => null),
    ]);
    tasa = Number(ajustes?.data?.()?.exchangeRateBsPerUsd) || 0;
    principal = p;
    extra = e;
    if (!principal) return;

    const img = document.getElementById("lpImg");
    if (img && principal.data.image) {
      img.src = principal.data.image;
      img.hidden = false;
    }
    pintar();
    datosParaGoogle();
  } catch (err) {
    // Si falla, se quedan los nombres de los paquetes que ya trae el HTML
    console.error("No se pudieron cargar los precios", err);
  }
}

window.addEventListener("gc-currency-change", pintar);
cargar();
