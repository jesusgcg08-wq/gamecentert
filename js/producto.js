// ============================================================================
// GameCenter — Pagina de producto (producto.html?id=...&opt=...)
// Flujo en 3 pasos estilo Venium:  1 Paquete  >  2 Datos  >  3 Pago
// (el paso "Datos" se omite si el producto no pide ID/zona/campo extra).
//
// Toda la logica de negocio viene del modal anterior de main.js y NO cambio:
// mismas funciones de Netlify, mismos payloads, cupones, Wallet, Binance Pay,
// Pago Movil (verificacion en segundo plano con onSnapshot), comprobante y
// redireccion a WhatsApp.
// ============================================================================

import { db } from "./firebase-config.js";
import { icon } from "./icons.js";
import { doc, getDoc, onSnapshot } from "https://www.gstatic.com/firebasejs/10.14.0/firebase-firestore.js";
import { initAccountMenu, onAccountChange, getDisplayCurrency } from "./account-menu.js";
import { esc, optionDiscountPercent, formatBs, formatUsdt } from "./catalog-utils.js";

initAccountMenu({ activePage: "producto" });

const params = new URLSearchParams(location.search);
const productId = params.get("id");
const $ = (id) => document.getElementById(id);

// ============ Estado ============
let product = null;
let publicSettings = null;
let currentUser = null;
let currentProfile = null;
let authReady = false;

let step = "paquete"; // paquete | datos | pago | done
let selectedOptionId = null;
let activeOptionType = "recarga";
let selectedPayMethod = "pago_movil";

let playerId = "";
let zoneId = "";
let extraValue = "";
let idVerified = false;
let verifiedName = "";

let currentDiscountPercent = 0;
let currentCouponCode = null;
let couponText = "";
let couponMsg = { text: "", cls: "" };
let proof = { last6: "", payerPhone: "", transactionId: "" };

let pendingWhatsappOrder = null;
let doneData = null;

const OPTION_TYPES = {
  recarga: { label: "Recarga", stepLabel: "Elige tu recarga" },
  membresia: { label: "Membresía", stepLabel: "Elige tu membresía" },
  pase: { label: "Pase", stepLabel: "Elige tu pase" },
};
const TYPE_ICON = {
  recarga: `<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><path d="M6 3h12l4 6-10 12L2 9l4-6Z"/><path d="M2 9h20M12 21 8 9l4-6 4 6-4 12"/></svg>`,
  membresia: `<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><path d="m3 7 4.5 4L12 4l4.5 7L21 7l-2 12H5L3 7Z"/></svg>`,
  pase: `<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><path d="M3 8a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v2a2 2 0 0 0 0 4v2a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-2a2 0 0 0 0-4V8Z"/></svg>`,
};
const getOptionType = (opt) => (opt && OPTION_TYPES[opt.type] ? opt.type : "recarga");

const WA_ICON = `<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M12.04 2C6.58 2 2.13 6.45 2.13 11.91c0 1.75.46 3.39 1.26 4.82L2 22l5.4-1.35a9.9 9.9 0 0 0 4.64 1.18h.01c5.46 0 9.91-4.45 9.91-9.92 0-2.65-1.03-5.14-2.9-7.01A9.86 9.86 0 0 0 12.04 2Zm5.8 14.02c-.24.68-1.4 1.3-1.93 1.35-.5.05-1.13.07-1.83-.12-.42-.11-.96-.3-1.66-.6-2.92-1.26-4.82-4.2-4.97-4.4-.15-.2-1.19-1.58-1.19-3.02s.75-2.15 1.02-2.44c.26-.29.57-.36.76-.36.19 0 .38 0 .55.01.18.01.41-.07.64.49.24.58.81 2 .88 2.14.07.15.12.32.02.51-.1.19-.15.3-.29.47-.15.17-.31.37-.44.5-.15.15-.3.31-.13.6.17.29.75 1.24 1.62 2.01 1.11.99 2.05 1.3 2.34 1.44.29.15.46.13.63-.08.17-.2.72-.84.91-1.13.19-.29.38-.24.63-.14.26.09 1.63.77 1.91.91.29.15.48.22.55.34.07.13.07.73-.17 1.41Z"/></svg>`;
const ICON = {
  chevR: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><path d="m9 18 6-6-6-6"/></svg>`,
  chevL: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><path d="m15 18-6-6 6-6"/></svg>`,
  check: `<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>`,
  globe: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18"/></svg>`,
  bolt: `<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M13 2 3 14h7l-1 8 10-12h-7l1-8Z"/></svg>`,
  box: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 8 12 3 3 8l9 5 9-5Z"/><path d="M3 8v8l9 5 9-5V8"/><path d="M12 13v8"/></svg>`,
  shield: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3 4 6v6c0 5 3.4 8 8 9 4.6-1 8-4 8-9V6l-8-3Z"/><path d="m9 12 2 2 4-4"/></svg>`,
  shieldBig: `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3 4 6v6c0 5 3.4 8 8 9 4.6-1 8-4 8-9V6l-8-3Z"/><path d="m9 12 2 2 4-4"/></svg>`,
  clock: `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>`,
  x: `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="9"/><path d="m15 9-6 6M9 9l6 6"/></svg>`,
};

// ============ Helpers de producto ============
function sortedOptionEntries() {
  return Object.entries(product?.options || {}).sort(
    (a, b) => (typeof a[1].order === "number" ? a[1].order : 9999) - (typeof b[1].order === "number" ? b[1].order : 9999)
  );
}
const selectedOption = () => (selectedOptionId ? product.options?.[selectedOptionId] : null);
const needsDatos = () => !!(product.requiresId || product.requiresZoneId || product.extraField?.fieldName);
const stepList = () => (needsDatos() ? ["paquete", "datos", "pago"] : ["paquete", "pago"]);
const STEP_LABEL = { paquete: "Paquete", datos: "Datos", pago: "Pago" };
const idLabel = () => product.requiresIdLabel || "Player ID";
const zoneLabel = () => product.requiresZoneIdLabel || "ID de Zona / Servidor";
// ID de Central One con el que se verifica la cuenta: el del producto, o si no
// esta puesto, el del item de la opcion elegida (ambos sirven para validar).
const verifyProductId = () => product.shop2topupSubCategoryId || selectedOption()?.shop2topupItemId || "";
const needsVerify = () => !!(product.requiresId && verifyProductId());

// ============ Dinero ============
const rate = () => publicSettings?.exchangeRateBsPerUsd || 0;
function moneyParts(usd, mode) {
  if (mode === "bs") return { sym: "Bs", num: formatBs(usd * rate()).replace(/^Bs\s/, "") };
  if (mode === "usdt") return { sym: "USDT", num: usd.toFixed(2) };
  return { sym: "$", num: usd.toFixed(2) };
}
const moneyStr = (usd, mode) => {
  const p = moneyParts(usd, mode);
  return mode === "usd" ? `$${p.num}` : `${p.sym} ${p.num}`;
};
// Moneda con la que se muestra el total: en el paso de pago depende del metodo.
function summaryMode() {
  if (step === "pago" || step === "done") {
    if (selectedPayMethod === "binance") return "usdt";
    if (selectedPayMethod === "wallet") return "usd";
    return "bs";
  }
  return getDisplayCurrency();
}

