// ============================================================================
// GameCenter — catalog-utils.js
// Helpers compartidos por index (main.js) y producto.html (producto.js).
//
// OFERTAS: una opcion esta "en oferta" cuando tiene el campo opcional
// `oldPriceUsd` (precio anterior, se muestra tachado) mayor que `priceUsd`.
// El monto que se COBRA sigue saliendo siempre de `priceUsd` (lo mismo que
// leen las funciones de Netlify), asi que activar una oferta no toca el backend.
// ============================================================================

export function esc(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function optionDiscountPercent(opt) {
  const oldPrice = Number(opt?.oldPriceUsd);
  const price = Number(opt?.priceUsd);
  if (!(oldPrice > 0) || !(price > 0) || oldPrice <= price) return 0;
  return Math.round((1 - price / oldPrice) * 100);
}

// Opciones en oferta de un producto, de mayor a menor descuento.
export function productDeals(product) {
  return Object.entries(product?.options || {})
    .map(([optId, opt]) => ({ optId, opt, pct: optionDiscountPercent(opt) }))
    .filter((d) => d.pct > 0)
    .sort((a, b) => b.pct - a.pct);
}

export function maxDiscount(product) {
  const deals = productDeals(product);
  return deals.length ? deals[0].pct : 0;
}

export function sortProducts(list) {
  // Eventos especiales primero; luego la posicion definida en el admin.
  return [...list].sort((a, b) => {
    const eventDiff = (b.isSpecialEvent ? 1 : 0) - (a.isSpecialEvent ? 1 : 0);
    if (eventDiff !== 0) return eventDiff;
    const posA = typeof a.position === "number" ? a.position : 9999;
    const posB = typeof b.position === "number" ? b.position : 9999;
    return posA - posB;
  });
}

// ---------- Dinero ----------
const nf = (n) => n.toLocaleString("es-VE", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export function formatBs(amount) {
  return `Bs ${nf(amount)}`;
}
export function formatUsd(amount) {
  return `$${amount.toFixed(2)}`;
}
export function formatUsdt(amount) {
  return `$${amount.toFixed(2)} USDT`;
}

// Devuelve el precio en la moneda que el usuario eligio en la barra (Bs / USD).
export function formatDisplay(usd, rate, currency) {
  return currency === "bs" ? formatBs(usd * (rate || 0)) : formatUsd(usd);
}
