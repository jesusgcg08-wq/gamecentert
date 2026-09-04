// Netlify Function: verifica un pago de Binance Pay contra Pabilo (misma
// API que pago movil, usando el userBankId de tu cuenta Binance dada de
// alta en Pabilo en vez de la del banco), revalida el precio contra el
// catalogo real en Firestore (nunca lo que mande el navegador), crea el
// pedido con permisos de servidor (firebase-admin) y, si el producto es de
// recarga automatica, dispara Shop2Topup de inmediato reusando
// lib/shop2topup.js. Misma estructura EXACTA que verify-pago-movil-order.js,
// solo cambia: la cuenta de Pabilo que se consulta, y que el monto debe
// coincidir EXACTO (no hay margen "puede ser mas"), porque en USDT no
// aplica la logica de redondeo de tasa de cambio en bolivares.
//
// Variables de entorno necesarias:
//   FIREBASE_SERVICE_ACCOUNT_BASE64 (ya la tienes, la usa lib/firebase-admin)
//   PABILO_API_KEY (ya la tienes, es la misma cuenta Pabilo para todo)
//   PABILO_BINANCE_USER_BANK_ID -> el userBankId que te dio Pabilo para tu
//                                  cuenta Binance (tipo "USER", no banco)
//   SHOP2TOPUP_API_KEY (ya la tienes)
// Opcionales (tienen valor por defecto):
//   PABILO_BINANCE_MOVEMENT_TYPE (si no la configuras, usa el mismo
//                                  GENERIC que pago movil -- tu proveedor
//                                  de Pabilo confirmo que la API es
//                                  identica, solo cambia el userBankId)
//   PABILO_BINANCE_AMOUNT_TOLERANCE_USD (default 0.001, solo para
//                                  redondeo de punto flotante, NO es un
//                                  margen real como en pago movil)

const admin = require("./lib/firebase-admin");
const { verifyPabiloPayment } = require("./lib/pabilo");
const { createShop2topupOrder, triggerVoucherFollowup } = require("./lib/shop2topup");

const db = admin.firestore();