// ============ Persistencia del ultimo ID (para "Usar datos anteriores") ============
const lastKey = () => `gc_last_player_${product._id}`;
function loadLast() {
  try {
    return JSON.parse(localStorage.getItem(lastKey()) || "null");
  } catch {
    return null;
  }
}
function saveLast() {
  try {
    localStorage.setItem(lastKey(), JSON.stringify({ id: playerId, zone: zoneId }));
  } catch {
    /* modo privado: no pasa nada */
  }
}

// ============ Carga ============
async function ensurePublicSettings() {
  if (publicSettings) return publicSettings;
  try {
    const snap = await getDoc(doc(db, "settings", "main"));
    publicSettings = snap.exists() ? snap.data() : { exchangeRateBsPerUsd: 0, pagoMovil: {}, binance: {}, whatsappNumber: "584163557506" };
  } catch (err) {
    console.error(err);
    publicSettings = { exchangeRateBsPerUsd: 0, pagoMovil: {}, binance: {}, whatsappNumber: "584163557506" };
  }
  const btn = $("floatingWhatsappBtn");
  if (btn) btn.href = `https://wa.me/${publicSettings.whatsappNumber || "584163557506"}?text=${encodeURIComponent("Hola")}`;
  return publicSettings;
}

onAccountChange((user, profile) => {
  const prevBalance = currentProfile?.walletBalanceUsd;
  currentUser = user;
  currentProfile = profile;
  if (!authReady) {
    authReady = true;
    boot();
    return;
  }
  if (product && step === "pago" && prevBalance !== profile?.walletBalanceUsd) renderPayCards();
});

let booted = false;
async function boot() {
  if (booted) return;
  booted = true;
  if (!productId) return renderNotFound();
  await ensurePublicSettings();
  try {
    const snap = await getDoc(doc(db, "products", productId));
    if (!snap.exists() || snap.data().active !== true) return renderNotFound();
    product = { _id: snap.id, ...snap.data() };
  } catch (err) {
    console.error(err);
    return renderNotFound();
  }

  document.title = `${product.name} — GameCenter`;

  const optParam = params.get("opt");
  const entries = sortedOptionEntries();
  if (optParam && product.options?.[optParam]) {
    selectedOptionId = optParam;
    activeOptionType = getOptionType(product.options[optParam]);
  } else if (entries.length) {
    activeOptionType = getOptionType(entries[0][1]);
  }

  renderAll();
  window.gcLoaderListo?.(); // producto en pantalla: quitar el logo girando
}

function renderNotFound() {
  window.gcLoaderListo?.();
  $("productInfo").innerHTML = "";
  $("stepper").style.display = "none";
  $("saleSummary").parentElement.style.display = "none";
  $("productMain").innerHTML = `
    <div class="empty-state">
      <p style="font-size:1.1rem; color:var(--text-primary); font-weight:700;">No encontramos este producto</p>
      <p>Puede que ya no este disponible.</p>
      <a href="index.html" class="btn btn-primary" style="margin-top:14px;">Volver al catalogo</a>
    </div>`;
}

// ============ Render general ============
function renderAll() {
  renderHeader();
  renderStepper();
  renderMain();
  renderSummary();
}

function renderHeader() {
  const delivery = product.autoRecharge
    ? `<span class="chip">${ICON.bolt}Entrega instantánea</span>`
    : `<span class="chip warn">${ICON.box}Entrega manual</span>`;
  $("productInfo").innerHTML = `
    <img class="product-img" src="${esc(product.image)}" alt="${esc(product.name)}" />
    <div style="min-width:0;">
      <h1 class="product-title">${esc(product.name)}</h1>
      <div class="chip-row">
        ${product.region ? `<span class="chip">${ICON.globe}${esc(product.region)}</span>` : ""}
        ${delivery}
        <span class="chip">${ICON.shield}Pago seguro</span>
      </div>
      ${product.description ? `<p class="product-desc">${esc(product.description)}</p>` : ""}
    </div>`;
}

function renderStepper() {
  const steps = stepList();
  const idx = step === "done" ? steps.length : steps.indexOf(step);
  $("stepper").innerHTML = steps
    .map((s, i) => {
      const cls = i < idx ? "done" : i === idx ? "current" : "";
      const inner = i < idx ? `${ICON.check}` : `<span class="n">${i + 1}</span>`;
      return `${i ? '<span class="st-sep">›</span>' : ""}<span class="st ${cls}">${inner}${STEP_LABEL[s]}</span>`;
    })
    .join("");
}

function renderMain() {
  if (step === "paquete") renderPaquete();
  else if (step === "datos") renderDatos();
  else if (step === "pago") renderPago();
  else renderDone();
  renderStepper();
}

// ---------- Paso 1: Paquete ----------
function renderPaquete() {
  const entries = sortedOptionEntries();
  const types = Object.keys(OPTION_TYPES).filter((t) => entries.some(([, o]) => getOptionType(o) === t));
  if (!types.includes(activeOptionType)) activeOptionType = types[0] || "recarga";
  const visible = types.length > 1 ? entries.filter(([, o]) => getOptionType(o) === activeOptionType) : entries;
  const cur = getDisplayCurrency();

  const tabs =
    types.length > 1
      ? `<div class="type-tabs" role="tablist">${types
          .map((t) => `<button type="button" role="tab" class="type-tab${t === activeOptionType ? " active" : ""}" data-act="pick-type" data-type="${t}">${OPTION_TYPES[t].label}s</button>`)
          .join("")}</div>`
      : "";

  const tiles = visible
    .map(([optId, o]) => {
      const pct = optionDiscountPercent(o);
      const active = optId === selectedOptionId;
      const icon = o.icon
        ? `<img src="${esc(o.icon)}" alt="" />`
        : `<span class="fb">${TYPE_ICON[getOptionType(o)]}</span>`;
      return `
      <button type="button" class="pkg${active ? " active" : ""}" data-act="pick-opt" data-opt="${esc(optId)}">
        ${active ? `<span class="pkg-check">${ICON.check}</span>` : ""}
        ${pct ? `<span class="pkg-ribbon">AHORRA ${pct}%</span>` : ""}
        <span class="pkg-icon">${icon}</span>
        <span class="pkg-label">${esc(o.label)}</span>
        <span class="pkg-price"><b>${moneyStr(o.priceUsd, cur)}</b>${pct ? `<s>${moneyStr(Number(o.oldPriceUsd), cur)}</s>` : ""}</span>
      </button>`;
    })
    .join("");

  const ctaLabel = currentUser ? "Siguiente" : "Inicia sesión para continuar";
  $("productMain").innerHTML = `
    <div class="step-title">
      <span class="step-num">1</span>
      <h2>Selecciona tu <em>paquete</em></h2>
      ${tabs}
    </div>
    <div class="pkg-grid">${tiles || '<div class="empty-state" style="grid-column:1/-1;">Este producto aun no tiene opciones.</div>'}</div>
    <div class="cta-divider"></div>
    <button type="button" class="cta" id="nextBtn" data-act="next" ${selectedOptionId ? "" : "disabled"}>${ctaLabel} ${ICON.chevR}</button>`;
}

