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
// que triggerVoucherFollowup en lib/shop2topup.js) la funcion en BACKGROUND
// verify-pago-movil-order-background.js, que aguanta hasta 15 minutos y ahi
// SI se llama a Pabilo sin importar cuanto tarde. El frontend escucha ese
// documento con onSnapshot y reacciona cuando el estado cambia de
// "verificando" a "listo".

const admin = require("./lib/firebase-admin");

const db = admin.firestore();

function fail(statusCode, message, extra = {}) {
  return { statusCode, body: JSON.stringify({ success: false, message, ...extra }) };
}

exports.handler = async function (event) {
  if (event.httpMethod !== "POST") {
    return fail(405, "Metodo no permitido");
  }

  let body;
  try {
    body = JSON.parse(event.body);
  } catch {
    return fail(400, "Body invalido");
  }

  const { productId, optionId, couponCode, bankReference, payerPhone, playerGameId, zoneId, extraFieldValue } = body;

  if (!productId || !optionId || !bankReference || !payerPhone) {
    return fail(400, "Faltan datos del pedido o del pago");
  }

  // ---- 1) El uid SIEMPRE sale del token de Firebase, nunca del body. ----
  const authHeader = event.headers.authorization || event.headers.Authorization || "";
  const idToken = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null;
  if (!idToken) return fail(401, "Falta autenticacion");

  let uid;
  try {
    const decoded = await admin.auth().verifyIdToken(idToken);
    uid = decoded.uid;
  } catch {
    return fail(401, "Sesion invalida, inicia sesion de nuevo");
  }

  // ---- 2) Producto/opcion reales tal como estan en Firestore hoy. ----
  const productSnap = await db.collection("products").doc(productId).get();
  if (!productSnap.exists || productSnap.data().active !== true) {
    return fail(404, "Producto no disponible");
  }
  const product = productSnap.data();
  const option = (product.options || {})[optionId];
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
        discountPercent = couponSnap.data().discountPercent;
        appliedCouponCode = code;
      }
    }
  }

  const totalUsd = option.priceUsd * (1 - discountPercent / 100);

  const settingsSnap = await db.collection("settings").doc("main").get();
  const exchangeRateBsPerUsd = settingsSnap.exists ? settingsSnap.data().exchangeRateBsPerUsd || 0 : 0;
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
    autoRecharge: !!product.autoRecharge,
    shop2topupItemId: product.autoRecharge ? option.shop2topupItemId || null : null,
    extraFieldName: product.extraField ? product.extraField.fieldName : "",
    extraFieldValue: product.extraField ? extraFieldValue : "",
    verificationState: "verificando",
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
  });

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
        headers: { "Content-Type": "application/json" },
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
};