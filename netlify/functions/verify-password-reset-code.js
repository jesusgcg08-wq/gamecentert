// Netlify Function: segundo paso del flujo de "olvide mi contraseña".
// Recibe el correo, el codigo que el usuario escribio y la nueva
// contraseña. Verifica el codigo contra el hash guardado en Firestore por
// request-password-reset.js y, si es correcto, cambia la contraseña
// directamente con permisos de admin -- a diferencia del cambio de
// contraseña normal (account-menu.js), aqui NO hace falta la contraseña
// anterior, porque la prueba de identidad es el codigo que llego al correo.

const crypto = require("crypto");
const admin = require("./lib/firebase");

const db = admin.firestore();

const MAX_ATTEMPTS = 5; // por codigo
const MAX_FAILS_PER_DAY = 10; // por correo en 24 h (mismo valor que request-password-reset.js)

function hashCode(code) {
  return crypto.createHash("sha256").update(code).digest("hex");
}

function mismoHash(a, b) {
  const x = Buffer.from(String(a || ""), "utf8");
  const y = Buffer.from(String(b || ""), "utf8");
  return x.length === y.length && crypto.timingSafeEqual(x, y);
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

  // Todo dentro de una transaccion: revisar intentos, comparar y sumar el
  // intento fallido es UN solo paso. Antes eran pasos separados y alguien
  // podia mandar cientos de intentos a la vez y todos pasaban el limite de 5.
  // El codigo correcto se marca usado en la misma transaccion (un solo uso).
  let resultado;
  try {
    resultado = await db.runTransaction(async (tx) => {
      const snap = await tx.get(codeDocRef);
      if (!snap.exists) return { ok: false };
      const data = snap.data();
      if (data.used) return { ok: false };
      const expiresAtMs = data.expiresAt?.toMillis?.() || 0;
      if (Date.now() > expiresAtMs) return { ok: false };
      if ((data.attempts || 0) >= MAX_ATTEMPTS || (data.dailyFails || 0) >= MAX_FAILS_PER_DAY) {
        return { ok: false, demasiados: true };
      }
      if (!mismoHash(data.codeHash, hashCode(code))) {
        tx.update(codeDocRef, {
          attempts: admin.firestore.FieldValue.increment(1),
          dailyFails: admin.firestore.FieldValue.increment(1),
        });
        return { ok: false };
      }
      tx.update(codeDocRef, { used: true });
      return { ok: true, uid: data.uid };
    });
  } catch (err) {
    console.error("[verify-password-reset-code] error en la transaccion:", err);
    return fail(500, "No se pudo verificar el codigo, intenta de nuevo.");
  }

  if (resultado.demasiados) {
    return fail(400, "Demasiados intentos con este codigo. Solicita uno nuevo.");
  }
  if (!resultado.ok) return invalidCodeResponse;

  try {
    await admin.auth().updateUser(resultado.uid, { password: newPassword });
  } catch (err) {
    console.error("[verify-password-reset-code] error actualizando contraseña:", err);
    return fail(500, "No se pudo actualizar la contraseña. Solicita un codigo nuevo.");
  }

  return { statusCode: 200, body: JSON.stringify({ success: true, message: "Contraseña actualizada." }) };
};