// ---------- Paso 2: Datos del jugador ----------
function renderDatos() {
  const last = loadLast();
  const showPrev = last && last.id && !playerId && !idVerified && product.requiresId;

  let body = "";
  if (idVerified) {
    body = `
      <div class="found-card">
        <span class="found-ico">${ICON.shieldBig}</span>
        <div style="min-width:0;">
          <div class="cap">Cuenta encontrada</div>
          <div class="found-name">${esc(verifiedName || playerId)} <small>(${esc(playerId)}${zoneId ? " · " + esc(zoneId) : ""})</small></div>
        </div>
        <button type="button" class="found-x" data-act="reset-verify" aria-label="Cambiar cuenta">${ICON.x}</button>
      </div>`;
  } else {
    if (product.requiresId) {
      body += `
      <div class="field-block">
        <label class="cap" for="playerIdInput">${esc(idLabel())}</label>
        <input type="text" class="big-input" id="playerIdInput" value="${esc(playerId)}" placeholder="Ingresa tu ID" autocomplete="off" inputmode="text" />
      </div>`;
    }
    if (product.requiresZoneId) {
      body += `
      <div class="field-block">
        <label class="cap" for="zoneIdInput">${esc(zoneLabel())}</label>
        <input type="text" class="big-input" id="zoneIdInput" value="${esc(zoneId)}" placeholder="Ej: 1234" autocomplete="off" />
      </div>`;
    }
    if (showPrev) {
      body += `<button type="button" class="prev-data" data-act="use-prev">${ICON.clock}<span>Usar datos anteriores: ${esc(idLabel())}: <b>${esc(last.id)}</b></span></button>`;
    }
  }

  if (product.extraField?.fieldName) {
    const opts = product.extraField.options || [];
    if (!extraValue && opts.length) extraValue = opts[0];
    body += `
      <div class="field-block" style="margin-top:18px;">
        <label class="cap" for="extraSelect">${esc(product.extraField.fieldLabel || "Selecciona una opcion")}</label>
        <select class="big-input" id="extraSelect">${opts
          .map((o) => `<option value="${esc(o)}" ${o === extraValue ? "selected" : ""}>${esc(o)}</option>`)
          .join("")}</select>
      </div>`;
  }

  $("productMain").innerHTML = `
    <div class="step-title">
      <button type="button" class="step-back" data-act="back" aria-label="Volver">${ICON.chevL}</button>
      <span class="step-num">2</span>
      <h2>Datos del <em>jugador</em></h2>
    </div>
    ${body}
    <div id="datosMsg" class="inline-msg"></div>
    <div class="cta-divider"></div>
    <button type="button" class="cta" id="datosBtn" data-act="datos-cta"></button>`;
  updateDatosCta();
}

function datosComplete() {
  if (product.requiresId && !playerId.trim()) return false;
  if (product.requiresZoneId && !zoneId.trim()) return false;
  return true;
}

function updateDatosCta() {
  const btn = $("datosBtn");
  if (!btn) return;
  const mustVerify = needsVerify() && !idVerified;
  btn.innerHTML = `${mustVerify ? "Verificar ID" : "Siguiente"} ${ICON.chevR}`;
  btn.disabled = !datosComplete();
}

async function verifyGameId() {
  const msg = $("datosMsg");
  const btn = $("datosBtn");
  const subCategoryId = verifyProductId();
  const pid = playerId.trim();
  const zid = product.requiresZoneId ? zoneId.trim() : "";

  if (!pid) {
    msg.textContent = "Ingresa el ID primero.";
    msg.className = "inline-msg err";
    return;
  }
  if (product.requiresZoneId && !zid) {
    msg.textContent = `Ingresa ${product.requiresZoneIdLabel || "tu ID de Zona"} primero.`;
    msg.className = "inline-msg err";
    return;
  }

  btn.disabled = true;
  btn.innerHTML = `<img class="gc-btn-logo" src="assets/logo-gc-blanco.png" alt="" /> Verificando...`;
  msg.textContent = "";
  idVerified = false;
  // Mientras verifica, el boton muestra el logo girando. Si la verificacion se queda trabada,
  // se corta a los 25 s para que el cliente no quede esperando para siempre.
  const corte = new AbortController();
  const tiempoMax = setTimeout(() => corte.abort(), 25000);

  try {
    const res = await fetch("/.netlify/functions/validate-player", {
      method: "POST",
      signal: corte.signal,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sub_category_id: subCategoryId,
        player_id: pid,
        ...(zid ? { zone_id: zid } : {}),
      }),
    });
    const data = await res.json();

    if (data.success && data.data) {
      idVerified = true;
      verifiedName = data.data.player_name || "";
      playerId = pid;
      zoneId = zid;
      saveLast();
      renderDatos();
      renderSummary();
      return;
    }

    const errorMessages = { PLAYER_NOT_FOUND: "No encontramos ese ID, revisalo e intenta de nuevo." };
    const apiMessage = errorMessages[data.error?.code] || data.message || data.error?.message || data.error;
    msg.textContent = `${typeof apiMessage === "string" ? apiMessage : "ID no valido, revisa el numero."}`;
    msg.className = "inline-msg err";
  } catch (err) {
    console.error(err);
    msg.textContent = "No se pudo verificar, intenta de nuevo.";
    msg.className = "inline-msg err";
  } finally {
    clearTimeout(tiempoMax);
  }
  updateDatosCta();
}

// ---------- Paso 3: Pago ----------
function renderPago() {
  $("productMain").innerHTML = `
    <div class="step-title">
      <button type="button" class="step-back" data-act="back" aria-label="Volver">${ICON.chevL}</button>
      <span class="step-num">${stepList().indexOf("pago") + 1}</span>
      <h2>Selecciona tu <em>método de pago</em></h2>
    </div>
    <div class="pay-grid" id="payCards"></div>
    <div class="pay-panel" id="payPanel"></div>
    <div id="payAlert" style="margin-top:16px;"></div>
    <div class="cta-divider"></div>
    <button type="button" class="cta" id="buyBtn" data-act="buy">Comprar ${ICON.chevR}</button>`;
  renderPayCards();
  renderPayPanel();
}

function renderPayCards() {
  const box = $("payCards");
  if (!box) return;
  const balance = currentProfile?.walletBalanceUsd || 0;
  const cards = [
    { id: "pago_movil", name: "Pago Móvil", sub: "Bolívares (Bs)", logo: `<img src="assets/logopagomovil.png" alt="" />` },
    { id: "binance", name: "Binance Pay", sub: "USDT", logo: `<img src="assets/logobinance.png" alt="" />` },
  ];
  if (currentUser && currentProfile) cards.push({ id: "wallet", name: "Wallet", sub: `Saldo: $${balance.toFixed(2)}`, logo: icon("wallet", "1.6em") });

  box.innerHTML = cards
    .map(
      (c) => `
    <button type="button" class="pay-card${c.id === selectedPayMethod ? " active" : ""}" data-act="pick-method" data-method="${c.id}">
      <span class="pay-logo">${c.logo}</span>
      <span><div class="pay-name">${c.name}</div><div class="pay-sub">${c.sub}</div></span>
      <span class="pay-radio"></span>
    </button>`
    )
    .join("");
}

