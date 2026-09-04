// Netlify Function: segundo paso del flujo de "olvide mi contraseña".
// Recibe el correo, el codigo que el usuario escribio y la nueva
// contraseña. Verifica el codigo contra el hash guardado en Firestore por
// request-password-reset.js y, si es correcto, cambia la contraseña
// directamente con permisos de admin -- a diferencia del cambio de
// contraseña normal (account-menu.js), aqui NO hace falta la contraseña
// anterior, porque la prueba de identidad es el codigo que llego al correo.

const crypto = require("crypto");
const admin = require("./lib/firebase-admin");

const db = admin.firestore();

const MAX_ATTEMPTS = 5;

function hashCode(code) {
  return crypto.createHash("sha256").update(code).digest("hex");
}

function fail(statusCode, message, extra = {}) {
  return { statusCode, body: JSON.stringify({ success: false, message, ...extra }) };
}

exports.handler = async function (event) {
  if (event.httpMethod !== "POST") return fail(405, "Metodo no permitido");

  let body;
  try {
    body = JSON.parse(event.body);
  } catch {
    return fail(400, "Body invalido");
  }

  const email = String(body.email || "").toLowerCase().trim();
  const code = String(body.code || "").trim();
  const newPassword = String(body.newPassword || "");

  if (!email || !code || !newPassword) {
    return fail(400, "Faltan datos");
  }
  if (newPassword.length < 6) {
    return fail(400, "La nueva contraseña debe tener al menos 6 caracteres");
  }

  const codeDocRef = db.collection("passwordResetCodes").doc(email);
  const snap = await codeDocRef.get();

  // Mensaje generico para codigo invalido/vencido/inexistente/ya usado --
  // no hace falta distinguir el motivo exacto, en todos los casos el
  // usuario debe reintentar o pedir un codigo nuevo.
  const invalidCodeResponse = fail(400, "Codigo invalido o vencido. Solicita uno nuevo.");

  if (!snap.exists) return invalidCodeResponse;

  const data = snap.data();
  if (data.used) return invalidCodeResponse;

  const expiresAtMs = data.expiresAt?.toMillis?.() || 0;
  if (Date.now() > expiresAtMs) return invalidCodeResponse;

  if (data.attempts >= MAX_ATTEMPTS) {
    return fail(400, "Demasiados intentos con este codigo. Solicita uno nuevo.");
  }

  if (data.codeHash !== hashCode(code)) {
    await codeDocRef.update({ attempts: admin.firestore.FieldValue.increment(1) });
    return invalidCodeResponse;
  }

  try {
    await admin.auth().updateUser(data.uid, { password: newPassword });
  } catch (err) {
    console.error("[verify-password-reset-code] error actualizando contraseña:", err);
    return fail(500, "No se pudo actualizar la contraseña, intenta de nuevo.");
  }

  // Codigo de un solo uso: se marca usado en vez de borrarse, para que un
  // reintento con el mismo codigo (doble click, etc.) caiga siempre en el
  // mismo mensaje generico de "invalido" en vez de comportarse distinto.
  await codeDocRef.update({ used: true });

  return { statusCode: 200, body: JSON.stringify({ success: true, message: "Contraseña actualizada." }) };
};