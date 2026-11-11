// Recibe los webhooks de Central One y actualiza el pedido en Firestore
// (estado + codigos de giftcard). URL a registrar en Integracion -> Webhooks:
//   https://gamecentervzla.com/.netlify/functions/centralone-webhook
// Firma: sha256=HMAC-SHA256(secreto, timestamp + "." + cuerpo CRUDO).
const crypto = require("crypto");
const admin = require("./lib/firebase");
const { mapCentralOneStatus, firestoreIdFromKey, toVouchers } = require("./lib/centralone");
const db = admin.firestore();

const ok = (obj = { received: true }) => ({ statusCode: 200, body: JSON.stringify(obj) });

function validSig(secret, timestamp, rawBody, signature) {
  if (!signature) return false;
  const expected = "sha256=" + crypto.createHmac("sha256", secret).update(`${timestamp}.${rawBody}`).digest("hex");
  const a = Buffer.from(expected);
  const b = Buffer.from(signature);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

exports.handler = async function (event) {
  if (event.httpMethod !== "POST") return { statusCode: 405, body: "Metodo no permitido" };

  const secret = process.env.CENTRALONE_WEBHOOK_SECRET;
  if (!secret) {
    console.warn("[webhook] CENTRALONE_WEBHOOK_SECRET no configurada -- 200 sin procesar");
    return ok({ received: true, bootstrap: true });
  }

  // Cuerpo CRUDO tal cual llego (no re-serializar nunca).
  const rawBody = event.isBase64Encoded ? Buffer.from(event.body, "base64").toString("utf8") : event.body;
  const h = Object.fromEntries(Object.entries(event.headers || {}).map(([k, v]) => [k.toLowerCase(), v]));
  const timestamp = h["x-centralone-timestamp"];

  // Rechaza avisos con mas de 5 minutos (evita reenvios de avisos capturados).
  if (!timestamp || !Number.isFinite(Number(timestamp)) || Math.abs(Date.now() / 1000 - Number(timestamp)) > 300) {
    console.warn("[webhook] Timestamp ausente o fuera de ventana");
    return { statusCode: 401, body: JSON.stringify({ error: "Invalid timestamp" }) };
  }
  // Durante la rotacion del secreto tambien llega la firma con el secreto anterior.
  const signatureOk =
    validSig(secret, timestamp, rawBody, h["x-centralone-signature"]) ||
    (process.env.CENTRALONE_WEBHOOK_SECRET_PREVIOUS &&
      validSig(process.env.CENTRALONE_WEBHOOK_SECRET_PREVIOUS, timestamp, rawBody, h["x-centralone-signature-previous"]));
  if (!signatureOk) {
    console.warn("[webhook] Firma invalida, se rechaza");
    return { statusCode: 401, body: JSON.stringify({ error: "Invalid signature" }) };
  }

  let payload;
  try { payload = JSON.parse(rawBody); } catch { return { statusCode: 400, body: "Body invalido" }; }

  const eventName = payload.event;
  if (!String(eventName || "").startsWith("order.") || !payload.order) return ok(); // webhook.test, deposit.*, etc.

  const firestoreId = firestoreIdFromKey(payload.order.idempotency_key);
  if (!firestoreId) return ok({ received: true, matched: false });

  try {
    const ref = db.collection("orders").doc(firestoreId);
    const result = await db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      if (!snap.exists) return "sin pedido";
      const cur = snap.data();
      // Avisos repetidos o desordenados: solo se aplica un sequence MAYOR al ultimo procesado.
      const seq = Number(payload.sequence);
      if (Number.isFinite(seq) && cur.centralOneLastSequence >= seq) return "ignorado (sequence viejo)";

      const update = { shop2topupStatus: payload.order.status };
      if (Number.isFinite(seq)) update.centralOneLastSequence = seq;
      if (payload.order.reference_code) update.centralOneReference = payload.order.reference_code;

      const internal = mapCentralOneStatus(payload.order.status);
      const vouchers = toVouchers({ order: { items: payload.order.codes || [] } });
      if (vouchers.length > 0) update.vouchers = vouchers;

      if (internal === "rechazado") {
        // El pago del cliente ya se cobro en el sitio pero Central One no entrego: revisar reembolso.
        update.status = "rechazado";
        update.requiresRefundReview = true;
        update.adminNote = `Central One reporto ${payload.order.status}${payload.order.failure?.code ? ` (${payload.order.failure.code})` : ""}. Revisar reembolso o entrega manual.`;
      } else if (internal === "completado") {
        update.status = "completado";
        update.requiresRefundReview = false;
      } else if (payload.order.status === "partially_completed") {
        update.status = "en_proceso";
        update.requiresRefundReview = true;
        update.adminNote = "Central One entrego solo parte de la orden. Revisar manualmente.";
      }
      tx.update(ref, update);
      return `actualizado a ${update.status || "(sin cambio de estado)"}`;
    });
    console.log(`[webhook] Pedido ${firestoreId}: ${result} (${eventName})`);
    return ok({ received: true });
  } catch (err) {
    console.error("[webhook] Error procesando el evento:", err);
    // 500 => Central One reintenta (la entrega es al menos una vez y ya deduplicamos por sequence).
    return { statusCode: 500, body: JSON.stringify({ error: "internal" }) };
  }
};
