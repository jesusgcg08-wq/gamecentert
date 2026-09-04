// Netlify Function: recibe los webhooks de Shop2Topup (order.completed,
// order.failed, order.refunded, webhook.test) y actualiza el pedido
// correspondiente en Firestore -- incluyendo los codigos de giftcard
// (vouchers) cuando el pedido se completa.
//
// Por que hace falta esto ademas de lo que ya tenias: create-shop2topup-order
// y los 3 verify-*/wallet-pay-order ya marcan "completado" apenas Shop2Topup
// ACEPTA la orden (por decision tuya, sin esperar el estado final). Pero
// solo el webhook trae el array "vouchers" con el codigo real de la
// giftcard -- eso NUNCA viene en la respuesta de /orders/create, solo en
// el webhook de order.completed (o si consultas /orders/:id despues). Asi
// que aunque el pedido ya diga "completado", sin este webhook el cliente
// nunca veria el codigo de su giftcard en el dashboard.
//
// IMPORTANTE sobre la verificacion de firma: hay que calcular el HMAC
// sobre el cuerpo CRUDO (los mismos bytes que Shop2Topup firmo), antes de
// hacer JSON.parse. Netlify entrega event.body ya como el string crudo del
// POST (o base64 si isBase64Encoded), asi que NO se debe re-serializar
// nada -- se firma exactamente ese string/buffer.
//
// Variables de entorno necesarias:
//   FIREBASE_SERVICE_ACCOUNT_BASE64 (ya la tienes)
//   SHOP2TOPUP_WEBHOOK_SECRET -> el secreto hexadecimal de 64 caracteres
//                                 que te muestra Shop2Topup UNA sola vez
//                                 al registrar la URL del webhook en
//                                 "Acceso API" de su panel

const crypto = require("crypto");
const admin = require("./lib/firebase-admin");

const db = admin.firestore();

function mapShop2topupStatus(s2tStatus) {
  if (s2tStatus === "completed") return "completado";
  if (s2tStatus === "failed" || s2tStatus === "refunded") return "rechazado";
  return "en_proceso";
}

function verifySignature(rawBody, signatureHeader, secret) {
  if (!signatureHeader) return false;
  const expected = "sha256=" + crypto.createHmac("sha256", secret).update(rawBody).digest("hex");
  const a = Buffer.from(expected);
  const b = Buffer.from(signatureHeader);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

exports.handler = async function (event) {
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, body: "Metodo no permitido" };
  }

  const secret = process.env.SHOP2TOPUP_WEBHOOK_SECRET;
  if (!secret) {
    // Todavia no configuraste el secreto (normal la primera vez: Shop2Topup
    // te lo muestra recien cuando registras la URL). Respondemos 200 para
    // que la validacion inicial de su panel pase, PERO sin verificar firma
    // ni tocar Firestore -- en este estado la funcion no hace nada real.
    // En cuanto agregues SHOP2TOPUP_WEBHOOK_SECRET y hagas deploy de nuevo,
    // este atajo se desactiva solo y empieza a verificar cada webhook.
    console.warn("[webhook] SHOP2TOPUP_WEBHOOK_SECRET no configurada todavia -- respondiendo 200 sin procesar (modo bootstrap)");
    return { statusCode: 200, body: JSON.stringify({ received: true, bootstrap: true }) };
  }

  // Cuerpo crudo tal cual llego -- si Netlify lo mando en base64 (puede
  // pasar segun el runtime), se decodifica a Buffer sin tocar el contenido;
  // si no, se usa el string tal cual. En ambos casos NO se hace JSON.parse
  // todavia, para no alterar los bytes antes de verificar la firma.
  const rawBody = event.isBase64Encoded ? Buffer.from(event.body, "base64") : event.body;

  const signatureHeader = event.headers["x-shop2topup-signature"] || event.headers["X-Shop2Topup-Signature"];
  if (!verifySignature(rawBody, signatureHeader, secret)) {
    console.warn("[webhook] Firma invalida, se rechaza");
    return { statusCode: 401, body: JSON.stringify({ error: "Invalid signature" }) };
  }

  let payload;
  try {
    payload = JSON.parse(rawBody.toString("utf8"));
  } catch {
    return { statusCode: 400, body: "Body invalido" };
  }

  const { event: eventName, data } = payload;

  // webhook.test: solo confirma que tu endpoint responde 2xx, no hay nada
  // que actualizar en Firestore.
  if (eventName === "webhook.test") {
    return { statusCode: 200, body: JSON.stringify({ received: true }) };
  }

  if (!data || !data.order_id) {
    return { statusCode: 200, body: JSON.stringify({ received: true, ignored: "sin order_id" }) };
  }

  try {
    // El order_id de Shop2Topup se guardo en el pedido como
    // "shop2topupOrderId" (ver create-shop2topup-order.js / lib/shop2topup.js).
    const snap = await db.collection("orders").where("shop2topupOrderId", "==", data.order_id).limit(1).get();

    if (snap.empty) {
      // No es necesariamente un error -- puede ser un webhook.test antiguo
      // o una orden que no vino de este sitio. Respondemos 200 igual para
      // que Shop2Topup no lo marque como entrega fallida.
      console.warn(`[webhook] No se encontro pedido con shop2topupOrderId=${data.order_id}`);
      return { statusCode: 200, body: JSON.stringify({ received: true, matched: false }) };
    }

    const orderDoc = snap.docs[0];
    const updateData = {
      status: mapShop2topupStatus(data.status),
      shop2topupStatus: data.status,
    };

    // Los vouchers (codigos de giftcard) solo vienen en order.completed, y
    // solo si el producto entrega codigo (returns_voucher). Se guardan tal
    // cual para que el dashboard los muestre.
    if (Array.isArray(data.vouchers) && data.vouchers.length > 0) {
      updateData.vouchers = data.vouchers;
    }

    await orderDoc.ref.update(updateData);
    console.log(`[webhook] Pedido ${orderDoc.id} actualizado a "${updateData.status}" (evento ${eventName})`);

    return { statusCode: 200, body: JSON.stringify({ received: true, matched: true }) };
  } catch (err) {
    console.error("[webhook] Error procesando el evento:", err);
    // Igual respondemos 200: Shop2Topup no reintenta (un solo intento), asi
    // que un 500 aca no ayuda -- pero si quieres verlo en tus logs de
    // Netlify para investigar manualmente, este console.error queda ahi.
    return { statusCode: 200, body: JSON.stringify({ received: true, error: "internal" }) };
  }
};


