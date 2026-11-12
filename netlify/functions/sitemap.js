// Netlify Function: mapa del sitio para Google (/sitemap.xml, ver netlify.toml).
// Lista las paginas publicas y cada producto activo, asi Google descubre los
// productos nuevos solo, sin tener que tocar nada.

const admin = require("./lib/firebase");

const db = admin.firestore();
const SITIO = "https://gamecentervzla.com";

const xml = (s) =>
  String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

exports.handler = async function () {
  const urls = [
    { loc: `${SITIO}/`, prioridad: "1.0" },
    { loc: `${SITIO}/catalogo-completo.html`, prioridad: "0.9" },
    { loc: `${SITIO}/recargas-free-fire-venezuela`, prioridad: "0.9" },
    { loc: `${SITIO}/resenas.html`, prioridad: "0.5" },
  ];

  try {
    const snap = await db.collection("products").where("active", "==", true).get();
    snap.forEach((d) => {
      urls.push({ loc: `${SITIO}/producto.html?id=${encodeURIComponent(d.id)}`, prioridad: "0.8" });
    });
  } catch (err) {
    // Si Firestore falla, igual entregamos las paginas fijas
    console.error("sitemap: no se pudieron leer los productos", err);
  }

  const cuerpo =
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n` +
    urls.map((u) => `  <url><loc>${xml(u.loc)}</loc><priority>${u.prioridad}</priority></url>`).join("\n") +
    `\n</urlset>\n`;

  return {
    statusCode: 200,
    headers: {
      "Content-Type": "application/xml; charset=utf-8",
      "Cache-Control": "public, max-age=3600",
    },
    body: cuerpo,
  };
};
