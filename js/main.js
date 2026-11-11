// ============================================================================
// GameCenter — Catalogo (index.html), estilo Venium
//  - Carrusel principal (hero1..hero4.mp4)
//  - Boss Deals: opciones en oferta (campo oldPriceUsd > priceUsd)
//  - Secciones por categoria con rail horizontal + "Ver todos"
//  - Buscador de la barra superior
// El flujo de compra ahora vive en producto.html / js/producto.js.
// ============================================================================

import { db } from "./firebase-config.js";
import { collection, query, where, orderBy, limit, getDocs, getCountFromServer, doc, getDoc } from "https://www.gstatic.com/firebasejs/10.14.0/firebase-firestore.js";
import { initAccountMenu, onAccountChange, getDisplayCurrency } from "./account-menu.js";
import { esc, productDeals, maxDiscount, sortProducts, formatDisplay } from "./catalog-utils.js";
import { visibleHeroSlides, isVideo } from "./hero-slides.js";

// ============ Sesion (la maneja account-menu.js) ============
let currentProfile = null;

initAccountMenu({ activePage: "home" });
onAccountChange((user, profile) => {
  currentProfile = profile;
  showWelcomeToast();
});

function showWelcomeToast() {
  if (sessionStorage.getItem("showWelcomeToast") !== "1") return;
  sessionStorage.removeItem("showWelcomeToast");

  const firstName = currentProfile?.name ? currentProfile.name.split(" ")[0] : "";
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

// ============ Carrusel principal ============
// Los slides se editan desde el panel (seccion "Carrusel") y se guardan en
// settings/main.heroSlides; ver js/hero-slides.js. Cada uno lleva foto o video,
// juego, frase y un boton que lleva al producto elegido (o, en los de fabrica,
// al producto que coincida por nombre). Si no encuentra el producto, va al catalogo.
let heroSlides = [];
// Con ahorro de datos o conexion lenta, el carrusel muestra solo fotos (sin videos)
const AHORRO_DATOS = (() => {
  const c = navigator.connection;
  return !!(c && (c.saveData || /(^|-)2g$|^3g$/.test(c.effectiveType || "")));
})();
let heroIndex = 0;
let heroTimer = null;

function initHero(slides) {
  const hero = document.getElementById("hero");
  const track = document.getElementById("heroTrack");
  const dotsBox = document.getElementById("heroDots");
  if (!hero || !track) return;
  heroSlides = slides;
  if (!heroSlides.length) {
    hero.style.display = "none";
    return;
  }

  heroSlides.forEach((s, i) => {
    const slide = document.createElement("div");
    slide.className = "hero-slide";
    if (isVideo(s.src) && !(AHORRO_DATOS && s.poster)) {
      const video = document.createElement("video");
      // El video solo se descarga cuando le toca (preload none); mientras, se ve la foto
      video.src = s.src;
      if (s.poster) video.poster = s.poster;
      video.muted = true;
      video.loop = true;
      video.playsInline = true;
      video.preload = "none";
      slide.appendChild(video);
    } else {
      const img = document.createElement("img");
      img.src = isVideo(s.src) ? s.poster : s.src;
      img.alt = s.title || s.game || "GameCenter";
      if (i > 0) img.loading = "lazy";
      slide.appendChild(img);
    }
    if (s.game || s.title || s.button) {
      slide.classList.add("has-info");
      const info = document.createElement("div");
      info.className = "hero-info";
      info.innerHTML = `
        ${s.game ? `<span class="hero-game">${esc(s.game)}</span>` : ""}
        ${s.title ? `<h2 class="hero-title">${esc(s.title)}</h2>` : ""}
        ${s.button ? `<a class="hero-btn" href="catalogo-completo.html" data-hero="${i}">${esc(s.button)}
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m9 18 6-6-6-6"/></svg>
        </a>` : ""}`;
      // En un slide de los lados, el boton no navega: primero trae ese slide al centro
      info.querySelector(".hero-btn")?.addEventListener("click", (e) => {
        if (i !== heroIndex) e.preventDefault();
      });
      slide.appendChild(info);
    }
    slide.addEventListener("click", () => {
      if (i !== heroIndex) goToHeroSlide(i);
      // Foto sin boton (ej. un flyer con su propio texto): tocarla lleva al producto
      else if (!s.button && s._href) window.location.href = s._href;
    });
    track.appendChild(slide);

    const dot = document.createElement("button");
    dot.type = "button";
    dot.className = "hero-dot";
    dot.setAttribute("aria-label", `Slide ${i + 1}`);
    dot.addEventListener("click", () => goToHeroSlide(i));
    dotsBox.appendChild(dot);
  });

  // Con un solo slide no hacen falta flechas ni puntos
  if (heroSlides.length < 2) {
    hero.classList.add("hero-single");
  }
  document.getElementById("heroPrev")?.addEventListener("click", () => goToHeroSlide((heroIndex - 1 + heroSlides.length) % heroSlides.length));
  document.getElementById("heroNext")?.addEventListener("click", () => goToHeroSlide((heroIndex + 1) % heroSlides.length));
  window.addEventListener("resize", layoutHero);

  goToHeroSlide(0);
}

function layoutHero() {
  const hero = document.getElementById("hero");
  const track = document.getElementById("heroTrack");
  const first = track?.children[0];
  if (!hero || !first) return;
  const gap = parseFloat(getComputedStyle(track).columnGap) || 0;
  const slideW = first.offsetWidth;
  const offset = (hero.clientWidth - slideW) / 2 - heroIndex * (slideW + gap);
  track.style.transform = `translateX(${offset}px)`;
}

function goToHeroSlide(i) {
  const slides = document.querySelectorAll(".hero-slide");
  const dots = document.querySelectorAll(".hero-dot");
  heroIndex = i;
  slides.forEach((s, idx) => {
    const active = idx === i;
    s.classList.toggle("active", active);
    const v = s.querySelector("video");
    if (v) {
      if (active) v.play().catch(() => {});
      else v.pause();
    }
  });
  dots.forEach((d, idx) => d.classList.toggle("active", idx === i));
  layoutHero();
  restartHeroTimer();
}

function restartHeroTimer() {
  clearInterval(heroTimer);
  if (heroSlides.length < 2) return;
  heroTimer = setInterval(() => goToHeroSlide((heroIndex + 1) % heroSlides.length), 6500);
}

// ============ Datos ============
let allProducts = [];
let publicSettings = null;
let searchQuery = "";
const expandedSections = new Set();

async function ensurePublicSettings() {
  if (!publicSettings) {
    try {
      const snap = await getDoc(doc(db, "settings", "main"));
      publicSettings = snap.exists() ? snap.data() : { exchangeRateBsPerUsd: 0, whatsappNumber: "584163557506" };
    } catch (err) {
      console.error(err);
      publicSettings = { exchangeRateBsPerUsd: 0, whatsappNumber: "584163557506" };
    }
    const btn = document.getElementById("floatingWhatsappBtn");
    if (btn) btn.href = `https://wa.me/${publicSettings.whatsappNumber || "584163557506"}?text=${encodeURIComponent("Hola")}`;
  }
  return publicSettings;
}

// Apunta el boton de cada slide a su producto: el elegido en el panel o, en los
// slides de fabrica, el primero cuyo nombre coincida (prefiere la categoria "juegos").
function linkHeroButtons() {
  const juegos = sortProducts(allProducts.filter((p) => p.category === "juegos"));
  const resto = sortProducts(allProducts.filter((p) => p.category !== "juegos"));
  const ordenados = [...juegos, ...resto];
  heroSlides.forEach((s, i) => {
    let p = s.productId ? allProducts.find((x) => x._id === s.productId) : null;
    if (!p && Array.isArray(s.find)) {
      for (const term of s.find) {
        p = ordenados.find((x) => (x.name || "").toLowerCase().includes(term));
        if (p) break;
      }
    }
    s._href = p ? `producto.html?id=${encodeURIComponent(p._id)}` : "";
    const btn = document.querySelector(`.hero-btn[data-hero="${i}"]`);
    if (btn && s._href) btn.href = s._href;
  });
}

async function loadProducts() {
  try {
    await ensurePublicSettings();
    initHero(visibleHeroSlides(publicSettings));
    const snap = await getDocs(query(collection(db, "products"), where("active", "==", true)));
    allProducts = snap.docs.map((d) => ({ _id: d.id, ...d.data() }));
    linkHeroButtons();
    renderHome();
    applySearch();
  } catch (err) {
    console.error("No se pudo cargar el catalogo", err);
    document.getElementById("homeSections").innerHTML = `<div class="empty-state">No se pudo cargar el catalogo. Recarga la pagina.</div>`;
  } finally {
    // Quita la pantalla de carga (logo girando) cuando el catalogo ya esta en pantalla (o si fallo).
    window.gcLoaderListo?.();
  }
}

// ============ Secciones ============
// cat = categoria guardada en Firestore. all=true pinta todo el titulo con el color.
const SECTIONS = [
  { cat: "juegos", id: "juegos", a: "Juegos", b: "", color: "#8b5cf6", all: false },
  { cat: "giftcards", id: "giftcards", a: "Gift", b: "Cards", color: "#38bdf8", all: true },
  { cat: "recargas", id: "servicios", a: "Otros", b: "Servicios", color: "#facc15", all: false },
  { cat: "streaming", id: "streaming", a: "Streaming", b: "", color: "#f472b6", all: true },
];

const ARROW_L = `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="m15 18-6-6 6-6"/></svg>`;
const ARROW_R = `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="m9 18 6-6-6-6"/></svg>`;
const BOLT = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M13 2 3 14h7l-1 8 10-12h-7l1-8Z"/></svg>`;

function sectionTitle(sec) {
  const style = `--bar:${sec.color};`;
  const second = sec.b ? ` <span style="color:${sec.color}">${esc(sec.b)}</span>` : "";
  const first = sec.all ? `<span style="color:${sec.color}">${esc(sec.a)}</span>` : `<span>${esc(sec.a)}</span>`;
  return `<h2 class="home-title" style="${style}">${first}${second}</h2>`;
}

function gameCardHtml(p) {
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

function dealsList() {
  const out = [];
  allProducts.forEach((p) => {
    productDeals(p).forEach((d) => out.push({ p, ...d }));
  });
  // Mayor descuento primero; a igualdad, el orden normal del catalogo
  out.sort((a, b) => b.pct - a.pct || (a.p.position ?? 9999) - (b.p.position ?? 9999));
  return out.slice(0, 24);
}

function dealsRailHtml() {
  const rate = publicSettings?.exchangeRateBsPerUsd || 0;
  const cur = getDisplayCurrency();
  return dealsList()
    .map(
      ({ p, optId, opt, pct }) => `
    <a class="deal-card" href="producto.html?id=${encodeURIComponent(p._id)}&opt=${encodeURIComponent(optId)}">
      <div class="deal-top">
        <img src="${esc(opt.icon || p.image)}" alt="" loading="lazy" />
        <div class="deal-text">
          <div class="deal-game">${esc(p.name)}</div>
          <div class="deal-label">${esc(opt.label)}</div>
        </div>
        <span class="deal-badge">-${pct}%</span>
      </div>
      <div class="deal-price">
        <s>${formatDisplay(Number(opt.oldPriceUsd), rate, cur)}</s>
        <strong>${formatDisplay(Number(opt.priceUsd), rate, cur)}</strong>
      </div>
    </a>`
    )
    .join("");
}

function renderHome() {
  const box = document.getElementById("homeSections");
  if (!box) return;

  const parts = [];

  // --- Boss Deals ---
  if (dealsList().length) {
    parts.push(`
      <section class="home-section" id="sec-deals">
        <div class="home-section-head">
          <h2 class="home-title" style="--bar:var(--cta-grad)"><span>Descuentos de la</span> <span class="deal-word">semana</span><span class="bolt">${BOLT}</span></h2>
          <div class="home-actions">
            <button type="button" class="rail-arrow" data-dir="-1" aria-label="Anterior">${ARROW_L}</button>
            <button type="button" class="rail-arrow" data-dir="1" aria-label="Siguiente">${ARROW_R}</button>
          </div>
        </div>
        <div class="rail" id="dealsRail">${dealsRailHtml()}</div>
      </section>`);
  }

  // --- Una seccion por categoria (solo si tiene productos) ---
  SECTIONS.forEach((sec) => {
    const list = sortProducts(allProducts.filter((p) => p.category === sec.cat));
    if (!list.length) return;
    const expanded = expandedSections.has(sec.id);
    parts.push(`
      <section class="home-section${expanded ? " expanded" : ""}" id="sec-${sec.id}" data-sec="${sec.id}">
        <div class="home-section-head">
          ${sectionTitle(sec)}
          <div class="home-actions">
            <button type="button" class="see-all" data-sec="${sec.id}">${expanded ? "Ver menos" : "Ver todos"}</button>
            <button type="button" class="rail-arrow" data-dir="-1" aria-label="Anterior">${ARROW_L}</button>
            <button type="button" class="rail-arrow" data-dir="1" aria-label="Siguiente">${ARROW_R}</button>
          </div>
        </div>
        <div class="rail">${list.map(gameCardHtml).join("")}</div>
      </section>`);
  });

  box.innerHTML = parts.length ? parts.join("") : `<div class="empty-state">Pronto habra productos disponibles.</div>`;
}

// Flechas y "Ver todos" (delegacion de eventos)
document.getElementById("homeSections")?.addEventListener("click", (e) => {
  const arrow = e.target.closest(".rail-arrow");
  if (arrow) {
    const rail = arrow.closest(".home-section")?.querySelector(".rail");
    if (rail) rail.scrollBy({ left: Number(arrow.dataset.dir) * rail.clientWidth * 0.85, behavior: "smooth" });
    return;
  }
  const seeAll = e.target.closest(".see-all");
  if (seeAll) {
    const id = seeAll.dataset.sec;
    if (expandedSections.has(id)) expandedSections.delete(id);
    else expandedSections.add(id);
    const section = document.getElementById(`sec-${id}`);
    section.classList.toggle("expanded", expandedSections.has(id));
    seeAll.textContent = expandedSections.has(id) ? "Ver menos" : "Ver todos";
    if (!expandedSections.has(id)) section.querySelector(".rail").scrollLeft = 0;
  }
});

// Cambiar moneda (Bs / USD): solo se repintan los precios de Boss Deals
window.addEventListener("gc-currency-change", () => {
  const rail = document.getElementById("dealsRail");
  if (rail) rail.innerHTML = dealsRailHtml();
});

// ============ Busqueda ============
function applySearch() {
  const home = document.getElementById("homeView");
  const view = document.getElementById("searchView");
  if (!home || !view) return;

  const q = searchQuery.trim().toLowerCase();
  if (!q) {
    home.style.display = "";
    view.style.display = "none";
    view.innerHTML = "";
    return;
  }

  const results = sortProducts(
    allProducts.filter((p) => `${p.name || ""} ${p.region || ""}`.toLowerCase().includes(q))
  );
  home.style.display = "none";
  view.style.display = "";
  view.innerHTML = `
    <h2 class="search-head">Resultados para <span>“${esc(searchQuery.trim())}”</span></h2>
    ${results.length ? `<div class="search-grid">${results.map(gameCardHtml).join("")}</div>` : `<div class="empty-state">No encontramos productos con ese nombre.</div>`}`;
}

window.addEventListener("gc-search", (e) => {
  searchQuery = e.detail?.q || "";
  applySearch();
  if (!searchQuery.trim()) layoutHero();
});

// Si llegas desde otra pagina con ?q=texto
const initialQ = new URLSearchParams(location.search).get("q");
if (initialQ) {
  searchQuery = initialQ;
  const input = document.getElementById("gcSearchInput");
  if (input) input.value = initialQ;
}

// Ancla #juegos / #soporte desde la barra
if (location.hash === "#juegos") setTimeout(() => document.getElementById("sec-juegos")?.scrollIntoView({ behavior: "smooth" }), 600);

// ============ Init ============
// El carrusel se arma en loadProducts(), apenas llega la configuracion (trae los slides del panel)
ensurePublicSettings();
// ============ Reseñas recientes en el inicio ============
// Lee la coleccion "reviews" (la misma de resenas.html). Si falla o aun no hay
// reglas de Firestore para leerla, la seccion simplemente no se muestra.
const RV_STAR = "M12 2.6l2.8 5.9 6.4.9-4.7 4.5 1.2 6.4L12 17.2l-5.7 3.1 1.2-6.4L2.8 9.4l6.4-.9L12 2.6z";
const RV_COLORS = ["#8b5cf6", "#2dd4bf", "#38bdf8", "#f472b6", "#facc15", "#fb923c", "#34d399"];
const rvStars = (n, size = 15) =>
  `<span class="rv-stars" aria-label="${n} de 5 estrellas">${[1, 2, 3, 4, 5]
    .map((i) => `<svg class="rv-star" width="${size}" height="${size}" viewBox="0 0 24 24" aria-hidden="true"><path d="${RV_STAR}" fill="${i <= n ? "url(#rvGrad)" : "rgba(255,255,255,0.1)"}"/></svg>`)
    .join("")}</span>`;

function rvCard(r) {
  const name = String(r.userName || "Cliente");
  const ini = esc((name.trim().split(/\s+/).slice(0, 2).map((w) => w[0]).join("") || "?").toUpperCase());
  let h = 0;
  for (const c of name) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  const img = r.userAvatar && /^https?:\/\//i.test(r.userAvatar) ? `<img src="${esc(r.userAvatar)}" alt="" loading="lazy" onerror="this.remove()" />` : "";
  const prod = [r.productName, r.optionLabel].filter(Boolean).join(" · ");
  const d = r.createdAt?.toDate ? r.createdAt.toDate() : null;
  const date = d ? d.toLocaleDateString("es-VE", { day: "numeric", month: "short", year: "numeric" }) : "";
  return `
    <a class="rv-card rv-card-home" href="resenas.html">
      <div class="rv-card-top">
        <div class="rv-avatar" style="--c:${RV_COLORS[h % RV_COLORS.length]}"><span>${ini}</span>${img}</div>
        <div class="rv-who">
          <div class="rv-name"><strong>${esc(name)}</strong></div>
          <div class="rv-meta">${date}</div>
        </div>
      </div>
      ${rvStars(r.rating)}
      <p class="rv-text">${esc(r.comment)}</p>
      ${prod ? `<span class="rv-chip"><b>${esc(prod)}</b></span>` : ""}
    </a>`;
}

async function loadHomeReviews() {
  const box = document.getElementById("homeReviews");
  if (!box) return;
  try {
    const [snap, ...cnt] = await Promise.all([
      getDocs(query(collection(db, "reviews"), orderBy("createdAt", "desc"), limit(10))),
      ...[1, 2, 3, 4, 5].map((n) => getCountFromServer(query(collection(db, "reviews"), where("rating", "==", n)))),
    ]);
    const list = snap.docs.map((d) => d.data());
    if (!list.length) return;
    const counts = cnt.map((c) => c.data().count);
    const total = counts.reduce((a, b) => a + b, 0);
    const avg = total ? counts.reduce((a, c, i) => a + c * (i + 1), 0) / total : 0;

    box.innerHTML = `
      <svg width="0" height="0" style="position:absolute" aria-hidden="true"><defs><linearGradient id="rvGrad" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#8b5cf6"/><stop offset="1" stop-color="#2dd4bf"/></linearGradient></defs></svg>
      <section class="home-section" id="sec-reviews">
        <div class="home-section-head">
          <h2 class="home-title" style="--bar:var(--accent-teal)"><span>Lo que dicen</span> <span style="color:var(--accent-teal)">nuestros clientes</span></h2>
          <div class="home-actions">
            <a href="resenas.html" class="see-all">Ver todas</a>
            <button type="button" class="rail-arrow" data-dir="-1" aria-label="Anterior">${ARROW_L}</button>
            <button type="button" class="rail-arrow" data-dir="1" aria-label="Siguiente">${ARROW_R}</button>
          </div>
        </div>
        <div class="rv-home-score">${rvStars(Math.round(avg), 16)}<strong>${avg.toFixed(1)}</strong><span>· ${total} ${total === 1 ? "opinion verificada" : "opiniones verificadas"}</span></div>
        <div class="rail rv-rail">${list.map(rvCard).join("")}</div>
      </section>`;
    box.addEventListener("click", (e) => {
      const arrow = e.target.closest(".rail-arrow");
      if (!arrow) return;
      const rail = box.querySelector(".rail");
      rail.scrollBy({ left: Number(arrow.dataset.dir) * rail.clientWidth * 0.85, behavior: "smooth" });
    });
  } catch (err) {
    console.warn("No se pudieron cargar las reseñas del inicio", err);
  }
}

loadProducts();
loadHomeReviews();