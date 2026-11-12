// Netlify Function: paga un pedido con el saldo de la Wallet del cliente.
// Mismo patron que verify-pago-movil-order.js (revalida producto/opcion/cupon
// SIEMPRE contra Firestore, nunca contra lo que mande el navegador, y crea el
// pedido con permisos de servidor via firebase-admin), pero en vez de
// verificar un pago externo (Pabilo), el "pago" es descontar saldo interno.
//
// Regla de negocio (asi la pidio el cliente):
//  - Si el producto es MANUAL (sin autoRecharge): el saldo se descuenta de
//    una vez -- ya esta "confirmado" por ser dinero interno -- y el pedido
//    queda "en_proceso" para procesarlo a mano y avisar por WhatsApp.
//  - Si el producto es AUTOMATICO (autoRecharge): el saldo se APARTA primero
//    (se descuenta en una transaccion junto con la creacion del pedido) y
//    despues se pide la recarga a Central One. Si Central One la rechaza, el
//    saldo se devuelve solo. Antes se cobraba DESPUES de la recarga, y varios
//    pedidos en paralelo podian llevarse varias recargas pagando una sola.

const admin = require("./lib/firebase");
const { createCentralOneOrder, triggerVoucherFollowup } = require("./lib/centralone");
const { opcionReal, porcentajeCupon, textoCorto } = require("./lib/seguridad");
const { leerSaldo, guardarSaldo } = require("./lib/wallet");

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

  const { productId, optionId, couponCode } = body;
  const playerGameId = textoCorto(body.playerGameId, 60);
  const zoneId = textoCorto(body.zoneId, 30);
  const extraFieldValue = textoCorto(body.extraFieldValue, 120);
  if (!productId || typeof productId !== "string" || !optionId || playerGameId === null || zoneId === null || extraFieldValue === null) {
    return fail(400, "Faltan datos del pedido");
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

  // ---- 3) Cupon: misma logica que verify-pago-movil-order.js. ----
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

  const totalUsd = Math.round(Number(option.priceUsd) * (1 - discountPercent / 100) * 100) / 100;

  // ---- 4) El saldo REAL se revisa abajo, dentro de la transaccion, en
  // wallets/{uid} (ver lib/wallet.js). El numero del perfil del cliente NO
  // cuenta: el cliente lo puede editar. ----

  const baseOrderData = {
    userId: uid,
    productId,
    optionId,
    productNameSnapshot: product.name,
    optionLabelSnapshot: option.label,
    priceUsdSnapshot: option.priceUsd,
    couponCode: appliedCouponCode,
    discountPercent,
    totalUsd,
    exchangeRateBsPerUsd: 0,
    paymentMethod: "wallet",
    isGiftcard: product.category === "giftcards",
    paymentProof: {},
    playerGameId: product.requiresId ? String(playerGameId).trim() : "",
    zoneId: product.requiresZoneId ? zoneId : "",
    autoRecharge: !!product.autoRecharge,
    shop2topupItemId: product.autoRecharge ? option.shop2topupItemId || null : null,
    extraFieldName: product.extraField ? product.extraField.fieldName : "",
    extraFieldValue: product.extraField ? extraFieldValue : "",
    adminNote: "",
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
  };

  const receiptBase = {
    productName: product.name,
    optionLabel: option.label,
    totalUsd,
    playerGameId: baseOrderData.playerGameId,
    paymentMethod: "Wallet",
    date: new Date().toISOString(),
  };

  // ---- Cobro: descuenta el saldo, crea el pedido y marca el cupon como
  // usado, TODO en una sola transaccion. Si dos pedidos llegan a la vez,
  // Firestore los pone en fila: el segundo ya ve el saldo descontado. ----
  const orderRef = db.collection("orders").doc();
  const cuponRef = appliedCouponCode ? db.collection("couponRedemptions").doc(`${uid}_${appliedCouponCode}`) : null;
  let newBalanceUsd;
  try {
    await db.runTransaction(async (tx) => {
      const { saldo: balance, migracion } = await leerSaldo(tx, db, uid);
      const cuponSnap = cuponRef ? await tx.get(cuponRef) : null;
      if (balance < totalUsd) throw new Error("INSUFFICIENT_BALANCE");
      if (cuponSnap && cuponSnap.exists) throw new Error("COUPON_USED");
      newBalanceUsd = Math.round((balance - totalUsd) * 100) / 100;

      tx.set(orderRef, { ...baseOrderData, status: "en_proceso", walletCharged: true });
      guardarSaldo(tx, db, uid, newBalanceUsd, migracion);
      if (cuponRef) {
        tx.create(cuponRef, { uid, code: appliedCouponCode, usedAt: admin.firestore.FieldValue.serverTimestamp() });
      }
    });
  } catch (err) {
    if (err.message === "INSUFFICIENT_BALANCE") {
      return fail(400, "No tienes saldo suficiente en tu wallet para este pedido.");
    }
    if (err.message === "COUPON_USED") {
      return fail(400, "Ese cupon ya lo usaste. Quitalo e intenta de nuevo.");
    }
    console.error(err);
    return fail(500, "No se pudo procesar el pago, intenta de nuevo");
  }

  // Devuelve el saldo apartado (cuando Central One rechaza la recarga).
  // Revisa walletCharged dentro de la transaccion para no devolver dos veces.
  async function devolverSaldo(nota) {
    let saldoFinal = null;
    await db.runTransaction(async (tx) => {
      const { saldo: balance, migracion } = await leerSaldo(tx, db, uid);
      const orderSnap = await tx.get(orderRef);
      if (!orderSnap.exists || orderSnap.data().walletCharged !== true) return;
      saldoFinal = Math.round((balance + totalUsd) * 100) / 100;
      guardarSaldo(tx, db, uid, saldoFinal, migracion);
      tx.update(orderRef, { status: "rechazado", walletCharged: false, walletRefunded: true, adminNote: nota });
      if (cuponRef) tx.delete(cuponRef);
    });
    return saldoFinal;
  }

  // ================= MANUAL: ya se desconto, queda en_proceso =================
  if (!product.autoRecharge) {

    return {
      statusCode: 200,
      body: JSON.stringify({
        success: true,
        autoRecharge: false,
        status: "en_proceso",
        needsWhatsapp: true,
        whatsappNote: "Tu pago con Wallet fue confirmado. Ya puedes proceder con la recarga.",
        newBalanceUsd,
        receipt: { ...receiptBase, orderId: orderRef.id },
      }),
    };
  }

  // ================= AUTOMATICA: saldo ya apartado, ahora Central One =================
  let s2tResult;
  try {
    s2tResult = await createCentralOneOrder({
      orderId: orderRef.id,
      subCategoryId: option.shop2topupItemId,
      playerId: baseOrderData.playerGameId,
      zoneId: baseOrderData.zoneId,
      extraFieldName: baseOrderData.extraFieldName,
      extraFieldValue: baseOrderData.extraFieldValue,
    });
  } catch (err) {
    // Error de conexion: NO sabemos si Central One alcanzo a hacer la
    // recarga, asi que el saldo queda apartado y el admin lo revisa (si se
    // devolviera solo, alguien podria quedarse con la recarga gratis).
    console.error(err);
    await orderRef.update({
      adminNote: "Error de conexion con Central One. El saldo quedo descontado: revisar en Central One si la recarga se hizo; si no, devolver el saldo.",
      requiresRefundReview: true,
    });
    return fail(502, "No pudimos confirmar tu recarga. Tu saldo quedo apartado mientras lo revisamos: escribenos por WhatsApp y lo resolvemos.", {
      code: "RECHARGE_FAILED",
      needsWhatsapp: true,
      orderId: orderRef.id,
    });
  }

  const s2tSucceeded = s2tResult.success && s2tResult.order && s2tResult.order.internal_status !== "rechazado";

  if (!s2tSucceeded) {
    // La orden en Central One fue rechazada (ej. ID de jugador invalido, sin
    // stock, etc.) o la funcion fallo -- NO se descuenta saldo, asi que aqui
    // no hace falta hablar de reembolso (no hubo cobro), solo avisar y dar
    // la opcion de contactar por WhatsApp si el cliente quiere completarlo
    // de otra forma.
    const note = s2tResult.message || s2tResult.order?.status || "La recarga automatica fue rechazada.";
    let saldoDevuelto = null;
    try {
      saldoDevuelto = await devolverSaldo(`${note} (saldo devuelto automaticamente)`);
    } catch (err) {
      console.error("[wallet-pay-order] no se pudo devolver el saldo:", err);
      await orderRef
        .update({ status: "rechazado", adminNote: `${note}. OJO: no se pudo devolver el saldo solo, devolverlo a mano.`, requiresRefundReview: true })
        .catch(() => {});
    }
    return fail(400, "No se pudo procesar tu recarga (posible falta de stock). El saldo se devolvio a tu Wallet.", {
      code: "RECHARGE_FAILED",
      needsWhatsapp: true,
      orderId: orderRef.id,
      newBalanceUsd: saldoDevuelto,
    });
  }

  // Central One acepto la orden (el saldo ya se habia descontado arriba).

  const finalStatus = "completado";
  const updatePayload = {
    status: finalStatus,
    shop2topupOrderId: s2tResult.order.order_id,
    shop2topupStatus: s2tResult.order.status,
  };
  const hasVouchers = s2tResult.order.vouchers && s2tResult.order.vouchers.length > 0;
  if (hasVouchers) {
    updatePayload.vouchers = s2tResult.order.vouchers;
  }
  await orderRef.update(updatePayload);

  if (!hasVouchers) {
    console.log(`[wallet-pay-order] Sin voucher todavia, disparando seguimiento para pedido ${orderRef.id} / shop2topup ${s2tResult.order.order_id}`);
    // IMPORTANTE: hay que esperar (await) a que el aviso se termine de
    // mandar. Si no se espera, Netlify congela el contenedor de esta
    // funcion apenas hace el "return" de mas abajo, y el fetch se muere a
    // mitad de camino sin llegar a disparar nada. Esto NO espera a que la
    // funcion en background TERMINE su trabajo (eso puede tardar hasta 24s)
    // -- solo espera la confirmacion casi instantanea de que la avisamos.
    await triggerVoucherFollowup(orderRef.id, s2tResult.order.order_id);
  }

  return {
    statusCode: 200,
    body: JSON.stringify({
      success: true,
      autoRecharge: true,
      status: finalStatus,
      needsWhatsapp: false,
      newBalanceUsd,
      receipt: { ...receiptBase, orderId: orderRef.id },
    }),
  };
};