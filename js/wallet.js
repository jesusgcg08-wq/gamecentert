// ============================================================================
// GameCenter — Wallet del cliente (wallet.html)
// Saldo disponible (USD y su equivalente en Bs) + flujo de deposito con
// temporizador de 10 minutos, verificado automaticamente contra Pabilo.
// ============================================================================

import { auth, db } from "./firebase-config.js";
import { doc, getDoc, collection, query, where, orderBy, getDocs } from "https://www.gstatic.com/firebasejs/10.14.0/firebase-firestore.js";
import { initAccountMenu, onAccountChange, getCurrentUser, getCurrentProfile } from "./account-menu.js";

initAccountMenu({ activePage: "wallet" });

let publicSettings = null;
let depositTimerInterval = null;
let depositExpiresAt = null;

async function ensureSettings() {
  if (!publicSettings) {
    const snap = await getDoc(doc(db, "settings", "main"));
    publicSettings = snap.exists() ? snap.data() : { exchangeRateBsPerUsd: 0, pagoMovil: {}, whatsappNumber: "584163557506" };
  }
  return publicSettings;
}

function formatBs(amount) {
  return `Bs ${amount.toLocaleString("es-VE", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function renderBalance(profile) {
  const rate = publicSettings?.exchangeRateBsPerUsd || 0;
  const usd = profile?.walletBalanceUsd || 0;
  document.getElementById("walletBalanceMain").textContent = `$${usd.toFixed(2)}`;
  document.getElementById("walletBalanceAlt").textContent = formatBs(usd * rate);
  window.__gcExchangeRate = rate;
}

async function loadDepositHistory(uid) {
  const list = document.getElementById("depositHistoryList");
  list.innerHTML = "<p style='color:var(--text-muted);'>Cargando...</p>";
  try {
    const q = query(collection(db, "walletDeposits"), where("uid", "==", uid), orderBy("createdAt", "desc"));
    const snap = await getDocs(q);
    if (snap.empty) {
      list.innerHTML = "<p style='color:var(--text-muted);'>Aun no has hecho depositos.</p>";
      return;
    }
    list.innerHTML = snap.docs
      .map((d) => {
        const dep = d.data();
        const fecha = dep.createdAt?.toDate ? dep.createdAt.toDate().toLocaleString("es-VE", { dateStyle: "medium", timeStyle: "short" }) : "";
        const statusLabel = dep.status === "completado" ? "✅ Success" : "Rechazado";
        return `
        <div class="order-card">
          <div>
            <strong>Deposito de $${(dep.amountUsdRequested || 0).toFixed(2)}</strong>
            <div style="color:var(--text-muted); font-size:0.85rem; margin-top:4px;">${fecha}</div>
          </div>
          <div style="text-align:right;">
            <div class="status-pill status-${dep.status}">${statusLabel}</div>
          </div>
        </div>`;
      })
      .join("");
  } catch (err) {
    console.error(err);
    list.innerHTML = "<p style='color:var(--text-muted);'>No se pudo cargar el historial.</p>";
  }
}

onAccountChange(async (user, profile) => {
  if (!user) {
    window.location.href = "login.html";
    return;
  }
  await ensureSettings();
  renderBalance(profile);
  loadDepositHistory(user.uid);
});

// ---------- Modal de deposito ----------
function goToDepStep(stepId) {
  document.querySelectorAll("#depositModalBackdrop .modal-step").forEach((s) => s.classList.remove("active"));
  document.getElementById(stepId).classList.add("active");
}

function resetDepositModal() {
  document.getElementById("dep_amount").value = "";
  document.getElementById("dep_currency").value = "usd";
  document.getElementById("dep_last6").value = "";
  document.getElementById("dep_payerPhone").value = "";
  const txIdEl = document.getElementById("dep_transactionId");
  if (txIdEl) txIdEl.value = "";
  document.getElementById("depStep1Alert").innerHTML = "";
  document.getElementById("depStep2Alert").innerHTML = "";
  document.getElementById("depReceiptBox").innerHTML = "";
  clearInterval(depositTimerInterval);
  goToDepStep("depStep1");
}

document.getElementById("openDepositBtn").addEventListener("click", async () => {
  await ensureSettings();
  resetDepositModal();
  document.getElementById("depositModalBackdrop").classList.add("open");
});
document.getElementById("closeDepositModal").addEventListener("click", () => {
  document.getElementById("depositModalBackdrop").classList.remove("open");
  clearInterval(depositTimerInterval);
});
document.getElementById("backToDepStep1").addEventListener("click", () => {
  clearInterval(depositTimerInterval);
  goToDepStep("depStep1");
});

let depositAmountUsd = 0;
let depositTotalBs = 0;

// Metodo de pago para depositar a la Wallet, segun la moneda elegida:
//  - "bs"  -> Pago Movil (Bs, verificado por Pabilo contra tu banco)
//  - "usd" -> Binance Pay (USDT, verificado por Pabilo contra tu cuenta Binance)
let depositPayMethod = "pago_movil";

document.getElementById("toDepStep2Btn").addEventListener("click", () => {
  const alertBox = document.getElementById("depStep1Alert");
  const rawAmount = parseFloat(document.getElementById("dep_amount").value);
  const currency = document.getElementById("dep_currency").value;
  const rate = publicSettings.exchangeRateBsPerUsd || 0;

  if (!rawAmount || rawAmount <= 0) {
    alertBox.innerHTML = '<div class="alert alert-error">Ingresa un monto valido</div>';
    return;
  }

  depositPayMethod = currency === "bs" ? "pago_movil" : "binance";

  if (depositPayMethod === "pago_movil") {
    if (!rate) {
      alertBox.innerHTML = '<div class="alert alert-error">La tasa de cambio no esta configurada, contacta a soporte.</div>';
      return;
    }
    // El cliente elige en que moneda escribir el monto, pero por dentro
    // SIEMPRE trabajamos en USD (lo que se acredita a la wallet) -- la tasa
    // nunca se muestra como numero, solo se usa para la conversion.
    depositAmountUsd = rawAmount / rate;
    depositTotalBs = depositAmountUsd * rate;
    document.getElementById("depTotalBs").textContent = formatBs(depositTotalBs);
  } else {
    // Binance Pay liquida 1:1 en USDT -- no hay conversion, el monto que
    // escribio el cliente ES el monto en USD/USDT.
    depositAmountUsd = rawAmount;
    depositTotalBs = 0;
    const totalBsEl = document.getElementById("depTotalBs");
    if (totalBsEl) totalBsEl.textContent = `$${depositAmountUsd.toFixed(2)} USDT`;
  }

  renderDepPayDetails();
  toggleDepPaymentFields();
  startDepositTimer();
  goToDepStep("depStep2");
});

// Muestra los campos de verificacion correctos segun el metodo: Pago Movil
// pide "ultimos 6 digitos" + telefono; Binance pide el ID de transaccion.
// NOTA: esto espera un contenedor #dep_binanceFields con un input
// #dep_transactionId en wallet.html (junto a los campos ya existentes de
// Pago Movil, #dep_last6 y #dep_payerPhone). Si todavia no agregaste ese
// bloque al HTML, esto no rompe nada -- simplemente no encuentra el
// elemento y sigue de largo.
function toggleDepPaymentFields() {
  const pagoMovilFields = document.getElementById("dep_pagoMovilFields");
  const binanceFields = document.getElementById("dep_binanceFields");
  if (pagoMovilFields) pagoMovilFields.style.display = depositPayMethod === "pago_movil" ? "block" : "none";
  if (binanceFields) binanceFields.style.display = depositPayMethod === "binance" ? "block" : "none";
}

function depPayRow(label, value) {
  const copyBtn = value ? `<button type="button" class="copy-field-btn" data-copy-value="${value}">Copiar</button>` : "";
  return `<div class="row"><span>${label}:</span><span class="row-value-copy"><strong>${value || "-"}</strong>${copyBtn}</span></div>`;
}

function renderDepPayDetails() {
  const box = document.getElementById("depPayDetailsBox");

  if (depositPayMethod === "binance") {
    const bn = publicSettings.binance || {};
    box.innerHTML = `
      <div class="pay-details">
        ${depPayRow("Binance Pay ID", bn.payId)}
      </div>
      <button type="button" class="btn btn-outline btn-full" style="margin-bottom:16px;" id="depToggleQrBtn">Ver QR</button>
      <div id="depQrBox" style="display:none; position:relative; text-align:center; margin-bottom:16px;">
        <span id="depCloseQrBtn" style="position:absolute; top:-8px; right:-8px; background:var(--bg-surface-2); border:1px solid var(--border-soft); border-radius:50%; width:26px; height:26px; display:flex; align-items:center; justify-content:center; cursor:pointer; font-size:16px;">&times;</span>
        <img src="assets/${bn.qrImage || "binanceqr.png"}" alt="QR Binance Pay" style="max-width:220px; width:100%; border-radius:12px; border:1px solid var(--border-soft);" onerror="this.parentElement.style.display='none';" />
      </div>`;
  } else {
    const pm = publicSettings.pagoMovil || {};
    box.innerHTML = `
      <div class="pay-details">
        ${depPayRow("C.I.", pm.ci)}
        ${depPayRow("Telefono", pm.phone)}
        ${depPayRow("Banco", pm.bank)}
        ${depPayRow("Nro. de cuenta", pm.accountNumber)}
        ${depPayRow("Titular", pm.holderName)}
      </div>
      <button type="button" class="btn btn-outline btn-full" style="margin-bottom:16px;" id="depToggleQrBtn">Ver QR</button>
      <div id="depQrBox" style="display:none; position:relative; text-align:center; margin-bottom:16px;">
        <span id="depCloseQrBtn" style="position:absolute; top:-8px; right:-8px; background:var(--bg-surface-2); border:1px solid var(--border-soft); border-radius:50%; width:26px; height:26px; display:flex; align-items:center; justify-content:center; cursor:pointer; font-size:16px;">&times;</span>
        <img src="assets/pagomovilqr.png" alt="QR Pago Movil" style="max-width:220px; width:100%; border-radius:12px; border:1px solid var(--border-soft);" onerror="this.parentElement.style.display='none';" />
      </div>`;
  }

  box.querySelectorAll(".copy-field-btn").forEach((btn) => {
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
  document.getElementById("depToggleQrBtn").addEventListener("click", () => {
    const qrBox = document.getElementById("depQrBox");
    qrBox.style.display = qrBox.style.display === "none" ? "block" : "none";
  });
  document.getElementById("depCloseQrBtn")?.addEventListener("click", () => {
    document.getElementById("depQrBox").style.display = "none";
  });
}

function startDepositTimer() {
  clearInterval(depositTimerInterval);
  depositExpiresAt = Date.now() + 10 * 60 * 1000;
  const timerEl = document.getElementById("depTimer");
  const verifyBtn = document.getElementById("verifyDepositBtn");
  verifyBtn.disabled = false;
  verifyBtn.textContent = "Verificar pago";

  depositTimerInterval = setInterval(() => {
    const msLeft = depositExpiresAt - Date.now();
    if (msLeft <= 0) {
      clearInterval(depositTimerInterval);
      timerEl.textContent = "00:00";
      document.getElementById("depStep2Alert").innerHTML =
        '<div class="alert alert-error">Se agoto el tiempo para este pago. Vuelve a intentar.</div>';
      verifyBtn.disabled = true;
      return;
    }
    const mins = Math.floor(msLeft / 60000);
    const secs = Math.floor((msLeft % 60000) / 1000);
    timerEl.textContent = `${String(mins).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
  }, 1000);
}

