// ============================================================================
// GameCenter — Catalogo (index.html) + flujo de compra
// Version original migrada de fetch(API_BASE) a Firestore/Firebase Auth.
// Se conserva TODA la funcionalidad original: hero slider, eventos
// especiales, iconos de opcion con fallback, integracion con WhatsApp,
// manejo de cupon ya usado, etc.
// ============================================================================

import { auth, db } from "./firebase-config.js";
import {
  collection,
  query,
  where,
  getDocs,
  doc,
  getDoc,
  onSnapshot,
} from "https://www.gstatic.com/firebasejs/10.14.0/firebase-firestore.js";
import { initAccountMenu, onAccountChange, getCurrentUser, getCurrentProfile, getDisplayCurrency } from "./account-menu.js";

// ============ Sesion del cliente (la maneja account-menu.js, compartido
// entre todas las paginas para no duplicar el listener de Firebase Auth) ============
let currentUser = null;
let currentProfile = null;

function requireLoginOrRedirect() {
  if (!currentUser) window.location.href = "login.html";
  return currentUser;
}

initAccountMenu({ activePage: "catalogo" });
onAccountChange((user, profile) => {
  currentUser = user;
  currentProfile = profile;
  showWelcomeToast();
});

function showWelcomeToast() {
  if (sessionStorage.getItem("showWelcomeToast") !== "1") return;
  sessionStorage.removeItem("showWelcomeToast");

  const firstName = currentProfile ? currentProfile.name.split(" ")[0] : "";
  const toast = document.createElement("div");
  toast.textContent = `¡Bienvenido${firstName ? ", " + firstName : ""}!`;
  toast.style.cssText =
    "position:fixed; top:20px; left:50%; transform:translateX(-50%); background:var(--success-soft); color:var(--success); padding:12px 22px; border-radius:10px; font-weight:600; z-index:999; transition:opacity 0.4s; box-shadow:0 8px 24px rgba(0,0,0,0.3);";
  document.body.appendChild(toast);

  setTimeout(() => {
    toast.style.opacity = "0";
    setTimeout(() => toast.remove(), 400);
  }, 2000);
}

window.addEventListener("gc-currency-change", () => renderGrid());

// ============ Hero: hero1.png, hero2.png, hero3.mp4, hero4.mp4 ============
const HERO_FILES = ["hero1.mp4", "hero2.mp4", "hero3.mp4", "hero4.mp4"];
let heroIndex = 0;
let heroTimer = null;

function initHero() {
  const hero = document.getElementById("hero");
  const dotsBox = document.getElementById("heroDots");
  if (!hero) return;

  HERO_FILES.forEach((file, i) => {
    const slide = document.createElement("div");
    slide.className = "hero-slide" + (i === 0 ? " active" : "");
    slide.dataset.index = i;

    if (file.endsWith(".mp4")) {
      const video = document.createElement("video");
      video.src = `assets/${file}`;
      video.autoplay = true;
      video.muted = true;
      video.loop = true;
      video.playsInline = true;
      slide.appendChild(video);
    } else {
      const img = document.createElement("img");
      img.src = `assets/${file}`;
      img.alt = "GameCenter";
      slide.appendChild(img);
    }
    hero.insertBefore(slide, hero.querySelector(".hero-overlay"));

    const dot = document.createElement("div");
    dot.className = "hero-dot" + (i === 0 ? " active" : "");
    dot.addEventListener("click", () => goToHeroSlide(i));
    dotsBox.appendChild(dot);
  });

  restartHeroTimer();
}

function goToHeroSlide(i) {
  const slides = document.querySelectorAll(".hero-slide");
  const dots = document.querySelectorAll(".hero-dot");
  slides.forEach((s) => s.classList.remove("active"));
  dots.forEach((d) => d.classList.remove("active"));
  slides[i].classList.add("active");
  dots[i].classList.add("active");
  heroIndex = i;
  restartHeroTimer();
}
function restartHeroTimer() {
  clearInterval(heroTimer);
  heroTimer = setInterval(() => {
    goToHeroSlide((heroIndex + 1) % HERO_FILES.length);
  }, 6000);
}

// ============ Utilidades de formato ============
function formatBs(amount) {
  return `Bs ${amount.toLocaleString("es-VE", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}
function formatUsdt(amount) {
  return `$${amount.toFixed(2)} USDT`;
}
// Las imagenes ahora son SIEMPRE una URL completa (no hay backend que las sirva)
function resolveImgSrc(src) {
  return src || "";
}

// ============ Catalogo ============
let allProducts = [];
let activeCategory = "juegos";
let selectedProduct = null;
let selectedOptionId = null;
let selectedPayMethod = "pago_movil";
let publicSettings = null;
let idVerified = false;

async function ensurePublicSettings() {
  if (!publicSettings) {
    const snap = await getDoc(doc(db, "settings", "main"));
    publicSettings = snap.exists() ? snap.data() : { exchangeRateBsPerUsd: 0, pagoMovil: {}, binance: {}, whatsappNumber: "584163557506" };
    setFloatingWhatsapp();
  }
  return publicSettings;
}

function setFloatingWhatsapp() {
  const btn = document.getElementById("floatingWhatsappBtn");
  if (!btn) return;
  const wa = publicSettings.whatsappNumber || "584163557506";
  btn.href = `https://wa.me/${wa}?text=${encodeURIComponent("Hola")}`;
}

async function loadProducts() {
  try {
    await ensurePublicSettings();
    const q = query(collection(db, "products"), where("active", "==", true));
    const snap = await getDocs(q);
    allProducts = snap.docs.map((d) => ({ _id: d.id, ...d.data() }));
    renderGrid();
  } catch (err) {
    console.error("No se pudo cargar el catalogo", err);
  }
}

