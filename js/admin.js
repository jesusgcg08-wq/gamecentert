// ============================================================================
// GameCenter — Panel de administracion (admin.html)
//
// RECONSTRUIDO desde cero porque el admin.js original se perdio/sobrescribio.
// Antes de confiar en esto en produccion, revisa el punto marcado con ⚠️.
//
// CONTROL DE ACCESO ADMIN (confirmado con las Firestore Rules reales):
// No existe coleccion "admins" separada. El propio documento en
// users/{uid} tiene un campo "role", y es admin si role == "admin":
//
//   function isAdmin() {
//     return isSignedIn() &&
//       exists(/databases/$(database)/documents/users/$(request.auth.uid)) &&
//       get(/databases/$(database)/documents/users/$(request.auth.uid)).data.role == "admin";
//   }
//
// El campo "role" de un usuario NUNCA se puede cambiar desde el navegador
// (ni el propio usuario ni nadie sin ya ser admin) — segun tus Rules, solo
// se cambia a mano desde la consola de Firebase o por otro admin ya
// existente actualizando ese documento.
//
// ⚠️ ESTRUCTURA DE DATOS
// Los campos de "products", "coupons" y "settings" los deduje de como los
// LEE main.js (js/main.js) y verify-pago-movil-order.js. Si tu version
// anterior de admin.js guardaba algun campo extra que main.js no usa, no
// esta contemplado aqui — dime y lo agrego.
// ============================================================================

import { auth, db } from "./firebase-config.js";
import {
  onAuthStateChanged,
  signInWithEmailAndPassword,
  signOut,
} from "https://www.gstatic.com/firebasejs/10.14.0/firebase-auth.js";
import {
  collection,
  doc,
  getDoc,
  getDocs,
  setDoc,
  addDoc,
  updateDoc,
  deleteDoc,
  query,
  orderBy,
  serverTimestamp,
} from "https://www.gstatic.com/firebasejs/10.14.0/firebase-firestore.js";

const STATUS_LABELS = {
  recibido: "Recibido",
  en_proceso: "En proceso",
  completado: "Completado",
  rechazado: "Rechazado",
};

// ============================================================================
// Acceso (login + verificacion de admin)
// ============================================================================
const accessGate = document.getElementById("accessGate");
const adminShell = document.getElementById("adminShell");
const accessForm = document.getElementById("accessForm");
const accessAlert = document.getElementById("accessAlert");

function showAccessError(msg) {
  accessAlert.innerHTML = `<div class="alert alert-error">${msg}</div>`;
}

async function isAdminUser(uid) {
  try {
    const snap = await getDoc(doc(db, "users", uid));
    return snap.exists() && snap.data().role === "admin";
  } catch (err) {
    console.error("No se pudo verificar permisos de admin", err);
    return false;
  }
}

accessForm?.addEventListener("submit", async (e) => {
  e.preventDefault();
  accessAlert.innerHTML = "";
  const email = document.getElementById("accessEmail").value.trim();
  const password = document.getElementById("accessKey").value;
  const submitBtn = accessForm.querySelector('button[type="submit"]');
  submitBtn.disabled = true;

  try {
    await signInWithEmailAndPassword(auth, email, password);
    // onAuthStateChanged de abajo se encarga de validar admin y mostrar el panel
  } catch (err) {
    console.error(err);
    showAccessError("Correo o contrasena incorrectos.");
    submitBtn.disabled = false;
  }
});

let panelInitialized = false;

onAuthStateChanged(auth, async (user) => {
  if (!user) {
    accessGate.style.display = "flex";
    adminShell.style.display = "none";
    return;
  }

  const ok = await isAdminUser(user.uid);
  if (!ok) {
    showAccessError("Esta cuenta no tiene permisos de administrador.");
    await signOut(auth);
    accessGate.style.display = "flex";
    adminShell.style.display = "none";
    return;
  }

  accessGate.style.display = "none";
  adminShell.style.display = "flex";

  if (!panelInitialized) {
    panelInitialized = true;
    setupProductFormToggles();
    loadProducts();
    loadCoupons();
    loadOrders();
    loadSettings();
  }
});

