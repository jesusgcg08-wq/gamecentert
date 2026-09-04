// netlify/functions/lib/firebase-admin.js
// Inicializa firebase-admin UNA sola vez (Netlify puede reusar el mismo
// contenedor entre invocaciones, por eso el chequeo de admin.apps.length).
//
// Necesita 3 variables de entorno en Netlify, sacadas del JSON que
// descargas en Firebase Console -> icono de engranaje -> "Configuracion
// del proyecto" -> pestaña "Cuentas de servicio" -> "Generar nueva clave
// privada":
//
//   FIREBASE_PROJECT_ID    -> el campo "project_id" del JSON, tal cual
//   FIREBASE_CLIENT_EMAIL  -> el campo "client_email" del JSON, tal cual
//   FIREBASE_PRIVATE_KEY   -> el campo "private_key" del JSON, tal cual
//                             (incluye las comillas de apertura/cierre NO,
//                             solo el contenido de adentro, con los \n
//                             literales como texto -- eso es normal, el
//                             codigo de abajo los convierte a saltos de
//                             linea reales)
//
// Ese archivo .json NO se sube a ningun repo.
const admin = require("firebase-admin");
if (!admin.apps.length) {
  const projectId = process.env.FIREBASE_PROJECT_ID;
  const clientEmail = process.env.FIREBASE_CLIENT_EMAIL;
  const rawPrivateKey = process.env.FIREBASE_PRIVATE_KEY;
  if (!projectId || !clientEmail || !rawPrivateKey) {
    throw new Error(
      "Falta configurar FIREBASE_PROJECT_ID, FIREBASE_CLIENT_EMAIL o FIREBASE_PRIVATE_KEY en Netlify"
    );
  }
  // El private_key del JSON trae "\n" como texto literal (dos caracteres:
  // barra invertida + n), no saltos de linea reales. Al pegarlo en Netlify
  // se mantiene igual, asi que aqui se convierte a saltos de linea reales,
  // que es lo que necesita la libreria de Firebase para leer la clave.
  const privateKey = rawPrivateKey.replace(/\\n/g, "\n");
  admin.initializeApp({
    credential: admin.credential.cert({ projectId, clientEmail, privateKey }),
  });
}
module.exports = admin;