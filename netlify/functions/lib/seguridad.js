// netlify/functions/lib/seguridad.js
// Validaciones compartidas por las funciones que manejan dinero. Todo lo que
// llega del navegador se trata como sospechoso: tipo, tamaño y formato.

const crypto = require("crypto");

// Opcion de un producto, solo si es una opcion REAL con precio valido.
// (Antes "__proto__" o "constructor" como optionId pasaban el chequeo y
// dejaban el precio en NaN.)
function opcionReal(product, optionId) {
  const opciones = product && product.options;
  if (!opciones || typeof opciones !== "object") return null;
  const id = String(optionId || "");
  if (!id || !Object.prototype.hasOwnProperty.call(opciones, id)) return null;
  const opcion = opciones[id];
  if (!opcion || typeof opcion !== "object") return null;
  const precio = Number(opcion.priceUsd);
  if (!Number.isFinite(precio) || precio <= 0) return null;
  return opcion;
}

// Porcentaje de un cupon: numero entre 0 y 100, si no, 0.
function porcentajeCupon(valor) {
  const n = Number(valor);
  return Number.isFinite(n) && n > 0 && n <= 100 ? n : 0;
}

// Monto en USD que manda el navegador (depositos a la wallet). Tiene que ser
// un NUMERO de verdad: antes un texto como "1" hacia que el saldo se pegara
// como texto ("9" + "1" = "91") en vez de sumarse.
function montoValido(valor, { min = 0.01, max = 10000 } = {}) {
  if (typeof valor !== "number" || !Number.isFinite(valor)) return null;
  if (valor < min || valor > max) return null;
  return valor;
}

// Saldo guardado en Firestore -> numero (por si alguno quedo como texto).
function saldoNumero(valor) {
  const n = Number(valor);
  return Number.isFinite(n) ? n : 0;
}

// Texto corto del cliente (ID de jugador, telefono, etc.). Devuelve null si
// no es texto/numero, para no guardar objetos raros en Firestore.
function textoCorto(valor, max = 100) {
  if (valor === undefined || valor === null) return "";
  if (typeof valor !== "string" && typeof valor !== "number") return null;
  return String(valor).trim().slice(0, max);
}

// Referencia de pago -> id seguro para un documento de Firestore.
// Solo letras, numeros y guion; nada de "/" (rompia la ruta del documento).
function referenciaValida(valor) {
  const t = textoCorto(valor, 80);
  if (!t || !/^[A-Za-z0-9-]{4,80}$/.test(t)) return null;
  return t;
}

// Registro PERMANENTE de pagos ya usados (pedido o deposito). No depende
// solo de lo que diga Pabilo: si el mismo pago ya se uso, no se usa otra vez.
// tipo: "pm" (pago movil) o "bn" (binance).
function pagoUsadoRef(db, tipo, referencia) {
  const limpia = String(referencia || "").replace(/[^A-Za-z0-9-]/g, "").toUpperCase();
  return db.collection("usedPayments").doc(`${tipo}_${limpia}`);
}

// Clave para que SOLO nuestras propias funciones puedan disparar las
// funciones en segundo plano. Sale de un secreto que ya existe en Netlify
// (no hay que configurar nada nuevo); si quieres, define INTERNAL_FN_SECRET.
function claveInterna() {
  const base =
    process.env.INTERNAL_FN_SECRET ||
    process.env.FIREBASE_PRIVATE_KEY ||
    process.env.FIREBASE_SERVICE_ACCOUNT_BASE64 ||
    "";
  if (!base) return "";
  return crypto.createHash("sha256").update(`gamecenter-interno:${base}`).digest("hex");
}

function claveInternaOk(event) {
  const esperada = claveInterna();
  const headers = (event && event.headers) || {};
  const recibida = String(headers["x-gc-interno"] || headers["X-Gc-Interno"] || "");
  if (!esperada || recibida.length !== esperada.length) return false;
  return crypto.timingSafeEqual(Buffer.from(recibida), Buffer.from(esperada));
}

// IP del visitante (Netlify la manda en este encabezado).
function ipCliente(event) {
  const h = (event && event.headers) || {};
  return String(h["x-nf-client-connection-ip"] || h["client-ip"] || String(h["x-forwarded-for"] || "").split(",")[0] || "desconocida").trim();
}

// Limite de intentos: maximo "max" llamadas por "ventanaMs" para una clave
// (por ejemplo la IP). Devuelve true si todavia puede, false si se paso.
// Guarda solo un hash de la clave, nunca la IP en claro.
async function dentroDelLimite(db, prefijo, clave, max, ventanaMs) {
  const id = `${prefijo}_${crypto.createHash("sha256").update(String(clave)).digest("hex").slice(0, 32)}`;
  const ref = db.collection("rateLimits").doc(id);
  const ahora = Date.now();
  try {
    return await db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      const d = snap.exists ? snap.data() : {};
      let inicio = typeof d.inicio === "number" ? d.inicio : 0;
      let cuenta = typeof d.cuenta === "number" ? d.cuenta : 0;
      if (ahora - inicio > ventanaMs) {
        inicio = ahora;
        cuenta = 0;
      }
      if (cuenta >= max) return false;
      tx.set(ref, { inicio, cuenta: cuenta + 1 });
      return true;
    });
  } catch (err) {
    // Si Firestore falla, no bloqueamos al cliente por eso.
    console.error("[seguridad] limite de intentos no disponible:", err.message);
    return true;
  }
}

module.exports = {
  ipCliente,
  dentroDelLimite,
  opcionReal,
  porcentajeCupon,
  montoValido,
  saldoNumero,
  textoCorto,
  referenciaValida,
  pagoUsadoRef,
  claveInterna,
  claveInternaOk,
};