document.getElementById("adminLogout")?.addEventListener("click", async () => {
  await signOut(auth);
  window.location.reload();
});

// ============================================================================
// Navegacion entre paneles (sidebar)
// ============================================================================
document.querySelectorAll(".admin-nav-item[data-panel]").forEach((item) => {
  item.addEventListener("click", () => {
    document.querySelectorAll(".admin-nav-item[data-panel]").forEach((i) => i.classList.remove("active"));
    document.querySelectorAll(".admin-panel").forEach((p) => p.classList.remove("active"));
    item.classList.add("active");
    document.getElementById(`panel-${item.dataset.panel}`)?.classList.add("active");
  });
});

// ============================================================================
// PRODUCTOS
// ============================================================================
let allProductsAdmin = [];
let optionRows = [];
let isNewProductForm = true;

// Cuando el producto es Giftcard: no necesita ID de jugador ni zona (son
// codigos genericos, no atados a una cuenta), y siempre es recarga
// automatica (el codigo se entrega solo cuando Shop2Topup confirma). Se
// ocultan esos campos para no confundir al admin con cosas que no aplican.
function applyGiftcardMode(isGiftcard) {
  document.getElementById("giftcardNotice").style.display = isGiftcard ? "block" : "none";
  document.getElementById("requiresIdToggleRow").style.display = isGiftcard ? "none" : "flex";
  document.getElementById("requiresZoneIdToggleRow").style.display = isGiftcard ? "none" : "flex";
  document.getElementById("autoRechargeToggleRow").style.display = isGiftcard ? "none" : "flex";

  if (isGiftcard) {
    // Se ocultan y se limpian: un producto giftcard nunca pide ID/zona.
    document.getElementById("p_requiresId").checked = false;
    document.getElementById("p_requiresZoneId").checked = false;
    document.getElementById("requiresIdLabelBox").style.display = "none";
    document.getElementById("subCategoryIdBox").style.display = "none";
    document.getElementById("requiresZoneIdLabelBox").style.display = "none";
    // Forzado a automatica (oculto), y su campo extra tampoco aplica.
    document.getElementById("p_autoRecharge").checked = true;
    document.getElementById("extraFieldBox").style.display = "none";
  }
}

function nextPositionForCategory(category) {
  const positions = allProductsAdmin
    .filter((p) => p.category === category)
    .map((p) => (typeof p.position === "number" ? p.position : 0));
  return positions.length ? Math.max(...positions) + 1 : 1;
}

function setupProductFormToggles() {
  document.getElementById("p_isEvent")?.addEventListener("change", (e) => {
    document.getElementById("eventDescBox").style.display = e.target.checked ? "block" : "none";
  });
  document.getElementById("p_category")?.addEventListener("change", (e) => {
    applyGiftcardMode(e.target.value === "giftcards");
    if (isNewProductForm) {
      document.getElementById("p_position").value = nextPositionForCategory(e.target.value);
    }
  });
  document.getElementById("p_requiresId")?.addEventListener("change", (e) => {
    const show = e.target.checked;
    document.getElementById("requiresIdLabelBox").style.display = show ? "block" : "none";
    document.getElementById("subCategoryIdBox").style.display = show ? "block" : "none";
  });
  document.getElementById("p_requiresZoneId")?.addEventListener("change", (e) => {
    document.getElementById("requiresZoneIdLabelBox").style.display = e.target.checked ? "block" : "none";
  });
  document.getElementById("p_autoRecharge")?.addEventListener("change", (e) => {
    document.getElementById("extraFieldBox").style.display = e.target.checked ? "block" : "none";
  });
  document.getElementById("addOptionBtn")?.addEventListener("click", () => addOptionRow());
}

