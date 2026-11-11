// Netlify Function: punto de entrada RAPIDO para pago movil. Ya NO llama a
// Pabilo aqui -- Pabilo a veces tarda mas de lo que Netlify deja esperar en
// una funcion normal, y si se agota el tiempo el pago SI se alcanza a
// verificar en Pabilo (gastando credito) pero la funcion muere antes de leer
// la respuesta, asi que el cliente ve error y reintenta, gastando OTRO
// credito de Pabilo por las puras.
//
// Solucion: aqui solo se valida lo rapido (login, producto/opcion/cupon,
// candado de referencia) y se crea un documento en "pendingVerifications"
// con todo lo necesario. Despues se dispara (fire-and-forget, mismo patron
// que triggerVoucherFollowup en lib/centralone.js) la funcion en BACKGROUND
// verify-pago-movil-order-background.js, que aguanta hasta 15 minutos y ahi
// SI se llama a Pabilo sin importar cuanto tarde. El frontend escucha ese
// documento con onSnapshot y reacciona cuando el estado cambia de
// "verificando" a "listo".

const admin = require("./lib/firebase");
const { opcionReal, porcentajeCupon, textoCorto, referenciaValida, claveInterna, dentroDelLimite } = require("./lib/seguridad");

const db = admin.firestore();

function fail(statusCode, message, extra = {}) {
  return { statusCode, body: JSON.stringify({ success: false, message, ...extra }) };
}

