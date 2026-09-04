// ============================================================================
// GameCenter — Dashboard del cliente (dashboard.html)
// Solo se encarga de los pedidos (coleccion "orders"). Los datos del perfil
// (nombre, correo, telefono, foto, contraseña) ahora se ven/editan desde el
// desplegable de cuenta -> "Info" (ver account-menu.js), asi que aqui no se
// duplica esa logica.
// ============================================================================

import { db } from "./firebase-config.js";
import { collection, query, where, orderBy, onSnapshot } from "https://www.gstatic.com/firebasejs/10.14.0/firebase-firestore.js";
import { initAccountMenu, onAccountChange } from "./account-menu.js";

initAccountMenu({ activePage: "dashboard" });

const STATUS_LABELS = {
  recibido: "Recibido",
  en_proceso: "En proceso",
  completado: "✅ Success",
  rechazado: "Rechazado",
};

const PAYMENT_LABELS = {
  pago_movil: "Pago Movil",
  binance: "Binance Pay",
  wallet: "Wallet",
};

function formatDate(ts) {
  if (!ts || !ts.toDate) return "";
  return ts.toDate().toLocaleString("es-VE", { dateStyle: "medium", timeStyle: "short" });
}

function formatExpiry(dateStr) {
  if (!dateStr) return "";
  const d = new Date(dateStr);
  if (isNaN(d)) return dateStr;
  return d.toLocaleDateString("es-VE", { day: "2-digit", month: "short", year: "numeric" });
}

