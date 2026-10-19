// netlify/functions/lib/centralone.js
// Integracion con Central One (API v1). Reemplaza a lib/shop2topup.js.
// Variables de entorno: CENTRALONE_API_KEY (co_live_...), CENTRALONE_WEBHOOK_SECRET (whsec_...).
// Permisos de la llave: catalog:read, orders:read, orders:write y codes:read
// (codes:read NO viene marcado por defecto y hace falta para entregar giftcards).
const API = "https://portal.centraloneglobal.com/api/v1";

function headers(extra = {}) {
  return { Authorization: `Bearer ${process.env.CENTRALONE_API_KEY}`, "Content-Type": "application/json", ...extra };
}

async function api(path, options = {}) {
  const res = await fetch(`${API}${path}`, { ...options, headers: headers(options.headers) });
  let data = null;
  try { data = await res.json(); } catch {}
  return { res, data };
}

const ERROR_ES = {
  insufficient_balance: "Saldo insuficiente en Central One",
  insufficient_stock: "Producto sin stock en este momento",
  invalid_api_key: "Llave de Central One invalida",
  insufficient_scope: "La llave de Central One no tiene el permiso necesario",
  rate_limited: "Demasiadas solicitudes, intenta en unos segundos",
};
function errorMessage(data, fallback) {
  const code = data?.error?.code;
  return ERROR_ES[code] || data?.error?.message || fallback;
}

// Estado de Central One -> estado interno del sitio.
function mapCentralOneStatus(s) {
  if (s === "completed") return "completado";
  if (s === "failed" || s === "cancelled") return "rechazado";
  return "en_proceso"; // created, confirmed, processing, partially_completed
}

// Llave de idempotencia determinista: mismo pedido => misma llave => nunca se cobra doble.
// El webhook la usa para encontrar el pedido en Firestore.
const KEY_PREFIX = "gc-";
function idempotencyKeyFor(firestoreOrderId) {
  return KEY_PREFIX + String(firestoreOrderId).replace(/[^A-Za-z0-9_-]/g, "_");
}
function firestoreIdFromKey(key) {
  return typeof key === "string" && key.startsWith(KEY_PREFIX) ? key.slice(KEY_PREFIX.length) : null;
}

// ---- Catalogo (cache 5 min para no pasar el limite de 60/min) ----
let catalogCache = { at: 0, items: null };
async function getCatalogItem(productId) {
  if (!catalogCache.items || Date.now() - catalogCache.at > 5 * 60 * 1000) {
    const { res, data } = await api("/catalog");
    if (!res.ok || !Array.isArray(data?.items)) return null;
    catalogCache = { at: Date.now(), items: data.items };
  }
  return catalogCache.items.find((i) => i.product_id === productId) || null;
}

// Arma target_payload con EXACTAMENTE las claves que el producto pide (target_fields).
// Mapea el ID del jugador y la zona/servidor del sitio a esas claves.
function buildTargetPayload(item, { playerId, zoneId, extraFieldName, extraFieldValue }) {
  const payload = {};
  const fields = item?.target_fields || [];
  if (fields.length === 0) {
    // Catalogo no disponible: se manda lo que haya con nombres por defecto.
    if (playerId) payload.player_id = String(playerId);
    if (zoneId) payload.zone_id = String(zoneId);
  } else {
    const zoneKeyRe = /server|zone|region/i;
    const playerKey = fields.find((k) => !zoneKeyRe.test(k) && /player|user|uid|id/i.test(k)) || fields.find((k) => !zoneKeyRe.test(k)) || fields[0];
    const zoneKey = fields.find((k) => k !== playerKey && zoneKeyRe.test(k)) || fields.find((k) => k !== playerKey);
    if (playerId) payload[playerKey] = String(playerId);
    if (zoneId && zoneKey) payload[zoneKey] = String(zoneId);
  }
  if (extraFieldName && extraFieldValue) {
    // Con el catalogo disponible solo se mandan las claves que el producto declara:
    // Central One rechaza la orden si el target_payload trae claves de mas.
    if (fields.length === 0 || fields.includes(extraFieldName)) payload[extraFieldName] = extraFieldValue;
  }
  return payload;
}

// "PIN - SERIAL" -> { code, serial_number } (formato que muestra el dashboard)
function toVouchers(codesResponse) {
  const out = [];
  for (const item of codesResponse?.order?.items || []) {
    for (const raw of item.codes || []) {
      const [code, ...rest] = String(raw).split(" - ");
      const v = { code: code.trim() };
      if (rest.length) v.serial_number = rest.join(" - ").trim();
      out.push(v);
    }
  }
  return out;
}

// Devuelve { vouchers, error }. error = null si se leyeron bien; si no, el motivo
// (ej. "insufficient_scope" = a la llave le falta el permiso codes:read).
async function fetchVouchers(orderId) {
  const { res, data } = await api(`/orders/${orderId}/codes`);
  if (!res.ok) {
    const error = { http: res.status, code: data?.error?.code || null, message: data?.error?.message || null };
    console.warn(`[centralone] No se pudieron leer los codigos (${res.status} ${error.code || ""})`);
    return { vouchers: [], error };
  }
  return { vouchers: toVouchers(data), error: null };
}

function normalize(order, vouchers = [], codesError = null) {
  return {
    order_id: order.id,
    reference_code: order.reference_code,
    status: order.status,
    internal_status: mapCentralOneStatus(order.status),
    vouchers,
    failure: order.failure || null,
    codesError,
    codesPending: (order.items || []).some((i) => i.delivered_count > 0) && vouchers.length === 0,
  };
}