function renderGrid() {
  // La franja separada de "Evento especial" (con texto generico y repetido)
  // se quita -- si tu index.html todavia tiene el contenedor #eventsStrip,
  // esto lo oculta para que no quede un hueco vacio.
  const eventsBox = document.getElementById("eventsStrip");
  if (eventsBox) eventsBox.style.display = "none";

  const grid = document.getElementById("productGrid");
  if (!grid) return;
  let list = allProducts.filter((p) => p.category === activeCategory);

  // Orden del catalogo:
  // 1) Los productos en Evento Especial siempre van primero (destacados con
  //    su badge "Evento especial" en la tarjeta).
  // 2) Dentro de cada grupo (eventos / normales), se respeta la posicion
  //    definida en el admin (campo "position", menor = sale primero).
  list = [...list].sort((a, b) => {
    const eventDiff = (b.isSpecialEvent ? 1 : 0) - (a.isSpecialEvent ? 1 : 0);
    if (eventDiff !== 0) return eventDiff;
    const posA = typeof a.position === "number" ? a.position : 9999;
    const posB = typeof b.position === "number" ? b.position : 9999;
    return posA - posB;
  });

  const rate = publicSettings ? publicSettings.exchangeRateBsPerUsd : 0;
  const showBs = getDisplayCurrency() === "bs";

  grid.innerHTML = list
    .map((p) => {
      const optionValues = Object.values(p.options || {});
      const minPrice = optionValues.length ? Math.min(...optionValues.map((o) => o.priceUsd)) : 0;
      const minBs = minPrice * rate;
      const priceLine = showBs ? formatBs(minBs) : `$${minPrice.toFixed(2)}`;
      return `
      <div class="card${p.isSpecialEvent ? " card-featured" : ""}">
        <img src="${resolveImgSrc(p.image)}" alt="${p.name}" />
        <div class="card-body">
          <div class="card-region">${p.region}</div>
          <div class="card-name">${p.name}</div>
          <div class="card-price">Desde ${priceLine}</div>
          ${p.isSpecialEvent ? '<div class="badge-event">Evento especial</div>' : ""}
          <button class="btn btn-primary btn-full" style="margin-top:10px;" onclick="openOrderModal('${p._id}')">Elige tu recarga</button>
        </div>
      </div>`;
    })
    .join("");
}

document.querySelectorAll(".tab").forEach((tab) => {
  tab.addEventListener("click", () => {
    document.querySelectorAll(".tab").forEach((t) => t.classList.remove("active"));
    tab.classList.add("active");
    activeCategory = tab.dataset.cat;
    renderGrid();
  });
});

// ============ Modal de compra (pasos) ============
function goToStep(stepId) {
  document.querySelectorAll(".modal-step").forEach((s) => s.classList.remove("active"));
  document.getElementById(stepId).classList.add("active");
}

async function openOrderModal(productId) {
  if (!requireLoginOrRedirect()) return;

  selectedProduct = allProducts.find((p) => p._id === productId);
  if (!selectedProduct) return;

  await ensurePublicSettings();

  document.getElementById("modalProductName").textContent = selectedProduct.name;
  document.getElementById("modalProductRegion").textContent = `Region: ${selectedProduct.region}`;
  renderTrustRow();

  const firstOptId = Object.keys(selectedProduct.options || {})[0];
  selectedOptionId = firstOptId;
  renderOptions();
  selectedPayMethod = "pago_movil";
  document.querySelectorAll(".pay-method").forEach((el) => el.classList.toggle("active", el.dataset.method === "pago_movil"));

  const walletTile = document.getElementById("walletPayMethod");
  if (walletTile) {
    if (currentUser && currentProfile) {
      walletTile.style.display = "flex";
      document.getElementById("walletPayMethodBalance").textContent = `(Saldo: $${(currentProfile.walletBalanceUsd || 0).toFixed(2)})`;
    } else {
      walletTile.style.display = "none";
    }
  }
  document.getElementById("couponInput").value = "";
  document.getElementById("verifyCouponBtn").style.display = "none";
  document.getElementById("couponMsg").textContent = "";
  document.getElementById("couponMsg").className = "coupon-msg";
  document.getElementById("step1Alert").innerHTML = "";
  document.getElementById("modalAlert").innerHTML = "";
  document.getElementById("stepDoneManualAlert").style.display = "block";
  document.getElementById("stepDoneReceiptBox").style.display = "none";
  document.getElementById("stepDoneReceiptBox").innerHTML = "";
  const completeBtnReset = document.getElementById("completeOrderBtn");
  completeBtnReset.disabled = false;
  completeBtnReset.textContent = "Finalizar Pago";

  updateStep2Total();
  goToStep("step1");
  document.getElementById("orderModalBackdrop").classList.add("open");
}
window.openOrderModal = openOrderModal;

function renderTrustRow() {
  const box = document.getElementById("modalTrustRow");
  if (!box) return;

  const deliveryLabel = selectedProduct.autoRecharge ? "Entrega inmediata" : "Entrega manual";
  const deliveryIcon = selectedProduct.autoRecharge
    ? `<svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor"><path d="M13 2 3 14h7l-1 8 10-12h-7l1-8Z"/></svg>`
    : `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 8 12 3 3 8l9 5 9-5Z"/><path d="M3 8v8l9 5 9-5V8"/><path d="M12 13v8"/></svg>`;
  const lockIcon = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="4" y="10" width="16" height="10" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/></svg>`;
  const headsetIcon = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 13v-1a9 9 0 0 1 18 0v1"/><rect x="2" y="13" width="5" height="7" rx="1.5"/><rect x="17" y="13" width="5" height="7" rx="1.5"/></svg>`;

  box.innerHTML = `
    <div class="trust-item">${deliveryIcon}<span>${deliveryLabel}</span></div>
    <div class="trust-item">${lockIcon}<span>Pago Seguro</span></div>
    <div class="trust-item">${headsetIcon}<span>Soporte Activo</span></div>
  `;
}

function renderOptions() {
  const box = document.getElementById("optionSelect");
  const optionsMap = selectedProduct.options || {};
  const entries = Object.entries(optionsMap).sort(
    (a, b) => (typeof a[1].order === "number" ? a[1].order : 9999) - (typeof b[1].order === "number" ? b[1].order : 9999)
  );
  box.innerHTML = entries
    .map(([optId, o]) => {
      const iconHtml = o.icon
        ? `<img src="${resolveImgSrc(o.icon)}" alt="" />`
        : `<div class="opt-icon-fallback">${(o.label || "?").trim().charAt(0).toUpperCase()}</div>`;
      return `<div class="option-tile ${optId === selectedOptionId ? "active" : ""}" onclick="selectOption('${optId}')">
        ${iconHtml}
        <div class="opt-text">
          <strong>${o.label}</strong>
          <span>${formatBs(o.priceUsd * publicSettings.exchangeRateBsPerUsd)}</span>
        </div>
      </div>`;
    })
    .join("");
}
function selectOption(id) {
  selectedOptionId = id;
  renderOptions();
  updateStep2Total();
}
window.selectOption = selectOption;

function updateStep2Total() {
  const option = selectedProduct.options[selectedOptionId];
  if (!option) return;
  document.getElementById("step2Total").textContent = formatBs(option.priceUsd * publicSettings.exchangeRateBsPerUsd);
  renderGameIdField();
  renderZoneIdField();
}