function formatTotal(order) {
  if (order.paymentMethod === "binance") {
    return `$${(order.totalUsd || 0).toFixed(2)} USDT`;
  }
  if (order.paymentMethod === "wallet") {
    return `$${(order.totalUsd || 0).toFixed(2)}`;
  }
  const rate = order.exchangeRateBsPerUsd || 0;
  return `Bs ${((order.totalUsd || 0) * rate).toLocaleString("es-VE", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

// Estado de "revelado" por voucher, en memoria (se resetea si recargas la
// pagina -- a proposito: es mejor volver a pedir la confirmacion que
// arriesgar a que quede revelado sin querer). Clave: "{orderId}_{indice}".
const voucherRevealState = new Map(); // valor: "hidden" | "confirming" | "revealed"

function voucherStateOf(key) {
  return voucherRevealState.get(key) || "hidden";
}

// Persistencia en localStorage: sin esto, el estado "revelado" vivia solo
// en memoria y se perdia al recargar la pagina (el cliente volvia a ver el
// boton "Mostrar giftcard" aunque ya hubiera visto el codigo antes). Ahora,
// una vez confirmado, queda marcado para siempre en este navegador.
const VOUCHER_STORAGE_KEY = "gc_revealed_vouchers";

function loadRevealedFromStorage() {
  try {
    const raw = localStorage.getItem(VOUCHER_STORAGE_KEY);
    if (!raw) return;
    JSON.parse(raw).forEach((key) => voucherRevealState.set(key, "revealed"));
  } catch {
    // localStorage no disponible (modo privado, etc) -- no pasa nada, solo
    // no persiste entre recargas en ese caso.
  }
}

function persistRevealed(key) {
  try {
    const raw = localStorage.getItem(VOUCHER_STORAGE_KEY);
    const arr = raw ? JSON.parse(raw) : [];
    if (!arr.includes(key)) {
      arr.push(key);
      localStorage.setItem(VOUCHER_STORAGE_KEY, JSON.stringify(arr));
    }
  } catch {
    // idem
  }
}

loadRevealedFromStorage();

// Tarjetitas de giftcard: se muestran solo cuando el pedido ya trae
// "vouchers" (los llena el seguimiento en background o el webhook apenas
// Shop2Topup confirma order.completed). El codigo arranca OCULTO detras de
// un boton -- el cliente tiene que confirmar que entiende que, una vez
// visto el codigo, no aplica reembolso (asi como pasa con cualquier tarjeta
// de regalo: una vez revelada, no hay forma de saber si ya se uso o no).
function renderVouchers(order, orderId) {
  if (!Array.isArray(order.vouchers) || order.vouchers.length === 0) return "";

  const cards = order.vouchers
    .map((v, i) => {
      const key = `${orderId}_${i}`;
      const state = voucherStateOf(key);
      const code = v.code || "";

      if (state === "revealed") {
        const metaLine =
          v.serial_number || v.expiry_date
            ? `<div class="voucher-code-meta">${v.serial_number ? `Serial: ${v.serial_number}` : ""}${
                v.serial_number && v.expiry_date ? " · " : ""
              }${v.expiry_date ? `Vence: ${formatExpiry(v.expiry_date)}` : ""}</div>`
            : "";
        return `
        <div class="voucher-card voucher-revealed">
          <div class="voucher-code-row">
            <div style="min-width:0;">
              <div class="voucher-code-label">🎁 Codigo de tu giftcard</div>
              <div class="voucher-code-value">${code}</div>
              ${metaLine}
            </div>
            <button type="button" class="btn btn-outline btn-sm copy-voucher-btn" data-code="${code}">Copiar</button>
          </div>
        </div>`;
      }

      if (state === "confirming") {
        return `
        <div class="voucher-card voucher-confirm">
          <div class="voucher-confirm-title">⚠️ Antes de ver tu codigo</div>
          <div class="voucher-confirm-text">
            Una vez que reveles el codigo de tu giftcard, <strong>no se puede procesar ningun reembolso</strong>
            sobre este pedido -- no hay forma de verificar si el codigo ya fue usado o no.
          </div>
          <div class="voucher-confirm-actions">
            <button type="button" class="btn btn-primary btn-sm confirm-reveal-btn" data-key="${key}">
              Entiendo, mostrar codigo
            </button>
            <button type="button" class="btn btn-outline btn-sm cancel-reveal-btn" data-key="${key}">
              Cancelar
            </button>
          </div>
        </div>`;
      }

      // hidden (default)
      return `
      <div class="voucher-card voucher-ready">
        <div class="voucher-ready-label">🎁 Tu giftcard ya esta lista</div>
        <button type="button" class="btn btn-primary btn-sm reveal-voucher-btn" data-key="${key}">
          Mostrar giftcard
        </button>
      </div>`;
    })
    .join("");

  return `<div class="voucher-list">${cards}</div>`;
}

function renderOrderCard(o, orderId) {
  const statusLabel = STATUS_LABELS[o.status] || o.status;
  const payLabel = PAYMENT_LABELS[o.paymentMethod] || o.paymentMethod || "-";

  return `
  <div class="order-card" style="flex-direction:column; align-items:stretch;">
    <div style="display:flex; justify-content:space-between; align-items:flex-start; gap:12px; flex-wrap:wrap;">
      <div class="order-info">
        <strong>${o.productNameSnapshot}</strong>
        <span style="color:var(--text-muted); font-weight:500;"> (${o.optionLabelSnapshot})</span>
      </div>
      <div class="status-pill status-${o.status}">${statusLabel}</div>
    </div>
    <div class="order-detail-grid">
      <div>
        <div class="label">Fecha</div>
        <div class="value">${formatDate(o.createdAt)}</div>
      </div>
      <div>
        <div class="label">Metodo de pago</div>
        <div class="value">${payLabel}</div>
      </div>
      ${o.playerGameId ? `<div><div class="label">ID del jugador</div><div class="value">${o.playerGameId}</div></div>` : ""}
      ${o.couponCode ? `<div><div class="label">Cupon</div><div class="value">${o.couponCode} (-${o.discountPercent}%)</div></div>` : ""}
      <div>
        <div class="label">Total pagado</div>
        <div class="value" style="font-family:'Sora',sans-serif; font-weight:700;">${formatTotal(o)}</div>
      </div>
    </div>
    ${renderVouchers(o, orderId)}
  </div>`;
}

// Guarda el ultimo snapshot para poder re-pintar la lista al instante
// cuando el cliente interactua con los botones de revelar/cancelar,  sin
// tener que esperar a un nuevo evento de Firestore (el estado de "revelado"
// es solo local, Firestore nunca se entera de esto).
let lastOrdersSnap = [];

function repaintOrders() {
  const list = document.getElementById("orderList");
  if (!list) return;
  list.innerHTML = lastOrdersSnap.map(({ data, id }) => renderOrderCard(data, id)).join("");
}

// Guarda la funcion para cancelar el listener anterior si el usuario cambia
// (logout/login, cambio de cuenta) para no dejar listeners duplicados vivos.
let unsubscribeOrders = null;

function watchOrders(uid) {
  const list = document.getElementById("orderList");
  list.innerHTML = "<p style='color:var(--text-muted);'>Cargando pedidos...</p>";

  if (unsubscribeOrders) {
    unsubscribeOrders();
    unsubscribeOrders = null;
  }

  const q = query(collection(db, "orders"), where("userId", "==", uid), orderBy("createdAt", "desc"));

  // onSnapshot deja el listener abierto: en cuanto el webhook de
  // Shop2Topup confirme el pedido (o el admin cambie el estado a mano), el
  // dashboard se actualiza solo, sin que el cliente tenga que recargar.
  unsubscribeOrders = onSnapshot(
    q,
    (snap) => {
      if (snap.empty) {
        lastOrdersSnap = [];
        list.innerHTML = "<p style='color:var(--text-muted);'>Aun no tienes pedidos.</p>";
        return;
      }
      lastOrdersSnap = snap.docs.map((d) => ({ data: d.data(), id: d.id }));
      repaintOrders();
    },
    (err) => {
      console.error(err);
      list.innerHTML = "<p style='color:var(--text-muted);'>No se pudieron cargar los pedidos.</p>";
    }
  );
}

// Delegado en el contenedor (no en cada tarjeta, porque se re-renderizan
// completas cada vez que llega un cambio de onSnapshot o el usuario revela
// un codigo).
document.getElementById("orderList")?.addEventListener("click", (e) => {
  const revealBtn = e.target.closest(".reveal-voucher-btn");
  if (revealBtn) {
    voucherRevealState.set(revealBtn.dataset.key, "confirming");
    repaintOrders();
    return;
  }

  const confirmBtn = e.target.closest(".confirm-reveal-btn");
  if (confirmBtn) {
    voucherRevealState.set(confirmBtn.dataset.key, "revealed");
    persistRevealed(confirmBtn.dataset.key);
    repaintOrders();
    return;
  }

  const cancelBtn = e.target.closest(".cancel-reveal-btn");
  if (cancelBtn) {
    voucherRevealState.set(cancelBtn.dataset.key, "hidden");
    repaintOrders();
    return;
  }

  const copyBtn = e.target.closest(".copy-voucher-btn");
  if (copyBtn) {
    const code = copyBtn.dataset.code || "";
    navigator.clipboard
      .writeText(code)
      .then(() => {
        const original = copyBtn.textContent;
        copyBtn.textContent = "✅ Copiado";
        setTimeout(() => {
          copyBtn.textContent = original;
        }, 1500);
      })
      .catch(() => {
        alert(`No se pudo copiar automaticamente. Codigo: ${code}`);
      });
  }
});

onAccountChange((user) => {
  if (!user) {
    if (unsubscribeOrders) {
      unsubscribeOrders();
      unsubscribeOrders = null;
    }
    window.location.href = "login.html";
    return;
  }
  watchOrders(user.uid);
});