// Consulta una orden y dice POR QUE falla si falla.
// Devuelve { order, error }: order = estado normalizado (con codigos si ya hay) o null;
// error = { http, code, message } cuando no se pudo consultar.
async function checkOrderStatusDetailed(centralOneOrderId) {
  if (!process.env.CENTRALONE_API_KEY) {
    return { order: null, error: { http: 0, code: "missing_api_key", message: "CENTRALONE_API_KEY no esta cargada en el servidor" } };
  }
  try {
    const { res, data } = await api(`/orders/${centralOneOrderId}`);
    if (!res.ok || !data?.order) {
      return { order: null, error: { http: res.status, code: data?.error?.code || null, message: data?.error?.message || null } };
    }
    const hasCodes = (data.order.items || []).some((i) => i.status === "completed" && i.delivered_count > 0);
    const got = hasCodes ? await fetchVouchers(centralOneOrderId) : { vouchers: [], error: null };
    return { order: normalize(data.order, got.vouchers, got.error), error: null };
  } catch (err) {
    return { order: null, error: { http: 0, code: "network", message: String(err && err.message ? err.message : err) } };
  }
}

// Version simple (null si falla), la usan el seguimiento y la espera.
async function checkOrderStatus(centralOneOrderId) {
  const { order } = await checkOrderStatusDetailed(centralOneOrderId);
  return order;
}

// Crea la orden. SOLO se llama despues de que el pago fue verificado.
async function createCentralOneOrder({ orderId, subCategoryId, playerId, zoneId, extraFieldName, extraFieldValue }) {
  if (!process.env.CENTRALONE_API_KEY) {
    return { success: false, message: "Falta configurar CENTRALONE_API_KEY en Netlify" };
  }
  try {
    const item = await getCatalogItem(subCategoryId);
    const line = { catalog_item_id: subCategoryId, quantity: 1 };
    // Las giftcards no llevan datos del jugador: solo se manda target_payload si el producto lo pide.
    if (item ? item.requires_target : playerId || zoneId || extraFieldName) {
      line.target_payload = buildTargetPayload(item, { playerId, zoneId, extraFieldName, extraFieldValue });
    }

    const { res, data } = await api("/orders", {
      method: "POST",
      headers: { "Idempotency-Key": idempotencyKeyFor(orderId) },
      body: JSON.stringify({ items: [line], note: String(orderId).slice(0, 500) }),
    });

    if (!res.ok || !data?.order) {
      return { success: false, error: data?.error || null, message: errorMessage(data, "No se pudo crear la orden") };
    }
    return { success: true, order: normalize(data.order) };
  } catch {
    return { success: false, message: "No se pudo contactar al servidor" };
  }
}

// Valida el ID del jugador (no cuesta ni reserva nada). Devuelve { status, name, reason, error }.
async function validatePlayer({ productId, playerId, zoneId }) {
  const item = await getCatalogItem(productId);
  if (!item) return { status: "error", message: "Producto no encontrado en Central One" };
  const target_payload = buildTargetPayload(item, { playerId, zoneId });
  const { res, data } = await api("/player/validate", {
    method: "POST",
    body: JSON.stringify({ product_id: productId, target_payload }),
  });
  if (!res.ok) return { status: "error", message: errorMessage(data, "No se pudo verificar el ID"), error: data?.error || null };
  return { status: data.status, name: data.player?.name || "", reason: data.reason || null };
}

// Espera (polling) a que Central One entregue los codigos de la giftcard.
// Devuelve el ultimo estado normalizado (con vouchers si ya hay), o null si
// nunca se pudo consultar. Corta antes si la orden fallo, o si se completo
// pero no trae codigos (ej. recargas directas de juegos, que no tienen codigo).
async function waitForVouchers(centralOneOrderId, { timeoutMs = 150000, intervalMs = 4000 } = {}) {
  const started = Date.now();
  let last = null;
  let completedWithoutCodes = 0;
  while (Date.now() - started < timeoutMs) {
    const r = await checkOrderStatus(centralOneOrderId);
    if (r) {
      last = r;
      if (r.vouchers.length > 0) return r;
      if (r.internal_status === "rechazado") return r;
      if (r.internal_status === "completado" && !r.codesPending) return r;
      if (r.internal_status === "completado") {
        completedWithoutCodes += 1;
        if (completedWithoutCodes >= 4) return r; // recarga sin codigo
      }
    }
    await new Promise((res) => setTimeout(res, intervalMs));
  }
  return last;
}

// Dispara la funcion background que sigue consultando hasta que haya codigos.
async function triggerVoucherFollowup(firestoreOrderId, centralOneOrderId) {
  const baseUrl = process.env.URL || process.env.DEPLOY_PRIME_URL || process.env.DEPLOY_URL;
  if (!baseUrl) {
    console.error("[triggerVoucherFollowup] No hay URL base disponible -- no se pudo disparar el seguimiento");
    return;
  }
  const targetUrl = `${baseUrl}/.netlify/functions/centralone-voucher-followup-background`;
  try {
    const res = await fetch(targetUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ firestoreOrderId, centralOneOrderId }),
    });
    console.log(`[triggerVoucherFollowup] ${targetUrl} -- HTTP ${res.status}`);
  } catch (err) {
    console.error(`[triggerVoucherFollowup] Fallo hacia ${targetUrl}:`, err.message);
  }
}

module.exports = {
  createCentralOneOrder,
  checkOrderStatus,
  checkOrderStatusDetailed,
  waitForVouchers,
  validatePlayer,
  triggerVoucherFollowup,
  mapCentralOneStatus,
  idempotencyKeyFor,
  firestoreIdFromKey,
  toVouchers,
};