document.querySelectorAll(".pay-method").forEach((el) => {
  el.addEventListener("click", () => {
    document.querySelectorAll(".pay-method").forEach((o) => o.classList.remove("active"));
    el.classList.add("active");
    selectedPayMethod = el.dataset.method;
  });
});

document.getElementById("toStep2Btn")?.addEventListener("click", () => {
  if (!selectedOptionId) {
    document.getElementById("step1Alert").innerHTML = `<div class="alert alert-error">Elige una recarga</div>`;
    return;
  }
  updateStep2Total();
  goToStep("step2");
});
document.getElementById("backToStep1")?.addEventListener("click", () => goToStep("step1"));

document.getElementById("toStep3Btn")?.addEventListener("click", () => {
  renderPayDetails();
  renderExtraField();
  renderGameIdField();
  renderZoneIdField();
  renderProofFields();
  updateTotal();
  goToStep("step3");
});
document.getElementById("backToStep2")?.addEventListener("click", () => goToStep("step2"));

function payRow(label, value, showAlways = true) {
  if (!value && !showAlways) return "";
  const copyBtn = value
    ? `<button type="button" class="copy-field-btn" data-copy-value="${value}">Copiar</button>`
    : "";
  return `<div class="row"><span>${label}:</span><span class="row-value-copy"><strong>${value || "-"}</strong>${copyBtn}</span></div>`;
}

function attachCopyButtons(container) {
  container.querySelectorAll(".copy-field-btn").forEach((btn) => {
    btn.addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText(btn.dataset.copyValue);
        const original = btn.textContent;
        btn.textContent = "Copiado";
        setTimeout(() => (btn.textContent = original), 1200);
      } catch (err) {
        console.error(err);
      }
    });
  });
}

function qrToggleBlock(imageFile, altText) {
  return `
    <button type="button" class="btn btn-outline btn-full" style="margin-bottom:16px;" id="toggleQrBtn">Ver QR</button>
    <div id="qrBox" style="display:none; position:relative; text-align:center; margin-bottom:16px;">
      <span id="closeQrBtn" style="position:absolute; top:-8px; right:-8px; background:var(--bg-surface-2); border:1px solid var(--border-soft); border-radius:50%; width:26px; height:26px; display:flex; align-items:center; justify-content:center; cursor:pointer; font-size:16px;">&times;</span>
      <img src="assets/${imageFile}" alt="${altText}" style="max-width:220px; width:100%; border-radius:12px; border:1px solid var(--border-soft);" />
    </div>`;
}

function attachQrToggle() {
  document.getElementById("toggleQrBtn")?.addEventListener("click", () => {
    const qrBox = document.getElementById("qrBox");
    qrBox.style.display = qrBox.style.display === "none" ? "block" : "none";
  });
  document.getElementById("closeQrBtn")?.addEventListener("click", () => {
    document.getElementById("qrBox").style.display = "none";
  });
}

function renderPayDetails() {
  const box = document.getElementById("payDetailsBox");
  if (selectedPayMethod === "wallet") {
    const option = selectedProduct.options[selectedOptionId];
    const totalUsd = option.priceUsd * (1 - currentDiscountPercent / 100);
    const balance = currentProfile?.walletBalanceUsd || 0;
    const remaining = balance - totalUsd;
    box.innerHTML = `
      <div class="pay-details">
        <div class="row"><span>Tu saldo actual:</span><span><strong>$${balance.toFixed(2)}</strong></span></div>
        <div class="row"><span>Total del pedido:</span><span><strong>$${totalUsd.toFixed(2)}</strong></span></div>
        <div class="row"><span>Saldo despues de pagar:</span><span><strong>${remaining < 0 ? "❌ Insuficiente" : `$${remaining.toFixed(2)}`}</strong></span></div>
      </div>`;
    return;
  }
  if (selectedPayMethod === "pago_movil") {
    const pm = publicSettings.pagoMovil || {};
    box.innerHTML = `
      <div class="pay-details">
        ${payRow("C.I.", pm.ci)}
        ${payRow("Telefono", pm.phone)}
        ${payRow("Banco", pm.bank)}
        ${payRow("Nro. de cuenta", pm.accountNumber)}
        ${payRow("Titular", pm.holderName, false)}
      </div>
      ${qrToggleBlock("pagomovilqr.png", "QR Pago Movil")}`;
  } else {
    const bn = publicSettings.binance || {};
    box.innerHTML = `
      <div class="pay-details">
        ${payRow("Binance Pay ID", bn.payId)}
      </div>
      ${qrToggleBlock(bn.qrImage, "QR Binance Pay")}`;
  }

  attachCopyButtons(box);
  attachQrToggle();
}

function renderExtraField() {
  const container = document.getElementById("extraFieldContainer");
  const labelEl = document.getElementById("extraFieldLabelText");
  const select = document.getElementById("extraFieldSelect");

  if (selectedProduct.extraField && selectedProduct.extraField.fieldName) {
    container.style.display = "block";
    labelEl.textContent = selectedProduct.extraField.fieldLabel || "Selecciona una opcion";
    select.innerHTML = (selectedProduct.extraField.options || [])
      .map((opt) => `<option value="${opt}">${opt}</option>`)
      .join("");
  } else {
    container.style.display = "none";
    select.innerHTML = "";
  }
}

function renderGameIdField() {
  const field = document.getElementById("gameIdField");
  const label = document.getElementById("gameIdLabel");
  const input = document.getElementById("gameIdInput");
  const msg = document.getElementById("verifyIdMsg");
  const verifyBtn = document.getElementById("verifyIdBtn");
  idVerified = false;

  // No todos los juegos requieren ID: solo se muestra el campo si el
  // producto lo pide (selectedProduct.requiresId)
  if (selectedProduct.requiresId) {
    field.style.display = "block";
    label.textContent = selectedProduct.requiresIdLabel || "Tu ID en el juego / servicio";
    input.value = "";
    if (msg) {
      msg.textContent = "";
      msg.className = "coupon-msg";
    }
    // El boton de verificar solo tiene sentido si el producto tiene
    // configurado su sub_category_id de Shop2Topup
    if (verifyBtn) {
      verifyBtn.style.display = selectedProduct.shop2topupSubCategoryId ? "inline-flex" : "none";
    }
  } else {
    field.style.display = "none";
  }
}

