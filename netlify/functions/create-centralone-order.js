// Netlify Function (solo ADMIN): boton "Completar (Central One)" del panel.
// Exige sesion Firebase + users/{uid}.role == "admin". Usa lib/centralone.js
// (Idempotency-Key determinista => nunca se crea ni cobra una orden duplicada).
const admin = require("./lib/firebase");
const { createCentralOneOrder } = require("./lib/centralone");
const db = admin.firestore();

const reply = (obj, statusCode = 200) => ({ statusCode, body: JSON.stringify(obj) });

exports.handler = async function (event) {
  if (event.httpMethod !== "POST") return reply({ success: false, message: "Metodo no permitido" }, 405);

  const authHeader = event.headers.authorization || event.headers.Authorization || "";
  const idToken = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null;
  if (!idToken) return reply({ success: false, message: "Falta autenticacion" }, 401);
  let uid;
  try { uid = (await admin.auth().verifyIdToken(idToken)).uid; } catch { return reply({ success: false, message: "Sesion invalida" }, 401); }

  const userSnap = await db.collection("users").doc(uid).get();
  if (!userSnap.exists || userSnap.data().role !== "admin") return reply({ success: false, message: "No autorizado" }, 403);

  let body;
  try { body = JSON.parse(event.body); } catch { return reply({ success: false, message: "Body invalido" }, 400); }

  const { orderId, subCategoryId, playerId, zoneId, extraFieldName, extraFieldValue } = body;
  if (!orderId || !subCategoryId) return reply({ success: false, message: "Faltan orderId o subCategoryId" }, 400);

  const result = await createCentralOneOrder({ orderId, subCategoryId, playerId, zoneId, extraFieldName, extraFieldValue });
  return reply(result); // 200 siempre para que el frontend lea el mensaje
};
