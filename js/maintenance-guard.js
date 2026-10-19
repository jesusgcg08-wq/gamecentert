// ============================================================================
// GameCenter — maintenance-guard.js
// Se carga en todas las paginas publicas. Lee settings/main y, si el admin
// activo el modo mantenimiento (maintenanceEnabled = true), manda a los
// visitantes a mantenimiento.html. Los administradores siguen viendo el sitio.
//
// Con "?mode=admin" (admin.html) no redirige: solo recuerda que eres admin.
// ============================================================================

import { auth, db } from "./firebase-config.js";
import { doc, getDoc } from "https://www.gstatic.com/firebasejs/10.14.0/firebase-firestore.js";

const MAINT_KEY = "gc_maint";
const ADMIN_KEY = "gc_maint_admin";
const adminMode = new URL(import.meta.url).searchParams.get("mode") === "admin";

function setFlag(key, on) {
  try {
    if (on) localStorage.setItem(key, "1");
    else localStorage.removeItem(key);
  } catch (e) {}
}

async function isAdmin() {
  try {
    await auth.authStateReady();
    const user = auth.currentUser;
    if (!user) return false;
    const snap = await getDoc(doc(db, "users", user.uid));
    return snap.exists() && snap.data().role === "admin";
  } catch (e) {
    return false;
  }
}

async function run() {
  let enabled = false;
  try {
    const snap = await getDoc(doc(db, "settings", "main"));
    enabled = snap.exists() && snap.data().maintenanceEnabled === true;
  } catch (e) {
    return; // si no se puede leer, no bloqueamos el sitio
  }
  setFlag(MAINT_KEY, enabled);

  const admin = await isAdmin();
  setFlag(ADMIN_KEY, admin);
  if (adminMode || !enabled) return;

  if (admin) {
    // El admin ve el sitio normal, con un aviso discreto
    const bar = document.createElement("div");
    bar.className = "maint-admin-bar";
    bar.textContent = "Modo mantenimiento activo: solo los administradores ven el sitio.";
    bar.style.cssText =
      "position:fixed;left:50%;bottom:12px;transform:translateX(-50%);z-index:9999;background:#fbbf24;color:#1a1300;font:600 12px Inter,sans-serif;padding:8px 14px;border-radius:999px;box-shadow:0 8px 24px rgba(0,0,0,.4);max-width:92vw;text-align:center;";
    document.body.appendChild(bar);
    return;
  }
  location.replace("mantenimiento.html");
}

run();
