// Netlify Function: entrega una foto del carrusel (la que subio el admin con
// carrusel-subir.js). Es publica: la pide el inicio con <img src="...?id=XXX">.
//
// Cada foto nueva tiene un id nuevo y nunca cambia, asi que se guarda en cache
// por un año (navegador y CDN de Netlify): Firestore solo se lee la primera vez.

const admin = require("./lib/firebase");

const db = admin.firestore();

exports.handler = async function (event) {
  const id = String((event.queryStringParameters || {}).id || "");
  if (!/^[A-Za-z0-9]{10,40}$/.test(id)) {
    return { statusCode: 400, body: "Id invalido" };
  }

  const snap = await db.collection("carruselFotos").doc(id).get();
  if (!snap.exists) {
    return { statusCode: 404, headers: { "Cache-Control": "no-store" }, body: "No existe" };
  }

  const { datos, tipo } = snap.data();
  // firebase-admin devuelve los bytes como Buffer
  const buf = Buffer.isBuffer(datos) ? datos : Buffer.from(datos);
  return {
    statusCode: 200,
    headers: {
      "Content-Type": tipo || "image/jpeg",
      "Cache-Control": "public, max-age=31536000, immutable",
      "Netlify-CDN-Cache-Control": "public, durable, max-age=31536000, immutable",
      "X-Content-Type-Options": "nosniff",
    },
    body: buf.toString("base64"),
    isBase64Encoded: true,
  };
};
