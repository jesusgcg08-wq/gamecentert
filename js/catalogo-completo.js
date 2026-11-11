// ============================================================================
// GameCenter — Catalogo completo (catalogo-completo.html)
// Muestra TODOS los productos activos, agrupados por categoria, con filtros
// por categoria y buscador. Solo lectura: no toca ventas ni pedidos.
// ============================================================================

import { db } from "./firebase-config.js";
import { collection, query, where, getDocs, doc, getDoc } from "https://www.gstatic.com/firebasejs/10.14.0/firebase-firestore.js";
import { initAccountMenu } from "./account-menu.js";
import { esc, maxDiscount, sortProducts } from "./catalog-utils.js";
import { icon } from "./icons.js";

initAccountMenu({ activePage: "catalogo" });

const CATEGORIES = [
  { cat: "juegos", a: "Juegos", b: "", color: "#8b5cf6", all: false },
  { cat: "giftcards", a: "Gift", b: "Cards", color: "#38bdf8", all: true },
  { cat: "recargas", a: "Otros", b: "Servicios", color: "#facc15", all: false },
  { cat: "streaming", a: "Streaming", b: "", color: "#f472b6", all: true },
];
const KNOWN = new Set(CATEGORIES.map((c) => c.cat));

let allProducts = [];
let activeCat = "todos";
let searchQuery = new URLSearchParams(location.search).get("q") || "";

const chipsBox = document.getElementById("catChips");
const content = document.getElementById("catContent");
const countBox = document.getElementById("catCount");

function cardHtml(p) {
  const off = maxDiscount(p);
  return `
    <a class="game-card${p.isSpecialEvent ? " is-event" : ""}" href="producto.html?id=${encodeURIComponent(p._id)}">
      <div class="gc-media">
        <img src="${esc(p.image)}" alt="${esc(p.name)}" loading="lazy" />
        ${off ? `<span class="badge-off">-${off}%</span>` : ""}
        ${p.isSpecialEvent ? `<span class="badge-ev">Evento</span>` : ""}
      </div>
      <div class="gc-body">
        <div class="gc-name">${esc(p.name)}</div>
        <div class="gc-region">${esc(p.region || "")}</div>
      </div>
    </a>`;
}

function titleHtml(c, total) {
  const second = c.b ? ` <span style="color:${c.color}">${esc(c.b)}</span>` : "";
  const first = c.all ? `<span style="color:${c.color}">${esc(c.a)}</span>` : `<span>${esc(c.a)}</span>`;
  return `<h2 class="home-title" style="--bar:${c.color};">${first}${second}<small>${total}</small></h2>`;
}

function filtered() {
  const q = searchQuery.trim().toLowerCase();
  if (!q) return allProducts;
  return allProducts.filter((p) => `${p.name || ""} ${p.region || ""}`.toLowerCase().includes(q));
}

function renderChips(list) {
  const counts = { todos: list.length };
  list.forEach((p) => {
    const k = KNOWN.has(p.category) ? p.category : "otros";
    counts[k] = (counts[k] || 0) + 1;
  });
  const chips = [{ id: "todos", label: "Todos" }];
  CATEGORIES.forEach((c) => {
    if (counts[c.cat]) chips.push({ id: c.cat, label: [c.a, c.b].filter(Boolean).join(" ") });
  });
  if (counts.otros) chips.push({ id: "otros", label: "Otros" });
  if (!chips.some((c) => c.id === activeCat)) activeCat = "todos";
  chipsBox.innerHTML = chips
    .map((c) => `<button type="button" class="cat-chip${c.id === activeCat ? " active" : ""}" data-cat="${c.id}" role="tab">${esc(c.label)}<small>${counts[c.id] || 0}</small></button>`)
    .join("");
}

function render() {
  const list = filtered();
  renderChips(list);
  countBox.textContent = `${list.length} producto${list.length === 1 ? "" : "s"}`;

  if (!list.length) {
    content.innerHTML = `<div class="empty-state">${searchQuery.trim() ? "No encontramos productos con ese nombre." : "Pronto habra productos disponibles."}</div>`;
    return;
  }

  const groups = CATEGORIES.map((c) => ({ ...c, items: sortProducts(list.filter((p) => p.category === c.cat)) }));
  const others = sortProducts(list.filter((p) => !KNOWN.has(p.category)));
  if (others.length) groups.push({ cat: "otros", a: "Otros", b: "", color: "#94a3b8", all: false, items: others });

  const visible = groups.filter((g) => g.items.length && (activeCat === "todos" || g.cat === activeCat));
  content.innerHTML = visible
    .map(
      (g) => `
      <section class="cat-section" id="cat-${g.cat}">
        ${titleHtml(g, g.items.length)}
        <div class="search-grid">${g.items.map(cardHtml).join("")}</div>
      </section>`
    )
    .join("");
}

// Al tocar una categoria: logo girando mientras se vuelven a pedir los productos
// (asi siempre se ve lo mas reciente). Minimo 0,5 s para que se alcance a ver.
let chipToken = 0;
chipsBox.addEventListener("click", async (e) => {
  const chip = e.target.closest(".cat-chip");
  if (!chip || chip.classList.contains("active")) return;
  activeCat = chip.dataset.cat;
  chipsBox.querySelectorAll(".cat-chip").forEach((c) => c.classList.toggle("active", c === chip));
  const token = ++chipToken;
  const nombre = chip.childNodes[0]?.textContent?.trim() || "productos";
  content.innerHTML = `
    <div class="gc-grid-loader" role="status">
      <div class="gc-loader-logo gc-loader-logo--sm"><img src="assets/logo-gc-blanco.png" alt="" /></div>
      <div class="gc-loader-text">Cargando <b>${esc(nombre)}</b>…</div>
    </div>`;
  const minimo = new Promise((r) => setTimeout(r, 500));
  try {
    const [snap] = await Promise.all([getDocs(query(collection(db, "products"), where("active", "==", true))), minimo]);
    allProducts = snap.docs.map((d) => ({ _id: d.id, ...d.data() }));
  } catch (err) {
    console.error("No se pudo actualizar el catalogo; se muestra el que ya estaba cargado", err);
    await minimo;
  }
  if (token === chipToken) render(); // si tocaron otra categoria mientras cargaba, gana la ultima
});

window.addEventListener("gc-search", (e) => {
  searchQuery = e.detail?.q || "";
  render();
});

async function load() {
  try {
    const snap = await getDocs(query(collection(db, "products"), where("active", "==", true)));
    allProducts = snap.docs.map((d) => ({ _id: d.id, ...d.data() }));
    render();
  } catch (err) {
    console.error("No se pudo cargar el catalogo", err);
    content.innerHTML = `<div class="empty-state">No se pudo cargar el catalogo. Recarga la pagina.</div>`;
  }
  window.gcLoaderListo?.(); // catalogo en pantalla: quitar el logo girando
  // Boton flotante de WhatsApp (mismo numero configurado en el admin)
  try {
    const s = await getDoc(doc(db, "settings", "main"));
    const wa = (s.exists() && s.data().whatsappNumber) || "584163557506";
    const btn = document.getElementById("floatingWhatsappBtn");
    if (btn) btn.href = `https://wa.me/${wa}?text=${encodeURIComponent("Hola")}`;
  } catch (err) {
    console.error(err);
  }
}

if (searchQuery) {
  const input = document.getElementById("gcSearchInput");
  if (input) input.value = searchQuery;
}
load();