function addOptionRow(opt = null) {
  optionRows.push(
    opt || {
      id: `opt_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      label: "",
      priceUsd: "",
      order: optionRows.length
        ? Math.max(...optionRows.map((o) => (typeof o.order === "number" ? o.order : 0))) + 1
        : 1,
      icon: "",
      shop2topupItemId: "",
    }
  );
  renderOptionsBox();
}

function removeOptionRow(id) {
  optionRows = optionRows.filter((o) => o.id !== id);
  renderOptionsBox();
}

function renderOptionsBox() {
  const box = document.getElementById("optionsBox");
  if (!optionRows.length) {
    box.innerHTML = `<p style="color:var(--text-muted); font-size:0.82rem;">Aun no hay opciones. Usa "+ Agregar opcion".</p>`;
    return;
  }

  box.innerHTML = optionRows
    .map(
      (o) => `
    <div class="field-row option-row" data-id="${o.id}" style="align-items:flex-end; margin-bottom:8px;">
      <div class="field"><label>Nombre</label><input type="text" class="opt-label" value="${o.label || ""}" placeholder="Ej: 100 diamantes" /></div>
      <div class="field"><label>Precio (USD)</label><input type="number" step="0.01" class="opt-price" value="${o.priceUsd ?? ""}" /></div>
      <div class="field" style="max-width:90px;"><label>Pos.</label><input type="number" step="1" class="opt-order" value="${typeof o.order === "number" ? o.order : ""}" placeholder="1" /></div>
      <div class="field"><label>Icono (URL, opcional)</label><input type="text" class="opt-icon" value="${o.icon || ""}" /></div>
      <div class="field"><label>Shop2Topup item ID (si es auto)</label><input type="text" class="opt-s2t" value="${o.shop2topupItemId || ""}" /></div>
      <button type="button" class="btn btn-outline btn-sm remove-option-btn">Quitar</button>
    </div>`
    )
    .join("");

  box.querySelectorAll(".option-row").forEach((row) => {
    const id = row.dataset.id;
    row.querySelector(".opt-label").addEventListener("input", (e) => updateOptionField(id, "label", e.target.value));
    row.querySelector(".opt-price").addEventListener("input", (e) => updateOptionField(id, "priceUsd", e.target.value));
    row.querySelector(".opt-order").addEventListener("input", (e) => updateOptionField(id, "order", e.target.value));
    row.querySelector(".opt-icon").addEventListener("input", (e) => updateOptionField(id, "icon", e.target.value));
    row.querySelector(".opt-s2t").addEventListener("input", (e) => updateOptionField(id, "shop2topupItemId", e.target.value));
    row.querySelector(".remove-option-btn").addEventListener("click", () => removeOptionRow(id));
  });
}

function updateOptionField(id, field, value) {
  const opt = optionRows.find((o) => o.id === id);
  if (opt) opt[field] = value;
}

document.getElementById("newProductBtn")?.addEventListener("click", () => openProductForm(null));
document.getElementById("cancelProductBtn")?.addEventListener("click", () => {
  document.getElementById("productFormBox").style.display = "none";
});

function openProductForm(product) {
  isNewProductForm = !product;
  document.getElementById("productFormAlert").innerHTML = "";
  document.getElementById("productFormTitle").textContent = product ? "Editar producto" : "Nuevo producto";
  document.getElementById("productId").value = product ? product._id : "";
  document.getElementById("p_name").value = product?.name || "";
  document.getElementById("p_category").value = product?.category || "juegos";
  document.getElementById("p_region").value = product?.region || "";
  document.getElementById("p_position").value = product
    ? typeof product.position === "number"
      ? product.position
      : ""
    : nextPositionForCategory(document.getElementById("p_category").value);
  document.getElementById("p_imageUrl").value = product?.image || "";
  document.getElementById("p_description").value = product?.description || "";

  document.getElementById("p_isEvent").checked = !!product?.isSpecialEvent;
  document.getElementById("eventDescBox").style.display = product?.isSpecialEvent ? "block" : "none";
  document.getElementById("p_eventDescription").value = product?.eventDescription || "";

  document.getElementById("p_requiresId").checked = !!product?.requiresId;
  document.getElementById("requiresIdLabelBox").style.display = product?.requiresId ? "block" : "none";
  document.getElementById("subCategoryIdBox").style.display = product?.requiresId ? "block" : "none";
  document.getElementById("p_requiresIdLabel").value = product?.requiresIdLabel || "";
  document.getElementById("p_subCategoryId").value = product?.shop2topupSubCategoryId || "";

  document.getElementById("p_requiresZoneId").checked = !!product?.requiresZoneId;
  document.getElementById("requiresZoneIdLabelBox").style.display = product?.requiresZoneId ? "block" : "none";
  document.getElementById("p_requiresZoneIdLabel").value = product?.requiresZoneIdLabel || "";

  document.getElementById("p_autoRecharge").checked = !!product?.autoRecharge;
  document.getElementById("extraFieldBox").style.display = product?.autoRecharge ? "block" : "none";
  document.getElementById("p_extraFieldName").value = product?.extraField?.fieldName || "";
  document.getElementById("p_extraFieldLabel").value = product?.extraField?.fieldLabel || "";
  document.getElementById("p_extraFieldOptions").value = (product?.extraField?.options || []).join(",");

  optionRows = product?.options
    ? Object.entries(product.options)
        .map(([id, o]) => ({ id, ...o }))
        .sort((a, b) => (typeof a.order === "number" ? a.order : 9999) - (typeof b.order === "number" ? b.order : 9999))
    : [];
  renderOptionsBox();

  applyGiftcardMode(document.getElementById("p_category").value === "giftcards");

  const formBox = document.getElementById("productFormBox");
  formBox.style.display = "block";
  formBox.scrollIntoView({ behavior: "smooth" });
}

document.getElementById("saveProductBtn")?.addEventListener("click", async () => {
  const alertBox = document.getElementById("productFormAlert");
  alertBox.innerHTML = "";

  const name = document.getElementById("p_name").value.trim();
  const imageUrl = document.getElementById("p_imageUrl").value.trim();
  if (!name || !imageUrl) {
    alertBox.innerHTML = '<div class="alert alert-error">Nombre e imagen son obligatorios</div>';
    return;
  }
  if (!optionRows.length) {
    alertBox.innerHTML = '<div class="alert alert-error">Agrega al menos una opcion de recarga</div>';
    return;
  }

  for (const o of optionRows) {
    if (!o.label || o.priceUsd === "" || o.priceUsd === null || o.priceUsd === undefined) {
      alertBox.innerHTML = '<div class="alert alert-error">Completa nombre y precio de todas las opciones</div>';
      return;
    }
  }

  const options = {};
  optionRows.forEach((o, index) => {
    const orderValue = o.order === "" || o.order === null || o.order === undefined ? index : parseInt(o.order, 10);
    options[o.id] = {
      label: String(o.label).trim(),
      priceUsd: parseFloat(o.priceUsd),
      order: Number.isFinite(orderValue) ? orderValue : index,
      ...(o.icon ? { icon: String(o.icon).trim() } : {}),
      ...(o.shop2topupItemId ? { shop2topupItemId: String(o.shop2topupItemId).trim() } : {}),
    };
  });

  const isEvent = document.getElementById("p_isEvent").checked;
  const requiresId = document.getElementById("p_requiresId").checked;
  const requiresZoneId = document.getElementById("p_requiresZoneId").checked;
  const autoRecharge = document.getElementById("p_autoRecharge").checked;
  const extraFieldName = document.getElementById("p_extraFieldName").value.trim();

  const productData = {
    name,
    category: document.getElementById("p_category").value,
    region: document.getElementById("p_region").value.trim(),
    position: (() => {
      const raw = document.getElementById("p_position").value;
      return raw === "" ? 9999 : parseInt(raw, 10);
    })(),
    image: imageUrl,
    description: document.getElementById("p_description").value.trim(),
    options,
    isSpecialEvent: isEvent,
    eventDescription: isEvent ? document.getElementById("p_eventDescription").value.trim() : "",
    requiresId,
    requiresIdLabel: requiresId ? document.getElementById("p_requiresIdLabel").value.trim() : "",
    shop2topupSubCategoryId: requiresId ? document.getElementById("p_subCategoryId").value.trim() || null : null,
    requiresZoneId,
    requiresZoneIdLabel: requiresZoneId ? document.getElementById("p_requiresZoneIdLabel").value.trim() : "",
    autoRecharge,
    extraField: extraFieldName
      ? {
          fieldName: extraFieldName,
          fieldLabel: document.getElementById("p_extraFieldLabel").value.trim(),
          options: document
            .getElementById("p_extraFieldOptions")
            .value.split(",")
            .map((s) => s.trim())
            .filter(Boolean),
        }
      : null,
    active: true,
  };

  const productId = document.getElementById("productId").value;

  try {
    if (productId) {
      await updateDoc(doc(db, "products", productId), productData);
    } else {
      await addDoc(collection(db, "products"), productData);
    }
    document.getElementById("productFormBox").style.display = "none";
    loadProducts();
  } catch (err) {
    console.error(err);
    alertBox.innerHTML = '<div class="alert alert-error">No se pudo guardar el producto</div>';
  }
});

async function loadProducts() {
  const tbody = document.getElementById("productsTableBody");
  tbody.innerHTML = `<tr><td colspan="9">Cargando...</td></tr>`;
  try {
    const snap = await getDocs(collection(db, "products"));
    allProductsAdmin = snap.docs.map((d) => ({ _id: d.id, ...d.data() }));
    renderProductsTable();
  } catch (err) {
    console.error(err);
    tbody.innerHTML = `<tr><td colspan="9">No se pudieron cargar los productos.</td></tr>`;
  }
}

function renderProductsTable() {
  const tbody = document.getElementById("productsTableBody");
  if (!allProductsAdmin.length) {
    tbody.innerHTML = `<tr><td colspan="9">No hay productos todavia.</td></tr>`;
    return;
  }

  const sorted = [...allProductsAdmin].sort((a, b) => {
    const catDiff = (a.category || "").localeCompare(b.category || "");
    if (catDiff !== 0) return catDiff;
    const posA = typeof a.position === "number" ? a.position : 9999;
    const posB = typeof b.position === "number" ? b.position : 9999;
    return posA - posB;
  });

  tbody.innerHTML = sorted
    .map((p) => {
      const optionsText = Object.values(p.options || {})
        .map((o) => `${o.label} ($${o.priceUsd})`)
        .join(", ");
      return `
      <tr>
        <td><img src="${p.image}" alt="" style="width:40px; height:40px; object-fit:cover; border-radius:6px;" /></td>
        <td>${p.name}</td>
        <td>${p.category}</td>
        <td>${p.region || "-"}</td>
        <td>${typeof p.position === "number" ? p.position : "-"}</td>
        <td style="max-width:220px; font-size:0.8rem;">${optionsText}</td>
        <td>${p.isSpecialEvent ? "Si" : "No"}</td>
        <td>${p.requiresId ? "Si" : "No"}</td>
        <td>
          <button class="btn btn-outline btn-sm edit-product-btn" data-id="${p._id}">Editar</button>
          <button class="btn btn-outline btn-sm delete-product-btn" data-id="${p._id}" style="color:var(--danger);">Eliminar</button>
        </td>
      </tr>`;
    })
    .join("");

  tbody.querySelectorAll(".edit-product-btn").forEach((btn) =>
    btn.addEventListener("click", () => openProductForm(allProductsAdmin.find((p) => p._id === btn.dataset.id)))
  );
  tbody.querySelectorAll(".delete-product-btn").forEach((btn) =>
    btn.addEventListener("click", async () => {
      if (!confirm("¿Eliminar este producto? Esta accion no se puede deshacer.")) return;
      try {
        await deleteDoc(doc(db, "products", btn.dataset.id));
        loadProducts();
      } catch (err) {
        console.error(err);
        alert("No se pudo eliminar el producto");
      }
    })
  );
}

// ============================================================================
// CUPONES
// ============================================================================
document.getElementById("createCouponBtn")?.addEventListener("click", async () => {
  const alertBox = document.getElementById("couponAlert");
  alertBox.innerHTML = "";
  const code = document.getElementById("c_code").value.trim().toUpperCase();
  const discount = parseFloat(document.getElementById("c_discount").value);
  const usesPerAccount = parseInt(document.getElementById("c_usesPerAccount").value, 10) || 1;

  if (!code || !discount || discount < 1 || discount > 100) {
    alertBox.innerHTML = '<div class="alert alert-error">Completa un codigo y un descuento valido (1-100)</div>';
    return;
  }

  try {
    await setDoc(doc(db, "coupons", code), {
      discountPercent: discount,
      usesPerAccount,
      active: true,
      createdAt: serverTimestamp(),
    });
    document.getElementById("c_code").value = "";
    document.getElementById("c_discount").value = "";
    document.getElementById("c_usesPerAccount").value = "1";
    loadCoupons();
  } catch (err) {
    console.error(err);
    alertBox.innerHTML = '<div class="alert alert-error">No se pudo crear el cupon</div>';
  }
});

async function loadCoupons() {
  const tbody = document.getElementById("couponsTableBody");
  tbody.innerHTML = `<tr><td colspan="5">Cargando...</td></tr>`;
  try {
    const snap = await getDocs(collection(db, "coupons"));
    if (snap.empty) {
      tbody.innerHTML = `<tr><td colspan="5">No hay cupones todavia.</td></tr>`;
      return;
    }
    tbody.innerHTML = snap.docs
      .map((d) => {
        const c = d.data();
        return `
        <tr>
          <td>${d.id}</td>
          <td>${c.discountPercent}%</td>
          <td>${c.usesPerAccount || 1}</td>
          <td>${c.active ? "Activo" : "Inactivo"}</td>
          <td><button class="btn btn-outline btn-sm toggle-coupon-btn" data-id="${d.id}" data-active="${c.active}">${c.active ? "Desactivar" : "Activar"}</button></td>
        </tr>`;
      })
      .join("");

    tbody.querySelectorAll(".toggle-coupon-btn").forEach((btn) =>
      btn.addEventListener("click", async () => {
        const isActive = btn.dataset.active === "true";
        try {
          await updateDoc(doc(db, "coupons", btn.dataset.id), { active: !isActive });
          loadCoupons();
        } catch (err) {
          console.error(err);
          alert("No se pudo actualizar el cupon");
        }
      })
    );
  } catch (err) {
    console.error(err);
    tbody.innerHTML = `<tr><td colspan="5">No se pudieron cargar los cupones.</td></tr>`;
  }
}

// ============================================================================
// PEDIDOS
// ============================================================================
let allOrdersAdmin = [];

async function loadOrders() {
  const tbody = document.getElementById("ordersTableBody");
  tbody.innerHTML = `<tr><td colspan="7">Cargando...</td></tr>`;
  try {
    const q = query(collection(db, "orders"), orderBy("createdAt", "desc"));
    const snap = await getDocs(q);
    if (snap.empty) {
      tbody.innerHTML = `<tr><td colspan="7">No hay pedidos todavia.</td></tr>`;
      return;
    }
    allOrdersAdmin = snap.docs.map((d) => ({ _id: d.id, ...d.data() }));

    // Trae el nombre de cada cliente una sola vez por uid
    const uniqueUids = [...new Set(allOrdersAdmin.map((o) => o.userId))];
    const profiles = {};
    await Promise.all(
      uniqueUids.map(async (uid) => {
        try {
          const s = await getDoc(doc(db, "users", uid));
          profiles[uid] = s.exists() ? s.data() : null;
        } catch {
          profiles[uid] = null;
        }
      })
    );

    renderOrdersTable(profiles);
  } catch (err) {
    console.error(err);
    tbody.innerHTML = `<tr><td colspan="7">No se pudieron cargar los pedidos.</td></tr>`;
  }
}

function renderOrdersTable(profiles) {
  const tbody = document.getElementById("ordersTableBody");

  tbody.innerHTML = allOrdersAdmin
    .map((o) => {
      const profile = profiles[o.userId];
      const proof =
        o.paymentMethod === "binance"
          ? `ID Tx: ${o.paymentProof?.transactionId || "-"}`
          : `Ref: ${o.paymentProof?.last6 || "-"} (Tel: ${o.paymentProof?.payerPhone || "-"})`;
      const total =
        o.paymentMethod === "binance"
          ? `$${(o.totalUsd || 0).toFixed(2)} USDT`
          : `Bs ${((o.totalUsd || 0) * (o.exchangeRateBsPerUsd || 0)).toLocaleString("es-VE", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

      const isFinal = o.status === "completado" || o.status === "rechazado";
      const actionsHtml = isFinal
        ? ""
        : `<div style="margin-top:6px; display:flex; gap:6px; flex-wrap:wrap;">
            ${
              o.shop2topupItemId
                ? `<button class="btn btn-primary btn-sm s2t-btn" data-id="${o._id}">Completar (Shop2Topup)</button>`
                : ""
            }
            <button class="btn btn-outline btn-sm complete-btn" data-id="${o._id}">Completado</button>
            <button class="btn btn-outline btn-sm reject-btn" data-id="${o._id}" style="color:var(--danger);">Rechazado</button>
          </div>`;

      // adminNote es donde verify-pago-movil-order.js / verify-binance-pay-order.js
      // guardan la razon REAL que dio Shop2Topup cuando la recarga/giftcard
      // falla (sin stock, precio cambio, etc) -- antes no se mostraba en
      // ningun lado del panel, asi que habia que adivinar. requiresRefundReview
      // marca que el pago ya esta cobrado y hace falta coordinar reembolso o
      // entrega manual con el cliente.
      const noteHtml = o.adminNote
        ? `<div style="margin-top:6px; font-size:0.76rem; color:${o.requiresRefundReview ? "var(--danger)" : "var(--text-muted)"}; max-width:260px;">
            ${o.requiresRefundReview ? "⚠️ " : ""}${o.adminNote}
          </div>`
        : "";

      return `
      <tr>
        <td>${profile ? profile.name : o.userId}</td>
        <td>${o.productNameSnapshot} (${o.optionLabelSnapshot})</td>
        <td>${o.playerGameId || "-"}</td>
        <td>${o.paymentMethod === "binance" ? "Binance" : "Pago Movil"}</td>
        <td style="font-size:0.8rem;">${proof}</td>
        <td>${total}</td>
        <td>
          <div class="status-pill status-${o.status}">${STATUS_LABELS[o.status] || o.status}</div>
          ${actionsHtml}
          ${noteHtml}
        </td>
      </tr>`;
    })
    .join("");

  tbody.querySelectorAll(".s2t-btn").forEach((btn) =>
    btn.addEventListener("click", () => handleOrderAction(allOrdersAdmin.find((o) => o._id === btn.dataset.id), "completar_shop2topup"))
  );
  tbody.querySelectorAll(".complete-btn").forEach((btn) =>
    btn.addEventListener("click", () => handleOrderAction(allOrdersAdmin.find((o) => o._id === btn.dataset.id), "completado_manual"))
  );
  tbody.querySelectorAll(".reject-btn").forEach((btn) =>
    btn.addEventListener("click", () => handleOrderAction(allOrdersAdmin.find((o) => o._id === btn.dataset.id), "rechazado"))
  );
}

async function handleOrderAction(order, action) {
  if (!order) return;

  if (action === "rechazado") {
    if (!confirm("¿Marcar este pedido como rechazado?")) return;
    try {
      await updateDoc(doc(db, "orders", order._id), { status: "rechazado" });
      loadOrders();
    } catch (err) {
      console.error(err);
      alert("No se pudo actualizar el pedido");
    }
    return;
  }

  if (action === "completado_manual") {
    if (!confirm("¿Confirmas que ya realizaste esta recarga manualmente?")) return;
    try {
      await updateDoc(doc(db, "orders", order._id), { status: "completado" });
      loadOrders();
    } catch (err) {
      console.error(err);
      alert("No se pudo actualizar el pedido");
    }
    return;
  }

  if (action === "completar_shop2topup") {
    if (!confirm("Esto va a ejecutar la recarga automatica en Shop2Topup. ¿Continuar?")) return;
    try {
      // create-shop2topup-order.js ahora exige sesion de admin, asi que hay
      // que mandar el token de Firebase igual que en el resto del sitio.
      const idToken = await auth.currentUser.getIdToken();
      const res = await fetch("/.netlify/functions/create-shop2topup-order", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${idToken}`,
        },
        body: JSON.stringify({
          orderId: order._id,
          subCategoryId: order.shop2topupItemId,
          playerId: order.playerGameId,
          extraFieldName: order.extraFieldName,
          extraFieldValue: order.extraFieldValue,
        }),
      });
      const data = await res.json();
      if (!data.success) {
        alert(data.message || "No se pudo completar la recarga en Shop2Topup");
        return;
      }
      await updateDoc(doc(db, "orders", order._id), {
        status: data.order.internal_status,
        shop2topupOrderId: data.order.order_id,
        shop2topupStatus: data.order.status,
      });
      loadOrders();
    } catch (err) {
      console.error(err);
      alert("No se pudo contactar la funcion de Shop2Topup");
    }
  }
}

// ============================================================================
// CONFIGURACION
// ============================================================================
async function loadSettings() {
  try {
    const snap = await getDoc(doc(db, "settings", "main"));
    const s = snap.exists() ? snap.data() : {};
    document.getElementById("s_rate").value = s.exchangeRateBsPerUsd || "";
    document.getElementById("s_ci").value = s.pagoMovil?.ci || "";
    document.getElementById("s_phone").value = s.pagoMovil?.phone || "";
    document.getElementById("s_bank").value = s.pagoMovil?.bank || "";
    document.getElementById("s_account").value = s.pagoMovil?.accountNumber || "";
    document.getElementById("s_holder").value = s.pagoMovil?.holderName || "";
    document.getElementById("s_binanceId").value = s.binance?.payId || "";
    document.getElementById("s_whatsapp").value = s.whatsappNumber || "";
  } catch (err) {
    console.error(err);
  }
}

document.getElementById("saveSettingsBtn")?.addEventListener("click", async () => {
  const alertBox = document.getElementById("settingsAlert");
  alertBox.innerHTML = "";

  const data = {
    exchangeRateBsPerUsd: parseFloat(document.getElementById("s_rate").value) || 0,
    pagoMovil: {
      ci: document.getElementById("s_ci").value.trim(),
      phone: document.getElementById("s_phone").value.trim(),
      bank: document.getElementById("s_bank").value.trim(),
      accountNumber: document.getElementById("s_account").value.trim(),
      holderName: document.getElementById("s_holder").value.trim(),
    },
    binance: {
      payId: document.getElementById("s_binanceId").value.trim(),
    },
    whatsappNumber: document.getElementById("s_whatsapp").value.trim(),
  };

  try {
    await setDoc(doc(db, "settings", "main"), data, { merge: true });
    alertBox.innerHTML = '<div class="alert alert-success">Configuracion guardada</div>';
  } catch (err) {
    console.error(err);
    alertBox.innerHTML = '<div class="alert alert-error">No se pudo guardar la configuracion</div>';
  }
});