// netlify/functions/lib/firebase.js
// Inicializa firebase-admin UNA sola vez usando la API MODULAR
// (firebase-admin/app, /firestore, /auth), que funciona en todas las
// versiones recientes. Exporta un objeto con la misma forma que el viejo
// "admin" (admin.firestore(), admin.auth(), admin.firestore.FieldValue...)
// para que el resto de las functions no tengan que cambiar.
//
// Credenciales (cualquiera de las dos formas):
//  A) FIREBASE_SERVICE_ACCOUNT_BASE64 -> JSON de la cuenta de servicio en base64
//  B) FIREBASE_PROJECT_ID + FIREBASE_CLIENT_EMAIL + FIREBASE_PRIVATE_KEY
const { initializeApp, getApps, getApp, cert } = require("firebase-admin/app");
const { getFirestore, FieldValue, Timestamp } = require("firebase-admin/firestore");
const { getAuth } = require("firebase-admin/auth");

function loadCredentials() {
  let projectId = process.env.FIREBASE_PROJECT_ID;
  let clientEmail = process.env.FIREBASE_CLIENT_EMAIL;
  let rawPrivateKey = process.env.FIREBASE_PRIVATE_KEY;

  if ((!projectId || !clientEmail || !rawPrivateKey) && process.env.FIREBASE_SERVICE_ACCOUNT_BASE64) {
    let json;
    try {
      json = JSON.parse(Buffer.from(process.env.FIREBASE_SERVICE_ACCOUNT_BASE64, "base64").toString("utf8"));
    } catch {
      throw new Error("FIREBASE_SERVICE_ACCOUNT_BASE64 no es un JSON valido en base64");
    }
    projectId = projectId || json.project_id;
    clientEmail = clientEmail || json.client_email;
    rawPrivateKey = rawPrivateKey || json.private_key;
  }

  if (!projectId || !clientEmail || !rawPrivateKey) {
    throw new Error(
      "Falta configurar credenciales de Firebase: FIREBASE_SERVICE_ACCOUNT_BASE64, o bien FIREBASE_PROJECT_ID + FIREBASE_CLIENT_EMAIL + FIREBASE_PRIVATE_KEY"
    );
  }
  // El private_key puede traer "\n" como texto literal: se convierte a saltos de linea reales.
  return { projectId, clientEmail, privateKey: rawPrivateKey.replace(/\\n/g, "\n") };
}

const app = getApps().length ? getApp() : initializeApp({ credential: cert(loadCredentials()) });

// Misma forma que el namespace clasico: admin.firestore() y admin.firestore.FieldValue
function firestore() {
  return getFirestore(app);
}
firestore.FieldValue = FieldValue;
firestore.Timestamp = Timestamp;

function auth() {
  return getAuth(app);
}

module.exports = { firestore, auth, app };
