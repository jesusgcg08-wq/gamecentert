// Netlify Function: primer paso del flujo de "olvide mi contraseña".
// Recibe un correo, genera un codigo numerico de 6 digitos, lo guarda
// (hasheado, nunca en texto plano) en Firestore con expiracion corta, y lo
// manda por correo via EmailJS -- misma cuenta que el correo de bienvenida
// de auth.js, pero con una PLANTILLA NUEVA que hay que crear en el
// dashboard de EmailJS (ver EMAILJS_RESET_TEMPLATE_ID mas abajo).
//
// Reglas de seguridad de este endpoint:
// - Nunca se confirma si el correo existe o no: la respuesta es identica
//   en ambos casos, para no dejar que alguien use esto para averiguar que
//   correos estan registrados.
// - El codigo sirve SOLO para la ultima solicitud: pedir uno nuevo
//   sobreescribe el anterior en Firestore, asi que el viejo deja de servir.
// - Reenvio limitado a 1 cada 120 segundos por correo, validado aqui en el
//   servidor contra el timestamp guardado (no se puede saltar recargando
//   la pagina ni abriendo otra pestaña).
// - El codigo expira a los 10 minutos.

const crypto = require("crypto");
const admin = require("./lib/firebase-admin");

const db = admin.firestore();

const RESEND_COOLDOWN_MS = 120 * 1000;
const CODE_TTL_MS = 10 * 60 * 1000;

// ---- EmailJS ----------------------------------------------------------
// IMPORTANTE: crea una plantilla NUEVA en tu cuenta de EmailJS (distinta a
// la de bienvenida) con variables {{to_name}}, {{to_email}} y {{code}}, y
// pega su Template ID abajo en EMAILJS_RESET_TEMPLATE_ID.
const EMAILJS_SERVICE_ID = "service_4bwr8io";
const EMAILJS_RESET_TEMPLATE_ID = "template_dtojdu7";
const EMAILJS_PUBLIC_KEY = "coyLXUV2WFGAFrYq6";
// Opcional pero recomendado: si en tu cuenta de EmailJS tienes activada la
// verificacion de origen (Allowed Origins) para bloquear llamadas que no
// vengan de un navegador, las peticiones desde esta funcion de servidor
// pueden ser rechazadas. Si eso pasa, agrega tu Private Key de EmailJS
// como variable de entorno EMAILJS_PRIVATE_KEY en Netlify -- se manda como
// "accessToken" y evita ese bloqueo.
const EMAILJS_PRIVATE_KEY = process.env.EMAILJS_PRIVATE_KEY || null;

async function sendResetCodeEmail({ toName, toEmail, code }) {
  const payload = {
    service_id: EMAILJS_SERVICE_ID,
    template_id: EMAILJS_RESET_TEMPLATE_ID,
    user_id: EMAILJS_PUBLIC_KEY,
    template_params: { to_name: toName, to_email: toEmail, code },
  };
  if (EMAILJS_PRIVATE_KEY) payload.accessToken = EMAILJS_PRIVATE_KEY;

  const res = await fetch("https://api.emailjs.com/api/v1.0/email/send", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`EmailJS respondio ${res.status}: ${text}`);
  }
}

function hashCode(code) {
  return crypto.createHash("sha256").update(code).digest("hex");
}

exports.handler = async function (event) {
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, body: JSON.stringify({ success: false, message: "Metodo no permitido" }) };
  }

  let body;
  try {
    body = JSON.parse(event.body);
  } catch {
    return { statusCode: 400, body: JSON.stringify({ success: false, message: "Body invalido" }) };
  }

  const email = String(body.email || "").toLowerCase().trim();
  if (!email) {
    return { statusCode: 400, body: JSON.stringify({ success: false, message: "Falta el correo" }) };
  }

  // Respuesta generica que se devuelve SIEMPRE que no haya un limite de
  // reenvio activo, exista o no la cuenta -- ver nota de seguridad arriba.
  const genericResponse = {
    statusCode: 200,
    body: JSON.stringify({
      success: true,
      message: "Si el correo esta registrado, te enviamos un codigo. Revisa tu bandeja (y spam).",
    }),
  };

  const codeDocRef = db.collection("passwordResetCodes").doc(email);

  // ---- Limite de reenvio: 1 cada 120s, validado contra Firestore. ----
  const existing = await codeDocRef.get();
  if (existing.exists) {
    const lastCreatedAt = existing.data().createdAt?.toMillis?.() || 0;
    const elapsed = Date.now() - lastCreatedAt;
    if (elapsed < RESEND_COOLDOWN_MS) {
      const waitSeconds = Math.ceil((RESEND_COOLDOWN_MS - elapsed) / 1000);
      return {
        statusCode: 429,
        body: JSON.stringify({
          success: false,
          message: `Espera ${waitSeconds} segundos antes de pedir otro codigo.`,
          waitSeconds,
        }),
      };
    }
  }

  // ---- Solo se genera/envia el codigo si el correo tiene cuenta real. ----
  let userRecord;
  try {
    userRecord = await admin.auth().getUserByEmail(email);
  } catch {
    return genericResponse; // no existe -- mismo mensaje generico, no se crea nada
  }

  const code = String(crypto.randomInt(100000, 1000000)); // 6 digitos
  await codeDocRef.set({
    uid: userRecord.uid,
    codeHash: hashCode(code),
    attempts: 0,
    used: false,
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
    expiresAt: admin.firestore.Timestamp.fromMillis(Date.now() + CODE_TTL_MS),
  });

  try {
    await sendResetCodeEmail({ toName: userRecord.displayName || "", toEmail: email, code });
  } catch (err) {
    // El codigo ya quedo guardado en Firestore -- igual devolvemos el
    // mensaje generico (para no filtrar si el correo existe), pero se deja
    // en el log para poder diagnosticar problemas de EmailJS.
    console.error("[request-password-reset] No se pudo enviar el correo:", err.message);
  }

  return genericResponse;
};