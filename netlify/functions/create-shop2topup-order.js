// Netlify Function: intermediario seguro entre el frontend y Shop2Topup para
// CREAR la orden de recarga. Misma idea que validate-player.js: la API key
// vive solo aqui (variable de entorno en Netlify), nunca en el navegador.
//
// SEGURIDAD: este endpoint es exclusivo del panel admin (boton "Aceptar" /
// "Completar (Shop2Topup)"), asi que ahora exige: 1) sesion valida de
// Firebase, y 2) que ese usuario tenga role == "admin" en su documento de
// users/{uid} -- el MISMO campo que ya usan admin.js y tus Firestore Rules
// para dar acceso al panel (ver admin.js, isAdminUser()). No se creo
// ningun campo ni coleccion nueva. Antes cualquiera que copiara este
// request desde el navegador (F12 -> Network) podia repetirlo sin login y
// crear ordenes reales en Shop2Topup a tu costa.
//
// IMPORTANTE sobre el flujo de Shop2Topup (ver docs oficiales):
// - POST /orders/create es asincrono: puede responder "pending" aunque la
//   orden haya sido aceptada. NO significa que ya se completo la recarga.
// - order_id es la clave de idempotencia: debe ser un UUID. Si reintentas
//   la creacion con el MISMO UUID, Shop2Topup te devuelve la orden ya
//   existente en vez de crear una duplicada (evita cobros dobles).
//   Por eso aqui generamos un UUID v5 DETERMINISTICO a partir del ID del
//   pedido de Firestore: si esta funcion se llama dos veces para el mismo
//   pedido (doble click, reintento de red, etc.), siempre se genera el
//   mismo order_id y Shop2Topup lo protege por su cuenta.
const crypto = require("crypto");
const admin = require("./lib/firebase-admin");
const db = admin.firestore();

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
  // pending, processing, partial, o cualquier otro -> lo dejamos "en_proceso"
  // hasta que un poll o webhook confirme el estado final.
  return "en_proceso";
}

exports.handler = async function (event) {
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, body: JSON.stringify({ success: false, message: "Metodo no permitido" }) };
  }

  // ---- Autenticacion obligatoria: igual que en verify-pago-movil-order.js ----
  const authHeader = event.headers.authorization || event.headers.Authorization || "";
  const idToken = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null;
  if (!idToken) {
    return { statusCode: 401, body: JSON.stringify({ success: false, message: "Falta autenticacion" }) };
  }
  let uid;
  try {
    const decoded = await admin.auth().verifyIdToken(idToken);
    uid = decoded.uid;
  } catch {
    return { statusCode: 401, body: JSON.stringify({ success: false, message: "Sesion invalida" }) };
  }

  // ---- Solo admins pueden crear ordenes directamente en Shop2Topup.
  // Mismo campo que usa admin.js (isAdminUser): users/{uid}.role == "admin" ----
  const userSnap = await db.collection("users").doc(uid).get();
  if (!userSnap.exists || userSnap.data().role !== "admin") {
    return { statusCode: 403, body: JSON.stringify({ success: false, message: "No autorizado" }) };
  }

  let body;
  try {
    body = JSON.parse(event.body);
  } catch {
    return { statusCode: 400, body: JSON.stringify({ success: false, message: "Body invalido" }) };
  }

  const { orderId, subCategoryId, playerId, zoneId, extraFieldName, extraFieldValue } = body;

  // NOTA: playerId ya NO es obligatorio aca -- las giftcards no estan
  // atadas a ninguna cuenta, asi que orderId + subCategoryId alcanza. Esta
  // validacion se habia quedado desactualizada respecto al "requirements"
  // de mas abajo, que ya maneja bien el caso sin playerId; por eso el boton
  // "Completar (Shop2Topup)" fallaba con "Faltan orderId, subCategoryId o
  // playerId" en cualquier giftcard.
  if (!orderId || !subCategoryId) {
    return {
      statusCode: 400,
      body: JSON.stringify({ success: false, message: "Faltan orderId o subCategoryId" }),
    };
  }

  const apiKey = process.env.SHOP2TOPUP_API_KEY;
  if (!apiKey) {
    return {
      statusCode: 500,
      body: JSON.stringify({ success: false, message: "Falta configurar SHOP2TOPUP_API_KEY en Netlify" }),
    };
  }

  // requirements se arma dinamicamente: siempre lleva player_id, y si el
  // producto tiene un campo extra configurado (ej: servidor), se agrega
  // con su propio nombre tal como lo pide Shop2Topup para esa categoria.
  // player_id solo se manda si el producto realmente lo pide (ej. recargas
  // de juego). Las giftcards no estan atadas a ninguna cuenta.
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
      // Caso especial: DUPLICATE_ORDER significa que esta orden YA fue
      // creada antes (mismo order_id derivado del pedido de Firestore).
      // NO se cobra de nuevo -- Shop2Topup solo rechaza el duplicado.
      // En vez de devolver un error y dejar el pedido "colgado" en
      // Firestore, consultamos el estado real de la orden existente.
      if (data.error?.code === "DUPLICATE_ORDER") {
        try {
          const statusRes = await fetch(
            `https://portal.shop2topup.com/api/endpoints/v1/orders/${s2tOrderId}`,
            { headers: { Authorization: `Bearer ${apiKey}` } }
          );
          const statusData = await statusRes.json();
          const existingOrder = statusData.order || statusData.data;
          if (statusRes.ok && statusData.success && existingOrder) {
            return {
              statusCode: 200,
              body: JSON.stringify({
                success: true,
                order: {
                  order_id: existingOrder.order_id || s2tOrderId,
                  status: existingOrder.status || "pending",
                  internal_status: mapShop2topupStatus(existingOrder.status),
                  vouchers: existingOrder.vouchers || [],
                },
              }),
            };
          }
        } catch {
          // si falla la consulta de estado, cae al mensaje de error generico de abajo
        }
      }

      // Errores esperables documentados por Shop2Topup: PLAYER_NOT_FOUND,
      // INSUFFICIENT_BALANCE, OUT_OF_STOCK, PRICE_INCREASED, DUPLICATE_ORDER, etc.
      return {
        statusCode: 200, // devolvemos 200 al frontend para que pueda leer el JSON y mostrar el mensaje
        body: JSON.stringify({
          success: false,
          error: data.error || null,
          message: data.error?.message || "No se pudo crear la orden en Shop2Topup",
        }),
      };
    }

    const order = data.order || {};
    return {
      statusCode: 200,
      body: JSON.stringify({
        success: true,
        order: {
          order_id: order.order_id || s2tOrderId,
          status: order.status || "pending",
          internal_status: mapShop2topupStatus(order.status),
        },
      }),
    };
  } catch (err) {
    return {
      statusCode: 502,
      body: JSON.stringify({ success: false, message: "No se pudo contactar al servidor" }),
    };
  }
};