function payRow(label, value, showAlways = true) {
  if (!value && !showAlways) return "";
  const copyBtn = value ? `<button type="button" class="copy-field-btn" data-act="copy" data-copy-value="${esc(value)}">Copiar</button>` : "";
  return `<div class="row"><span>${label}:</span><span class="row-value-copy"><strong>${esc(value || "-")}</strong>${copyBtn}</span></div>`;
}

function qrToggleBlock(imageFile, altText) {
  if (!imageFile) return "";
  return `
    <button type="button" class="btn btn-outline btn-full" style="margin-bottom:16px;" data-act="toggle-qr">Ver QR</button>
    <div id="qrBox" style="display:none; position:relative; text-align:center; margin-bottom:16px;">
      <span data-act="close-qr" style="position:absolute; top:-8px; right:calc(50% - 118px); background:var(--bg-surface-2); border:1px solid var(--border-soft); border-radius:50%; width:26px; height:26px; display:flex; align-items:center; justify-content:center; cursor:pointer; font-size:16px;">&times;</span>
      <img src="assets/${esc(imageFile)}" alt="${esc(altText)}" style="max-width:220px; width:100%; border-radius:12px; border:1px solid var(--border-soft);" />
    </div>`;
}

function payDetailsHtml() {
  const opt = selectedOption();
  const totalUsd = opt.priceUsd * (1 - currentDiscountPercent / 100);

  if (selectedPayMethod === "wallet") {
    const balance = currentProfile?.walletBalanceUsd || 0;
    const remaining = balance - totalUsd;
    return `
      <div class="pay-details">
        <div class="row"><span>Tu saldo actual:</span><span><strong>$${balance.toFixed(2)}</strong></span></div>
        <div class="row"><span>Total del pedido:</span><span><strong>$${totalUsd.toFixed(2)}</strong></span></div>
        <div class="row"><span>Saldo despues de pagar:</span><span><strong>${remaining < 0 ? "Insuficiente" : `$${remaining.toFixed(2)}`}</strong></span></div>
      </div>`;
  }
  if (selectedPayMethod === "pago_movil") {
    const pm = publicSettings.pagoMovil || {};
    return `
      <div class="pay-details">
        ${payRow("C.I.", pm.ci)}
        ${payRow("Telefono", pm.phone)}
        ${payRow("Banco", pm.bank)}
        ${payRow("Nro. de cuenta", pm.accountNumber)}
        ${payRow("Titular", pm.holderName, false)}
      </div>
      ${qrToggleBlock("pagomovilqr.png", "QR Pago Movil")}`;
  }
  const bn = publicSettings.binance || {};
  return `
    <div class="pay-details">
      ${payRow("Binance Pay ID", bn.payId)}
    </div>
    ${qrToggleBlock(bn.qrImage, "QR Binance Pay")}`;
}

function proofFieldsHtml() {
  if (selectedPayMethod === "wallet") {
    return `<div class="alert alert-info">Se descontara de tu saldo Wallet al confirmar. No necesitas ingresar ningun dato de pago.</div>`;
  }
  if (selectedPayMethod === "binance") {
    return `
      <div class="alert alert-info">Asegurate de pagar el monto correcto, de lo contrario tendremos problemas con el pago.</div>
      <div class="field-block">
        <label class="cap" for="transactionId">ID de la transaccion</label>
        <input type="text" class="big-input" id="transactionId" value="${esc(proof.transactionId)}" placeholder="Ej: 123456789012" />
      </div>`;
  }
  return `
    <div class="field-row" style="gap:12px; flex-wrap:wrap;">
      <div class="field-block" style="flex:1 1 220px; margin-bottom:0;">
        <label class="cap" for="last6">Ultimos 6 digitos de la referencia</label>
        <input type="text" class="big-input" id="last6" maxlength="6" value="${esc(proof.last6)}" placeholder="Ej: 456789" inputmode="numeric" />
      </div>
      <div class="field-block" style="flex:1 1 220px; margin-bottom:0;">
        <label class="cap" for="payerPhone">Telefono desde donde realizo el pago</label>
        <input type="text" class="big-input" id="payerPhone" value="${esc(proof.payerPhone)}" placeholder="Ej: 04141234567" inputmode="tel" />
      </div>
    </div>`;
}

function renderPayPanel() {
  const panel = $("payPanel");
  if (!panel) return;
  panel.innerHTML = `
    ${payDetailsHtml()}
    <div class="field-block" style="margin-top:6px;">
      <label class="cap" for="couponInput">Cupon de descuento (opcional)</label>
      <div class="coupon-row">
        <input type="text" class="big-input" id="couponInput" value="${esc(couponText)}" placeholder="Ej: CUPON10" style="padding:14px 18px;" />
        <button type="button" class="btn btn-outline" id="verifyCouponBtn" data-act="verify-coupon" style="display:${couponText.trim() ? "inline-flex" : "none"};">Verificar</button>
      </div>
      <div id="couponMsg" class="inline-msg ${couponMsg.cls}">${esc(couponMsg.text)}</div>
    </div>
    ${proofFieldsHtml()}`;
}

// ---------- Cupon ----------
async function verifyCoupon() {
  const code = couponText.trim().toUpperCase();
  if (!code) return;
  try {
    const couponSnap = await getDoc(doc(db, "coupons", code));
    if (!couponSnap.exists() || couponSnap.data().active !== true) {
      currentDiscountPercent = 0;
      currentCouponCode = null;
      couponMsg = { text: "Cupon no valido.", cls: "err" };
    } else {
      const redemptionSnap = currentUser ? await getDoc(doc(db, "couponRedemptions", `${currentUser.uid}_${code}`)) : null;
      if (redemptionSnap && redemptionSnap.exists()) {
        currentDiscountPercent = 0;
        currentCouponCode = null;
        couponMsg = { text: "Este cupon ya fue usado. Tu pedido continua sin descuento.", cls: "warn" };
      } else {
        currentDiscountPercent = couponSnap.data().discountPercent;
        currentCouponCode = code;
        couponMsg = { text: `Cupon valido: ${currentDiscountPercent}% de descuento aplicado`, cls: "ok" };
      }
    }
  } catch (err) {
    console.error(err);
    couponMsg = { text: "No se pudo verificar el cupon, intenta de nuevo.", cls: "err" };
  }
  renderPayPanel();
  renderSummary();
}

