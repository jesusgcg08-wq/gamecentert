// ============================================================================
// GameCenter — Autenticacion de clientes (login.html / register.html)
// Reemplaza routes/auth.js. Ya no hay bcrypt/JWT propios: Firebase Auth
// maneja el hash de contrasena y la sesion. El resto de los datos del
// usuario (name, countryCode, phone) se guardan en Firestore, coleccion
// "users", con el mismo uid que genera Firebase Auth.
//
// Login SOLO por correo (Firebase Auth no soporta telefono como
// identificador nativo sin pasar por SMS/OTP, que ademas requiere Blaze).
// ============================================================================

import { auth, db } from "./firebase-config.js";
import {
  createUserWithEmailAndPassword,
  signInWithEmailAndPassword,
  GoogleAuthProvider,
  signInWithPopup,
} from "https://www.gstatic.com/firebasejs/10.14.0/firebase-auth.js";
import {
  doc,
  getDoc,
  setDoc,
  serverTimestamp,
} from "https://www.gstatic.com/firebasejs/10.14.0/firebase-firestore.js";

// Misma validacion de paises que tenias en el backend
const ALLOWED_COUNTRY_CODES = [
  "+1", "+52", "+54", "+55", "+56", "+57", "+58", "+51", "+593", "+595",
  "+598", "+591", "+506", "+507", "+503", "+502", "+504", "+505", "+53",
  "+1809", "+1829", "+1849",
];

function showAlert(message, type = "danger") {
  const box = document.getElementById("alertBox");
  if (!box) return;
  box.innerHTML = `<div class="alert alert-${type}">${message}</div>`;
}

// ---- Correo de bienvenida (EmailJS) ------------------------------------
//
// IMPORTANTE: esto solo funciona si la pagina actual carga el script
// <script src=".../@emailjs/browser@4/dist/email.min.js"></script> ANTES
// de este modulo -- si "emailjs" no esta definido, se registra el error en
// consola y no se manda nada, sin avisar al usuario (a proposito: un
// correo de bienvenida que falle no debe bloquear el registro). Antes solo
// register.html cargaba ese script; login.html no lo tenia, asi que un
// registro nuevo por Google hecho DESDE login.html (ver
// handleGoogleSignIn mas abajo) fallaba en silencio. Ya se agrego el
// script a login.html tambien.

const EMAILJS_SERVICE_ID = "service_4bwr8io";
const EMAILJS_TEMPLATE_ID = "template_8i8zuxl";
const EMAILJS_PUBLIC_KEY = "coyLXUV2WFGAFrYq6";

function sendWelcomeEmail(name, email) {
  if (typeof emailjs === "undefined") {
    console.error("EmailJS no esta cargado (falta el script en esta pagina)");
    return;
  }
  emailjs
    .send(
      EMAILJS_SERVICE_ID,
      EMAILJS_TEMPLATE_ID,
      { to_name: name, to_email: email },
      EMAILJS_PUBLIC_KEY
    )
    .catch((err) => console.error("Error enviando correo de bienvenida:", err));
}

// ---- Registro --------------------------------------------------------

const registerForm = document.getElementById("registerForm");
if (registerForm) {
  registerForm.addEventListener("submit", async (e) => {
    e.preventDefault();

    const name = document.getElementById("name").value.trim();
    const countryCode = document.getElementById("countryCode").value;
    const phone = document.getElementById("phone").value.trim();
    const email = document.getElementById("email").value.toLowerCase().trim();
    const password = document.getElementById("password").value;

    if (!name || !countryCode || !phone || !email || !password) {
      return showAlert("Todos los campos son obligatorios");
    }
    if (password.length < 6) {
      return showAlert("La contrasena debe tener al menos 6 caracteres");
    }
    if (!ALLOWED_COUNTRY_CODES.includes(countryCode)) {
      return showAlert("Codigo de pais no valido");
    }

    try {
      const cred = await createUserWithEmailAndPassword(auth, email, password);

      // Perfil del usuario. "role" siempre nace "cliente": las Firestore
      // Rules bloquean que el propio usuario se ponga role distinto.
      await setDoc(doc(db, "users", cred.user.uid), {
        name,
        countryCode,
        phone,
        email,
        role: "cliente",
        createdAt: serverTimestamp(),
      });

      sendWelcomeEmail(name, email);

      showAlert("Registro exitoso, iniciando sesion...", "success");
      sessionStorage.setItem("showWelcomeToast", "1");
      setTimeout(() => {
        window.location.href = "index.html";
      }, 1200);
    } catch (err) {
      console.error(err);
      if (err.code === "auth/email-already-in-use") {
        showAlert("Ya existe una cuenta con ese correo");
      } else if (err.code === "auth/weak-password") {
        showAlert("La contrasena es demasiado debil");
      } else {
        showAlert("No se pudo completar el registro. Intenta de nuevo.");
      }
    }
  });
}