async function mainHandler(event) {
  if (event.httpMethod !== "POST") {
    return fail(405, "Metodo no permitido");
  }

  let body;
  try {
    body = JSON.parse(event.body);
  } catch {
    return fail(400, "Body invalido");
  }

  const { productId, optionId, couponCode } = body;
  const bankReference = referenciaValida(body.bankReference);
  const payerPhone = textoCorto(body.payerPhone, 20);
  const playerGameId = textoCorto(body.playerGameId, 60);
  const zoneId = textoCorto(body.zoneId, 30);
  const extraFieldValue = textoCorto(body.extraFieldValue, 120);

  if (!productId || typeof productId !== "string" || !optionId || !bankReference || !payerPhone) {
    return fail(400, "Faltan datos del pedido o del pago");
  }
  if (playerGameId === null || zoneId === null || extraFieldValue === null) {
    return fail(400, "Datos del pedido no validos");
  }

  // ---- 1) El uid SIEMPRE sale del token de Firebase, nunca del body. ----
  const headers = event.headers || {};
  const authHeader = headers.authorization || headers.Authorization || "";
  const idToken = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null;
  if (!idToken) return fail(401, "Falta autenticacion");

  let uid;
  try {
    const decoded = await admin.auth().verifyIdToken(idToken);
    uid = decoded.uid;
  } catch {
    return fail(401, "Sesion invalida, inicia sesion de nuevo");
  }

  // Limite de verificaciones de pago por cuenta: evita que alguien pruebe
  // referencias al azar hasta "encontrar" el pago de otra persona.
  if (!(await dentroDelLimite(db, "pago", uid, 12, 30 * 60 * 1000))) {
    return fail(429, "Hiciste demasiados intentos seguidos. Espera unos minutos o escribenos por WhatsApp.");
  }

  // ---- 2) Producto/opcion reales tal como estan en Firestore hoy. ----
  const productSnap = await db.collection("products").doc(productId).get();
  if (!productSnap.exists || productSnap.data().active !== true) {
    return fail(404, "Producto no disponible");
  }
  const product = productSnap.data();
  const option = opcionReal(product, optionId);
  if (!option) return fail(404, "Opcion de recarga no valida");

  if (product.requiresId && (!playerGameId || !String(playerGameId).trim())) {
    return fail(400, `Falta ${product.requiresIdLabel || "tu ID"}`);
  }
  if (product.requiresZoneId && (!zoneId || !String(zoneId).trim())) {
    return fail(400, `Falta ${product.requiresZoneIdLabel || "tu ID de Zona"}`);
  }
  if (product.extraField && product.extraField.fieldName && !extraFieldValue) {
    return fail(400, `Falta ${product.extraField.fieldLabel || "un dato adicional"}`);
  }

  // ---- 3) Cupon: misma logica de siempre. ----
  let discountPercent = 0;
  let appliedCouponCode = null;
  if (couponCode) {
    const code = String(couponCode).toUpperCase();
    const couponSnap = await db.collection("coupons").doc(code).get();
    if (couponSnap.exists && couponSnap.data().active === true) {
      const redemptionSnap = await db.collection("couponRedemptions").doc(`${uid}_${code}`).get();
      if (!redemptionSnap.exists) {
        discountPercent = porcentajeCupon(couponSnap.data().discountPercent);
        appliedCouponCode = discountPercent ? code : null;
      }
    }
  }

  const totalUsd = Number(option.priceUsd) * (1 - discountPercent / 100);

  const settingsSnap = await db.collection("settings").doc("main").get();
  const exchangeRateBsPerUsd = settingsSnap.exists ? Number(settingsSnap.data().exchangeRateBsPerUsd) || 0 : 0;
  // Sin tasa, el total en Bs daria 0 y cualquier pago "alcanzaria".
  if (!(exchangeRateBsPerUsd > 0)) {
    return fail(500, "La tasa de cambio no esta configurada, contacta a soporte.");
  }
  const expectedTotalBs = totalUsd * exchangeRateBsPerUsd;

  // ---- 4) Candado por referencia -- se crea aqui y NO se libera en esta
  // funcion: se libera en verify-pago-movil-order-background.js cuando
  // termine (exito o error), porque tiene que durar todo lo que tarde la
  // verificacion real contra Pabilo. ----
  const lockRef = db.collection("paymentVerificationLocks").doc(`${String(bankReference).trim()}`);
  try {
    await db.runTransaction(async (tx) => {
      const existing = await tx.get(lockRef);
      if (existing.exists) throw new Error("REFERENCE_IN_USE");
      tx.set(lockRef, { uid, productId, createdAt: admin.firestore.FieldValue.serverTimestamp() });
    });
  } catch (err) {
    if (err.message === "REFERENCE_IN_USE") {
      return fail(409, "Esta referencia ya se esta verificando. Espera unos segundos e intenta de nuevo.");
    }
    return fail(500, "No se pudo procesar la verificacion, intenta de nuevo");
  }

  // ---- 5) Documento de verificacion pendiente: el frontend lo escucha con
  // onSnapshot para saber cuando termino. ----
  const pendingRef = db.collection("pendingVerifications").doc();
  // Si esto falla, se libera el candado (antes quedaba trancada para siempre
  // esa referencia y nadie podia volver a usarla).
  try {
  await pendingRef.set({
    uid,
    productId,
    optionId,
    productNameSnapshot: product.name,
    optionLabelSnapshot: option.label,
    priceUsdSnapshot: option.priceUsd,
    couponCode: appliedCouponCode,
    discountPercent,
    totalUsd,
    exchangeRateBsPerUsd,
    expectedTotalBs,
    bankReference: String(bankReference).trim(),
    payerPhone: String(payerPhone).trim(),
    playerGameId: product.requiresId ? String(playerGameId).trim() : "",
    zoneId: product.requiresZoneId ? String(zoneId).trim() : "",
    isGiftcard: product.category === "giftcards",
    autoRecharge: !!product.autoRecharge,
    shop2topupItemId: product.autoRecharge ? option.shop2topupItemId || null : null,
    extraFieldName: product.extraField ? product.extraField.fieldName : "",
    extraFieldValue: product.extraField ? extraFieldValue : "",
    verificationState: "verificando",
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
  });
  } catch (err) {
    await lockRef.delete().catch(() => {});
    throw err;
  }

  // ---- 6) Se dispara la funcion en background SIN esperar a que termine
  // (mismo patron que triggerVoucherFollowup): solo se espera la
  // confirmacion casi instantanea de que la recibio, nunca el resultado
  // final -- si no se espera ni eso, Netlify puede congelar el contenedor
  // antes de que el fetch salga. ----
  const baseUrl = process.env.URL || process.env.DEPLOY_PRIME_URL || process.env.DEPLOY_URL;
  if (baseUrl) {
    try {
      const dispatchRes = await fetch(`${baseUrl}/.netlify/functions/verify-pago-movil-order-background`, {
        method: "POST",
        // Clave interna: sin ella la funcion en segundo plano no hace nada
        // (asi nadie de afuera la puede disparar).
        headers: { "Content-Type": "application/json", "x-gc-interno": claveInterna() },
        body: JSON.stringify({ pendingId: pendingRef.id }),
      });
      console.log(`[verify-pago-movil-order] Background disparado -- status HTTP: ${dispatchRes.status}`);
    } catch (err) {
      console.error("[verify-pago-movil-order] No se pudo disparar el background:", err.message);
    }
  } else {
    console.error("[verify-pago-movil-order] No hay URL base disponible (process.env.URL vacio), no se pudo disparar el background");
  }

  return {
    statusCode: 200,
    body: JSON.stringify({ success: true, pending: true, pendingId: pendingRef.id }),
  };
}

// Envoltorio: pase lo que pase (TypeError, Firestore caido, env vars faltantes),
// SIEMPRE se responde JSON. Antes, una excepcion no capturada hacia que Netlify
// devolviera texto plano "TypeError: ..." con 500 y el frontend reventaba en
// res.json() con "Unexpected token 'T'".
exports.handler = async function (event) {
  try {
    return await mainHandler(event);
  } catch (err) {
    console.error("[verify-pago-movil-order] error no controlado:", err);
    return fail(500, "Error interno al iniciar la verificacion, intenta de nuevo");
  }
};