// ============ Resumen de venta (barra lateral) ============
function renderSummary() {
  const box = $("saleSummary");
  if (!box || !product) return;
  const opt = selectedOption();
  const mode = summaryMode();
  const subtotalUsd = opt ? opt.priceUsd : 0;
  const totalUsd = subtotalUsd * (1 - currentDiscountPercent / 100);
  const total = moneyParts(totalUsd, mode);

  const showPlayer = (step === "pago" || step === "done" || idVerified) && (playerId || zoneId || extraValue);
  const playerBox = showPlayer
    ? `<div class="sale-box">
        <div class="h">Datos del jugador</div>
        ${playerId ? `<div class="r"><span>${esc(idLabel())}:</span><b>${esc(playerId)}</b></div>` : ""}
        ${idVerified && verifiedName ? `<div class="r"><span>Cuenta:</span><b>${esc(verifiedName)}</b></div>` : ""}
        ${zoneId ? `<div class="r"><span>${esc(zoneLabel())}:</span><b>${esc(zoneId)}</b></div>` : ""}
        ${product.extraField?.fieldName && extraValue ? `<div class="r"><span>${esc(product.extraField.fieldLabel || "Opcion")}:</span><b>${esc(extraValue)}</b></div>` : ""}
      </div>`
    : "";

  const discountRow =
    opt && currentDiscountPercent > 0
      ? `<div class="sale-sub disc"><span>Cupon ${esc(currentCouponCode || "")} (-${currentDiscountPercent}%)</span><span class="v">- ${moneyStr(subtotalUsd - totalUsd, mode)}</span></div>`
      : "";

  box.innerHTML = `
    <div class="sale-title">Resumen de <em>venta</em></div>
    <div class="sale-item">
      <img class="main" src="${esc(product.image)}" alt="" />
      <div style="min-width:0;">
        <div class="t">${esc(product.name)}</div>
        <div class="s">${opt ? esc(opt.label) : "Selecciona un paquete"}</div>
      </div>
    </div>
    ${playerBox}
    <div class="sale-sub"><span>Subtotal</span><span class="v">${moneyStr(subtotalUsd, mode)}</span></div>
    ${discountRow}
    <div class="sale-total-cap">Total a pagar</div>
    <div class="sale-total-row">
      <div class="sale-total"><small>${total.sym}</small>${total.num}</div>
      <span class="sale-chip ${product.autoRecharge ? "" : "manual"}">${product.autoRecharge ? "Instantánea" : "Manual"}</span>
    </div>
    <div class="sale-ssl">Transacción segura SSL ${icon("lock")}</div>`;
}

window.addEventListener("gc-currency-change", () => {
  if (!product) return;
  if (step === "paquete") renderPaquete();
  renderSummary();
});

// ============ Navegacion entre pasos ============
function goNext() {
  const steps = stepList();
  const next = steps[steps.indexOf(step) + 1];
  if (!next) return;

  if (step === "paquete" && !selectedOptionId) return;

  // El pago requiere sesion: se guarda a donde volver (con el paquete elegido)
  if (step === "paquete" && !currentUser) {
    sessionStorage.setItem("gc_return_to", `producto.html?id=${encodeURIComponent(product._id)}&opt=${encodeURIComponent(selectedOptionId)}`);
    window.location.href = "login.html";
    return;
  }

  step = next;
  renderMain();
  renderSummary();
  window.scrollTo({ top: 0, behavior: "smooth" });
}

function goBack() {
  const steps = stepList();
  const prev = steps[steps.indexOf(step) - 1];
  if (!prev) return;
  step = prev;
  renderMain();
  renderSummary();
}

// ============ Eventos (delegacion) ============
const main = $("productMain");

main.addEventListener("click", (e) => {
  const el = e.target.closest("[data-act]");
  if (!el) return;
  switch (el.dataset.act) {
    case "pick-type": {
      activeOptionType = el.dataset.type;
      // Si lo elegido pertenece a otra pestaña, se limpia para no dejar una seleccion invisible
      if (selectedOptionId && getOptionType(product.options[selectedOptionId]) !== activeOptionType) selectedOptionId = null;
      renderPaquete();
      renderSummary();
      break;
    }
    case "pick-opt":
      selectedOptionId = el.dataset.opt;
      renderPaquete();
      renderSummary();
      break;
    case "next":
      goNext();
      break;
    case "back":
      goBack();
      break;
    case "use-prev": {
      const last = loadLast();
      if (last) {
        playerId = last.id || "";
        zoneId = last.zone || "";
      }
      renderDatos();
      break;
    }
    case "reset-verify":
      idVerified = false;
      verifiedName = "";
      renderDatos();
      renderSummary();
      break;
    case "datos-cta":
      if (needsVerify() && !idVerified) verifyGameId();
      else {
        if (product.requiresId) saveLast();
        goNext();
      }
      break;
    case "pick-method":
      selectedPayMethod = el.dataset.method;
      renderPayCards();
      renderPayPanel();
      renderSummary();
      break;
    case "verify-coupon":
      verifyCoupon();
      break;
    case "buy":
      buy();
      break;
    case "copy":
      copyValue(el);
      break;
    case "toggle-qr": {
      const qr = $("qrBox");
      if (qr) qr.style.display = qr.style.display === "none" ? "block" : "none";
      break;
    }
    case "close-qr":
      if ($("qrBox")) $("qrBox").style.display = "none";
      break;
    case "dashboard":
      window.location.href = "dashboard.html";
      break;
  }
});

main.addEventListener("input", (e) => {
  switch (e.target.id) {
    case "playerIdInput":
      playerId = e.target.value;
      idVerified = false;
      $("datosMsg").textContent = "";
      updateDatosCta();
      renderSummary();
      break;
    case "zoneIdInput":
      zoneId = e.target.value;
      idVerified = false;
      $("datosMsg").textContent = "";
      updateDatosCta();
      break;
    case "extraSelect":
      extraValue = e.target.value;
      renderSummary();
      break;
    case "couponInput": {
      couponText = e.target.value;
      const btn = $("verifyCouponBtn");
      if (btn) btn.style.display = couponText.trim() ? "inline-flex" : "none";
      if (currentCouponCode && currentCouponCode !== couponText.trim().toUpperCase()) {
        currentDiscountPercent = 0;
        currentCouponCode = null;
        couponMsg = { text: "", cls: "" };
        const m = $("couponMsg");
        if (m) {
          m.textContent = "";
          m.className = "inline-msg";
        }
        renderSummary();
      }
      break;
    }
    case "last6":
      proof.last6 = e.target.value;
      break;
    case "payerPhone":
      proof.payerPhone = e.target.value;
      break;
    case "transactionId":
      proof.transactionId = e.target.value;
      break;
  }
});

main.addEventListener("change", (e) => {
  if (e.target.id === "extraSelect") {
    extraValue = e.target.value;
    renderSummary();
  }
});

async function copyValue(btn) {
  try {
    await navigator.clipboard.writeText(btn.dataset.copyValue);
    const original = btn.textContent;
    btn.textContent = "Copiado";
    setTimeout(() => (btn.textContent = original), 1200);
  } catch (err) {
    console.error(err);
  }
}

// ============ COMPRAR (misma logica del modal anterior) ============
function supportLink(text) {
  const wa = publicSettings.whatsappNumber || "584163557506";
  return `<a href="https://wa.me/${wa}?text=${encodeURIComponent(text)}" target="_blank" rel="noopener" class="btn btn-outline btn-full" style="margin-top:10px; display:flex; align-items:center; justify-content:center; gap:8px;">${WA_ICON} Contactar soporte por WhatsApp</a>`;
}

