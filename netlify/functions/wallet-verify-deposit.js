// Netlify Function: verifica un deposito a la Wallet contra Pabilo y, si el
// pago es valido, acredita el saldo del cliente en Firestore con permisos de
// servidor (firebase-admin). Es el mismo patron que verify-pago-movil-order.js,
// solo que en vez de crear un pedido de producto, suma saldo a users/{uid}.

const admin = require("./lib/firebase");
const { verifyPabiloPayment } = require("./lib/pabilo");
const { montoValido, textoCorto, referenciaValida, pagoUsadoRef, dentroDelLimite } = require("./lib/seguridad");
const { leerSaldo, guardarSaldo } = require("./lib/wallet");

const db = admin.firestore();

// Misma tolerancia por redondeo que usa la verificacion de pedidos.
const AMOUNT_TOLERANCE_BS = parseFloat(process.env.PABILO_AMOUNT_TOLERANCE_BS || "0.5");

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
  // texto en vez de sumarlo). Referencia: solo letras/numeros.
  const amountUsd = montoValido(body.amountUsd, { min: 0.1, max: 5000 });
  const bankReference = referenciaValida(body.bankReference);
  const payerPhone = textoCorto(body.payerPhone, 20);

  if (amountUsd === null || !bankReference || !payerPhone) {
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

  // ---- 2) La tasa SIEMPRE sale de Firestore (settings/main), nunca del
  // navegador -- el cliente ya convirtio a USD con la tasa que vio, pero
  // aqui se recalcula el monto esperado en Bs con la tasa real del servidor
  // para comparar contra lo que Pabilo confirma que se pago. ----
  const settingsSnap = await db.collection("settings").doc("main").get();
  const exchangeRateBsPerUsd = settingsSnap.exists ? settingsSnap.data().exchangeRateBsPerUsd || 0 : 0;
  if (!exchangeRateBsPerUsd) {
    return fail(500, "La tasa de cambio no esta configurada, contacta a soporte.");
  }
  const expectedTotalBs = amountUsd * exchangeRateBsPerUsd;

  // ---- 3) Candado momentaneo por referencia, igual que en pedidos: evita
  // dos verificaciones en paralelo para el mismo comprobante (doble click,
  // reintento de red, etc). Comparte coleccion con verify-pago-movil-order
  // porque una misma referencia de banco no deberia poder usarse ni para un
  // pedido ni para un deposito a la vez. ----
  const lockRef = db.collection("paymentVerificationLocks").doc(`${String(bankReference).trim()}`);
  try {
    await db.runTransaction(async (tx) => {
      const existing = await tx.get(lockRef);
      if (existing.exists) throw new Error("REFERENCE_IN_USE");
      tx.set(lockRef, { uid, type: "wallet_deposit", createdAt: admin.firestore.FieldValue.serverTimestamp() });
    });
  } catch (err) {
    if (err.message === "REFERENCE_IN_USE") {
      return fail(409, "Esta referencia ya se esta verificando. Espera unos segundos e intenta de nuevo.");
    }
    return fail(500, "No se pudo procesar la verificacion, intenta de nuevo");
  }

  try {
    // ---- 4) Verificacion real contra Pabilo ----
    let pabiloResult;
    try {
      pabiloResult = await verifyPabiloPayment({ bankReference, payerPhone });
    } catch (err) {
      return fail(500, "No se pudo verificar el pago en este momento, intenta de nuevo");
    }

    if (!pabiloResult.found) {
      return fail(404, pabiloResult.error || "No encontramos ese pago. Revisa la referencia e intenta de nuevo.");
    }

    if (pabiloResult.isNew === false) {
      return fail(409, "Este comprobante ya fue verificado antes.");
    }

    const amountOk = pabiloResult.amount >= expectedTotalBs - AMOUNT_TOLERANCE_BS;

    // ---- 5) El deposito SIEMPRE se registra en walletDeposits para que
    // quede visible en el panel admin, alcance o no alcance el monto. ----
    const depositRef = db.collection("walletDeposits").doc();
    const depositData = {
      uid,
      amountUsdRequested: amountUsd,
      exchangeRateBsPerUsd,
      expectedTotalBs,
      paymentProof: { last6: String(bankReference).trim(), payerPhone: String(payerPhone).trim() },
      pabiloReference: pabiloResult.reference || bankReference,
      pabiloAmountBs: pabiloResult.amount,
      status: amountOk ? "acreditando" : "rechazado",
      adminNote: amountOk
        ? ""
        : `Monto insuficiente: el cliente pago Bs ${pabiloResult.amount.toFixed(2)} y el deposito solicitado era Bs ${expectedTotalBs.toFixed(2)}. Referencia verificada correctamente por Pabilo.`,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    };
    await depositRef.set(depositData);

    if (!amountOk) {
      return fail(
        400,
        `El monto verificado (Bs ${pabiloResult.amount.toFixed(2)}) es menor al deposito solicitado (Bs ${expectedTotalBs.toFixed(2)}). No se acredito saldo. Contacta a soporte por WhatsApp con tu comprobante a la mano.`,
        { code: "INSUFFICIENT_AMOUNT", depositId: depositRef.id }
      );
    }

    // ---- 6) Se acredita el saldo en una transaccion para que dos depositos
    // simultaneos del mismo usuario no se pisen entre si. ----
    // En la MISMA transaccion se marca el pago como usado para siempre: si
    // ya se habia usado (en un pedido o en otro deposito), no se acredita.
    const usadoRef = pagoUsadoRef(db, "pm", pabiloResult.reference || bankReference);
    let newBalanceUsd = amountUsd;
    try {
      await db.runTransaction(async (tx) => {
        const usadoSnap = await tx.get(usadoRef);
        if (usadoSnap.exists) throw new Error("PAGO_YA_USADO");
        const { saldo: currentBalance, migracion } = await leerSaldo(tx, db, uid, { excluirDepositoId: depositRef.id });
        newBalanceUsd = Math.round((currentBalance + amountUsd) * 100) / 100;
        tx.create(usadoRef, { uid, type: "wallet_deposit", depositId: depositRef.id, usedAt: admin.firestore.FieldValue.serverTimestamp() });
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
        reference: String(bankReference).trim(),
        newBalanceUsd,
        date: new Date().toISOString(),
      }),
    };
  } finally {
    await lockRef.delete().catch(() => {});
  }
};