// Consulta el estado ACTUAL de una orden en Central One. Requiere sesion y que el
// pedido pertenezca a quien pregunta (nunca se devuelve estado/codigos de pedidos ajenos).
const admin = require("./lib/firebase");
const { checkOrderStatusDetailed } = require("./lib/centralone");
const db = admin.firestore();

const reply = (obj, statusCode = 200) => ({ statusCode, body: JSON.stringify(obj) });

exports.handler = async function (event) {
  if (event.httpMethod !== "POST") return reply({ success: false, message: "Metodo no permitido" }, 405);
  let body;
  try { body = JSON.parse(event.body); } catch { return reply({ success: false, message: "Body invalido" }, 400); }

  // Acepta el id del pedido en Firestore (orderId) o el id de Central One
  // (shop2topupOrderId, nombre de campo conservado).
  const { orderId, shop2topupOrderId: bodyCentralId } = body;
  if (!orderId && !bodyCentralId) return reply({ success: false, message: "Falta orderId" }, 400);

  const authHeader = event.headers.authorization || event.headers.Authorization || "";
  const idToken = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null;
  if (!idToken) return reply({ success: false, message: "Falta autenticacion" }, 401);
  let uid;
  try { uid = (await admin.auth().verifyIdToken(idToken)).uid; } catch { return reply({ success: false, message: "Sesion invalida" }, 401); }

  let orderRef;
  let orderData;
  if (orderId) {
    const one = await db.collection("orders").doc(String(orderId)).get();
    if (!one.exists) return reply({ success: false, message: "Pedido no encontrado" }, 404);
    orderRef = one.ref;
    orderData = one.data();
  } else {
    const snap = await db.collection("orders").where("shop2topupOrderId", "==", bodyCentralId).limit(1).get();
    if (snap.empty) return reply({ success: false, message: "No autorizado" }, 403);
    orderRef = snap.docs[0].ref;
    orderData = snap.docs[0].data();
  }
  if (orderData.userId !== uid) return reply({ success: false, message: "No autorizado" }, 403);

  const centralId = orderData.shop2topupOrderId;
  if (!centralId) return reply({ success: true, order: null, pending: true });

  // Si ya hay codigos guardados, no hace falta molestar a Central One.
  if (Array.isArray(orderData.vouchers) && orderData.vouchers.length > 0) {
    return reply({ success: true, order: { vouchers: orderData.vouchers, internal_status: "completado" } });
  }

  const { order, error } = await checkOrderStatusDetailed(centralId);
  if (!order) {
    console.error(`[check-centralone-order-status] pedido ${orderRef.id} (Central One ${centralId}):`, error);
    return reply({ success: false, message: "No se pudo consultar el estado", detail: error });
  }

  // Se guarda lo que Central One ya entrego, asi el dashboard lo ve aunque el
  // webhook o el seguimiento en background no hayan alcanzado a escribirlo.
  try {
    const update = {};
    if (order.vouchers.length > 0) {
      update.vouchers = order.vouchers;
      update.status = "completado";
      update.shop2topupStatus = order.status;
    } else if (order.internal_status === "completado" && orderData.status !== "completado") {
      update.status = "completado";
      update.shop2topupStatus = order.status;
    }
    if (Object.keys(update).length) await orderRef.update(update);
  } catch (err) {
    console.error("[check-centralone-order-status] no se pudo guardar:", err);
  }
  return reply({ success: true, order });
};