document.getElementById("verifyDepositBtn").addEventListener("click", async () => {
  const alertBox = document.getElementById("depStep2Alert");

  // Cada metodo pide datos distintos: Pago Movil necesita referencia +
  // telefono; Binance solo necesita el ID de transaccion.
  let last6 = "";
  let payerPhone = "";
  let transactionId = "";

  if (depositPayMethod === "pago_movil") {
    last6 = document.getElementById("dep_last6").value.trim();
    payerPhone = document.getElementById("dep_payerPhone").value.trim();
    if (!last6 || !payerPhone) {
      alertBox.innerHTML = '<div class="alert alert-error">Completa la referencia y el telefono</div>';
      return;
    }
  } else {
    transactionId = document.getElementById("dep_transactionId")?.value.trim() || "";
    if (!transactionId) {
      alertBox.innerHTML = '<div class="alert alert-error">Ingresa el ID de la transaccion de Binance Pay</div>';
      return;
    }
  }

  const btn = document.getElementById("verifyDepositBtn");
  btn.disabled = true;
  btn.innerHTML = `<span class="btn-spinner"></span> Verificando pago...`;
  alertBox.innerHTML = "";

  try {
    const idToken = await getCurrentUser().getIdToken();
    const endpoint =
      depositPayMethod === "binance" ? "/.netlify/functions/wallet-verify-binance-deposit" : "/.netlify/functions/wallet-verify-deposit";
    const payload =
      depositPayMethod === "binance"
        ? { amountUsd: depositAmountUsd, transactionId }
        : { amountUsd: depositAmountUsd, bankReference: last6, payerPhone };

    const res = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${idToken}` },
      body: JSON.stringify(payload),
    });
    const data = await res.json();

    if (!data.success) {
      const isInsufficient = data.code === "INSUFFICIENT_AMOUNT";
      const wa = publicSettings.whatsappNumber || "584163557506";
      const supportText = encodeURIComponent(
        `Hola, hice un deposito a mi wallet de GameCenter pero el sistema no pudo procesarlo.\nReferencia: ${last6}\nTelefono: ${payerPhone}`
      );
      alertBox.innerHTML = `
        <div class="alert alert-error">${data.message || "No se pudo verificar el pago"}</div>
        ${
          isInsufficient
            ? `<a href="https://wa.me/${wa}?text=${supportText}" target="_blank" rel="noopener" class="btn btn-outline btn-full" style="margin-top:10px;">💬 Contactar soporte por WhatsApp</a>`
            : ""
        }`;
      btn.disabled = false;
      btn.textContent = "Verificar pago";
      return;
    }

    clearInterval(depositTimerInterval);
    const fecha = new Date(data.date).toLocaleString("es-VE", { dateStyle: "medium", timeStyle: "short" });
    document.getElementById("depReceiptBox").innerHTML = `
      <div class="alert alert-success" style="text-align:center;">✅ <strong>SUCCESS</strong> — Deposito verificado y acreditado</div>
      <div class="pay-details" style="margin-top:10px; border:1px dashed var(--border-soft); border-radius:12px; padding:16px;">
        <div style="text-align:center; margin-bottom:10px;">
          <strong style="font-size:1.05rem;">🧾 Comprobante de deposito</strong>
          <div style="color:var(--text-muted); font-size:0.8rem; margin-top:2px;">${fecha}</div>
        </div>
        <div class="row"><span>Monto depositado:</span><span><strong>$${data.amountUsd.toFixed(2)}</strong></span></div>
        <div class="row"><span>Referencia:</span><span><strong>${data.reference}</strong></span></div>
        <div class="row"><span>Nuevo saldo:</span><span><strong>$${data.newBalanceUsd.toFixed(2)}</strong></span></div>
      </div>
      <button class="btn btn-primary btn-full" id="closeDepReceiptBtn" style="margin-top:14px;">Listo</button>`;
    goToDepStep("depStepDone");

    document.getElementById("closeDepReceiptBtn").addEventListener("click", () => {
      document.getElementById("depositModalBackdrop").classList.remove("open");
      renderBalance({ walletBalanceUsd: data.newBalanceUsd });
      loadDepositHistory(getCurrentUser().uid);
    });
  } catch (err) {
    console.error(err);
    alertBox.innerHTML = '<div class="alert alert-error">Error de conexion. Intenta de nuevo.</div>';
    btn.disabled = false;
    btn.textContent = "Verificar pago";
  }
});