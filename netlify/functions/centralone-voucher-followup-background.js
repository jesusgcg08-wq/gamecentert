// Netlify BACKGROUND Function (el sufijo "-background" es obligatorio: permite
// correr hasta 15 min). Central One responde "confirmed" al crear la orden y el
// codigo de la giftcard sale despues (1-2 min, a veces mas). Aqui se consulta
// la orden como pide su doc (cada ~30 s los primeros 5 min) y se guarda el
// codigo apenas existe. El webhook es un respaldo independiente.
const admin = require("./lib/firebase");
const { checkOrderStatus } = require("./lib/centralone");
const db = admin.firestore();

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const hasVouchers = (d) => Array.isArray(d?.vouchers) && d.vouchers.length > 0;

exports.handler = async function (event) {
  let body;
  try { body = JSON.parse(event.body); } catch { return { statusCode: 400, body: "Body invalido" }; }

  const { firestoreOrderId, centralOneOrderId } = body;
  if (!firestoreOrderId || !centralOneOrderId) return { statusCode: 400, body: "Faltan datos" };

  const orderRef = db.collection("orders").doc(firestoreOrderId);
  // El id guardado en el pedido (campo shop2topupOrderId) debe coincidir: evita disparos con datos inventados.
  const orderSnap = await orderRef.get();
  if (!orderSnap.exists || orderSnap.data().shop2topupOrderId !== centralOneOrderId) {
    console.warn(`[voucher-followup] Pedido ${firestoreOrderId} no coincide, se ignora`);
    return { statusCode: 200, body: "ignorado" };
  }
  if (hasVouchers(orderSnap.data())) return { statusCode: 200, body: "ya tenia vouchers" };

  const maxAttempts = 10; // 10 x 30 s = 5 min
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    await sleep(attempt === 1 ? 15000 : 30000);

    const r = await checkOrderStatus(centralOneOrderId);
    if (!r) continue;
    if (r.internal_status === "en_proceso" && r.status !== "partially_completed") continue; // sigue avanzando

    const fresh = await orderRef.get(); // por si el webhook escribio mientras tanto
    if (hasVouchers(fresh.data())) return { statusCode: 200, body: "el webhook llego primero" };

    const update = { shop2topupStatus: r.status };
    if (r.vouchers.length > 0) {
      update.vouchers = r.vouchers;
      update.status = "completado";
    } else if (r.internal_status === "rechazado") {
      update.status = "rechazado";
      update.requiresRefundReview = true;
      update.adminNote = `Central One reporto ${r.status}${r.failure?.code ? ` (${r.failure.code})` : ""}. Revisar reembolso o entrega manual.`;
    } else if (r.status === "partially_completed") {
      update.requiresRefundReview = true;
      update.adminNote = "Central One entrego solo parte de la orden. Revisar manualmente.";
    } else if (r.codesPending) {
      continue; // entregada pero el codigo aun no se pudo leer: reintenta
    }
    await orderRef.update(update);
    console.log(`[voucher-followup] Pedido ${firestoreOrderId} actualizado en el intento ${attempt}`);
    return { statusCode: 200, body: "actualizado" };
  }

  console.warn(`[voucher-followup] Pedido ${firestoreOrderId} sin cerrar tras ${maxAttempts} intentos. Queda pendiente del webhook o revision manual.`);
  return { statusCode: 200, body: "se agotaron los intentos" };
};
