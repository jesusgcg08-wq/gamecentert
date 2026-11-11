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

const admin = require("./lib/firebase");
const { verifyPabiloPayment } = require("./lib/pabilo");
const { createCentralOneOrder, triggerVoucherFollowup, waitForVouchers } = require("./lib/centralone");
const { claveInternaOk, pagoUsadoRef } = require("./lib/seguridad");

const db = admin.firestore();

// Si paga de MENOS: se tolera hasta 10 Bs de diferencia (11 Bs o mas de menos => rechazado).
// Si paga de MAS: se procesa igual, sin limite (500 Bs de mas tambien pasa).
const AMOUNT_TOLERANCE_BS = parseFloat(process.env.PABILO_AMOUNT_TOLERANCE_BS || "10");

exports.handler = async function (event) {
  // Solo la puede disparar verify-pago-movil-order.js (lleva la clave interna).
  if (!claveInternaOk(event)) {
    console.warn("[pago-movil-background] llamada sin clave interna, ignorada");
    return { statusCode: 403, body: "No autorizado" };
  }

  let body;
  try {
    body = JSON.parse(event.body);
  } catch {
    return { statusCode: 400, body: "Body invalido" };
  }

  const pendingId = typeof body.pendingId === "string" ? body.pendingId : "";
  if (!/^[A-Za-z0-9]{10,40}$/.test(pendingId)) return { statusCode: 400, body: "Falta pendingId" };

  const pendingRef = db.collection("pendingVerifications").doc(pendingId);

  // Se "toma" la verificacion en una transaccion (verificando -> procesando):
  // si llegan dos disparos a la vez, solo uno sigue. Antes los dos llamaban a
  // Pabilo y podian crear dos pedidos con un solo pago.
  let pending;
  try {
    pending = await db.runTransaction(async (tx) => {
      const snap = await tx.get(pendingRef);
      if (!snap.exists) return null;
      const data = snap.data();
      if (data.verificationState !== "verificando") return null;
      tx.update(pendingRef, { verificationState: "procesando" });
      return data;
    });
  } catch (err) {
    console.error("[pago-movil-background] no se pudo tomar la verificacion:", err);
    return { statusCode: 200, body: "error al tomar" };
  }
  if (!pending) {
    return { statusCode: 200, body: "ignorado o ya resuelto" };
  }
  console.log(`[pago-movil-background] Procesando pendingId=${pendingId} referencia=${pending.bankReference}`);

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
    isGiftcard,
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
    // Epsilon de 0.005 para evitar errores de punto flotante justo en el borde de 10 Bs.
    if (pabiloResult.amount < expectedTotalBs - AMOUNT_TOLERANCE_BS - 0.005) {
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
      isGiftcard: !!isGiftcard,
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

    // Pedido + registro PERMANENTE del pago usado, en una sola transaccion:
    // si ese pago ya se uso (en otro pedido o en un deposito a la wallet),
    // no se crea el pedido. No depende solo de lo que diga Pabilo.
    const orderRef = db.collection("orders").doc();
    const usadoRef = pagoUsadoRef(db, "pm", pabiloResult.reference || bankReference);
    try {
      await db.runTransaction(async (tx) => {
        const usadoSnap = await tx.get(usadoRef);
        if (usadoSnap.exists) throw new Error("PAGO_YA_USADO");
        tx.create(usadoRef, { uid, type: "order", orderId: orderRef.id, usedAt: admin.firestore.FieldValue.serverTimestamp() });
        tx.set(orderRef, orderData);
        if (appliedCouponCode) {
          tx.set(db.collection("couponRedemptions").doc(`${uid}_${appliedCouponCode}`), {
            uid,
            code: appliedCouponCode,
            usedAt: admin.firestore.FieldValue.serverTimestamp(),
          });
        }
      });
    } catch (err) {
      if (err.message === "PAGO_YA_USADO") {
        await resolve({
          verificationState: "listo",
          success: false,
          message: "Este comprobante ya fue verificado en otro pedido.",
        });
        return { statusCode: 200, body: "rechazado (pago ya usado)" };
      }
      throw err;
    }

    const receipt = {
      orderId: orderRef.id,
      productName: productNameSnapshot,
      optionLabel: optionLabelSnapshot,
      totalUsd,
      totalBs: expectedTotalBs,
      playerGameId: orderData.playerGameId,
      zoneId: orderData.zoneId,
      paymentMethod: "Pago Movil",
      reference: bankReference,
      date: new Date().toISOString(),
    };

    // ---- Recarga automatica, si el producto la tiene activada ----
    if (autoRecharge && shop2topupItemId) {
      const s2tResult = await createCentralOneOrder({
        orderId: orderRef.id,
        subCategoryId: shop2topupItemId,
        playerId: orderData.playerGameId,
        zoneId: orderData.zoneId,
        extraFieldName: orderData.extraFieldName,
        extraFieldValue: orderData.extraFieldValue,
      });

      if (s2tResult.success && s2tResult.order) {
        const centralOneOrderId = s2tResult.order.order_id;
        receipt.centralOneOrderId = centralOneOrderId;

        // Se guarda YA el id de Central One en el pedido (el seguimiento y el
        // dashboard lo necesitan para encontrar la giftcard).
        await orderRef.update({
          status: "en_proceso",
          shop2topupOrderId: centralOneOrderId,
          shop2topupStatus: s2tResult.order.status,
        });

        // Se ESPERA a que Central One entregue el codigo antes de mostrar el
        // recibo: asi el cliente ve su giftcard de una vez. Esta funcion es
        // background (hasta 15 min), asi que aguanta la espera sin problema.
        let final = s2tResult.order.vouchers && s2tResult.order.vouchers.length > 0 ? s2tResult.order : null;
        if (!final) {
          // Solo las giftcards tienen codigo que esperar; las recargas directas no.
          final = (await waitForVouchers(centralOneOrderId, isGiftcard ? {} : { timeoutMs: 20000 })) || s2tResult.order;
        }
        const vouchers = final.vouchers || [];

        if (final.internal_status === "rechazado") {
          const note = `Central One reporto ${final.status}${final.failure && final.failure.code ? ` (${final.failure.code})` : ""}. Revisar reembolso o entrega manual.`;
          await orderRef.update({ status: "rechazado", shop2topupStatus: final.status, adminNote: note, requiresRefundReview: true });
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
          return { statusCode: 200, body: "completado (auto rechazado)" };
        }

        const delivered = vouchers.length > 0 || final.internal_status === "completado";
        const updatePayload = { shop2topupStatus: final.status };
        if (vouchers.length > 0) updatePayload.vouchers = vouchers;
        if (delivered) updatePayload.status = "completado";
        await orderRef.update(updatePayload);

        // Si todavia no hay codigo (Central One tardo mas de lo normal), el
        // seguimiento en background sigue consultando y el dashboard lo
        // mostrara apenas llegue.
        if (!delivered || (vouchers.length === 0 && final.codesPending)) {
          console.log(`[pago-movil-background] Sin voucher todavia, disparando seguimiento para pedido ${orderRef.id}`);
          await triggerVoucherFollowup(orderRef.id, centralOneOrderId);
        }

        await resolve({
          verificationState: "listo",
          success: true,
          autoRecharge: true,
          status: delivered ? "completado" : "en_proceso",
          needsWhatsapp: false,
          orderId: orderRef.id,
          vouchers,
          receipt,
        });
        return { statusCode: 200, body: "completado (auto)" };
      }

      // Pago verificado pero Central One fallo (ej. sin stock): el dinero ya
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