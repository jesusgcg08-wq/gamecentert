// ============================================================================
// GameCenter — account-menu.js
// Modulo COMPARTIDO por index.html, dashboard.html y wallet.html. Se encarga
// de UNA sola cosa que todas las paginas necesitan: la sesion del cliente.
//
// Que hace:
//  - Escucha Firebase Auth y el documento "users/{uid}" en tiempo real.
//  - Dibuja dentro de <div id="navAccountArea"> los links Catalogo / Soporte,
//    el selector de moneda (USD / Bs) y el cuadro de cuenta (foto + nombre +
//    saldo) con su menu desplegable: Mis pedidos, Info, Wallet, Salir.
//  - Si no hay sesion, muestra un boton "Iniciar sesion".
//  - Expone helpers para que main.js / dashboard.js / wallet.js no tengan que
//    reescribir nada de esto: initAccountMenu, onAccountChange, getCurrentUser,
//    getCurrentProfile, getDisplayCurrency.
//
// IMPORTANTE: cada pagina que use este modulo necesita en su navbar:
//   <div class="nav-links" id="navAccountArea"></div>
// (sin links fijos de Catalogo/Dashboard/Salir a mano, eso ya lo pone este JS)
// ============================================================================

import { auth, db } from "./firebase-config.js";
import {
  onAuthStateChanged,
  signOut,
  EmailAuthProvider,
  reauthenticateWithCredential,
  updatePassword,
} from "https://www.gstatic.com/firebasejs/10.14.0/firebase-auth.js";
import { doc, getDoc, onSnapshot, updateDoc } from "https://www.gstatic.com/firebasejs/10.14.0/firebase-firestore.js";

const CURRENCY_KEY = "gc_display_currency";

let currentUser = null;
let currentProfile = null;
let profileUnsub = null;
let publicSettings = null;
let pageOptions = { activePage: "" };

const listeners = [];

// ============ API publica ============
export function getCurrentUser() {
  return currentUser;
}
export function getCurrentProfile() {
  return currentProfile;
}
export function getDisplayCurrency() {
  return localStorage.getItem(CURRENCY_KEY) === "usd" ? "usd" : "bs";
}
export function onAccountChange(callback) {
  listeners.push(callback);
  // Si ya sabemos el estado (el listener se agrego tarde), avisamos de una vez
  if (authResolvedOnce) callback(currentUser, currentProfile);
}

let authResolvedOnce = false;

function notifyListeners() {
  listeners.forEach((cb) => {
    try {
      cb(currentUser, currentProfile);
    } catch (err) {
      console.error(err);
    }
  });
}

async function ensurePublicSettings() {
  if (!publicSettings) {
    try {
      const snap = await getDoc(doc(db, "settings", "main"));
      publicSettings = snap.exists() ? snap.data() : { exchangeRateBsPerUsd: 0 };
    } catch (err) {
      console.error(err);
      publicSettings = { exchangeRateBsPerUsd: 0 };
    }
  }
  return publicSettings;
}

// ============ Init ============
export function initAccountMenu(options = {}) {
  pageOptions = { ...pageOptions, ...options };
  injectStylesOnce();

  const area = document.getElementById("navAccountArea");
  if (area) buildStaticNav(area);

  ensurePublicSettings();

  onAuthStateChanged(auth, (user) => {
    currentUser = user;

    if (profileUnsub) {
      profileUnsub();
      profileUnsub = null;
    }

    if (user) {
      profileUnsub = onSnapshot(
        doc(db, "users", user.uid),
        (snap) => {
          currentProfile = snap.exists() ? { uid: user.uid, ...snap.data() } : { uid: user.uid };
          authResolvedOnce = true;
          renderAccountBox();
          notifyListeners();
        },
        (err) => {
          console.error(err);
          authResolvedOnce = true;
          notifyListeners();
        }
      );
    } else {
      currentProfile = null;
      authResolvedOnce = true;
      renderAccountBox();
      notifyListeners();
    }
  });

  document.addEventListener("click", (e) => {
    document.querySelectorAll(".currency-toggle.open").forEach((el) => {
      if (!el.contains(e.target)) el.classList.remove("open");
    });
    document.querySelectorAll(".account-box.open").forEach((el) => {
      if (!el.contains(e.target)) el.classList.remove("open");
    });
  });
}

