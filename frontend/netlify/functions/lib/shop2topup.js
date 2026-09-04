// netlify/functions/lib/shop2topup.js
// Logica compartida para crear ordenes en Shop2Topup. La usan TANTO
// create-shop2topup-order.js (boton "Aceptar" del panel admin) COMO
// verify-pago-movil-order.js (verificacion automatica nueva). Vive en un
// solo lugar para que el manejo de duplicados (order_id determinista +
// caso DUPLICATE_ORDER) nunca se desincronice entre los dos flujos.
//
// Esta es exactamente la misma logica que ya tenias en
// create-shop2topup-order.js, solo movida aqui sin cambios de comportamiento.
const crypto = require("crypto");

// Namespace fijo y arbitrario (estandar UUID DNS namespace) solo para tener
// un punto de partida estable al derivar UUIDs v5. No es secreto.
const S2T_UUID_NAMESPACE = "6ba7b810-9dad-11d1-80b4-00c04fd430c8";

function uuidV5FromOrderId(firestoreOrderId) {
  const namespaceBytes = Buffer.from(S2T_UUID_NAMESPACE.replace(/-/g, ""), "hex");
  const nameBytes = Buffer.from(firestoreOrderId, "utf8");
  const hash = crypto.createHash("sha1").update(Buffer.concat([namespaceBytes, nameBytes])).digest();
  const bytes = Buffer.from(hash.subarray(0, 16));
  bytes[6] = (bytes[6] & 0x0f) | 0x50; // version 5
  bytes[8] = (bytes[8] & 0x3f) | 0x80; // variant RFC4122
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

// Traduce el estado que devuelve Shop2Topup al estado interno que usa tu
// panel admin (recibido / en_proceso / completado / rechazado).
function mapShop2topupStatus(s2tStatus) {
  if (s2tStatus === "completed") return "completado";
  if (s2tStatus === "failed" || s2tStatus === "refunded") return "rechazado";
  return "en_proceso";
}

async function createShop2topupOrder({ orderId, subCategoryId, playerId, zoneId, extraFieldName, extraFieldValue }) {
  const apiKey = process.env.SHOP2TOPUP_API_KEY;
  if (!apiKey) {
    return { success: false, message: "Falta configurar SHOP2TOPUP_API_KEY en Netlify" };
  }

  // player_id solo se manda si el producto realmente lo pide (ej. recargas
  // de juego). Las giftcards no estan atadas a ninguna cuenta, asi que no
  // tiene sentido mandar un player_id vacio -- Shop2Topup solo espera los
  // campos que la categoria realmente requiere.
  const requirements = {};
  if (playerId) {
    requirements.player_id = String(playerId);
  }
  if (zoneId) {
    requirements.zone_id = String(zoneId);
  }
  if (extraFieldName && extraFieldValue) {
    requirements[extraFieldName] = extraFieldValue;
  }

  const s2tOrderId = uuidV5FromOrderId(orderId);

  try {
    const res = await fetch("https://portal.shop2topup.com/api/endpoints/v1/orders/create", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        order_id: s2tOrderId,
        sub_category_id: subCategoryId,
        quantity: 1,
        requirements,
      }),
    });

    const data = await res.json();

    if (!res.ok || data.success === false) {
      // DUPLICATE_ORDER: esta orden YA fue creada antes (mismo order_id
      // determinista). No se cobra de nuevo -- consultamos el estado real
      // en vez de dejar el pedido "colgado".
      if (data.error?.code === "DUPLICATE_ORDER") {
        try {
          const statusRes = await fetch(
            `https://portal.shop2topup.com/api/endpoints/v1/orders/${s2tOrderId}`,
            { headers: { Authorization: `Bearer ${apiKey}` } }
          );
          const statusData = await statusRes.json();
          // GET /orders/:id envuelve la orden en "data", no en "order".
          const existingOrder = statusData.order || statusData.data;
          if (statusRes.ok && statusData.success && existingOrder) {
            return {
              success: true,
              order: {
                order_id: existingOrder.order_id || s2tOrderId,
                status: existingOrder.status || "pending",
                internal_status: mapShop2topupStatus(existingOrder.status),
                vouchers: existingOrder.vouchers || [],
              },
            };
          }
        } catch {
          // si falla la consulta de estado, cae al mensaje de error generico de abajo
        }
      }

      return {
        success: false,
        error: data.error || null,
        message: data.error?.message || "No se pudo crear la orden",
      };
    }

    const order = data.order || {};
    return {
      success: true,
      order: {
        order_id: order.order_id || s2tOrderId,
        status: order.status || "pending",
        internal_status: mapShop2topupStatus(order.status),
        vouchers: order.vouchers || [],
      },
    };
  } catch (err) {
    return { success: false, message: "No se pudo contactar al servidor" };
  }
}

async function checkOrderStatus(s2tOrderId) {
  const apiKey = process.env.SHOP2TOPUP_API_KEY;
  if (!apiKey) return null;
  try {
    const res = await fetch(`https://portal.shop2topup.com/api/endpoints/v1/orders/${s2tOrderId}`, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    const data = await res.json();
    const order = data.order || data.data;
    if (!res.ok || data.success === false || !order) return null;
    return {
      order_id: order.order_id || s2tOrderId,
      status: order.status || "pending",
      internal_status: mapShop2topupStatus(order.status),
      vouchers: order.vouchers || [],
    };
  } catch {
    return null;
  }
}

// Dispara (sin esperar el resultado final) la funcion en background que
// sigue consultando el voucher hasta ~24 segundos despues de la compra. Es
// "fire and forget" en el sentido de que no bloqueamos la respuesta al
// cliente por esto -- pero SI dejamos rastro en los logs de exito o fallo,
// para poder diagnosticar sin adivinar.
async function triggerVoucherFollowup(firestoreOrderId, shop2topupOrderId) {
  const baseUrl = process.env.URL || process.env.DEPLOY_PRIME_URL || process.env.DEPLOY_URL;
  if (!baseUrl) {
    console.error("[triggerVoucherFollowup] No hay URL base disponible (process.env.URL vacio) -- no se pudo disparar el seguimiento");
    return;
  }
  const targetUrl = `${baseUrl}/.netlify/functions/shop2topup-voucher-followup-background`;
  try {
    const res = await fetch(targetUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ firestoreOrderId, shop2topupOrderId }),
    });
    console.log(`[triggerVoucherFollowup] Disparado hacia ${targetUrl} -- status HTTP: ${res.status}`);
  } catch (err) {
    console.error(`[triggerVoucherFollowup] Fallo al disparar hacia ${targetUrl}:`, err.message);
  }
}

module.exports = { createShop2topupOrder, checkOrderStatus, triggerVoucherFollowup, uuidV5FromOrderId, mapShop2topupStatus };