// lib/binance-pay.js
// Cliente minimo para la API NORMAL de tu cuenta de Binance (Configuracion >
// API Management) -- no es la Merchant API, no requiere registrar un
// negocio ni pasar KYB, y no tiene ninguna relacion con Pabilo (Pabilo
// solo se sigue usando para pago movil).
//
// Usa GET /sapi/v1/pay/transactions para leer el historial de movimientos
// de Binance Pay de tu propia cuenta y buscar ahi un pago ENTRANTE que
// coincida con el monto esperado del pedido.
//
// Variables de entorno necesarias en Netlify:
//   BINANCE_API_KEY
//   BINANCE_API_SECRET
//
// IMPORTANTE: esta API solo te deja ver movimientos de TU cuenta -- nunca
// se manda ni se recibe la clave del cliente, el cliente nunca ve estas
// credenciales, viven solo en el servidor.

const crypto = require("crypto");

const BINANCE_BASE_URL = "https://api.binance.com";

function sign(queryString, secret) {
  return crypto.createHmac("sha256", secret).update(queryString).digest("hex");
}

async function fetchPayTransactions({ startTime, endTime, limit = 50 }) {
  const apiKey = process.env.BINANCE_API_KEY;
  const apiSecret = process.env.BINANCE_API_SECRET;
  if (!apiKey || !apiSecret) {
    throw new Error("Falta configurar BINANCE_API_KEY / BINANCE_API_SECRET en Netlify");
  }

  const params = new URLSearchParams({
    timestamp: String(Date.now()),
    recvWindow: "10000",
    limit: String(limit),
  });
  if (startTime) params.set("startTime", String(startTime));
  if (endTime) params.set("endTime", String(endTime));

  const signature = sign(params.toString(), apiSecret);
  params.set("signature", signature);

  const res = await fetch(`${BINANCE_BASE_URL}/sapi/v1/pay/transactions?${params.toString()}`, {
    headers: { "X-MBX-APIKEY": apiKey },
  });
  const data = await res.json();

  if (!res.ok || data.code !== "000000") {
    throw new Error(data.message || data.msg || "Error consultando la API de Binance");
  }
  return data.data || [];
}

// Busca, entre tus movimientos recientes de Binance Pay, un pago entrante
// en USDT (orderType "C2C", que es como se registra una transferencia
// hecha a tu Pay ID) que coincida con el monto esperado. Si el cliente
// aporto un ID de transaccion, se prioriza ese match exacto primero; si no
// aparece (o el cliente no lo mando bien), se busca por monto+ventana de
// tiempo -- que es seguro porque es TU propio estado de cuenta, nunca un
// dato que manda el navegador.
async function verifyBinancePayPayment({
  expectedAmountUsd,
  clientTransactionId,
  lookbackMinutes = 30,
  toleranceUsd = 0.01,
}) {
  const endTime = Date.now();
  const startTime = endTime - lookbackMinutes * 60 * 1000;

  const transactions = await fetchPayTransactions({ startTime, endTime });

  const incoming = transactions.filter(
    (t) => t.orderType === "C2C" && t.currency === "USDT" && parseFloat(t.amount) > 0
  );

  if (!incoming.length) {
    return { found: false, error: "No encontramos ningun pago reciente en tu cuenta de Binance Pay." };
  }

  if (clientTransactionId) {
    const exact = incoming.find((t) => String(t.transactionId) === String(clientTransactionId).trim());
    if (exact) {
      const amount = parseFloat(exact.amount);
      if (Math.abs(amount - expectedAmountUsd) > toleranceUsd) {
        return { found: true, amountMismatch: true, amount, transactionId: exact.transactionId };
      }
      return { found: true, amount, transactionId: exact.transactionId, transactionTime: exact.transactionTime };
    }
  }

  const byAmount = incoming.find((t) => Math.abs(parseFloat(t.amount) - expectedAmountUsd) <= toleranceUsd);
  if (byAmount) {
    return {
      found: true,
      amount: parseFloat(byAmount.amount),
      transactionId: byAmount.transactionId,
      transactionTime: byAmount.transactionTime,
    };
  }

  return {
    found: false,
    error: "No encontramos un pago por ese monto en los ultimos minutos. Si ya pagaste, espera unos segundos e intenta de nuevo.",
  };
}

module.exports = { verifyBinancePayPayment };