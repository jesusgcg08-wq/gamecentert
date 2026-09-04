// ============================================================================
// GameCenter — Configuracion de Firebase
// Reemplaza js/config.js (que antes solo tenia API_BASE apuntando al backend
// Express). Ahora el "backend" es directamente Firebase Auth + Firestore.
//
// Estos valores NO son secretos: la clave de API de Firebase esta pensada
// para ir en el frontend (la seguridad real la dan las Firestore Rules,
// no esta clave). Aun asi, cada quien debe pegar aqui la config de SU
// propio proyecto de Firebase (Project settings > General > Tus apps > SDK).
// ============================================================================

import { initializeApp } from "https://www.gstatic.com/firebasejs/10.14.0/firebase-app.js";
import {
  getAuth,
  connectAuthEmulator,
} from "https://www.gstatic.com/firebasejs/10.14.0/firebase-auth.js";
import {
  getFirestore,
  connectFirestoreEmulator,
} from "https://www.gstatic.com/firebasejs/10.14.0/firebase-firestore.js";

const firebaseConfig = {
  apiKey: "AIzaSyBE3Kk7tHS_qAxLBo4rprPl1RXM_j9AmEo",
  authDomain: "gamecenternuevo.firebaseapp.com",
  projectId: "gamecenternuevo",
  storageBucket: "gamecenternuevo.firebasestorage.app",
  messagingSenderId: "806006253817",
  appId: "1:806006253817:web:8f74681b586f734471da28",
  measurementId: "G-6KH2HQRXZ4"
};

export const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);
export const db = getFirestore(app);

// Numero de WhatsApp de soporte (antes tambien vivia en Settings, pero este
// es el fijo que ya usabas hardcodeado en los enlaces de index.html/dashboard.html)
export const SUPPORT_WHATSAPP = "584264300345";