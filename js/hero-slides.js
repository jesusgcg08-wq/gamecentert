// ============================================================================
// GameCenter — Slides del carrusel principal
// Los usa el inicio (js/main.js) para pintar el carrusel y el panel (js/admin.js)
// para editarlo.
//
// Se guardan en settings/main.heroSlides (lo edita el admin desde el panel,
// seccion "Carrusel"). Mientras ese campo no exista, se usan los 4 videos de abajo.
//
// Cada slide:
//   src        -> archivo a mostrar: "assets/hero1.mp4" o la foto subida desde el panel
//                 ("/.netlify/functions/carrusel-foto?id=...")
//   poster     -> foto que se ve mientras el video carga (solo videos)
//   photoId    -> id de la foto subida (para borrarla cuando se quita el slide)
//   game       -> texto pequeño de arriba (ej. "Free Fire")
//   title      -> frase grande (ej. "Diamantes en segundos")
//   button     -> texto del boton (vacio = sin boton)
//   productId  -> producto al que lleva el boton
//   find       -> (solo los de fabrica) palabras para encontrar el producto por nombre
//   active     -> false = el slide existe pero no se muestra
// ============================================================================

export const DEFAULT_HERO_SLIDES = [
  { src: "assets/hero1.mp4", poster: "assets/hero1.jpg", game: "Call of Duty Mobile", title: "Tus CP al instante", button: "Recargar ahora", productId: "", find: ["call of duty", "cod mobile", "codm"], active: true },
  { src: "assets/hero2.mp4", poster: "assets/hero2.jpg", game: "Free Fire", title: "Diamantes en segundos", button: "Recargar ahora", productId: "", find: ["free fire"], active: true },
  { src: "assets/hero3.mp4", poster: "assets/hero3.jpg", game: "Blood Strike", title: "Oro y pases sin esperar", button: "Recargar ahora", productId: "", find: ["blood strike"], active: true },
  { src: "assets/hero4.mp4", poster: "assets/hero4.jpg", game: "Clash", title: "Gemas al instante", button: "Recargar ahora", productId: "", find: ["clash royale", "clash of clans", "clash"], active: true },
];

export function isVideo(src) {
  return /\.mp4($|\?)/i.test(src || "");
}

// Slides tal como estan guardados (o los de fabrica si todavia no se ha guardado ninguno)
export function savedHeroSlides(settings) {
  const list = settings && Array.isArray(settings.heroSlides) ? settings.heroSlides : null;
  return (list || DEFAULT_HERO_SLIDES).map((s) => ({ ...s }));
}

// Slides que se muestran en el inicio: solo los activos con archivo.
// Si el admin oculto todos, se vuelve a los de fabrica para que el inicio no quede vacio.
export function visibleHeroSlides(settings) {
  const list = savedHeroSlides(settings).filter((s) => s.active !== false && s.src);
  return list.length ? list : DEFAULT_HERO_SLIDES.map((s) => ({ ...s }));
}