// ============ Nav: partes fijas (Catalogo / Soporte / moneda / cuenta) ============
function buildStaticNav(area) {
  const cur = getDisplayCurrency();
  area.innerHTML = `
    <a href="index.html" class="${pageOptions.activePage === "catalogo" ? "active" : ""}">Catalogo</a>
    <a href="index.html#soporte">Soporte</a>
    <div class="currency-toggle" id="gcCurrencyToggle">
      <button type="button" class="currency-toggle-btn" id="gcCurrencyBtn">
        <span id="gcCurrencyLabel">${cur === "bs" ? "Bs" : "USD"}</span>
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><path d="M6 9l6 6 6-6"/></svg>
      </button>
      <div class="currency-dropdown">
        <div class="currency-option ${cur === "usd" ? "active" : ""}" data-cur="usd">Ver en Dolares (USD)</div>
        <div class="currency-option ${cur === "bs" ? "active" : ""}" data-cur="bs">Ver en Bolivares (Bs)</div>
      </div>
    </div>
    <div id="gcAccountBox"></div>
  `;

  const toggle = document.getElementById("gcCurrencyToggle");
  toggle.querySelector("#gcCurrencyBtn").addEventListener("click", (e) => {
    e.stopPropagation();
    toggle.classList.toggle("open");
  });
  toggle.querySelectorAll(".currency-option").forEach((opt) => {
    opt.addEventListener("click", () => {
      const cur2 = opt.dataset.cur;
      localStorage.setItem(CURRENCY_KEY, cur2);
      document.getElementById("gcCurrencyLabel").textContent = cur2 === "bs" ? "Bs" : "USD";
      toggle.querySelectorAll(".currency-option").forEach((o) => o.classList.toggle("active", o === opt));
      toggle.classList.remove("open");
      window.dispatchEvent(new CustomEvent("gc-currency-change", { detail: { currency: cur2 } }));
      renderAccountBox();
    });
  });

  renderAccountBox();
}

function initials(name) {
  if (!name) return "?";
  return name
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((w) => w.charAt(0).toUpperCase())
    .join("");
}