// ---- Login -------------------------------------------------------------

const loginForm = document.getElementById("loginForm");
if (loginForm) {
  loginForm.addEventListener("submit", async (e) => {
    e.preventDefault();

    const email = document.getElementById("identifier").value.toLowerCase().trim();
    const password = document.getElementById("password").value;

    if (!email || !password) {
      return showAlert("Completa correo y contrasena");
    }

    try {
      await signInWithEmailAndPassword(auth, email, password);
      sessionStorage.setItem("showWelcomeToast", "1");
      window.location.href = "index.html";
    } catch (err) {
      console.error(err);
      showAlert("Credenciales incorrectas");
    }
  });
}

// ---- Google Sign-In (compartido entre login.html y register.html) -----
//
// Un mismo boton (id="googleSignInBtn") sirve para ambas paginas: si la
// cuenta de Google ya tiene documento en Firestore, es simplemente un
// login; si no lo tiene (primera vez), se crea igual que en el registro
// manual, con "role" siempre en "cliente". countryCode y phone quedan
// vacios porque Google no los da — el usuario los completa despues en su
// perfil ("info"), no se le pide nada extra aqui.

async function handleGoogleSignIn() {
  const provider = new GoogleAuthProvider();

  try {
    const cred = await signInWithPopup(auth, provider);
    const user = cred.user;

    const userRef = doc(db, "users", user.uid);
    const snap = await getDoc(userRef);

    if (!snap.exists()) {
      await setDoc(userRef, {
        name: user.displayName || "",
        countryCode: "",
        phone: "",
        email: user.email,
        role: "cliente",
        createdAt: serverTimestamp(),
      });
      sendWelcomeEmail(user.displayName || "", user.email);
    }

    sessionStorage.setItem("showWelcomeToast", "1");
    window.location.href = "index.html";
  } catch (err) {
    console.error(err);
    if (err.code === "auth/popup-closed-by-user") {
      // El usuario cerro el popup, no hace falta mostrar error
      return;
    }
    if (err.code === "auth/account-exists-with-different-credential") {
      showAlert("Ya existe una cuenta con ese correo usando otro metodo de acceso");
      return;
    }
    showAlert("No se pudo iniciar sesion con Google. Intenta de nuevo.");
  }
}

document.getElementById("googleSignInBtn")?.addEventListener("click", handleGoogleSignIn);

// ---- Olvide mi contraseña (solo login.html) -----------------------------
//
// Flujo con codigo de un solo uso, distinto al link estandar de Firebase
// (sendPasswordResetEmail): el frontend nunca toca Firebase Auth
// directamente aca, todo pasa por dos funciones de Netlify con
// firebase-admin:
//   1) request-password-reset.js: genera el codigo, lo guarda hasheado en
//      Firestore (coleccion "passwordResetCodes") y lo manda por correo.
//      Reenvio limitado a 1 cada 120s, validado en el SERVIDOR (no solo
//      con el contador de aca, que solo es para la experiencia visual).
//   2) verify-password-reset-code.js: valida el codigo contra ese mismo
//      documento y, si es correcto, cambia la contraseña con permisos de
//      admin (no hace falta la contraseña anterior).
//
// Todos los elementos se buscan con "?." porque este modulo tambien se
// carga en register.html, que no tiene este modal.

const forgotLink = document.getElementById("forgotPasswordLink");
const forgotBackdrop = document.getElementById("forgotPasswordBackdrop");
const forgotStepEmail = document.getElementById("forgotStepEmail");
const forgotStepCode = document.getElementById("forgotStepCode");
const forgotAlert = document.getElementById("forgotAlert");
const forgotEmailInput = document.getElementById("forgotEmail");
const forgotSendBtn = document.getElementById("forgotSendBtn");
const forgotResendBtn = document.getElementById("forgotResendBtn");
const forgotCodeInput = document.getElementById("forgotCode");
const forgotNewPassword = document.getElementById("forgotNewPassword");
const forgotNewPassword2 = document.getElementById("forgotNewPassword2");
const forgotResetBtn = document.getElementById("forgotResetBtn");
const forgotCloseBtn = document.getElementById("forgotCloseBtn");

let forgotEmailInFlight = "";
let resendTimer = null;

function showForgotAlert(message, type = "danger") {
  if (forgotAlert) forgotAlert.innerHTML = `<div class="alert alert-${type}">${message}</div>`;
}

function startResendCooldown(seconds) {
  if (!forgotResendBtn) return;
  let remaining = Math.max(1, Math.round(seconds));
  forgotResendBtn.disabled = true;
  forgotResendBtn.textContent = `Reenviar codigo (${remaining}s)`;
  clearInterval(resendTimer);
  resendTimer = setInterval(() => {
    remaining -= 1;
    if (remaining <= 0) {
      clearInterval(resendTimer);
      forgotResendBtn.disabled = false;
      forgotResendBtn.textContent = "Reenviar codigo";
      return;
    }
    forgotResendBtn.textContent = `Reenviar codigo (${remaining}s)`;
  }, 1000);
}

