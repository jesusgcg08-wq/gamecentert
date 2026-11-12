// Netlify Function: verifica un deposito a la Wallet pagado con Binance Pay
// (USDT) contra Pabilo -- mismo patron que wallet-verify-deposit.js (Pago
// Movil), solo que usa el userBankId de tu cuenta Binance (igual que
// verify-binance-pay-order.js) y el monto debe coincidir EXACTO en USD (no
// hay tasa de cambio de por medio, 1 USDT = 1 USD).

const admin = require("./lib/firebase");
const { verifyPabiloPayment } = require("./lib/pabilo");
const { montoValido, referenciaValida, pagoUsadoRef, dentroDelLimite } = require("./lib/seguridad");
const { leerSaldo, guardarSaldo } = require("./lib/wallet");

const db = admin.firestore();

// Solo tolerancia de redondeo de punto flotante, NO un margen real como en
// Pago Movil (ahi la tasa de cambio puede variar unos centimos).
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

  // Monto: tiene que ser un NUMERO (un texto como "1" pegaba el saldo como
  // texto en vez de sumarlo). ID de transaccion: solo letras/numeros.
  const amountUsd = montoValido(body.amountUsd, { min: 0.1, max: 5000 });
  const transactionId = referenciaValida(body.transactionId);

  if (amountUsd === null || !transactionId) {
    return fail(400, "Faltan datos del deposito o no son validos");
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

  // Limite de verificaciones de pago por cuenta: evita que alguien pruebe
  // referencias al azar hasta "encontrar" el pago de otra persona.
  if (!(await dentroDelLimite(db, "pago", uid, 12, 30 * 60 * 1000))) {
    return fail(429, "Hiciste demasiados intentos seguidos. Espera unos minutos o escribenos por WhatsApp.");
  }

  const cleanTxId = String(transactionId).trim();

  // ---- 2) Candado momentaneo por referencia, igual que en Pago Movil y en
  // el pago de pedidos con Binance -- prefijo "binance_" para no chocar con
  // referencias de banco en la misma coleccion. ----
  const lockRef = db.collection("paymentVerificationLocks").doc(`binance_${cleanTxId}`);
  try {
    await db.runTransaction(async (tx) => {
      const existing = await tx.get(lockRef);
      if (existing.exists) throw new Error("REFERENCE_IN_USE");
      tx.set(lockRef, { uid, type: "wallet_deposit_binance", createdAt: admin.firestore.FieldValue.serverTimestamp() });
    });
  } catch (err) {
    if (err.message === "REFERENCE_IN_USE") {
      return fail(409, "Este comprobante ya se esta verificando. Espera unos segundos e intenta de nuevo.");
    }
    return fail(500, "No se pudo procesar la verificacion, intenta de nuevo");
  }

  try {
    // ---- 3) Verificacion real contra Pabilo, usando el userBankId de tu
    // cuenta Binance (misma logica que verify-binance-pay-order.js). ----
    let pabiloResult;
    try {
      pabiloResult = await verifyPabiloPayment({
        bankReference: cleanTxId,
        userBankId: process.env.PABILO_BINANCE_USER_BANK_ID,
        movementType: process.env.PABILO_BINANCE_MOVEMENT_TYPE || undefined,
      });
    } catch (err) {
      return fail(500, "No se pudo verificar el pago en este momento, intenta de nuevo");
    }

    if (!pabiloResult.found) {
      return fail(404, pabiloResult.error || "No encontramos ese pago. Revisa el ID de transaccion e intenta de nuevo.");
    }

    if (pabiloResult.isNew === false) {
      return fail(409, "Este comprobante ya fue verificado antes.");
    }

    const amountOk = Math.abs(pabiloResult.amount - amountUsd) <= AMOUNT_TOLERANCE_USD;

    // ---- 4) El deposito SIEMPRE se registra en walletDeposits, alcance o
    // no el monto -- para que quede visible en el panel admin. ----
    const depositRef = db.collection("walletDeposits").doc();
    const depositData = {
      uid,
      amountUsdRequested: amountUsd,
      paymentMethod: "binance",
      paymentProof: { transactionId: cleanTxId },
      pabiloReference: pabiloResult.reference || cleanTxId,
      pabiloAmountUsd: pabiloResult.amount,
      status: amountOk ? "acreditando" : "rechazado",
      adminNote: amountOk
        ? ""
        : `Monto no coincide: el cliente pago $${pabiloResult.amount.toFixed(2)} y el deposito solicitado era $${amountUsd.toFixed(2)}. Referencia verificada correctamente por Pabilo.`,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    };
    await depositRef.set(depositData);

    if (!amountOk) {
      return fail(
        400,
        `El monto verificado ($${pabiloResult.amount.toFixed(2)}) no coincide con el deposito solicitado ($${amountUsd.toFixed(2)}). No se acredito saldo. Contacta a soporte por WhatsApp con tu comprobante a la mano.`,
        { code: "INSUFFICIENT_AMOUNT", depositId: depositRef.id }
      );
    }

    // ---- 5) Se acredita el saldo en una transaccion para que dos depositos
    // simultaneos del mismo usuario no se pisen entre si. ----
    // En la MISMA transaccion se marca el pago como usado para siempre: si
    // ya se habia usado (en un pedido o en otro deposito), no se acredita.
    const usadoRef = pagoUsadoRef(db, "bn", pabiloResult.reference || cleanTxId);
    let newBalanceUsd = amountUsd;
    try {
      await db.runTransaction(async (tx) => {
        const usadoSnap = await tx.get(usadoRef);
        if (usadoSnap.exists) throw new Error("PAGO_YA_USADO");
        const { saldo: currentBalance, migracion } = await leerSaldo(tx, db, uid, { excluirDepositoId: depositRef.id });
        newBalanceUsd = Math.round((currentBalance + amountUsd) * 100) / 100;
        tx.create(usadoRef, { uid, type: "wallet_deposit_binance", depositId: depositRef.id, usedAt: admin.firestore.FieldValue.serverTimestamp() });
        guardarSaldo(tx, db, uid, newBalanceUsd, migracion);
        tx.update(depositRef, { status: "completado" });
      });
    } catch (err) {
      if (err.message === "PAGO_YA_USADO") {
        await depositRef.update({ status: "rechazado", adminNote: "Ese pago ya se habia usado antes. No se acredito saldo." });
        return fail(409, "Este comprobante ya fue verificado antes.");
      }
      console.error("[wallet-deposit] no se pudo acreditar:", err);
      await depositRef
        .update({ status: "rechazado", adminNote: "Pago verificado pero fallo al acreditar el saldo. Acreditar a mano.", requiresRefundReview: true })
        .catch(() => {});
      return fail(500, "Tu pago fue verificado pero no se pudo acreditar el saldo. Escribenos por WhatsApp con tu comprobante.");
    }

    return {
      statusCode: 200,
      body: JSON.stringify({
        success: true,
        amountUsd,
        reference: cleanTxId,
        newBalanceUsd,
        date: new Date().toISOString(),
      }),
    };
  } finally {
    await lockRef.delete().catch(() => {});
  }
};