function formatMoneyDisplay(usdAmount) {
  const cur = getDisplayCurrency();
  if (cur === "bs") {
    const rate = publicSettings?.exchangeRateBsPerUsd || 0;
    return `Bs ${(usdAmount * rate).toLocaleString("es-VE", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  }
  return `$${usdAmount.toFixed(2)}`;
}

function renderAccountBox() {
  const box = document.getElementById("gcAccountBox");
  if (!box) return;

  if (!currentUser) {
    box.innerHTML = `<a href="login.html" class="btn btn-primary btn-sm">Iniciar sesion</a>`;
    return;
  }

  const name = currentProfile?.name || "Mi cuenta";
  const avatarUrl = currentProfile?.avatarUrl || "";
  const balance = currentProfile?.walletBalanceUsd || 0;

  box.innerHTML = `
    <div class="account-box" id="gcAccountBoxInner">
      <div class="account-trigger" id="gcAccountTrigger">
        <div class="account-avatar">
          ${avatarUrl ? `<img src="${avatarUrl}" alt="" onerror="this.parentElement.textContent='${initials(name)}';" />` : initials(name)}
        </div>
        <div class="account-text">
          <div class="account-name">${name}</div>
          <div class="account-balance">${formatMoneyDisplay(balance)}</div>
        </div>
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><path d="M6 9l6 6 6-6"/></svg>
      </div>
      <div class="account-dropdown">
        <a href="dashboard.html" class="account-dropdown-item ${pageOptions.activePage === "dashboard" ? "active" : ""}">🧾 Mis pedidos</a>
        <div class="account-dropdown-item" id="gcOpenInfoBtn">👤 Info</div>
        <a href="wallet.html" class="account-dropdown-item ${pageOptions.activePage === "wallet" ? "active" : ""}">💰 Wallet</a>
        <div class="account-dropdown-item danger" id="gcLogoutBtn">🚪 Salir</div>
      </div>
    </div>
  `;

  const inner = document.getElementById("gcAccountBoxInner");
  inner.querySelector(".account-trigger").addEventListener("click", (e) => {
    e.stopPropagation();
    inner.classList.toggle("open");
  });
  document.getElementById("gcOpenInfoBtn").addEventListener("click", () => {
    inner.classList.remove("open");
    openInfoModal();
  });
  document.getElementById("gcLogoutBtn").addEventListener("click", async () => {
    inner.classList.remove("open");
    await signOut(auth);
    window.location.href = "index.html";
  });
}

// Recalcula el saldo mostrado (usd/bs) sin re-renderizar todo cuando cambia
// la tasa u otro dato -- se llama tambien al recibir el evento de moneda.
window.addEventListener("gc-currency-change", () => renderAccountBox());

// ============ Modal "Info" (telefono, foto, contraseña) ============
let infoModalBuilt = false;

function ensureInfoModal() {
  if (infoModalBuilt) return;
  infoModalBuilt = true;

  const wrapper = document.createElement("div");
  wrapper.className = "modal-backdrop";
  wrapper.id = "gcInfoModalBackdrop";
  wrapper.innerHTML = `
    <div class="modal" style="max-width:460px;">
      <span class="modal-close" id="gcInfoCloseBtn">&times;</span>
      <h3>Mi informacion</h3>
      <p style="color:var(--text-muted); font-size:0.85rem; margin:6px 0 18px;">
        Tu nombre y correo no se pueden cambiar aqui. Si necesitas actualizarlos, contacta a soporte.
      </p>

      <div class="field">
        <label>Nombre</label>
        <input type="text" id="gcInfoName" disabled />
      </div>
      <div class="field">
        <label>Correo</label>
        <input type="text" id="gcInfoEmail" disabled />
      </div>
      <div class="field">
        <label>Telefono</label>
        <input type="text" id="gcInfoPhone" placeholder="04141234567" />
      </div>
      <div class="field">
        <label>Foto de perfil (link a una imagen)</label>
        <input type="text" id="gcInfoAvatar" placeholder="https://..." />
      </div>
      <div id="gcInfoAlert1"></div>
      <button class="btn btn-primary btn-full" id="gcSaveInfoBtn">Guardar cambios</button>

      <div style="height:1px; background:var(--border-soft); margin:24px 0;"></div>

      <h4 style="margin-bottom:4px;">Cambiar contraseña</h4>
      <p style="color:var(--text-muted); font-size:0.82rem; margin:0 0 14px;">
        Por seguridad necesitamos tu contraseña actual para poder cambiarla.
      </p>
      <div class="field">
        <label>Contraseña actual</label>
        <input type="password" id="gcCurrentPassword" />
      </div>
      <div class="field-row">
        <div class="field">
          <label>Nueva contraseña</label>
          <input type="password" id="gcNewPassword" />
        </div>
        <div class="field">
          <label>Confirmar nueva contraseña</label>
          <input type="password" id="gcNewPassword2" />
        </div>
      </div>
      <div id="gcInfoAlert2"></div>
      <button class="btn btn-outline btn-full" id="gcSavePasswordBtn">Actualizar contraseña</button>
    </div>
  `;
  document.body.appendChild(wrapper);

  document.getElementById("gcInfoCloseBtn").addEventListener("click", () => {
    wrapper.classList.remove("open");
  });
  wrapper.addEventListener("click", (e) => {
    if (e.target === wrapper) wrapper.classList.remove("open");
  });

  document.getElementById("gcSaveInfoBtn").addEventListener("click", async () => {
    const alertBox = document.getElementById("gcInfoAlert1");
    const btn = document.getElementById("gcSaveInfoBtn");
    const phone = document.getElementById("gcInfoPhone").value.trim();
    const avatarUrl = document.getElementById("gcInfoAvatar").value.trim();

    if (phone && phone.replace(/\D/g, "").length < 10) {
      alertBox.innerHTML = '<div class="alert alert-error">Revisa el numero de telefono.</div>';
      return;
    }
    if (avatarUrl && !/^https?:\/\//i.test(avatarUrl)) {
      alertBox.innerHTML = '<div class="alert alert-error">El link de la foto debe empezar con http:// o https://</div>';
      return;
    }

    btn.disabled = true;
    const original = btn.textContent;
    btn.innerHTML = `<span class="btn-spinner"></span> Guardando...`;
    alertBox.innerHTML = "";

    try {
      await updateDoc(doc(db, "users", currentUser.uid), { phone, avatarUrl });
      alertBox.innerHTML = '<div class="alert alert-success">Datos actualizados ✅</div>';
    } catch (err) {
      console.error(err);
      alertBox.innerHTML = '<div class="alert alert-error">No se pudo guardar, intenta de nuevo.</div>';
    } finally {
      btn.disabled = false;
      btn.textContent = original;
    }
  });

  document.getElementById("gcSavePasswordBtn").addEventListener("click", async () => {
    const alertBox = document.getElementById("gcInfoAlert2");
    const btn = document.getElementById("gcSavePasswordBtn");
    const currentPassword = document.getElementById("gcCurrentPassword").value;
    const newPassword = document.getElementById("gcNewPassword").value;
    const newPassword2 = document.getElementById("gcNewPassword2").value;

    if (!currentPassword) {
      alertBox.innerHTML = '<div class="alert alert-error">Ingresa tu contraseña actual.</div>';
      return;
    }
    if (newPassword.length < 6) {
      alertBox.innerHTML = '<div class="alert alert-error">La nueva contraseña debe tener al menos 6 caracteres.</div>';
      return;
    }
    if (newPassword !== newPassword2) {
      alertBox.innerHTML = '<div class="alert alert-error">Las dos contraseñas nuevas no coinciden.</div>';
      return;
    }

    btn.disabled = true;
    const original = btn.textContent;
    btn.innerHTML = `<span class="btn-spinner"></span> Actualizando...`;
    alertBox.innerHTML = "";

    try {
      const credential = EmailAuthProvider.credential(currentUser.email, currentPassword);
      await reauthenticateWithCredential(currentUser, credential);
      await updatePassword(currentUser, newPassword);
      alertBox.innerHTML = '<div class="alert alert-success">Contraseña actualizada ✅</div>';
      document.getElementById("gcCurrentPassword").value = "";
      document.getElementById("gcNewPassword").value = "";
      document.getElementById("gcNewPassword2").value = "";
    } catch (err) {
      console.error(err);
      const msg =
        err.code === "auth/wrong-password" || err.code === "auth/invalid-credential"
          ? "La contraseña actual no es correcta."
          : "No se pudo actualizar la contraseña, intenta de nuevo.";
      alertBox.innerHTML = `<div class="alert alert-error">${msg}</div>`;
    } finally {
      btn.disabled = false;
      btn.textContent = original;
    }
  });
}

function openInfoModal() {
  ensureInfoModal();
  document.getElementById("gcInfoName").value = currentProfile?.name || "";
  document.getElementById("gcInfoEmail").value = currentProfile?.email || currentUser?.email || "";
  document.getElementById("gcInfoPhone").value = currentProfile?.phone || "";
  document.getElementById("gcInfoAvatar").value = currentProfile?.avatarUrl || "";
  document.getElementById("gcInfoAlert1").innerHTML = "";
  document.getElementById("gcInfoAlert2").innerHTML = "";
  document.getElementById("gcCurrentPassword").value = "";
  document.getElementById("gcNewPassword").value = "";
  document.getElementById("gcNewPassword2").value = "";
  document.getElementById("gcInfoModalBackdrop").classList.add("open");
}

// Los estilos del menu de cuenta viven en css/style.css. Este flag es solo
// por si en algun momento se quiere inyectar CSS extra desde JS; hoy no hace
// falta nada aqui, pero se deja el hook para no tener que tocar mas archivos.
function injectStylesOnce() {}