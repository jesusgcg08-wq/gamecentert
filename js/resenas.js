// ============================================================================
// GameCenter — Reseñas (resenas.html)
// Coleccion Firestore "reviews". El ID del documento ES el ID del pedido, asi
// que cada pedido completado solo puede tener UNA reseña (no hay duplicados).
// Campos: userId, userName, userAvatar, orderId, productId, productName,
//         optionLabel, productImage, rating (1-5), comment, createdAt.
// No toca pedidos, wallet ni pagos: solo LEE "orders" para listar las compras
// completadas del cliente y ESCRIBE en "reviews".
// ============================================================================

import { db } from "./firebase-config.js";
import { icon } from "./icons.js";
import {
  collection, query, where, orderBy, limit, getDocs, getCountFromServer,
  doc, setDoc, serverTimestamp,
} from "https://www.gstatic.com/firebasejs/10.14.0/firebase-firestore.js";
import { initAccountMenu, onAccountChange } from "./account-menu.js";

initAccountMenu({ activePage: "resenas" });

const PAGE_SIZE = 8;
const MAX_LOAD = 300;
const MAX_CHARS = 400;
const MIN_CHARS = 5;
const LABELS = ["", "Muy malo", "Malo", "Regular", "Bueno", "Excelente"];
const STAR_PATH = "M12 2.6l2.8 5.9 6.4.9-4.7 4.5 1.2 6.4L12 17.2l-5.7 3.1 1.2-6.4L2.8 9.4l6.4-.9L12 2.6z";
const AVATAR_COLORS = ["#8b5cf6", "#2dd4bf", "#38bdf8", "#f472b6", "#facc15", "#fb923c", "#34d399"];

let user = null;
let profile = null;
let reviews = [];
let counts = [0, 0, 0, 0, 0, 0]; // indice = estrellas
let filter = 0;
let page = 1;
let productsMap = new Map();
let eligiblePromise = null;
let flow = null; // estado del modal

const $ = (id) => document.getElementById(id);
const esc = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

