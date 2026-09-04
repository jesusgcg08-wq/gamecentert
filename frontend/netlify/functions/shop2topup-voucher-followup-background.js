// Netlify BACKGROUND Function (el sufijo "-background" es obligatorio y es
// lo que le dice a Netlify que la deje correr hasta 15 minutos en vez de
// los ~10 segundos normales de una funcion sincrona).
//
// Por que existe: /orders/create de Shop2Topup responde "pending" antes de
// que el codigo de la giftcard este listo, y el tiempo real que tardan en
// terminarlo varia (a veces 2s, a veces mas de 10s). Hacer ese reintento
// DENTRO de wallet-pay-order.js / verify-*-order.js es arriesgado: sumarle
// varios segundos de espera a una funcion sincrona la puede empujar contra
// el limite de tiempo de Netlify y tumbar la compra a medias (orden ya
// creada en Shop2Topup, pero la funcion muere antes de guardar el voucher).
//
// Esta funcion se dispara SIN esperar respuesta (fire-and-forget, ver
// lib/shop2topup.js -> triggerVoucherFollowup) justo despues de que la
// compra ya se confirmo y respondio al cliente. Corre aparte, con todo el
// tiempo del mundo, y guarda el voucher en Firestore apenas Shop2Topup lo
// tenga listo. El webhook (shop2topup-webhook.js) sigue siendo un segundo
// respaldo independiente -- cualquiera de los dos que llegue primero deja
// el pedido completo.

const admin = require("./lib/firebase-admin");
const { checkOrderStatus, mapShop2topupStatus } = require("./lib/shop2topup");

const db = admin.firestore();

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

exports.handler = async function (event) {
  let body;
  try {
    body = JSON.parse(event.body);
  } catch {
    return { statusCode: 400, body: "Body invalido" };
  }

  const { firestoreOrderId, shop2topupOrderId } = body;
  if (!firestoreOrderId || !shop2topupOrderId) {
    return { statusCode: 400, body: "Faltan datos" };
  }

  const orderRef = db.collection("orders").doc(firestoreOrderId);

  // Verificacion minima: que el pedido exista y que el shop2topupOrderId
  // coincida con el que ya tiene guardado -- evita que alguien dispare esta
  // funcion "a mano" con datos inventados para hacerte gastar cuota de
  // Netlify o de la API de Shop2Topup sin sentido.
  const orderSnap = await orderRef.get();
  if (!orderSnap.exists || orderSnap.data().shop2topupOrderId !== shop2topupOrderId) {
    console.warn(`[voucher-followup] Pedido ${firestoreOrderId} no coincide, se ignora`);
    return { statusCode: 200, body: "ignorado" };
  }

  // Si ya tiene vouchers (el webhook le gano la carrera, o llego antes),
  // no hay nada que hacer.
  if (Array.isArray(orderSnap.data().vouchers) && orderSnap.data().vouchers.length > 0) {
    return { statusCode: 200, body: "ya tenia vouchers" };
  }

  const maxAttempts = 8;
  const intervalMs = 3000; // 8 intentos x 3s = 24 segundos de cobertura

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    await sleep(intervalMs);

    const result = await checkOrderStatus(shop2topupOrderId);
    if (!result) continue; // fallo de red puntual, se sigue intentando

    if (result.internal_status === "en_proceso" && (!result.vouchers || result.vouchers.length === 0)) {
      continue; // sigue pendiente, se intenta de nuevo
    }

    // Llegamos a un estado final (completado con o sin voucher, o
    // rechazado) -- otra vuelta a leer el doc por si el webhook ya escribio
    // algo mientras tanto, para no pisarlo con datos viejos.
    const freshSnap = await orderRef.get();
    if (Array.isArray(freshSnap.data()?.vouchers) && freshSnap.data().vouchers.length > 0) {
      return { statusCode: 200, body: "el webhook llego primero" };
    }

    const updateData = { shop2topupStatus: result.status };
    if (result.vouchers && result.vouchers.length > 0) {
      updateData.vouchers = result.vouchers;
      updateData.status = "completado";
    } else if (mapShop2topupStatus(result.status) === "rechazado") {
      updateData.status = "rechazado";
    }
    await orderRef.update(updateData);
    console.log(`[voucher-followup] Pedido ${firestoreOrderId} actualizado en el intento ${attempt}`);
    return { statusCode: 200, body: "actualizado" };
  }

  console.warn(`[voucher-followup] Pedido ${firestoreOrderId} sigue sin voucher tras ${maxAttempts} intentos (~24s). Queda pendiente del webhook o revision manual.`);
  return { statusCode: 200, body: "se agotaron los intentos" };
};