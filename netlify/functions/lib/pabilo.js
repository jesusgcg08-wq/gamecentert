// netlify/functions/lib/pabilo.js
// Cliente minimo de la API de Pabilo (verificacion de pagos). Sirve para
// cualquier cuenta que tengas dada de alta en Pabilo -- banco (pago movil)
// o, ahora tambien, tu cuenta de Binance -- pasando el userBankId y
// movementType correctos para cada una.
//
// Variables de entorno requeridas en Netlify:
//   PABILO_API_KEY            -> tu API key de Pabilo (Bearer token), compartida por todas las cuentas
//   PABILO_USER_BANK_ID       -> el userBankId de TU cuenta de Banco de Venezuela (pago movil)
// Opcional:
//   PABILO_MOVEMENT_TYPE      -> por defecto "GENERIC" (correcto para Banco de Venezuela persona natural)
//
// Para otras cuentas (ej. Binance) no hace falta agregar mas variables aca:
// quien llama a verifyPabiloPayment() le pasa su propio userBankId /
// movementType como parametros, y si no los pasa, se usan los de arriba
// (asi ninguna llamada existente cambia de comportamiento).

async function verifyPabiloPayment({ bankReference, payerPhone, userBankId, movementType }) {
  const apiKey = process.env.PABILO_API_KEY;
  const resolvedUserBankId = userBankId || process.env.PABILO_USER_BANK_ID;
  const resolvedMovementType = movementType || process.env.PABILO_MOVEMENT_TYPE || "GENERIC";

  if (!apiKey || !resolvedUserBankId) {
    throw new Error("Falta configurar PABILO_API_KEY o el userBankId correspondiente en Netlify");
  }

  const body = {
    bank_reference: String(bankReference).trim(),
    movement_type: resolvedMovementType,
  };
  // phone_pagador no lo exige Banco de Venezuela persona natural, pero no
  // hace daño mandarlo si lo tenemos: puede ayudar a Pabilo a ubicar el
  // movimiento si hay ambiguedad.
  if (payerPhone) body.phone_pagador = String(payerPhone);

  let res;
  try {
    res = await fetch(`https://api.pabilo.app/userbankpayment/${resolvedUserBankId}/betaserio`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(body),
    });
  } catch (err) {
    throw new Error("No se pudo contactar a Pabilo");
  }

  const data = await res.json().catch(() => ({}));

  if (res.status === 404) {
    // Antes se mostraba tal cual el mensaje crudo de Pabilo (ej. "movement
    // not found with bank reference 284882, movements counts 139"), que es
    // texto tecnico en ingles pensado para debug, no para el cliente. Ahora
    // siempre se muestra un mensaje amigable con la referencia que el
    // cliente escribio.
    return { found: false, error: `Pago no encontrado (referencia ${String(bankReference).trim()}), verifica tu referencia y vuelve a intentarlo.` };
  }
  if (res.status === 401) {
    throw new Error("PABILO_API_KEY invalida o inactiva");
  }
  if (res.status === 402) {
    throw new Error("Sin creditos suficientes en Pabilo para verificar pagos");
  }
  if (!res.ok) {
    return { found: false, error: data.message || (data.error && data.error.toString()) || "Error verificando el pago" };
  }

  // Pabilo responde en dos formas distintas segun si el pago es nuevo o ya
  // estaba registrado (ver documentacion que compartiste): a veces los
  // campos van en la raiz de la respuesta, a veces envueltos en "data".
  // Normalizamos aqui para no repetir esto en cada function que lo use.
  const root = data.data || data;
  const payment = root.user_bank_payment;
  if (!payment) {
    return { found: false, error: "Respuesta inesperada de Pabilo" };
  }

  const amount = typeof payment.amount === "number" ? payment.amount : parseFloat(payment.amount) || 0;

  return {
    found: true,
    isNew: root.is_new !== false,
    amount,
    reference: payment.bank_reference_id || bankReference,
    raw: payment,
  };
}

module.exports = { verifyPabiloPayment };