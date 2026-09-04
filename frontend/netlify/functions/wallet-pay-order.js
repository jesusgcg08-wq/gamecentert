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
//  - Si el producto es AUTOMATICO (autoRecharge): primero se crea la orden
//    en Shop2Topup, y SOLO si esa orden es aceptada se descuenta el saldo.
//    Si Shop2Topup la rechaza o falla, no se cobra nada.

const admin = require("./lib/firebase-admin");
const { createShop2topupOrder, triggerVoucherFollowup } = require("./lib/shop2topup");

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

  const { productId, optionId, couponCode, playerGameId, zoneId, extraFieldValue } = body;
  if (!productId || !optionId) {
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

  // ---- 3) Cupon: misma logica que verify-pago-movil-order.js. ----
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

  // ---- 4) Saldo real del cliente, siempre leido de Firestore (nunca del
  // navegador). Solo lo confirmamos aqui; el descuento real se hace mas
  // abajo, dentro de una transaccion, para que dos pagos simultaneos no se
  // pisen entre si. ----
  const userSnapCheck = await db.collection("users").doc(uid).get();
  const currentBalance = userSnapCheck.exists ? userSnapCheck.data().walletBalanceUsd || 0 : 0;
  if (currentBalance < totalUsd) {
    return fail(400, "No tienes saldo suficiente en tu wallet para este pedido.");
  }

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
    paymentProof: {},
    playerGameId: product.requiresId ? String(playerGameId).trim() : "",
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

  // ================= MANUAL: se descuenta de una vez, queda en_proceso =================
  if (!product.autoRecharge) {
    const orderRef = db.collection("orders").doc();
    let newBalanceUsd;
    try {
      await db.runTransaction(async (tx) => {
        const userRef = db.collection("users").doc(uid);
        const userSnap = await tx.get(userRef);
        const balance = userSnap.exists ? userSnap.data().walletBalanceUsd || 0 : 0;
        if (balance < totalUsd) throw new Error("INSUFFICIENT_BALANCE");
        newBalanceUsd = balance - totalUsd;

        tx.set(orderRef, { ...baseOrderData, status: "en_proceso" });
        tx.update(userRef, { walletBalanceUsd: newBalanceUsd });
        if (appliedCouponCode) {
          tx.set(db.collection("couponRedemptions").doc(`${uid}_${appliedCouponCode}`), {
            uid,
            code: appliedCouponCode,
            usedAt: admin.firestore.FieldValue.serverTimestamp(),
          });
        }
      });
    } catch (err) {
      if (err.message === "INSUFFICIENT_BALANCE") {
        return fail(400, "No tienes saldo suficiente en tu wallet para este pedido.");
      }
      console.error(err);
      return fail(500, "No se pudo procesar el pago, intenta de nuevo");
    }

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

  // ================= AUTOMATICA: primero Shop2Topup, saldo se descuenta =================
  // ================= solo si la orden es aceptada. =================
  const orderRef = db.collection("orders").doc();
  await orderRef.set({ ...baseOrderData, status: "en_proceso" });

  let s2tResult;
  try {
    s2tResult = await createShop2topupOrder({
      orderId: orderRef.id,
      subCategoryId: option.shop2topupItemId,
      playerId: baseOrderData.playerGameId,
      extraFieldName: baseOrderData.extraFieldName,
      extraFieldValue: baseOrderData.extraFieldValue,
    });
  } catch (err) {
    console.error(err);
    await orderRef.update({ status: "rechazado", adminNote: "Error de conexion con Shop2Topup, no se descargo el saldo." });
    return fail(502, "No se pudo procesar la recarga automatica, intenta de nuevo o elige otro metodo de pago.", {
      code: "RECHARGE_FAILED",
      orderId: orderRef.id,
    });
  }

  const s2tSucceeded = s2tResult.success && s2tResult.order && s2tResult.order.internal_status !== "rechazado";

  if (!s2tSucceeded) {
    // La orden en Shop2Topup fue rechazada (ej. ID de jugador invalido, sin
    // stock, etc.) o la funcion fallo -- NO se descuenta saldo, asi que aqui
    // no hace falta hablar de reembolso (no hubo cobro), solo avisar y dar
    // la opcion de contactar por WhatsApp si el cliente quiere completarlo
    // de otra forma.
    const note = s2tResult.message || s2tResult.order?.status || "La recarga automatica fue rechazada.";
    await orderRef.update({ status: "rechazado", adminNote: note });
    return fail(400, `No se pudo procesar tu recarga (posible falta de stock): ${note}. No se descarto saldo de tu Wallet.`, {
      code: "RECHARGE_FAILED",
      needsWhatsapp: true,
      orderId: orderRef.id,
    });
  }

  // Shop2Topup acepto la orden: ahora si se descuenta el saldo, dentro de
  // una transaccion para evitar pagos dobles en paralelo.
  let newBalanceUsd;
  try {
    await db.runTransaction(async (tx) => {
      const userRef = db.collection("users").doc(uid);
      const userSnap = await tx.get(userRef);
      const balance = userSnap.exists ? userSnap.data().walletBalanceUsd || 0 : 0;
      if (balance < totalUsd) throw new Error("INSUFFICIENT_BALANCE");
      newBalanceUsd = balance - totalUsd;
      tx.update(userRef, { walletBalanceUsd: newBalanceUsd });
      if (appliedCouponCode) {
        tx.set(db.collection("couponRedemptions").doc(`${uid}_${appliedCouponCode}`), {
          uid,
          code: appliedCouponCode,
          usedAt: admin.firestore.FieldValue.serverTimestamp(),
        });
      }
    });
  } catch (err) {
    // Caso muy raro: el saldo cambio justo entre el chequeo inicial y aqui
    // (ej. dos pagos casi simultaneos). La recarga en Shop2Topup YA se hizo,
    // asi que no la revertimos -- se deja visible para que el admin revise
    // el saldo manualmente en vez de perder la recarga ya entregada.
    console.error(err);
    await orderRef.update({ adminNote: "Recarga entregada por Shop2Topup pero hubo un problema al descontar el saldo, revisar manualmente." });
    newBalanceUsd = null;
  }

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