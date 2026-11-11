// Netlify Function: sube o borra una foto del carrusel del inicio.
// Solo la puede usar un administrador (users/{uid}.role == "admin").
//
// La foto llega ya achicada desde el panel (js/admin.js la pasa a JPEG de
// maximo 1600 px) y se guarda en Firestore, coleccion "carruselFotos", como
// bytes. Se escribe con permisos de servidor (firebase-admin), asi que no hace
// falta tocar las reglas de Firestore. La sirve carrusel-foto.js.
//
// POST con Authorization: Bearer <idToken> y body JSON:
//   { "accion": "subir", "tipo": "image/jpeg", "datos": "<base64>" } -> { success, id, url }
//   { "accion": "borrar", "id": "<id>" }                               -> { success }

const admin = require("./lib/firebase");

const db = admin.firestore();
const MAX_BYTES = 900 * 1024; // Firestore admite hasta ~1 MB por documento
const TIPOS = ["image/jpeg", "image/png", "image/webp"];

function respuesta(statusCode, data) {
  return { statusCode, headers: { "Content-Type": "application/json" }, body: JSON.stringify(data) };
}
function fail(statusCode, message) {
  return respuesta(statusCode, { success: false, message });
}

// Comprueba que los bytes de verdad sean una imagen del tipo indicado
function esImagen(buf, tipo) {
  if (tipo === "image/jpeg") return buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff;
  if (tipo === "image/png") return buf.slice(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  if (tipo === "image/webp") return buf.slice(0, 4).toString("ascii") === "RIFF" && buf.slice(8, 12).toString("ascii") === "WEBP";
  return false;
}

exports.handler = async function (event) {
  if (event.httpMethod !== "POST") return fail(405, "Metodo no permitido");

  // ---- Solo administradores ----
  const authHeader = event.headers.authorization || event.headers.Authorization || "";
  const idToken = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null;
  if (!idToken) return fail(401, "Falta autenticacion");
  let uid;
  try {
    uid = (await admin.auth().verifyIdToken(idToken)).uid;
  } catch {
    return fail(401, "Sesion invalida, inicia sesion de nuevo");
  }
  const userSnap = await db.collection("users").doc(uid).get();
  if (!userSnap.exists || userSnap.data().role !== "admin") {
    return fail(403, "Solo un administrador puede cambiar el carrusel");
  }

  let body;
  try {
    body = JSON.parse(event.body || "{}");
  } catch {
    return fail(400, "Body invalido");
  }

  if (body.accion === "borrar") {
    const id = String(body.id || "");
    if (!/^[A-Za-z0-9]{10,40}$/.test(id)) return fail(400, "Id invalido");
    await db.collection("carruselFotos").doc(id).delete();
    return respuesta(200, { success: true });
  }

  if (body.accion !== "subir") return fail(400, "Accion invalida");

  const tipo = String(body.tipo || "");
  if (!TIPOS.includes(tipo)) return fail(400, "Formato no permitido. Usa JPG, PNG o WEBP");
  let buf;
  try {
    buf = Buffer.from(String(body.datos || ""), "base64");
  } catch {
    return fail(400, "La foto llego dañada");
  }
  if (!buf.length) return fail(400, "La foto esta vacia");
  if (buf.length > MAX_BYTES) return fail(413, "La foto es muy pesada (maximo 900 KB despues de achicarla)");
  if (!esImagen(buf, tipo)) return fail(400, "El archivo no es una imagen valida");

  const ref = db.collection("carruselFotos").doc();
  await ref.set({
    datos: buf,
    tipo,
    bytes: buf.length,
    subidaPor: uid,
    creada: admin.firestore.FieldValue.serverTimestamp(),
  });

  return respuesta(200, { success: true, id: ref.id, url: `/.netlify/functions/carrusel-foto?id=${ref.id}` });
};