const AMOUNT_TOLERANCE_USD = parseFloat(process.env.PABILO_BINANCE_AMOUNT_TOLERANCE_USD || "0.001");

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

  const { productId, optionId, couponCode, transactionId, playerGameId, zoneId, extraFieldValue } = body;

  if (!productId || !optionId || !transactionId) {
    return fail(400, "Faltan datos del pedido o del pago");
  }

  // ---- 1) Quien hace el pedido se determina por el token de Firebase que
  // manda el navegador, NUNCA por un userId que venga en el body. ----
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

  // ---- 3) Cupon: misma logica que Pago Movil. ----
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

  // Binance Pay liquida en USDT, 1:1 con USD -- a diferencia de Pago Movil
  // aqui NO se multiplica por la tasa de cambio.
  const totalUsd = option.priceUsd * (1 - discountPercent / 100);
  const cleanTxId = String(transactionId).trim();

  // ---- 4) Candado momentaneo por referencia: evita que un doble click o
  // un reintento de red dispare DOS verificaciones en paralelo para la
  // misma referencia. Se libera siempre al terminar (exito o error) --
  // la proteccion PERMANENTE contra reusar un comprobante ya pagado la da
  // el "is_new" que devuelve Pabilo, igual que en pago movil, no esta
  // clave. Prefijo "binance_" para que un ID de Binance nunca choque por
  // coincidencia con una referencia de banco en la misma coleccion. ----
  const lockRef = db.collection("paymentVerificationLocks").doc(`binance_${cleanTxId}`);
  try {
    await db.runTransaction(async (tx) => {
      const existing = await tx.get(lockRef);
      if (existing.exists) throw new Error("REFERENCE_IN_USE");
      tx.set(lockRef, { uid, productId, createdAt: admin.firestore.FieldValue.serverTimestamp() });
    });
  } catch (err) {
    if (err.message === "REFERENCE_IN_USE") {
      return fail(409, "Este comprobante ya se esta verificando. Espera unos segundos e intenta de nuevo.");
    }
    return fail(500, "No se pudo procesar la verificacion, intenta de nuevo");
  }

  try {
    // ---- 5) Verificacion real contra Pabilo, usando el userBankId de tu
    // cuenta Binance en vez del bancario. ----
    let pabiloResult;
    try {
      pabiloResult = await verifyPabiloPayment({
        bankReference: cleanTxId,
        userBankId: process.env.PABILO_BINANCE_USER_BANK_ID,
        // Tu proveedor de Pabilo confirmo que es exactamente la misma API
        // que pago movil: mismo endpoint, mismo body, solo cambia el
        // userBankId. Por eso NO forzamos un movement_type distinto aca --
        // si no configuras PABILO_BINANCE_MOVEMENT_TYPE, cae al mismo
        // GENERIC que ya usa pago movil (ver lib/pabilo.js).
        movementType: process.env.PABILO_BINANCE_MOVEMENT_TYPE || undefined,
      });
    } catch (err) {
      return fail(500, "No se pudo verificar el pago en este momento, intenta de nuevo");
    }

    if (!pabiloResult.found) {
      return fail(404, pabiloResult.error || "No encontramos ese pago. Revisa el ID de transaccion e intenta de nuevo.");
    }

    if (pabiloResult.isNew === false) {
      return fail(409, "Este comprobante ya fue verificado en otro pedido.");
    }

    // A diferencia de pago movil, aqui el monto debe coincidir EXACTO --
    // solo se tolera el redondeo de punto flotante, no una diferencia real.
    if (Math.abs(pabiloResult.amount - totalUsd) > AMOUNT_TOLERANCE_USD) {
      return fail(
        400,
        `El monto verificado ($${pabiloResult.amount.toFixed(2)}) no coincide con el total de tu pedido ($${totalUsd.toFixed(2)}). Si crees que es un error, contactanos por WhatsApp.`,
        { code: "INSUFFICIENT_AMOUNT" }
      );
    }

    // ---- 6) Pago verificado: se crea el pedido con permisos de servidor ----
    const orderData = {
      userId: uid,
      productId,
      optionId,
      productNameSnapshot: product.name,
      optionLabelSnapshot: option.label,
      priceUsdSnapshot: option.priceUsd,
      couponCode: appliedCouponCode,
      discountPercent,
      totalUsd,
      paymentMethod: "binance",
      paymentProof: { transactionId: cleanTxId },
      playerGameId: product.requiresId ? String(playerGameId).trim() : "",
      zoneId: product.requiresZoneId ? String(zoneId).trim() : "",
      autoRecharge: !!product.autoRecharge,
      shop2topupItemId: product.autoRecharge ? option.shop2topupItemId || null : null,
      extraFieldName: product.extraField ? product.extraField.fieldName : "",
      extraFieldValue: product.extraField ? extraFieldValue : "",
      status: "recibido",
      adminNote: "",
      paymentVerified: true,
      paymentVerifiedAt: admin.firestore.FieldValue.serverTimestamp(),
      pabiloReference: pabiloResult.reference || cleanTxId,
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
      productName: product.name,
      optionLabel: option.label,
      totalUsd,
      reference: cleanTxId,
      paymentMethod: "Binance Pay",
      playerGameId: orderData.playerGameId,
      zoneId: orderData.zoneId,
    };

    // ---- 7) Recarga automatica, si el producto la tiene activada ----
    if (product.autoRecharge && option.shop2topupItemId) {
      const s2tResult = await createShop2topupOrder({
        orderId: orderRef.id,
        subCategoryId: option.shop2topupItemId,
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
          console.log(`Sin voucher todavia, disparando seguimiento para pedido ${orderRef.id} / shop2topup ${s2tResult.order.order_id}`);
          // Ver comentario en wallet-pay-order.js: hay que esperar a que el
          // aviso se termine de mandar, o Netlify congela la funcion antes.
          await triggerVoucherFollowup(orderRef.id, s2tResult.order.order_id);
        }
        return {
          statusCode: 200,
          body: JSON.stringify({
            success: true,
            autoRecharge: true,
            status: "completado",
            needsWhatsapp: false,
            receipt,
          }),
        };
      }

      // Pago verificado pero Shop2Topup fallo (ej. sin stock): el dinero ya
      // esta confirmado, no se pierde. Se deja visible para revision y se
      // avisa por WhatsApp igual -- dejando claro que fue un error de la
      // recarga/giftcard (no del pago) y que hay que contactar para el
      // reembolso o la entrega manual.
      const note = `Pago verificado pero la recarga automatica fallo: ${s2tResult.message || "error desconocido"}. Revisar y coordinar reembolso o entrega manual.`;
      await orderRef.update({ status: "en_proceso", adminNote: note, requiresRefundReview: true });
      return {
        statusCode: 200,
        body: JSON.stringify({
          success: true,
          autoRecharge: true,
          status: "en_proceso",
          needsWhatsapp: true,
          requiresRefund: true,
          whatsappNote:
            "Tu pago fue procesado, pero hubo un error con tu recarga/giftcard (posible falta de stock). Contactanos por WhatsApp para coordinar tu reembolso o la entrega manual.",
          receipt,
        }),
      };
    }

    // ---- 8) Sin recarga automatica: el pago ya quedo verificado, pero la
    // recarga la sigue haciendo el admin a mano, avisando por WhatsApp. ----
    await orderRef.update({ status: "en_proceso" });
    return {
      statusCode: 200,
      body: JSON.stringify({
        success: true,
        autoRecharge: false,
        status: "en_proceso",
        needsWhatsapp: true,
        whatsappNote: "Tu pago fue verificado automaticamente. Ya puedes proceder con la recarga.",
        receipt,
      }),
    };
  } finally {
    await lockRef.delete().catch(() => {});
  }
};