// Zona ID: solo algunos juegos la piden (ej. Mobile Legends). Se muestra
// junto al ID del jugador, y se reusa el mismo boton "Verificar ID" para
// no duplicar controles -- si el producto pide zona, el boton exige que
// la zona tambien este llena antes de verificar, y la manda junto con el
// player_id a Shop2Topup.
function renderZoneIdField() {
  const field = document.getElementById("zoneIdField");
  const label = document.getElementById("zoneIdLabel");
  const input = document.getElementById("zoneIdInput");
  if (!field) return;

  if (selectedProduct.requiresZoneId) {
    field.style.display = "block";
    label.textContent = selectedProduct.requiresZoneIdLabel || "Tu ID de Zona / Servidor";
    input.value = "";
  } else {
    field.style.display = "none";
  }
}

async function verifyGameId() {
  const msg = document.getElementById("verifyIdMsg");
  const playerId = document.getElementById("gameIdInput").value.trim();
  const subCategoryId = selectedProduct.shop2topupSubCategoryId;
  const zoneId = selectedProduct.requiresZoneId ? document.getElementById("zoneIdInput").value.trim() : "";

  if (!playerId) {
    msg.textContent = "Ingresa el ID primero.";
    msg.className = "coupon-msg err";
    return;
  }
  if (selectedProduct.requiresZoneId && !zoneId) {
    msg.textContent = `Ingresa ${selectedProduct.requiresZoneIdLabel || "tu ID de Zona"} primero.`;
    msg.className = "coupon-msg err";
    return;
  }
  if (!subCategoryId) {
    msg.textContent = "Este producto no tiene configurada la verificacion aun.";
    msg.className = "coupon-msg err";
    return;
  }

  msg.textContent = "Verificando...";
  msg.className = "coupon-msg";
  idVerified = false;

  try {
    const res = await fetch("/.netlify/functions/validate-player", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sub_category_id: subCategoryId,
        player_id: playerId,
        ...(zoneId ? { zone_id: zoneId } : {}),
      }),
    });
    const data = await res.json();
    console.log("Respuesta Shop2Topup validate:", data);

    if (data.success && data.data) {
      idVerified = true;
      msg.textContent = `✅ Cuenta encontrada: ${data.data.player_name}`;
      msg.className = "coupon-msg ok";
    } else {
      idVerified = false;
      const errorMessages = {
        PLAYER_NOT_FOUND: "No encontramos ese ID, revisalo e intenta de nuevo.",
      };
      const code = data.error?.code;
      const apiMessage = errorMessages[code] || data.message || data.error?.message || data.error;
      msg.textContent = `❌ ${apiMessage || "ID no valido, revisa el numero."}`;
      msg.className = "coupon-msg err";
    }
  } catch (err) {
    console.error(err);
    idVerified = false;
    msg.textContent = "No se pudo verificar, intenta de nuevo.";
    msg.className = "coupon-msg err";
  }
}

document.getElementById("verifyIdBtn")?.addEventListener("click", verifyGameId);

document.getElementById("gameIdInput")?.addEventListener("input", () => {
  idVerified = false;
  const msg = document.getElementById("verifyIdMsg");
  if (msg) {
    msg.textContent = "";
    msg.className = "coupon-msg";
  }
});

document.getElementById("zoneIdInput")?.addEventListener("input", () => {
  idVerified = false;
  const msg = document.getElementById("verifyIdMsg");
  if (msg) {
    msg.textContent = "";
    msg.className = "coupon-msg";
  }
});

function renderProofFields() {
  const box = document.getElementById("proofFields");
  if (selectedPayMethod === "wallet") {
    box.innerHTML = `<div class="alert alert-info">Se descontara de tu saldo Wallet al confirmar. No necesitas ingresar ningun dato de pago.</div>`;
  } else if (selectedPayMethod === "binance") {
    box.innerHTML = `
      <div class="alert alert-info">Asegurate de pagar el monto correcto, de lo contrario tendremos problemas con el pago.</div>
      <div class="field">
        <label>ID de la transaccion</label>
        <input type="text" id="transactionId" placeholder="Ej: 123456789012" />
      </div>`;
  } else {
    box.innerHTML = `
      <div class="field-row">
        <div class="field">
          <label>Ultimos 6 digitos de la referencia</label>
          <input type="text" id="last6" maxlength="6" placeholder="Ej: 456789" />
        </div>
        <div class="field">
          <label>Telefono desde donde realizo el pago</label>
          <input type="text" id="payerPhone" placeholder="Ej: 04141234567" />
        </div>
      </div>`;
  }
}

let currentTotalUsd = 0;
let currentDiscountPercent = 0;
let currentCouponCode = null;

function recalcTotalDisplay() {
  const option = selectedProduct.options[selectedOptionId];
  if (!option) return;
  currentTotalUsd = option.priceUsd * (1 - currentDiscountPercent / 100);

  const totalEl = document.getElementById("modalTotal");
  if (selectedPayMethod === "wallet") {
    totalEl.textContent = `$${currentTotalUsd.toFixed(2)} (Wallet)`;
  } else if (selectedPayMethod === "binance") {
    totalEl.textContent = formatUsdt(currentTotalUsd);
  } else {
    totalEl.textContent = formatBs(currentTotalUsd * publicSettings.exchangeRateBsPerUsd);
  }
}

function updateTotal() {
  currentDiscountPercent = 0;
  currentCouponCode = null;
  document.getElementById("couponMsg").textContent = "";
  document.getElementById("couponMsg").className = "coupon-msg";
  recalcTotalDisplay();
}

const couponInputEl = document.getElementById("couponInput");
const verifyCouponBtn = document.getElementById("verifyCouponBtn");
const couponMsgEl = document.getElementById("couponMsg");

couponInputEl?.addEventListener("input", () => {
  verifyCouponBtn.style.display = couponInputEl.value.trim() ? "inline-flex" : "none";
  if (currentCouponCode && currentCouponCode !== couponInputEl.value.trim().toUpperCase()) {
    currentDiscountPercent = 0;
    currentCouponCode = null;
    couponMsgEl.textContent = "";
    couponMsgEl.className = "coupon-msg";
    recalcTotalDisplay();
  }
});

verifyCouponBtn?.addEventListener("click", async () => {
  const code = couponInputEl.value.trim().toUpperCase();
  if (!code) return;

  try {
    const couponSnap = await getDoc(doc(db, "coupons", code));

    if (!couponSnap.exists() || couponSnap.data().active !== true) {
      currentDiscountPercent = 0;
      currentCouponCode = null;
      couponMsgEl.textContent = "Cupon no valido.";
      couponMsgEl.className = "coupon-msg err";
    } else {
      const redemptionSnap = currentUser
        ? await getDoc(doc(db, "couponRedemptions", `${currentUser.uid}_${code}`))
        : null;

      if (redemptionSnap && redemptionSnap.exists()) {
        currentDiscountPercent = 0;
        currentCouponCode = null;
        couponMsgEl.textContent = "Este cupon ya fue usado. Tu pedido continua sin descuento.";
        couponMsgEl.className = "coupon-msg warn";
      } else {
        currentDiscountPercent = couponSnap.data().discountPercent;
        currentCouponCode = code;
        couponMsgEl.textContent = `Cupon valido: ${currentDiscountPercent}% de descuento aplicado`;
        couponMsgEl.className = "coupon-msg ok";
      }
    }
  } catch (err) {
    console.error(err);
    couponMsgEl.textContent = "No se pudo verificar el cupon, intenta de nuevo.";
    couponMsgEl.className = "coupon-msg err";
  }

  recalcTotalDisplay();
});