// Mientras se procesa el pago: logo GC chiquito girando en el boton y, debajo, el logo con su aro
// y el aviso de no cerrar la pagina. Si hay un error, el mensaje de error reemplaza este aviso.
function payLoaderHTML(texto) {
  return `
    <div class="gc-grid-loader gc-pay-loader" role="status">
      <div class="gc-loader-logo gc-loader-logo--sm"><img src="assets/logo-gc-blanco.png" alt="" /></div>
      <div class="gc-loader-text"><b>${texto}</b></div>
      <small>No cierres ni recargues esta página.</small>
    </div>`;
}
function setBuyBusy(label) {
  const btn = $("buyBtn");
  btn.disabled = true;
  btn.innerHTML = `<img class="gc-btn-logo" src="assets/logo-gc-blanco.png" alt="" /> ${label}`;
  const box = $("payAlert");
  if (box) box.innerHTML = payLoaderHTML(label.replace(/\.\.\.$/, "…").replace(/pago/, "tu pago"));
}
function setBuyIdle() {
  const btn = $("buyBtn");
  btn.disabled = false;
  btn.innerHTML = `Comprar ${ICON.chevR}`;
}

async function buy() {
  const alertBox = $("payAlert");
  alertBox.innerHTML = "";

  if (!currentUser) {
    sessionStorage.setItem("gc_return_to", `producto.html?id=${encodeURIComponent(product._id)}&opt=${encodeURIComponent(selectedOptionId || "")}`);
    window.location.href = "login.html";
    return;
  }

  const option = selectedOption();
  if (!option) {
    alertBox.innerHTML = `<div class="alert alert-error">Elige un paquete para continuar</div>`;
    return;
  }

  // Datos del jugador (ya validados en el paso 2, se revalidan por seguridad)
  let gameId = "";
  if (product.requiresId) {
    gameId = playerId.trim();
    if (!gameId) {
      alertBox.innerHTML = `<div class="alert alert-error">Ingresa ${esc(product.requiresIdLabel || "tu ID")} para continuar</div>`;
      return;
    }
    if (verifyProductId() && !idVerified) {
      alertBox.innerHTML = `<div class="alert alert-error">Verifica tu ID antes de finalizar el pago</div>`;
      return;
    }
  }
  let zone = "";
  if (product.requiresZoneId) {
    zone = zoneId.trim();
    if (!zone) {
      alertBox.innerHTML = `<div class="alert alert-error">Ingresa ${esc(product.requiresZoneIdLabel || "tu ID de Zona")} para continuar</div>`;
      return;
    }
  }
  let extraFieldValue = "";
  if (product.extraField && product.extraField.fieldName) {
    extraFieldValue = extraValue;
    if (!extraFieldValue) {
      alertBox.innerHTML = `<div class="alert alert-error">Selecciona ${esc(product.extraField.fieldLabel || "una opcion")}</div>`;
      return;
    }
  }

  const common = {
    productId: product._id,
    optionId: selectedOptionId,
    couponCode: currentCouponCode,
    playerGameId: product.requiresId ? gameId : "",
    zoneId: product.requiresZoneId ? zone : "",
    extraFieldValue: product.extraField ? extraFieldValue : "",
  };

  // ---------- WALLET ----------
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

    setBuyBusy("Procesando pago...");
    try {
      const idToken = await currentUser.getIdToken();
      const res = await fetch("/.netlify/functions/wallet-pay-order", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${idToken}` },
        body: JSON.stringify(common),
      });
      const data = await res.json();

      if (!data.success) {
        alertBox.innerHTML = `
          <div class="alert alert-error">${esc(data.message || "No se pudo procesar el pago")}</div>
          ${data.needsWhatsapp ? supportLink(`Hola, intente pagar *${product.name}* con mi Wallet pero el sistema no pudo procesar la recarga.\nPedido: ${data.orderId || "-"}`) : ""}`;
        setBuyIdle();
        return;
      }

      currentProfile.walletBalanceUsd = remaining;
      pendingWhatsappOrder = data.needsWhatsapp
        ? {
            order: { paymentMethod: "wallet", totalUsd: data.receipt.totalUsd, couponCode: currentCouponCode, discountPercent: currentDiscountPercent },
            gameId,
            zoneId: zone,
            verifiedNote: data.whatsappNote,
          }
        : null;
      finish(data);
    } catch (err) {
      console.error(err);
      alertBox.innerHTML = '<div class="alert alert-error">Error de conexion. Intenta de nuevo.</div>';
      setBuyIdle();
    }
    return;
  }

  // ---------- BINANCE PAY ----------
  if (selectedPayMethod === "binance") {
    const transactionId = proof.transactionId.trim();
    if (!transactionId) {
      alertBox.innerHTML = '<div class="alert alert-error">Ingresa el ID de la transaccion</div>';
      return;
    }

    setBuyBusy("Verificando pago...");
    try {
      const idToken = await currentUser.getIdToken();
      const res = await fetch("/.netlify/functions/verify-binance-pay-order", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${idToken}` },
        body: JSON.stringify({ ...common, transactionId }),
      });
      const data = await res.json();

      if (!data.success) {
        const isInsufficient = data.code === "INSUFFICIENT_AMOUNT";
        alertBox.innerHTML = `
          <div class="alert alert-error">${esc(data.message || "No se pudo verificar el pago")}</div>
          ${isInsufficient ? supportLink(`Hola, hice un pago por Binance Pay por *${product.name}* pero el sistema no pudo procesarlo automaticamente.\nID de transaccion: ${transactionId}`) : ""}`;
        setBuyIdle();
        return;
      }

      pendingWhatsappOrder = data.needsWhatsapp
        ? {
            order: {
              paymentMethod: "binance",
              paymentProof: { transactionId },
              totalUsd: data.receipt.totalUsd,
              couponCode: currentCouponCode,
              discountPercent: currentDiscountPercent,
            },
            gameId,
            zoneId: zone,
            verifiedNote: data.whatsappNote,
          }
        : null;
      finish(data);
    } catch (err) {
      console.error(err);
      alertBox.innerHTML = '<div class="alert alert-error">Error de conexion. Intenta de nuevo.</div>';
      setBuyIdle();
    }
    return;
  }

  // ---------- PAGO MOVIL (verificacion en segundo plano; se escucha el doc con onSnapshot) ----------
  const last6 = proof.last6.trim();
  const payerPhone = proof.payerPhone.trim();
  if (!last6 || !payerPhone) {
    alertBox.innerHTML = '<div class="alert alert-error">Completa los datos del pago</div>';
    return;
  }

  setBuyBusy("Verificando pago...");
  try {
    const idToken = await currentUser.getIdToken();
    const res = await fetch("/.netlify/functions/verify-pago-movil-order", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${idToken}` },
      body: JSON.stringify({ ...common, bankReference: last6, payerPhone }),
    });
    // Lectura segura: si el servidor responde texto plano (ej. "TypeError: ...")
    // no se intenta parsear a ciegas, se muestra un error legible.
    const rawText = await res.text();
    let entryData;
    try {
      entryData = JSON.parse(rawText);
    } catch {
      console.error("Respuesta no-JSON de verify-pago-movil-order:", res.status, rawText);
      entryData = { success: false, message: "El servidor tuvo un problema al iniciar la verificacion. Intenta de nuevo en unos segundos." };
    }

    if (!entryData.success) {
      alertBox.innerHTML = `<div class="alert alert-error">${esc(entryData.message || "No se pudo procesar tu pago")}</div>`;
      setBuyIdle();
      return;
    }

    alertBox.innerHTML = payLoaderHTML("Procesando tu pago…");

    const unsubscribe = onSnapshot(
      doc(db, "pendingVerifications", entryData.pendingId),
      (snap) => {
        if (!snap.exists()) return;
        const data = snap.data();
        if (data.verificationState !== "listo") return;
        unsubscribe();

        if (!data.success) {
          const isInsufficient = data.code === "INSUFFICIENT_AMOUNT";
          alertBox.innerHTML = `
            <div class="alert alert-error">${esc(data.message || "No se pudo verificar el pago")}</div>
            ${isInsufficient ? supportLink(`Hola, hice un pago movil por *${product.name}* pero el sistema no pudo procesarlo automaticamente.\nReferencia: ${last6}\nTelefono: ${payerPhone}`) : ""}`;
          setBuyIdle();
          return;
        }

        pendingWhatsappOrder = data.needsWhatsapp
          ? {
              order: {
                paymentMethod: "pago_movil",
                paymentProof: { last6, payerPhone },
                totalUsd: data.receipt.totalUsd,
                exchangeRateBsPerUsd: publicSettings.exchangeRateBsPerUsd || 0,
                couponCode: currentCouponCode,
                discountPercent: currentDiscountPercent,
              },
              gameId,
              zoneId: zone,
              verifiedNote: data.whatsappNote,
            }
          : null;
        finish(data);
      },
      (err) => {
        console.error(err);
        alertBox.innerHTML = '<div class="alert alert-error">Error de conexion. Intenta de nuevo.</div>';
        setBuyIdle();
      }
    );
  } catch (err) {
    console.error(err);
    alertBox.innerHTML = '<div class="alert alert-error">Error de conexion. Intenta de nuevo.</div>';
    setBuyIdle();
  }
}

function finish(data) {
  doneData = data;
  step = "done";
  renderMain();
  renderSummary();
  window.scrollTo({ top: 0, behavior: "smooth" });
}

// ============ Pantalla final: comprobante ============
const RC_ICON = {
  checkCircle: `<svg width="30" height="30" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="m8 12.5 2.8 2.8L16 9.5"/></svg>`,
  receipt: `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 3h14v18l-3-2-2 2-2-2-2 2-2-2-3 2V3Z"/><path d="M9 8h6M9 12h6"/></svg>`,
  gift: `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="8" width="18" height="4" rx="1"/><path d="M12 8v13M5 12v8a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-8"/><path d="M7.5 8a2.5 2.5 0 1 1 0-5C10 3 12 8 12 8s2-5 4.5-5a2.5 2.5 0 1 1 0 5"/></svg>`,
  copy: `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/></svg>`,
  clock: `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>`,
  alert: `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3 2 20h20L12 3Z"/><path d="M12 10v4M12 17.5v.01"/></svg>`,
  spinner: `<svg class="rc-spin" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><path d="M21 12a9 9 0 1 1-6.2-8.55"/></svg>`,
  home: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 11 12 3l9 8"/><path d="M5 10v10h14V10"/></svg>`,
  cart: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="9" cy="20" r="1.5"/><circle cx="18" cy="20" r="1.5"/><path d="M2 3h3l2.7 12.4a1 1 0 0 0 1 .8h9.4a1 1 0 0 0 1-.8L21 7H6"/></svg>`,
};

// Marca el codigo como "ya revelado" para que el dashboard no lo vuelva a
// esconder detras del boton (mismo almacenamiento que usa dashboard.js).
function markVoucherRevealed(orderId, count) {
  try {
    const KEY = "gc_revealed_vouchers";
    const arr = JSON.parse(localStorage.getItem(KEY) || "[]");
    for (let i = 0; i < count; i++) {
      const k = `${orderId}_${i}`;
      if (!arr.includes(k)) arr.push(k);
    }
    localStorage.setItem(KEY, JSON.stringify(arr));
  } catch {}
}

function receiptVouchersHtml(vouchers) {
  return vouchers
    .map((v, i) => {
      const code = esc(v.code || "");
      const meta = [v.serial_number ? `Serial: ${esc(v.serial_number)}` : "", v.expiry_date ? `Vence: ${esc(v.expiry_date)}` : ""]
        .filter(Boolean)
        .join(" · ");
      return `
      <div class="rc-voucher">
        <div class="rc-voucher-head">${RC_ICON.gift}<span>Codigo de tu giftcard${vouchers.length > 1 ? ` (${i + 1}/${vouchers.length})` : ""}</span></div>
        <div class="rc-voucher-row">
          <div class="rc-voucher-code" id="rcCode${i}">${code}</div>
          <button type="button" class="btn btn-outline btn-sm rc-copy" data-code="${code}">${RC_ICON.copy}<span>Copiar</span></button>
        </div>
        ${meta ? `<div class="rc-voucher-meta">${meta}</div>` : ""}
      </div>`;
    })
    .join("");
}

function showReceiptVouchers(vouchers, orderId) {
  const box = $("receiptVouchers");
  if (!box) return;
  box.innerHTML = `
    ${receiptVouchersHtml(vouchers)}
    <div class="rc-note">${RC_ICON.alert}<span>Guarda este codigo. Una vez entregado no se pueden procesar reembolsos sobre este pedido. Tambien lo encuentras siempre en tu Dashboard.</span></div>`;
  markVoucherRevealed(orderId, vouchers.length);
  box.querySelectorAll(".rc-copy").forEach((btn) => {
    btn.addEventListener("click", () => {
      const code = btn.dataset.code || "";
      const label = btn.querySelector("span");
      navigator.clipboard
        .writeText(code)
        .then(() => {
          label.textContent = "Copiado";
          setTimeout(() => (label.textContent = "Copiar"), 1500);
        })
        .catch(() => alert(`No se pudo copiar automaticamente. Codigo: ${code}`));
    });
  });
}

// Si el codigo aun no esta (Central One tarda 1-2 min a veces), se consulta
// cada pocos segundos mientras el cliente ve el recibo.
function startVoucherPolling(orderId) {
  let tries = 0;
  let completedNoCode = 0;
  const MAX_TRIES = 50; // ~3.5 min
  const stop = () => clearInterval(timer);
  const timer = setInterval(async () => {
    const box = $("receiptVouchers");
    if (!box) return stop(); // el cliente salio de la pantalla de recibo
    tries += 1;
    try {
      const idToken = await currentUser.getIdToken();
      const res = await fetch("/.netlify/functions/check-centralone-order-status", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${idToken}` },
        body: JSON.stringify({ orderId }),
      });
      const j = await res.json();
      const o = j && j.success ? j.order : null;
      if (o && Array.isArray(o.vouchers) && o.vouchers.length) {
        stop();
        showReceiptVouchers(o.vouchers, orderId);
        return;
      }
      if (o && o.codesError && o.codesError.code === "insufficient_scope") {
        stop();
        box.innerHTML = `<div class="rc-pending rc-pending-warn">${RC_ICON.alert}<span>Tu pago fue exitoso, pero no pudimos leer el codigo de tu giftcard. Contactanos por WhatsApp y te lo entregamos enseguida.</span></div>`;
        return;
      }
      if (o && o.internal_status === "rechazado") {
        stop();
        box.innerHTML = `<div class="rc-pending rc-pending-warn">${RC_ICON.alert}<span>Hubo un problema con tu giftcard. Contactanos por WhatsApp para coordinar tu reembolso o la entrega manual.</span></div>`;
        return;
      }
      if (o && o.internal_status === "completado" && !o.codesPending && ++completedNoCode >= 3) {
        stop();
        box.innerHTML = ""; // recarga directa: no hay codigo que mostrar
        return;
      }
    } catch (err) {
      console.error(err);
    }
    if (tries >= MAX_TRIES) {
      stop();
      box.innerHTML = `<div class="rc-pending">${RC_ICON.clock}<span>Tu giftcard esta tardando mas de lo normal. No te preocupes: aparecera en tu Dashboard apenas este lista.</span></div>`;
    }
  }, 4000);
}

