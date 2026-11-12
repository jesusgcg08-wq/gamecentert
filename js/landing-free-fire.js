// Pagina para Google: /recargas-free-fire-venezuela
// El texto va fijo en el HTML (para que Google lo lea sin esperar a nada) y
// aqui solo se ponen los precios de hoy, leidos del producto Free Fire.

import { db } from "./firebase-config.js";
import { doc, getDoc } from "https://www.gstatic.com/firebasejs/10.14.0/firebase-firestore.js";
import { esc, formatBs, formatUsd } from "./catalog-utils.js";
import { initAccountMenu, getDisplayCurrency } from "./account-menu.js";

const PRODUCTO_ID = "QNjhYlyEU21bFBvUbMz2";
const URL_PRODUCTO = `/producto.html?id=${PRODUCTO_ID}`;

initAccountMenu({ activePage: "free-fire" });

let paquetes = [];
let tasa = 0;

function precioTexto(usd) {
  if (getDisplayCurrency() === "bs" && tasa > 0) return formatBs(usd * tasa);
  return formatUsd(usd);
}

function pintar() {
  const caja = document.getElementById("lpPrices");
  if (!caja || !paquetes.length) return;
  caja.innerHTML = paquetes
    .map(([id, o]) => {
      const antes = Number(o.oldPriceUsd) > o.priceUsd ? `<s>${precioTexto(Number(o.oldPriceUsd))}</s>` : "";
      return `<a class="lp-price" href="${URL_PRODUCTO}&opt=${encodeURIComponent(id)}">
        <span>${esc(o.label)}</span>
        <b>${precioTexto(o.priceUsd)}${antes}</b>
      </a>`;
    })
    .join("");

  const nota = document.getElementById("lpRateNote");
  if (nota && getDisplayCurrency() === "bs" && tasa > 0) {
    nota.textContent = `Precios en bolívares a la tasa de hoy (Bs ${tasa.toLocaleString("es-VE")} por dólar). Toca un paquete para comprarlo.`;
  }
}

function datosParaGoogle() {
  const precios = paquetes.map(([, o]) => o.priceUsd);
  if (!precios.length) return;
  const data = {
    "@context": "https://schema.org",
    "@type": "Product",
    name: "Recarga de diamantes Free Fire (Venezuela)",
    description: "Recarga de diamantes, Tarjeta Semanal, Tarjeta Mensual y Pase Booyah de Free Fire con entrega automática. Pago Móvil y Binance.",
    brand: { "@type": "Brand", name: "Free Fire" },
    url: "https://gamecentervzla.com/recargas-free-fire-venezuela",
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
  const s = document.createElement("script");
  s.type = "application/ld+json";
  s.textContent = JSON.stringify(data);
  document.head.appendChild(s);
}

async function cargar() {
  try {
    const [prod, ajustes] = await Promise.all([
      getDoc(doc(db, "products", PRODUCTO_ID)),
      getDoc(doc(db, "settings", "main")).catch(() => null),
    ]);
    tasa = Number(ajustes?.data?.()?.exchangeRateBsPerUsd) || 0;
    if (!prod.exists() || prod.data().active !== true) return;
    paquetes = Object.entries(prod.data().options || {})
      .filter(([, o]) => o && Number(o.priceUsd) > 0 && o.active !== false)
      .map(([id, o]) => [id, { ...o, priceUsd: Number(o.priceUsd) }])
      .sort((a, b) => (Number(a[1].order) || 0) - (Number(b[1].order) || 0));
    pintar();
    datosParaGoogle();
  } catch (err) {
    // Si falla, se quedan los nombres de los paquetes que ya trae el HTML
    console.error("No se pudieron cargar los precios de Free Fire", err);
  }
}

window.addEventListener("gc-currency-change", pintar);
cargar();
