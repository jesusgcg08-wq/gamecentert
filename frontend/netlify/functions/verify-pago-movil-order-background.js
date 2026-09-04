// Netlify BACKGROUND Function (el sufijo "-background" es obligatorio: le
// dice a Netlify que la deje correr hasta 15 minutos en vez de los ~10s
// normales de una funcion sincrona). La dispara verify-pago-movil-order.js
// despues de validar todo lo rapido y crear el documento en
// "pendingVerifications".
//
// Aqui SI se llama a Pabilo, sin importar cuanto tarde ese dia. Ademas se
// cambio la regla del monto respecto a como funcionaba antes: si el cliente
// pago DE MAS (no importa cuanto mas), se procesa igual -- solo se rechaza
// si pago DE MENOS (por debajo del margen de tolerancia por redondeo).

const admin = require("./lib/firebase-admin");
const { verifyPabiloPayment } = require("./lib/pabilo");
const { createShop2topupOrder, triggerVoucherFollowup } = require("./lib/shop2topup");

const db = admin.firestore();

const AMOUNT_TOLERANCE_BS = parseFloat(process.env.PABILO_AMOUNT_TOLERANCE_BS || "0.5");

exports.handler = async function (event) {
  let body;
  try {
    body = JSON.parse(event.body);
  } catch {
    return { statusCode: 400, body: "Body invalido" };
  }

  const { pendingId } = body;
  if (!pendingId) return { statusCode: 400, body: "Falta pendingId" };

  const pendingRef = db.collection("pendingVerifications").doc(pendingId);
  const pendingSnap = await pendingRef.get();
  if (!pendingSnap.exists) {
    console.warn(`[pago-movil-background] pendingVerification ${pendingId} no existe`);
    return { statusCode: 200, body: "ignorado" };
  }
  const pending = pendingSnap.data();
  console.log(`[pago-movil-background] Procesando pendingId=${pendingId} referencia=${pending.bankReference}`);

  // Si por lo que sea ya se resolvio (doble disparo), no se hace nada de nuevo.
  if (pending.verificationState !== "verificando") {
    return { statusCode: 200, body: "ya estaba resuelto" };
  }

  const {
    uid,
    productId,
    optionId,
    productNameSnapshot,
    optionLabelSnapshot,
    priceUsdSnapshot,
    couponCode: appliedCouponCode,
    discountPercent,
    totalUsd,
    exchangeRateBsPerUsd,
    expectedTotalBs,
    bankReference,
    payerPhone,
    playerGameId,
    zoneId,
    autoRecharge,
    shop2topupItemId,
    extraFieldName,
    extraFieldValue,
  } = pending;

  const lockRef = db.collection("paymentVerificationLocks").doc(bankReference);

  async function resolve(update) {
    await pendingRef.update(update);
    await lockRef.delete().catch(() => {});
  }

  try {
    // ---- Verificacion real contra Pabilo -- aqui SI puede tardar lo que
    // haga falta, no hay limite de ~10s como en una funcion normal. ----
    let pabiloResult;
    try {
      pabiloResult = await verifyPabiloPayment({ bankReference, payerPhone });
    } catch (err) {
      console.error(`[pago-movil-background] Error llamando a Pabilo (pedido pendiente ${pendingId}, referencia ${bankReference}):`, err);
      await resolve({
        verificationState: "listo",
        success: false,
        message: "No se pudo verificar el pago en este momento, intenta de nuevo",
      });
      return { statusCode: 200, body: "rechazado (error pabilo)" };
    }

    if (!pabiloResult.found) {
      await resolve({
        verificationState: "listo",
        success: false,
        message: pabiloResult.error || "No encontramos ese pago. Revisa la referencia e intenta de nuevo.",
      });
      return { statusCode: 200, body: "rechazado (no encontrado)" };
    }

    if (pabiloResult.isNew === false) {
      await resolve({
        verificationState: "listo",
        success: false,
        message: "Este comprobante ya fue verificado en otro pedido.",
      });
      return { statusCode: 200, body: "rechazado (ya usado)" };
    }

    // ---- Regla de monto: si pago MENOS de lo esperado (mas alla del
    // margen de tolerancia por redondeo), se rechaza. Si pago igual o MAS
    // -- sin importar cuanto mas -- se procesa normal. ----
    if (pabiloResult.amount < expectedTotalBs - AMOUNT_TOLERANCE_BS) {
      await resolve({
        verificationState: "listo",
        success: false,
        code: "INSUFFICIENT_AMOUNT",
        message: `El monto verificado (Bs ${pabiloResult.amount.toFixed(2)}) es menor al total de tu pedido (Bs ${expectedTotalBs.toFixed(2)}). Si crees que es un error, contactanos por WhatsApp.`,
      });
      return { statusCode: 200, body: "rechazado (monto insuficiente)" };
    }

    // ---- Pago verificado: se crea el pedido con permisos de servidor ----
    const orderData = {
      userId: uid,
      productId,
      optionId,
      productNameSnapshot,
      optionLabelSnapshot,
      priceUsdSnapshot,
      couponCode: appliedCouponCode,
      discountPercent,
      totalUsd,
      exchangeRateBsPerUsd,
      paymentMethod: "pago_movil",
      paymentProof: { last6: bankReference, payerPhone },
      playerGameId: playerGameId || "",
      zoneId: zoneId || "",
      autoRecharge: !!autoRecharge,
      shop2topupItemId: autoRecharge ? shop2topupItemId || null : null,
      extraFieldName: extraFieldName || "",
      extraFieldValue: extraFieldValue || "",
      status: "recibido",
      adminNote: "",
      paymentVerified: true,
      paymentVerifiedAt: admin.firestore.FieldValue.serverTimestamp(),
      pabiloReference: pabiloResult.reference || bankReference,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    };

    const orderRef = db.collection("orders").doc();
    const batch = db.batch();
    batch.set(orderRef, orderData);
    if (appliedCouponCode) {
      batch.set(db.collection("couponRedemptions").doc(`${uid}_${appliedCouponCode}`), {
        uid,
        code: appliedCouponCode,
        usedAt: admin.firestore.FieldValue.serverTimestamp(),
      });
    }
    await batch.commit();

    const receipt = {
      orderId: orderRef.id,
      productName: productNameSnapshot,
      optionLabel: optionLabelSnapshot,
      totalUsd,
      totalBs: expectedTotalBs,
      playerGameId: orderData.playerGameId,
      zoneId: orderData.zoneId,
    };

    // ---- Recarga automatica, si el producto la tiene activada ----
    if (autoRecharge && shop2topupItemId) {
      const s2tResult = await createShop2topupOrder({
        orderId: orderRef.id,
        subCategoryId: shop2topupItemId,
        playerId: orderData.playerGameId,
        zoneId: orderData.zoneId,
        extraFieldName: orderData.extraFieldName,
        extraFieldValue: orderData.extraFieldValue,
      });

      if (s2tResult.success && s2tResult.order) {
        const updatePayload = {
          status: "completado",
          shop2topupOrderId: s2tResult.order.order_id,
          shop2topupStatus: s2tResult.order.status,
        };
        const hasVouchers = s2tResult.order.vouchers && s2tResult.order.vouchers.length > 0;
        if (hasVouchers) {
          updatePayload.vouchers = s2tResult.order.vouchers;
        }
        await orderRef.update(updatePayload);

        if (!hasVouchers) {
          console.log(`[pago-movil-background] Sin voucher todavia, disparando seguimiento para pedido ${orderRef.id}`);
          await triggerVoucherFollowup(orderRef.id, s2tResult.order.order_id);
        }

        await resolve({
          verificationState: "listo",
          success: true,
          autoRecharge: true,
          status: "completado",
          needsWhatsapp: false,
          orderId: orderRef.id,
          receipt,
        });
        return { statusCode: 200, body: "completado (auto)" };
      }

      // Pago verificado pero Shop2Topup fallo (ej. sin stock): el dinero ya
      // esta confirmado, no se pierde. Se deja visible para revision y se
      // avisa por WhatsApp igual, dejando claro que fue un error de la
      // recarga/giftcard (no del pago).
      const note = `Pago verificado pero la recarga automatica fallo: ${s2tResult.message || "error desconocido"}. Revisar y coordinar reembolso o entrega manual.`;
      await orderRef.update({ status: "en_proceso", adminNote: note, requiresRefundReview: true });
      await resolve({
        verificationState: "listo",
        success: true,
        autoRecharge: true,
        status: "en_proceso",
        needsWhatsapp: true,
        requiresRefund: true,
        whatsappNote:
          "Tu pago fue procesado, pero hubo un error con tu recarga/giftcard (posible falta de stock). Contactanos por WhatsApp para coordinar tu reembolso o la entrega manual.",
        orderId: orderRef.id,
        receipt,
      });
      return { statusCode: 200, body: "completado (auto fallo)" };
    }

    // ---- Sin recarga automatica: el pago ya quedo verificado, pero la
    // recarga la sigue haciendo el admin a mano, avisando por WhatsApp. ----
    await orderRef.update({ status: "en_proceso" });
    await resolve({
      verificationState: "listo",
      success: true,
      autoRecharge: false,
      status: "en_proceso",
      needsWhatsapp: true,
      whatsappNote: "Tu pago fue verificado automaticamente. Ya puedes proceder con la recarga.",
      orderId: orderRef.id,
      receipt,
    });
    return { statusCode: 200, body: "completado (manual)" };
  } catch (err) {
    console.error("[pago-movil-background] error inesperado:", err);
    await resolve({
      verificationState: "listo",
      success: false,
      message: "No se pudo procesar el pago, intenta de nuevo",
    }).catch(() => {});
    return { statusCode: 200, body: "error inesperado" };
  }
};