function renderDone() {
  const data = doneData || {};
  const r = data.receipt || {};
  const vouchers = Array.isArray(data.vouchers) ? data.vouchers : [];
  const isSuccess = data.status === "completado";
  const orderId = data.orderId || r.orderId;
  // Pago automatico que aun no trae codigo: se muestra "preparando" y se consulta.
  const waitingVoucher =
    product?.category === "giftcards" && !!data.autoRecharge && !data.needsWhatsapp && vouchers.length === 0 && !!orderId;

  const statusHtml = isSuccess
    ? `<div class="rc-status rc-ok">${RC_ICON.checkCircle}<div><strong>Pago verificado</strong><span>${vouchers.length ? "Tu giftcard fue entregada" : "Tu recarga fue completada"}</span></div></div>`
    : data.needsWhatsapp
    ? `<div class="rc-status rc-ok">${RC_ICON.checkCircle}<div><strong>Pago verificado</strong><span>${esc(data.whatsappNote || "Tu recarga esta siendo procesada.")}</span></div></div>`
    : `<div class="rc-status rc-ok">${RC_ICON.checkCircle}<div><strong>Pago verificado</strong><span>Tu pedido esta siendo procesado, en unos minutos deberia completarse.</span></div></div>`;

  const fecha = new Date(r.date || Date.now()).toLocaleString("es-VE", { dateStyle: "medium", timeStyle: "short" });
  const row = (label, value) => (value ? `<div class="row"><span>${label}</span><span><strong>${value}</strong></span></div>` : "");

  const waRedirect =
    data.needsWhatsapp && pendingWhatsappOrder
      ? `<a href="#" id="waNowBtn" class="btn btn-primary btn-full" style="display:flex; align-items:center; justify-content:center; gap:8px;">${WA_ICON} ${data.requiresRefund ? "Contactar por WhatsApp (reembolso)" : "Ir a WhatsApp ahora"}</a>
         <p style="text-align:center; color:var(--text-muted); font-size:0.8rem; margin:0;">Te redirigiremos automaticamente en <strong id="waCountdownNum">3</strong>s...</p>`
      : "";

  const voucherSection = vouchers.length
    ? `<div id="receiptVouchers" class="rc-vouchers"></div>`
    : waitingVoucher
    ? `<div id="receiptVouchers" class="rc-vouchers"><div class="rc-pending">${RC_ICON.spinner}<span>Estamos preparando tu giftcard. Aparecera aqui en unos instantes, no cierres esta pagina.</span></div></div>`
    : "";

  main.innerHTML = `
    <div class="receipt-wrap">
      <div class="step-title"><span class="step-num">${ICON.check}</span><h2>Compra <em>realizada</em></h2></div>
      ${statusHtml}
      ${voucherSection}
      <div class="rc-card">
        <div class="rc-card-head">
          <span class="rc-card-icon">${RC_ICON.receipt}</span>
          <div>
            <strong>Comprobante de compra</strong>
            <div class="rc-date">${esc(fecha)}</div>
          </div>
        </div>
        <div class="pay-details">
          ${row("Numero de pedido", esc(r.orderId))}
          ${row("Producto", `${esc(r.productName)} (${esc(r.optionLabel)})`)}
          ${row("ID del jugador", r.playerGameId ? esc(r.playerGameId) : "")}
          ${row("Zona ID", r.zoneId ? esc(r.zoneId) : "")}
          ${row("Metodo de pago", r.paymentMethod ? esc(r.paymentMethod) : "")}
          ${row("Referencia", r.reference ? esc(r.reference) : "")}
          ${row("Total pagado", r.totalBs != null ? formatBs(r.totalBs) : `$${(r.totalUsd || 0).toFixed(2)}`)}
          <div class="row"><span>Estado</span><span><strong class="rc-state ${isSuccess ? "rc-state-ok" : "rc-state-wait"}">${isSuccess ? "Completado" : "En proceso"}</strong></span></div>
        </div>
      </div>
      <div class="receipt-actions">
        ${waRedirect}
        <button type="button" class="btn btn-outline btn-full rc-btn" data-act="dashboard">${RC_ICON.home}<span>Ver mi Dashboard</span></button>
        <a href="index.html" class="btn btn-outline btn-full rc-btn">${RC_ICON.cart}<span>Seguir comprando</span></a>
      </div>
    </div>`;
  renderStepper();

  if (vouchers.length) showReceiptVouchers(vouchers, orderId);
  else if (waitingVoucher) startVoucherPolling(orderId);

  // Redireccion a WhatsApp a los 3s (location.href, nunca window.open en un timeout:
  // los navegadores bloquean popups que no vienen de un click directo)
  if (data.needsWhatsapp && pendingWhatsappOrder) {
    let redirected = false;
    let countdownInterval = null;
    const goToWhatsapp = () => {
      if (redirected) return;
      redirected = true;
      clearInterval(countdownInterval);
      const p = pendingWhatsappOrder;
      window.location.href = buildWhatsappUrl(p.order, p.gameId, p.verifiedNote, p.zoneId);
    };
    $("waNowBtn")?.addEventListener("click", (e) => {
      e.preventDefault();
      goToWhatsapp();
    });
    let secondsLeft = 3;
    countdownInterval = setInterval(() => {
      secondsLeft -= 1;
      const numEl = $("waCountdownNum");
      if (numEl) numEl.textContent = String(Math.max(secondsLeft, 0));
      if (secondsLeft <= 0) clearInterval(countdownInterval);
    }, 1000);
    setTimeout(goToWhatsapp, 3000);
  }
}

function buildWhatsappUrl(order, gameId, verifiedNote, zone) {
  const option = product.options[selectedOptionId];
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
    verifiedNote ? "(Pago verificado automaticamente)" : "(Nuevo Pedido)",
    "",
    `- Cliente: ${currentProfile ? currentProfile.name : ""}`,
    gameId ? `- ${product.requiresIdLabel || "ID"}: ${gameId}` : null,
    zone ? `- ${product.requiresZoneIdLabel || "Zona ID"}: ${zone}` : null,
    `- Producto: ${product.name} (${option.label})`,
    `- Region: ${product.region}`,
    `- Metodo de pago: ${methodLabel}`,
    `- Referencia: ${paymentRef}`,
    order.couponCode ? `- Cupon aplicado: ${order.couponCode} (${order.discountPercent}% off)` : null,
    `- Total pagado: ${totalLine}`,
    verifiedNote ? `- Nota: ${verifiedNote}` : null,
  ].filter((l) => l !== null);

  const wa = publicSettings.whatsappNumber || "584163557506";
  return `https://wa.me/${wa}?text=${encodeURIComponent(lines.join("\n"))}`;
}