async function requestResetCode(email) {
  try {
    const res = await fetch("/.netlify/functions/request-password-reset", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email }),
    });
    return await res.json();
  } catch (err) {
    console.error(err);
    return { success: false, message: "Error de conexion, intenta de nuevo" };
  }
}

if (forgotLink) {
  forgotLink.addEventListener("click", (e) => {
    e.preventDefault();
    forgotEmailInFlight = "";
    forgotStepEmail.style.display = "";
    forgotStepCode.style.display = "none";
    forgotAlert.innerHTML = "";
    // Comodidad: si ya habia algo escrito en "correo o telefono" del login
    // y parece un correo, lo precargamos.
    const identifierVal = document.getElementById("identifier")?.value.trim() || "";
    forgotEmailInput.value = identifierVal.includes("@") ? identifierVal : "";
    forgotCodeInput.value = "";
    forgotNewPassword.value = "";
    forgotNewPassword2.value = "";
    clearInterval(resendTimer);
    forgotResendBtn.disabled = false;
    forgotResendBtn.textContent = "Reenviar codigo";
    forgotBackdrop.classList.add("open");
  });
}

forgotCloseBtn?.addEventListener("click", () => forgotBackdrop.classList.remove("open"));
forgotBackdrop?.addEventListener("click", (e) => {
  if (e.target === forgotBackdrop) forgotBackdrop.classList.remove("open");
});

forgotSendBtn?.addEventListener("click", async () => {
  const email = forgotEmailInput.value.toLowerCase().trim();
  if (!email) return showForgotAlert("Ingresa tu correo");

  forgotSendBtn.disabled = true;
  const original = forgotSendBtn.textContent;
  forgotSendBtn.innerHTML = `<span class="btn-spinner"></span> Enviando...`;

  const data = await requestResetCode(email);

  forgotSendBtn.disabled = false;
  forgotSendBtn.textContent = original;

  if (!data.success) {
    showForgotAlert(data.message || "No se pudo enviar el codigo");
    // Si el motivo fue el limite de 120s, es porque ya se habia pedido un
    // codigo antes (por ejemplo el usuario cerro el modal por error) --
    // igual lo dejamos pasar a la pantalla del codigo con el cooldown real
    // que devuelve el servidor.
    if (data.waitSeconds) {
      forgotEmailInFlight = email;
      forgotStepEmail.style.display = "none";
      forgotStepCode.style.display = "";
      startResendCooldown(data.waitSeconds);
    }
    return;
  }

  forgotEmailInFlight = email;
  forgotStepEmail.style.display = "none";
  forgotStepCode.style.display = "";
  showForgotAlert(data.message, "success");
  startResendCooldown(120);
});

forgotResendBtn?.addEventListener("click", async () => {
  if (forgotResendBtn.disabled || !forgotEmailInFlight) return;
  forgotResendBtn.disabled = true;

  const data = await requestResetCode(forgotEmailInFlight);

  if (!data.success) {
    showForgotAlert(data.message || "No se pudo reenviar el codigo");
    if (data.waitSeconds) startResendCooldown(data.waitSeconds);
    else forgotResendBtn.disabled = false;
    return;
  }

  showForgotAlert(data.message, "success");
  startResendCooldown(120);
});

forgotResetBtn?.addEventListener("click", async () => {
  const code = forgotCodeInput.value.trim();
  const newPassword = forgotNewPassword.value;
  const newPassword2 = forgotNewPassword2.value;

  if (!code) return showForgotAlert("Ingresa el codigo que te enviamos");
  if (newPassword.length < 6) return showForgotAlert("La nueva contraseña debe tener al menos 6 caracteres");
  if (newPassword !== newPassword2) return showForgotAlert("Las contraseñas no coinciden");

  forgotResetBtn.disabled = true;
  const original = forgotResetBtn.textContent;
  forgotResetBtn.innerHTML = `<span class="btn-spinner"></span> Verificando...`;

  try {
    const res = await fetch("/.netlify/functions/verify-password-reset-code", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: forgotEmailInFlight, code, newPassword }),
    });
    const data = await res.json();

    if (!data.success) {
      showForgotAlert(data.message || "No se pudo restablecer la contraseña");
      return;
    }

    showForgotAlert("Contraseña actualizada. Ya puedes iniciar sesion con ella.", "success");
    setTimeout(() => {
      forgotBackdrop.classList.remove("open");
    }, 1800);
  } catch (err) {
    console.error(err);
    showForgotAlert("Error de conexion, intenta de nuevo");
  } finally {
    forgotResetBtn.disabled = false;
    forgotResetBtn.textContent = original;
  }
});