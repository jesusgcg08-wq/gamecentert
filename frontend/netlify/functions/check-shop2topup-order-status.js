// Netlify Function: consulta el estado ACTUAL de una orden que ya fue creada
// en Shop2Topup. Requiere sesion (token de Firebase) y verifica que el
// pedido le pertenezca a quien pregunta -- SIN esto, cualquiera que supiera
// o calculara un shop2topupOrderId (la formula es publica, ver
// lib/shop2topup.js) podria consultar o robarse el codigo de giftcard de
// otra persona. Nunca se debe devolver el estado/voucher de un pedido sin
// confirmar el dueño primero.

const admin = require("./lib/firebase-admin");
const db = admin.firestore();

function mapShop2topupStatus(s2tStatus) {
  if (s2tStatus === "completed") return "completado";
  if (s2tStatus === "failed" || s2tStatus === "refunded") return "rechazado";
  return "en_proceso";
}

exports.handler = async function (event) {
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, body: JSON.stringify({ success: false, message: "Metodo no permitido" }) };
  }

  let body;
  try {
    body = JSON.parse(event.body);
  } catch {
    return { statusCode: 400, body: JSON.stringify({ success: false, message: "Body invalido" }) };
  }

  const { shop2topupOrderId } = body;
  if (!shop2topupOrderId) {
    return {
      statusCode: 400,
      body: JSON.stringify({ success: false, message: "Falta shop2topupOrderId" }),
    };
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

  // ---- Verificar que el pedido con ese shop2topupOrderId pertenece a este uid ----
  const snap = await db.collection("orders").where("shop2topupOrderId", "==", shop2topupOrderId).limit(1).get();
  if (snap.empty || snap.docs[0].data().userId !== uid) {
    // Mensaje generico a proposito: no confirmamos si el pedido existe o
    // no, para no darle pistas a alguien que este probando IDs ajenos.
    return { statusCode: 403, body: JSON.stringify({ success: false, message: "No autorizado" }) };
  }

  const apiKey = process.env.SHOP2TOPUP_API_KEY;
  if (!apiKey) {
    return {
      statusCode: 500,
      body: JSON.stringify({ success: false, message: "Falta configurar SHOP2TOPUP_API_KEY en Netlify" }),
    };
  }

  try {
    const res = await fetch(`https://portal.shop2topup.com/api/endpoints/v1/orders/${shop2topupOrderId}`, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    const data = await res.json();

    // IMPORTANTE: GET /orders/:id envuelve la orden en "data", NO en "order"
    // (a diferencia de POST /orders/create, que si usa "order"). Se soportan
    // ambos por si acaso para no volver a romperse si Shop2Topup cambia esto.
    const order = data.order || data.data;

    if (!res.ok || data.success === false || !order) {
      return {
        statusCode: 200, // 200 para que el frontend pueda leer el mensaje
        body: JSON.stringify({
          success: false,
          message: data.error?.message || data.message || "No se pudo consultar el estado en",
        }),
      };
    }

    return {
      statusCode: 200,
      body: JSON.stringify({
        success: true,
        order: {
          order_id: order.order_id || shop2topupOrderId,
          status: order.status || "pending",
          internal_status: mapShop2topupStatus(order.status),
          vouchers: order.vouchers || [],
        },
      }),
    };
  } catch (err) {
    return {
      statusCode: 502,
      body: JSON.stringify({ success: false, message: "No se pudo contactar" }),
    };
  }
};