document.getElementById("closeModal")?.addEventListener("click", () => {
  document.getElementById("orderModalBackdrop").classList.remove("open");
});

document.getElementById("completeOrderBtn")?.addEventListener("click", async () => {
  const alertBox = document.getElementById("modalAlert");
  const completeBtn = document.getElementById("completeOrderBtn");
  alertBox.innerHTML = "";

  const option = selectedProduct.options[selectedOptionId];
  let gameId = "";
  if (selectedProduct.requiresId) {
    gameId = document.getElementById("gameIdInput").value.trim();
    if (!gameId) {
      alertBox.innerHTML = `<div class="alert alert-error">Ingresa ${selectedProduct.requiresIdLabel || "tu ID"} para continuar</div>`;
      return;
    }
    if (selectedProduct.shop2topupSubCategoryId && !idVerified) {
      alertBox.innerHTML = `<div class="alert alert-error">Verifica tu ID antes de finalizar el pago</div>`;
      return;
    }
  }

  let zoneId = "";
  if (selectedProduct.requiresZoneId) {
    zoneId = document.getElementById("zoneIdInput").value.trim();
    if (!zoneId) {
      alertBox.innerHTML = `<div class="alert alert-error">Ingresa ${selectedProduct.requiresZoneIdLabel || "tu ID de Zona"} para continuar</div>`;
      return;
    }
  }

  let extraFieldValue = "";
  if (selectedProduct.extraField && selectedProduct.extraField.fieldName) {
    extraFieldValue = document.getElementById("extraFieldSelect").value;
    if (!extraFieldValue) {
      alertBox.innerHTML = `<div class="alert alert-error">Selecciona ${selectedProduct.extraField.fieldLabel || "una opcion"}</div>`;
      return;
    }
  }

  // ================= WALLET: se descuenta el saldo directamente =================
  if (selectedPayMethod === "wallet") {
    const totalUsd = option.priceUsd * (1 - currentDiscountPercent / 100);
    const balance = currentProfile?.walletBalanceUsd || 0;
    if (balance < totalUsd) {
      alertBox.innerHTML = '<div class="alert alert-error">No tienes saldo suficiente en tu wallet para este pedido.</div>';
      return;
    }
    const remaining = balance - totalUsd;
    const confirmed = confirm(
      `Vas a pagar $${totalUsd.toFixed(2)} con tu saldo Wallet.\nTu saldo despues de esta compra sera: $${remaining.toFixed(2)}.\n\n¿Confirmas el pago?`
    );
    if (!confirmed) return;

    completeBtn.disabled = true;
    const originalBtnText = completeBtn.textContent;
    completeBtn.innerHTML = `<span class="btn-spinner"></span> Procesando pago...`;

    try {
      const idToken = await currentUser.getIdToken();
      const res = await fetch("/.netlify/functions/wallet-pay-order", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${idToken}` },
        body: JSON.stringify({
          productId: selectedProduct._id,
          optionId: selectedOptionId,
          couponCode: currentCouponCode,
          playerGameId: selectedProduct.requiresId ? gameId : "",
          zoneId: selectedProduct.requiresZoneId ? zoneId : "",
          extraFieldValue: selectedProduct.extraField ? extraFieldValue : "",
        }),
      });
      const data = await res.json();

      if (!data.success) {
        const wa = publicSettings.whatsappNumber || "584163557506";
        const supportText = encodeURIComponent(
          `Hola, intente pagar *${selectedProduct?.name || "un producto"}* con mi Wallet pero el sistema no pudo procesar la recarga.\nPedido: ${data.orderId || "-"}`
        );
        alertBox.innerHTML = `
          <div class="alert alert-error">${data.message || "No se pudo procesar el pago"}</div>
          ${
            data.needsWhatsapp
              ? `<a href="https://wa.me/${wa}?text=${supportText}" target="_blank" rel="noopener" class="btn btn-outline btn-full" style="margin-top:10px; display:flex; align-items:center; justify-content:center; gap:8px;">
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M12.04 2C6.58 2 2.13 6.45 2.13 11.91c0 1.75.46 3.39 1.26 4.82L2 22l5.4-1.35a9.9 9.9 0 0 0 4.64 1.18h.01c5.46 0 9.91-4.45 9.91-9.92 0-2.65-1.03-5.14-2.9-7.01A9.86 9.86 0 0 0 12.04 2Zm5.8 14.02c-.24.68-1.4 1.3-1.93 1.35-.5.05-1.13.07-1.83-.12-.42-.11-.96-.3-1.66-.6-2.92-1.26-4.82-4.2-4.97-4.4-.15-.2-1.19-1.58-1.19-3.02s.75-2.15 1.02-2.44c.26-.29.57-.36.76-.36.19 0 .38 0 .55.01.18.01.41-.07.64.49.24.58.81 2 .88 2.14.07.15.12.32.02.51-.1.19-.15.3-.29.47-.15.17-.31.37-.44.5-.15.15-.3.31-.13.6.17.29.75 1.24 1.62 2.01 1.11.99 2.05 1.3 2.34 1.44.29.15.46.13.63-.08.17-.2.72-.84.91-1.13.19-.29.38-.24.63-.14.26.09 1.63.77 1.91.91.29.15.48.22.55.34.07.13.07.73-.17 1.41Z"/></svg>
                  Contactar por WhatsApp
                </a>`
              : ""
          }`;
        completeBtn.disabled = false;
        completeBtn.textContent = originalBtnText;
        return;
      }

      currentProfile.walletBalanceUsd = remaining;

      pendingWhatsappOrder = data.needsWhatsapp
        ? {
            order: {
              paymentMethod: "wallet",
              totalUsd: data.receipt.totalUsd,
              couponCode: currentCouponCode,
              discountPercent: currentDiscountPercent,
            },
            gameId,
            zoneId,
            verifiedNote: data.whatsappNote,
          }
        : null;

      renderAutoReceipt(data);
      goToStep("stepDone");
    } catch (err) {
      console.error(err);
      alertBox.innerHTML = '<div class="alert alert-error">Error de conexion. Intenta de nuevo.</div>';
      completeBtn.disabled = false;
      completeBtn.textContent = originalBtnText;
    }
    return;
  }

  // ================= BINANCE: verificacion automatica contra tu API de Binance =================
  if (selectedPayMethod === "binance") {
    const transactionId = document.getElementById("transactionId").value.trim();
    if (!transactionId) {
      alertBox.innerHTML = '<div class="alert alert-error">Ingresa el ID de la transaccion</div>';
      return;
    }

    completeBtn.disabled = true;
    const originalBtnText = completeBtn.textContent;
    completeBtn.innerHTML = `<span class="btn-spinner"></span> Verificando pago...`;
    alertBox.innerHTML = "";

    try {
      const idToken = await currentUser.getIdToken();
      const res = await fetch("/.netlify/functions/verify-binance-pay-order", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${idToken}` },
        body: JSON.stringify({
          productId: selectedProduct._id,
          optionId: selectedOptionId,
          couponCode: currentCouponCode,
          transactionId,
          playerGameId: selectedProduct.requiresId ? gameId : "",
          zoneId: selectedProduct.requiresZoneId ? zoneId : "",
          extraFieldValue: selectedProduct.extraField ? extraFieldValue : "",
        }),
      });
      const data = await res.json();

      if (!data.success) {
        const isInsufficient = data.code === "INSUFFICIENT_AMOUNT";
        const wa = publicSettings.whatsappNumber || "584163557506";
        const supportText = encodeURIComponent(
          `Hola, hice un pago por Binance Pay por *${selectedProduct?.name || "un producto"}* pero el sistema no pudo procesarlo automaticamente.\nID de transaccion: ${transactionId}`
        );
        alertBox.innerHTML = `
          <div class="alert alert-error">${data.message || "No se pudo verificar el pago"}</div>
          ${
            isInsufficient
              ? `<a href="https://wa.me/${wa}?text=${supportText}" target="_blank" rel="noopener" class="btn btn-outline btn-full" style="margin-top:10px; display:flex; align-items:center; justify-content:center; gap:8px;">
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M12.04 2C6.58 2 2.13 6.45 2.13 11.91c0 1.75.46 3.39 1.26 4.82L2 22l5.4-1.35a9.9 9.9 0 0 0 4.64 1.18h.01c5.46 0 9.91-4.45 9.91-9.92 0-2.65-1.03-5.14-2.9-7.01A9.86 9.86 0 0 0 12.04 2Zm5.8 14.02c-.24.68-1.4 1.3-1.93 1.35-.5.05-1.13.07-1.83-.12-.42-.11-.96-.3-1.66-.6-2.92-1.26-4.82-4.2-4.97-4.4-.15-.2-1.19-1.58-1.19-3.02s.75-2.15 1.02-2.44c.26-.29.57-.36.76-.36.19 0 .38 0 .55.01.18.01.41-.07.64.49.24.58.81 2 .88 2.14.07.15.12.32.02.51-.1.19-.15.3-.29.47-.15.17-.31.37-.44.5-.15.15-.3.31-.13.6.17.29.75 1.24 1.62 2.01 1.11.99 2.05 1.3 2.34 1.44.29.15.46.13.63-.08.17-.2.72-.84.91-1.13.19-.29.38-.24.63-.14.26.09 1.63.77 1.91.91.29.15.48.22.55.34.07.13.07.73-.17 1.41Z"/></svg>
                  Contactar soporte por WhatsApp
                </a>`
              : ""
          }`;
        completeBtn.disabled = false;
        completeBtn.textContent = originalBtnText;
        return;
      }

      // Igual que Pago Movil: guardamos los datos para el mensaje de
      // WhatsApp y lo enviamos con un click real del usuario, nunca
      // automatico (los navegadores bloquean window.open() si no).
      if (data.needsWhatsapp) {
        pendingWhatsappOrder = {
          order: {
            paymentMethod: "binance",
            paymentProof: { transactionId },
            totalUsd: data.receipt.totalUsd,
            couponCode: currentCouponCode,
            discountPercent: currentDiscountPercent,
          },
          gameId,
          zoneId,
          verifiedNote: data.whatsappNote,
        };
      } else {
        pendingWhatsappOrder = null;
      }

      renderAutoReceipt(data);
      goToStep("stepDone");
    } catch (err) {
      console.error(err);
      alertBox.innerHTML = '<div class="alert alert-error">Error de conexion. Intenta de nuevo.</div>';
      completeBtn.disabled = false;
      completeBtn.textContent = originalBtnText;
    }
    return;
  }

  // ================= PAGO MOVIL: verificacion en segundo plano contra Pabilo =================
  // Ya no se espera la respuesta de Pabilo en esta misma llamada (a veces
  // tarda mas de lo que Netlify deja esperar y el pago fallaba por timeout
  // aunque SI se hubiera verificado, gastando credito por las puras). Ahora
  // el backend crea un documento en "pendingVerifications" y hace la
  // verificacion real en una funcion en background; aqui solo escuchamos
  // ese documento con onSnapshot hasta que quede listo.
  const last6 = document.getElementById("last6").value.trim();
  const payerPhone = document.getElementById("payerPhone").value.trim();
  if (!last6 || !payerPhone) {
    alertBox.innerHTML = '<div class="alert alert-error">Completa los datos del pago</div>';
    return;
  }

  completeBtn.disabled = true;
  const originalBtnText = completeBtn.textContent;
  completeBtn.innerHTML = `<span class="btn-spinner"></span> Verificando pago...`;
  alertBox.innerHTML = "";

  try {
    const idToken = await currentUser.getIdToken();
    const res = await fetch("/.netlify/functions/verify-pago-movil-order", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${idToken}` },
      body: JSON.stringify({
        productId: selectedProduct._id,
        optionId: selectedOptionId,
        couponCode: currentCouponCode,
        bankReference: last6,
        payerPhone,
        playerGameId: selectedProduct.requiresId ? gameId : "",
        zoneId: selectedProduct.requiresZoneId ? zoneId : "",
        extraFieldValue: selectedProduct.extraField ? extraFieldValue : "",
      }),
    });
    const entryData = await res.json();

    if (!entryData.success) {
      alertBox.innerHTML = `<div class="alert alert-error">${entryData.message || "No se pudo procesar tu pago"}</div>`;
      completeBtn.disabled = false;
      completeBtn.textContent = originalBtnText;
      return;
    }

    alertBox.innerHTML =
      '<div class="alert alert-info">Procesando tu pago...</div>';

    const pendingRef = doc(db, "pendingVerifications", entryData.pendingId);
    const unsubscribe = onSnapshot(
      pendingRef,
      (snap) => {
        if (!snap.exists()) return;
        const data = snap.data();
        if (data.verificationState !== "listo") return;
        unsubscribe();

        if (!data.success) {
          const isInsufficient = data.code === "INSUFFICIENT_AMOUNT";
          const wa = publicSettings.whatsappNumber || "584163557506";
          const supportText = encodeURIComponent(
            `Hola, hice un pago movil por *${selectedProduct?.name || "un producto"}* pero el sistema no pudo procesarlo automaticamente.\nReferencia: ${last6}\nTelefono: ${payerPhone}`
          );
          alertBox.innerHTML = `
            <div class="alert alert-error">${data.message || "No se pudo verificar el pago"}</div>
            ${
              isInsufficient
                ? `<a href="https://wa.me/${wa}?text=${supportText}" target="_blank" rel="noopener" class="btn btn-outline btn-full" style="margin-top:10px; display:flex; align-items:center; justify-content:center; gap:8px;">
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M12.04 2C6.58 2 2.13 6.45 2.13 11.91c0 1.75.46 3.39 1.26 4.82L2 22l5.4-1.35a9.9 9.9 0 0 0 4.64 1.18h.01c5.46 0 9.91-4.45 9.91-9.92 0-2.65-1.03-5.14-2.9-7.01A9.86 9.86 0 0 0 12.04 2Zm5.8 14.02c-.24.68-1.4 1.3-1.93 1.35-.5.05-1.13.07-1.83-.12-.42-.11-.96-.3-1.66-.6-2.92-1.26-4.82-4.2-4.97-4.4-.15-.2-1.19-1.58-1.19-3.02s.75-2.15 1.02-2.44c.26-.29.57-.36.76-.36.19 0 .38 0 .55.01.18.01.41-.07.64.49.24.58.81 2 .88 2.14.07.15.12.32.02.51-.1.19-.15.3-.29.47-.15.17-.31.37-.44.5-.15.15-.3.31-.13.6.17.29.75 1.24 1.62 2.01 1.11.99 2.05 1.3 2.34 1.44.29.15.46.13.63-.08.17-.2.72-.84.91-1.13.19-.29.38-.24.63-.14.26.09 1.63.77 1.91.91.29.15.48.22.55.34.07.13.07.73-.17 1.41Z"/></svg>
                    Contactar soporte por WhatsApp
                  </a>`
                : ""
            }`;
          completeBtn.disabled = false;
          completeBtn.textContent = originalBtnText;
          return;
        }

        // Guardamos los datos del pedido para armar el mensaje de WhatsApp
        // cuando el usuario TOQUE el boton (nunca automatico) -- los
        // navegadores bloquean window.open() si no viene de un click directo,
        // y por eso antes "no pasaba nada" despues de verificar.
        if (data.needsWhatsapp) {
          pendingWhatsappOrder = {
            order: {
              paymentMethod: "pago_movil",
              paymentProof: { last6, payerPhone },
              totalUsd: data.receipt.totalUsd,
              exchangeRateBsPerUsd: publicSettings.exchangeRateBsPerUsd || 0,
              couponCode: currentCouponCode,
              discountPercent: currentDiscountPercent,
            },
            gameId,
            zoneId,
            verifiedNote: data.whatsappNote,
          };
        } else {
          pendingWhatsappOrder = null;
        }

        renderAutoReceipt(data);
        goToStep("stepDone");
      },
      (err) => {
        console.error(err);
        alertBox.innerHTML = '<div class="alert alert-error">Error de conexion. Intenta de nuevo.</div>';
        completeBtn.disabled = false;
        completeBtn.textContent = originalBtnText;
      }
    );
  } catch (err) {
    console.error(err);
    alertBox.innerHTML = '<div class="alert alert-error">Error de conexion. Intenta de nuevo.</div>';
    completeBtn.disabled = false;
    completeBtn.textContent = originalBtnText;
  }
});

// Pedido pendiente de enviar a WhatsApp (se llena cuando la verificacion de
// pago movil termina con needsWhatsapp=true) -- se envia con un click real
// del usuario en renderAutoReceipt, nunca automatico.
let pendingWhatsappOrder = null;

// Rellena la pantalla final ("stepDone") con el recibo de la verificacion
// automatica: numero de pedido, producto, ID del jugador si aplica, y un
// mensaje distinto segun si la recarga ya se hizo sola o quedo pendiente.
function renderAutoReceipt(data) {
  document.getElementById("stepDoneManualAlert").style.display = "none";
  const box = document.getElementById("stepDoneReceiptBox");
  const r = data.receipt || {};
  const isSuccess = data.status === "completado";

  const statusMessage = isSuccess
    ? "✅ <strong>SUCCESS</strong> — Pago verificado y recarga completada"
    : data.needsWhatsapp
    ? `✅ <strong>Pago verificado.</strong> ${data.whatsappNote || "Tu recarga esta siendo procesada."}`
    : "✅ <strong>Pago verificado.</strong> Tu recarga esta siendo procesada, en unos minutos deberia completarse.";

  const fecha = new Date(r.date || Date.now()).toLocaleString("es-VE", { dateStyle: "medium", timeStyle: "short" });

  const waRedirect = data.needsWhatsapp && pendingWhatsappOrder
    ? `<a href="#" id="waNowBtn" class="btn btn-primary btn-full" style="margin-top:14px; display:flex; align-items:center; justify-content:center; gap:8px;">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M12.04 2C6.58 2 2.13 6.45 2.13 11.91c0 1.75.46 3.39 1.26 4.82L2 22l5.4-1.35a9.9 9.9 0 0 0 4.64 1.18h.01c5.46 0 9.91-4.45 9.91-9.92 0-2.65-1.03-5.14-2.9-7.01A9.86 9.86 0 0 0 12.04 2Zm5.8 14.02c-.24.68-1.4 1.3-1.93 1.35-.5.05-1.13.07-1.83-.12-.42-.11-.96-.3-1.66-.6-2.92-1.26-4.82-4.2-4.97-4.4-.15-.2-1.19-1.58-1.19-3.02s.75-2.15 1.02-2.44c.26-.29.57-.36.76-.36.19 0 .38 0 .55.01.18.01.41-.07.64.49.24.58.81 2 .88 2.14.07.15.12.32.02.51-.1.19-.15.3-.29.47-.15.17-.31.37-.44.5-.15.15-.3.31-.13.6.17.29.75 1.24 1.62 2.01 1.11.99 2.05 1.3 2.34 1.44.29.15.46.13.63-.08.17-.2.72-.84.91-1.13.19-.29.38-.24.63-.14.26.09 1.63.77 1.91.91.29.15.48.22.55.34.07.13.07.73-.17 1.41Z"/></svg>
        ${data.requiresRefund ? "Contactar por WhatsApp (reembolso)" : "Ir a WhatsApp ahora"}
      </a>
      <p id="waCountdownText" style="text-align:center; color:var(--text-muted); font-size:0.8rem; margin-top:8px;">Te redirigiremos automaticamente en <strong id="waCountdownNum">3</strong>s...</p>`
    : "";

  box.innerHTML = `
    <div style="position:relative;">
      <span id="closeReceiptBtn" title="Cerrar" style="position:absolute; top:-4px; right:-4px; cursor:pointer; color:var(--text-muted); font-size:1.3rem; padding:4px 8px; line-height:1;">&times;</span>
      <div class="alert alert-success" style="margin-top:14px; text-align:center;">${statusMessage}</div>
      <div class="pay-details" style="margin-top:10px; border:1px dashed var(--border-soft); border-radius:12px; padding:16px;">
        <div style="text-align:center; margin-bottom:10px;">
          <strong style="font-size:1.05rem;">🧾 Comprobante de compra</strong>
          <div style="color:var(--text-muted); font-size:0.8rem; margin-top:2px;">${fecha}</div>
        </div>
        <div class="row"><span>Numero de pedido:</span><span><strong>${r.orderId}</strong></span></div>
        <div class="row"><span>Producto:</span><span><strong>${r.productName} (${r.optionLabel})</strong></span></div>
        ${r.playerGameId ? `<div class="row"><span>ID del jugador:</span><span><strong>${r.playerGameId}</strong></span></div>` : ""}
        ${r.zoneId ? `<div class="row"><span>Zona ID:</span><span><strong>${r.zoneId}</strong></span></div>` : ""}
        ${r.paymentMethod ? `<div class="row"><span>Metodo de pago:</span><span><strong>${r.paymentMethod}</strong></span></div>` : ""}
        ${r.reference ? `<div class="row"><span>Referencia:</span><span><strong>${r.reference}</strong></span></div>` : ""}
        <div class="row"><span>Total pagado:</span><span><strong>${r.totalBs != null ? formatBs(r.totalBs) : `$${(r.totalUsd || 0).toFixed(2)}`}</strong></span></div>
        <div class="row"><span>Estado:</span><span><strong>${isSuccess ? "✅ Success" : "En proceso"}</strong></span></div>
      </div>
      ${waRedirect}
    </div>`;
  box.style.display = "block";

  document.getElementById("closeReceiptBtn")?.addEventListener("click", () => {
    document.getElementById("orderModalBackdrop").classList.remove("open");
  });

  // Redirige a WhatsApp 3s despues de mostrar el comprobante (o de inmediato
  // si el usuario toca el boton) -- usamos location.href (navegacion normal),
  // NUNCA window.open() en un timeout, porque los navegadores SI bloquean
  // popups abiertos fuera de un click directo del usuario, pero SI permiten
  // navegar la pestana actual.
  if (data.needsWhatsapp && pendingWhatsappOrder) {
    let redirected = false;
    const goToWhatsapp = () => {
      if (redirected) return;
      redirected = true;
      clearInterval(countdownInterval);
      const url = buildWhatsappUrl(pendingWhatsappOrder.order, pendingWhatsappOrder.gameId, pendingWhatsappOrder.verifiedNote, pendingWhatsappOrder.zoneId);
      window.location.href = url;
    };

    document.getElementById("waNowBtn")?.addEventListener("click", (e) => {
      e.preventDefault();
      goToWhatsapp();
    });

    let secondsLeft = 3;
    const numEl = document.getElementById("waCountdownNum");
    const countdownInterval = setInterval(() => {
      secondsLeft -= 1;
      if (numEl) numEl.textContent = String(Math.max(secondsLeft, 0));
      if (secondsLeft <= 0) clearInterval(countdownInterval);
    }, 1000);

    setTimeout(goToWhatsapp, 3000);
  }
}

document.getElementById("goToDashboardBtn")?.addEventListener("click", () => {
  window.location.href = "dashboard.html";
});

function buildWhatsappUrl(order, gameId, verifiedNote, zoneId) {
  const option = selectedProduct.options[selectedOptionId];
  const methodLabel = order.paymentMethod === "binance" ? "Binance Pay" : order.paymentMethod === "wallet" ? "Wallet" : "Pago Movil";
  const paymentRef =
    order.paymentMethod === "binance"
      ? order.paymentProof.transactionId
      : order.paymentMethod === "wallet"
      ? "Pagado con saldo de la Wallet"
      : `${order.paymentProof.last6} (Tel: ${order.paymentProof.payerPhone})`;

  const totalLine =
    order.paymentMethod === "binance" || order.paymentMethod === "wallet"
      ? formatUsdt(order.totalUsd).replace(" USDT", order.paymentMethod === "wallet" ? "" : " USDT")
      : formatBs(order.totalUsd * (order.exchangeRateBsPerUsd || publicSettings.exchangeRateBsPerUsd));

  const lines = [
    "*GameCenter Venezuela*",
    verifiedNote ? "(Pago verificado automaticamente ✅)" : "(Nuevo Pedido)",
    "",
    `- Cliente: ${currentProfile ? currentProfile.name : ""}`,
    gameId ? `- ${selectedProduct.requiresIdLabel || "ID"}: ${gameId}` : null,
    zoneId ? `- ${selectedProduct.requiresZoneIdLabel || "Zona ID"}: ${zoneId}` : null,
    `- Producto: ${selectedProduct.name} (${option.label})`,
    `- Region: ${selectedProduct.region}`,
    `- Metodo de pago: ${methodLabel}`,
    `- Referencia: ${paymentRef}`,
    order.couponCode ? `- Cupon aplicado: ${order.couponCode} (${order.discountPercent}% off)` : null,
    `- Total pagado: ${totalLine}`,
    verifiedNote ? `- Nota: ${verifiedNote}` : null,
  ].filter((l) => l !== null);

  const text = encodeURIComponent(lines.join("\n"));
  const wa = publicSettings.whatsappNumber || "584163557506";
  return `https://wa.me/${wa}?text=${text}`;
}

function sendOrderToWhatsapp(order, gameId, verifiedNote, zoneId) {
  window.open(buildWhatsappUrl(order, gameId, verifiedNote, zoneId), "_blank");
}

// ============ Init ============
initHero();
loadProducts();