// ---------- Helpers visuales ----------
function star(on, size = 16) {
  return `<svg class="rv-star" width="${size}" height="${size}" viewBox="0 0 24 24" aria-hidden="true"><path d="${STAR_PATH}" fill="${
    on ? "url(#rvGrad)" : "rgba(255,255,255,0.1)"
  }"/></svg>`;
}
function stars(n, size = 16) {
  return `<span class="rv-stars" aria-label="${n} de 5 estrellas">${[1, 2, 3, 4, 5].map((i) => star(i <= n, size)).join("")}</span>`;
}
function initials(name) {
  return (String(name || "?").trim().split(/\s+/).slice(0, 2).map((w) => w[0]).join("") || "?").toUpperCase();
}
function colorFor(name) {
  let h = 0;
  for (const c of String(name || "")) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return AVATAR_COLORS[h % AVATAR_COLORS.length];
}
function avatarHtml(name, url) {
  const ini = esc(initials(name));
  const img = url && /^https?:\/\//i.test(url) ? `<img src="${esc(url)}" alt="" loading="lazy" onerror="this.remove()" />` : "";
  return `<div class="rv-avatar" style="--c:${colorFor(name)}"><span>${ini}</span>${img}<i>${icon("check", "10px")}</i></div>`;
}
function fmtDate(ts) {
  const d = ts?.toDate ? ts.toDate() : ts instanceof Date ? ts : null;
  return d ? d.toLocaleDateString("es-VE", { day: "numeric", month: "short", year: "numeric" }) : "";
}
function orderTotal(o) {
  const usd = o.totalUsd || 0;
  if (o.paymentMethod === "pago_movil" && o.exchangeRateBsPerUsd) {
    return `Bs ${(usd * o.exchangeRateBsPerUsd).toLocaleString("es-VE", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  }
  return `$${usd.toFixed(2)}`;
}
const orderCode = (id) => "#" + String(id).slice(-6).toUpperCase();

// ---------- Carga de datos ----------
async function loadProducts() {
  try {
    const snap = await getDocs(query(collection(db, "products"), where("active", "==", true)));
    snap.docs.forEach((d) => productsMap.set(d.id, d.data()));
  } catch (e) {
    console.warn("No se pudieron cargar los productos", e);
  }
}

async function loadReviews() {
  $("rvGrid").innerHTML = `<div class="rv-empty">Cargando reseñas...</div>`;
  try {
    const snap = await getDocs(query(collection(db, "reviews"), orderBy("createdAt", "desc"), limit(MAX_LOAD)));
    reviews = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
  } catch (e) {
    console.error(e);
    reviews = [];
    $("rvGrid").innerHTML = `<div class="rv-empty">No se pudieron cargar las reseñas. Recarga la pagina.</div>`;
    renderSummary();
    return;
  }
  // Conteos exactos desde el servidor (si falla, se calculan con lo cargado)
  try {
    const res = await Promise.all(
      [1, 2, 3, 4, 5].map((n) => getCountFromServer(query(collection(db, "reviews"), where("rating", "==", n))))
    );
    counts = [0, ...res.map((r) => r.data().count)];
  } catch (e) {
    counts = [0, 0, 0, 0, 0, 0];
    reviews.forEach((r) => { if (r.rating >= 1 && r.rating <= 5) counts[r.rating]++; });
  }
  render();
}

// ---------- Render pagina ----------
function totals() {
  const total = counts.reduce((a, b) => a + b, 0);
  const sum = counts.reduce((a, c, i) => a + c * i, 0);
  return { total, avg: total ? sum / total : 0 };
}

function renderSummary() {
  const { total, avg } = totals();
  $("rvScore").innerHTML = `
    <div class="rv-score-label">Calificacion global</div>
    <div class="rv-score-num">${total ? avg.toFixed(1) : "–"}</div>
    ${stars(Math.round(avg), 22)}
    <div class="rv-score-sub">Basado en ${total} ${total === 1 ? "opinion" : "opiniones"}</div>`;

  $("rvBars").innerHTML = [5, 4, 3, 2, 1]
    .map((n) => {
      const pct = total ? (counts[n] / total) * 100 : 0;
      return `<button type="button" class="rv-bar${filter === n ? " active" : ""}" data-star="${n}" aria-pressed="${filter === n}">
        <span class="rv-bar-n">${n}</span>${star(true, 14)}
        <span class="rv-bar-track"><span style="width:${pct}%"></span></span>
        <span class="rv-bar-c">${counts[n]}</span>
      </button>`;
    })
    .join("");
  $("rvBars").querySelectorAll(".rv-bar").forEach((b) =>
    b.addEventListener("click", () => {
      const n = Number(b.dataset.star);
      filter = filter === n ? 0 : n;
      page = 1;
      render();
    })
  );
}

function filtered() {
  return filter ? reviews.filter((r) => r.rating === filter) : reviews;
}

function reviewCard(r) {
  const prod = [r.productName, r.optionLabel].filter(Boolean).join(" · ");
  const img = r.productImage || productsMap.get(r.productId)?.image || "";
  return `
  <article class="rv-card">
    <div class="rv-card-top">
      ${avatarHtml(r.userName, r.userAvatar)}
      <div class="rv-who">
        <div class="rv-name"><strong>${esc(r.userName || "Cliente")}</strong><span class="rv-badge">${icon("check", "10px")} Verificada</span></div>
        <div class="rv-meta">${fmtDate(r.createdAt)}</div>
      </div>
      ${stars(r.rating, 15)}
    </div>
    <p class="rv-text">${esc(r.comment)}</p>
    ${
      prod
        ? `<div class="rv-card-foot"><span class="rv-foot-label">Compra verificada</span>
        <span class="rv-chip">${img ? `<img src="${esc(img)}" alt="" loading="lazy" onerror="this.remove()" />` : ""}<b>${esc(prod)}</b></span></div>`
        : ""
    }
  </article>`;
}

function pageList(cur, n) {
  if (n <= 7) return Array.from({ length: n }, (_, i) => i + 1);
  const s = new Set([1, n, cur - 1, cur, cur + 1]);
  if (cur <= 3) [2, 3, 4, 5].forEach((x) => s.add(x));
  if (cur >= n - 2) [n - 1, n - 2, n - 3, n - 4].forEach((x) => s.add(x));
  const arr = [...s].filter((x) => x >= 1 && x <= n).sort((a, b) => a - b);
  const out = [];
  arr.forEach((x, i) => {
    if (i && x - arr[i - 1] > 1) out.push("…");
    out.push(x);
  });
  return out;
}

function render() {
  renderSummary();
  const list = filtered();
  const pages = Math.max(1, Math.ceil(list.length / PAGE_SIZE));
  if (page > pages) page = pages;
  const from = (page - 1) * PAGE_SIZE;
  const slice = list.slice(from, from + PAGE_SIZE);

  $("rvCount").innerHTML = list.length
    ? `Mostrando ${from + 1}-${from + slice.length} de ${list.length} opiniones${filter ? ` <span class="rv-filter-chip">${filter} ★ filtrado</span>` : ""}`
    : filter ? `Sin opiniones con ${filter} ★ <span class="rv-filter-chip">${filter} ★ filtrado</span>` : "Todavia no hay opiniones";
  $("rvClear").hidden = !filter;

  $("rvGrid").innerHTML = slice.length
    ? slice.map(reviewCard).join("")
    : `<div class="rv-empty">${filter ? "No hay reseñas con esa calificacion." : "Aun no hay reseñas. ¡Se el primero en opinar!"}</div>`;

  const pager = $("rvPager");
  if (pages <= 1) { pager.innerHTML = ""; return; }
  pager.innerHTML =
    `<button type="button" class="rv-pg" data-p="${page - 1}" ${page === 1 ? "disabled" : ""} aria-label="Anterior">‹</button>` +
    pageList(page, pages)
      .map((p) => (p === "…" ? `<span class="rv-pg-gap">…</span>` : `<button type="button" class="rv-pg${p === page ? " active" : ""}" data-p="${p}">${p}</button>`))
      .join("") +
    `<button type="button" class="rv-pg" data-p="${page + 1}" ${page === pages ? "disabled" : ""} aria-label="Siguiente">›</button>`;
  pager.querySelectorAll("[data-p]").forEach((b) =>
    b.addEventListener("click", () => {
      page = Number(b.dataset.p);
      render();
      $("rvGrid").scrollIntoView({ behavior: "smooth", block: "start" });
    })
  );
}

$("rvClear").addEventListener("click", () => { filter = 0; page = 1; render(); });
$("rvWriteBtn").innerHTML = `${icon("chat", "16px")} Escribir reseña`;
document.querySelector(".rv-shield").innerHTML = icon("lock", "26px");

// ---------- Modal (3 pasos) ----------
const backdrop = $("rvModalBackdrop");
const modal = $("rvModal");

function stepDots(n) {
  return `<div class="rv-dots">${[1, 2, 3].map((i) => `<span class="${i < n ? "done" : i === n ? "now" : ""}"></span>`).join("")}</div>`;
}
function head(title, sub) {
  return `<button type="button" class="rv-x" id="rvClose" aria-label="Cerrar">${icon("close", "16px")}</button>
    <h3>${title}</h3><p class="rv-sub">${sub}</p>`;
}

function openModal() {
  backdrop.classList.add("open");
  document.body.style.overflow = "hidden";
}
function closeModal() {
  backdrop.classList.remove("open");
  document.body.style.overflow = "";
}
backdrop.addEventListener("click", (e) => { if (e.target === backdrop) closeModal(); });
document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeModal(); });

function bindClose() { $("rvClose")?.addEventListener("click", closeModal); }

$("rvWriteBtn").addEventListener("click", () => {
  if (!user) return viewLogin();
  flow = { step: 1, rating: 0, orderId: null, comment: "" };
  eligiblePromise = loadEligible();
  viewRating();
  openModal();
});

function viewLogin() {
  modal.innerHTML = `${head("Escribir reseña", "Inicia sesion para continuar")}
    <div class="rv-center">
      <div class="rv-bigicon">${icon("lock", "28px")}</div>
      <h4>Necesitas una cuenta</h4>
      <p>Para mantener las opiniones reales, solo los clientes con pedidos completados pueden escribir una reseña.</p>
    </div>
    <div class="rv-actions">
      <a class="btn btn-outline" href="register.html">Crear cuenta</a>
      <button type="button" class="btn btn-primary" id="rvGoLogin">Iniciar sesion</button>
    </div>`;
  bindClose();
  $("rvGoLogin").addEventListener("click", () => {
    sessionStorage.setItem("gc_return_to", "resenas.html");
    window.location.href = "login.html";
  });
  openModal();
}

// Paso 1: estrellas
function viewRating() {
  const r = flow.rating;
  modal.innerHTML = `${head("Nueva reseña", "Paso 1 de 3: Tu calificacion")}
    ${stepDots(1)}
    <h4 class="rv-q">¿Que te parecio?</h4>
    <div class="rv-picker" id="rvPicker" role="radiogroup" aria-label="Calificacion">
      ${[1, 2, 3, 4, 5].map((i) => `<button type="button" class="rv-pick" data-v="${i}" role="radio" aria-checked="${i === r}" aria-label="${i} estrellas">${star(i <= r, 40)}</button>`).join("")}
    </div>
    <div class="rv-label-wrap"><span class="rv-label${r ? " on" : ""}" id="rvLabel">${r ? LABELS[r] : "Toca una estrella"}</span></div>
    <div class="rv-actions">
      <button type="button" class="btn btn-outline" id="rvCancel">Cancelar</button>
      <button type="button" class="btn btn-primary" id="rvNext1" ${r ? "" : "disabled"}>Siguiente</button>
    </div>`;
  bindClose();
  // Solo cambia el color (no reemplaza el SVG): si se re-creara el elemento
  // bajo el cursor, el hover se dispararia en bucle y el clic nunca llegaria.
  const paint = (v) => {
    modal.querySelectorAll(".rv-pick").forEach((b) => {
      const i = Number(b.dataset.v);
      b.querySelector("path").setAttribute("fill", i <= v ? "url(#rvGrad)" : "rgba(255,255,255,0.1)");
      b.classList.toggle("lit", i <= v);
    });
  };
  modal.querySelectorAll(".rv-pick").forEach((b) => {
    const v = Number(b.dataset.v);
    b.addEventListener("mouseenter", () => paint(v));
    b.addEventListener("click", () => {
      flow.rating = v;
      paint(v);
      modal.querySelectorAll(".rv-pick").forEach((x) => x.setAttribute("aria-checked", String(Number(x.dataset.v) === v)));
      const lb = $("rvLabel");
      lb.textContent = LABELS[v];
      lb.classList.add("on");
      $("rvNext1").disabled = false;
    });
  });
  $("rvPicker").addEventListener("mouseleave", () => paint(flow.rating));
  $("rvCancel").addEventListener("click", closeModal);
  $("rvNext1").addEventListener("click", () => { flow.step = 2; viewOrders(); });
}

async function loadEligible() {
  const [os, rs] = await Promise.all([
    getDocs(query(collection(db, "orders"), where("userId", "==", user.uid), orderBy("createdAt", "desc"), limit(30))),
    getDocs(query(collection(db, "reviews"), where("userId", "==", user.uid))),
  ]);
  const done = new Set(rs.docs.map((d) => d.id));
  return os.docs
    .map((d) => ({ id: d.id, ...d.data() }))
    .filter((o) => o.status === "completado" && !done.has(o.id))
    .slice(0, 6);
}

// Paso 2: elegir la compra
async function viewOrders() {
  modal.innerHTML = `${head("Vincular compra", "Paso 2 de 3: Selecciona tu compra (ultimas 6)")}
    ${stepDots(2)}
    <div class="rv-loading"><span class="btn-spinner rv-spin"></span> Buscando tus compras...</div>`;
  bindClose();

  let orders;
  try {
    orders = await eligiblePromise;
  } catch (e) {
    console.error(e);
    modal.innerHTML = `${head("Vincular compra", "Paso 2 de 3")}${stepDots(2)}
      <div class="rv-center"><p>No pudimos cargar tus compras. Intenta de nuevo en un momento.</p></div>
      <div class="rv-actions"><button type="button" class="btn btn-outline" id="rvBack2">Atras</button>
      <button type="button" class="btn btn-primary" id="rvRetry">Reintentar</button></div>`;
    bindClose();
    $("rvBack2").addEventListener("click", () => { flow.step = 1; viewRating(); });
    $("rvRetry").addEventListener("click", () => { eligiblePromise = loadEligible(); viewOrders(); });
    return;
  }

  if (!orders.length) {
    modal.innerHTML = `${head("Vincular compra", "Paso 2 de 3")}${stepDots(2)}
      <div class="rv-center">
        <div class="rv-bigicon">${icon("receipt", "28px")}</div>
        <h4>No tienes compras por reseñar</h4>
        <p>Aqui aparecen tus pedidos con estado <strong>Success</strong> que todavia no tienen reseña. Cuando recibas tu proximo pedido podras opinar.</p>
      </div>
      <div class="rv-actions"><button type="button" class="btn btn-outline" id="rvBack2">Atras</button>
      <a class="btn btn-primary" href="catalogo-completo.html">Ver catalogo</a></div>`;
    bindClose();
    $("rvBack2").addEventListener("click", () => { flow.step = 1; viewRating(); });
    return;
  }

  const tiles = orders
    .map((o) => {
      const img = productsMap.get(o.productId)?.image || "";
      const sel = flow.orderId === o.id;
      return `<button type="button" class="rv-order${sel ? " sel" : ""}" data-id="${esc(o.id)}">
        <span class="rv-order-img">${img ? `<img src="${esc(img)}" alt="" onerror="this.remove()" />` : ""}</span>
        <span class="rv-order-info">
          <b>${esc(o.productNameSnapshot || "Producto")}</b>
          <em>${esc(o.optionLabelSnapshot || "")}</em>
          <small>Pedido ${orderCode(o.id)} · ${fmtDate(o.createdAt)}</small>
          <strong>${orderTotal(o)}</strong>
        </span>
        <i class="rv-tick">${icon("check", "12px")}</i>
      </button>`;
    })
    .join("");

  modal.innerHTML = `${head("Vincular compra", "Paso 2 de 3: Selecciona tu compra (ultimas 6)")}
    ${stepDots(2)}
    <p class="rv-hint">Elige el pedido que calificaras para verificar tu reseña:</p>
    <div class="rv-orders">${tiles}</div>
    <div class="rv-actions">
      <button type="button" class="btn btn-outline" id="rvBack2">Atras</button>
      <button type="button" class="btn btn-primary" id="rvNext2" ${flow.orderId ? "" : "disabled"}>Siguiente</button>
    </div>`;
  bindClose();
  modal.querySelectorAll(".rv-order").forEach((b) =>
    b.addEventListener("click", () => {
      flow.orderId = b.dataset.id;
      flow.order = orders.find((o) => o.id === flow.orderId);
      modal.querySelectorAll(".rv-order").forEach((x) => x.classList.toggle("sel", x === b));
      $("rvNext2").disabled = false;
    })
  );
  $("rvBack2").addEventListener("click", () => { flow.step = 1; viewRating(); });
  $("rvNext2").addEventListener("click", () => { flow.step = 3; viewComment(); });
}

// Paso 3: comentario
function viewComment() {
  const o = flow.order;
  const name = [o.productNameSnapshot, o.optionLabelSnapshot].filter(Boolean).join(" · ");
  modal.innerHTML = `${head("Escribe tu comentario", "Paso 3 de 3: Tu opinion nos importa")}
    ${stepDots(3)}
    <div class="rv-recap"><span>${stars(flow.rating, 14)}</span><span class="rv-recap-p">${esc(name)}</span></div>
    <div class="rv-textarea">
      <textarea id="rvText" maxlength="${MAX_CHARS}" rows="5" placeholder="¿Que te parecio la velocidad de entrega, el precio o la atencion?">${esc(flow.comment)}</textarea>
      <small id="rvChars">${flow.comment.length}/${MAX_CHARS}</small>
    </div>
    <div id="rvAlert"></div>
    <div class="rv-actions">
      <button type="button" class="btn btn-outline" id="rvBack3">Atras</button>
      <button type="button" class="btn btn-primary" id="rvSend">Publicar reseña</button>
    </div>`;
  bindClose();
  const ta = $("rvText");
  ta.addEventListener("input", () => {
    flow.comment = ta.value;
    $("rvChars").textContent = `${ta.value.length}/${MAX_CHARS}`;
  });
  $("rvBack3").addEventListener("click", () => { flow.step = 2; viewOrders(); });
  $("rvSend").addEventListener("click", submitReview);
}

async function submitReview() {
  const btn = $("rvSend");
  const alertBox = $("rvAlert");
  const comment = flow.comment.trim().replace(/\n{3,}/g, "\n\n");
  if (comment.length < MIN_CHARS) {
    alertBox.innerHTML = `<div class="alert alert-error">Escribe un comentario de al menos ${MIN_CHARS} caracteres.</div>`;
    return;
  }
  if (!user || !flow.order || !flow.rating) return;

  btn.disabled = true;
  $("rvBack3").disabled = true;
  const label = btn.textContent;
  btn.innerHTML = `<span class="btn-spinner"></span> Publicando...`;
  alertBox.innerHTML = "";

  const o = flow.order;
  const name = String(profile?.name || user.displayName || "Cliente").trim().slice(0, 60);
  const data = {
    userId: user.uid,
    userName: name,
    userAvatar: profile?.avatarUrl || "",
    orderId: o.id,
    productId: o.productId || "",
    productName: o.productNameSnapshot || "",
    optionLabel: o.optionLabelSnapshot || "",
    productImage: productsMap.get(o.productId)?.image || "",
    rating: flow.rating,
    comment: comment.slice(0, MAX_CHARS),
    createdAt: serverTimestamp(),
  };

  try {
    await setDoc(doc(db, "reviews", o.id), data);
    reviews.unshift({ id: o.id, ...data, createdAt: new Date() });
    counts[data.rating]++;
    filter = 0;
    page = 1;
    render();
    viewDone();
  } catch (e) {
    console.error(e);
    const msg =
      e.code === "permission-denied"
        ? "No se pudo publicar. Puede que este pedido ya tenga una reseña o que falten las reglas de Firestore para reseñas."
        : "No se pudo publicar tu reseña, intenta de nuevo.";
    alertBox.innerHTML = `<div class="alert alert-error">${msg}</div>`;
    btn.disabled = false;
    $("rvBack3").disabled = false;
    btn.textContent = label;
  }
}

function viewDone() {
  modal.innerHTML = `${head("¡Gracias!", "Tu reseña ya esta publicada")}
    <div class="rv-center">
      <div class="rv-bigicon ok">${icon("check", "30px")}</div>
      <h4>Reseña publicada</h4>
      <p>Gracias por compartir tu experiencia con la comunidad de GameCenter.</p>
    </div>
    <div class="rv-actions one"><button type="button" class="btn btn-primary" id="rvDone">Listo</button></div>`;
  bindClose();
  $("rvDone").addEventListener("click", () => {
    closeModal();
    $("rvGrid").scrollIntoView({ behavior: "smooth", block: "start" });
  });
}

// ---------- Inicio ----------
onAccountChange((u, p) => {
  user = u;
  profile = p;
});

loadProducts().then(loadReviews);