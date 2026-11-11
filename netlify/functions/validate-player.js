// Verifica el ID del jugador ANTES de pagar (POST /player/validate de Central One).
// Respuesta para el frontend (formato de siempre): { success, data:{player_name} }.
//
// Es publica (se puede verificar sin iniciar sesion), por eso tiene limite de
// intentos por IP: sin limite, alguien podia usarla sin parar y gastar el
// cupo de consultas de Central One, haciendo fallar las recargas reales.
const admin = require("./lib/firebase");
const { validatePlayer } = require("./lib/centralone");
const { textoCorto, ipCliente, dentroDelLimite } = require("./lib/seguridad");

const db = admin.firestore();
const MAX_POR_IP = 30; // verificaciones...
const VENTANA_MS = 10 * 60 * 1000; // ...cada 10 minutos

const reply = (obj, statusCode = 200) => ({ statusCode, body: JSON.stringify(obj) });

exports.handler = async function (event) {
  if (event.httpMethod !== "POST") return reply({ success: false, message: "Metodo no permitido" }, 405);
  let body;
  try { body = JSON.parse(event.body); } catch { return reply({ success: false, message: "Body invalido" }, 400); }

  const subCategoryId = textoCorto(body.sub_category_id, 80);
  const playerId = textoCorto(body.player_id, 60);
  const zoneId = textoCorto(body.zone_id, 30);
  if (!subCategoryId || !playerId || zoneId === null) {
    return reply({ success: false, message: "Faltan datos para verificar el ID" }, 400);
  }
  if (!process.env.CENTRALONE_API_KEY) {
    console.error("[validate-player] falta CENTRALONE_API_KEY");
    return reply({ success: false, message: "No se pudo verificar el ID ahora, intenta mas tarde." }, 500);
  }

  if (!(await dentroDelLimite(db, "vp", ipCliente(event), MAX_POR_IP, VENTANA_MS))) {
    return reply({ success: false, message: "Demasiadas verificaciones seguidas. Espera unos minutos e intenta de nuevo." }, 429);
  }

  try {
    const r = await validatePlayer({ productId: subCategoryId, playerId, zoneId });
    // Queda en la terminal / logs de Netlify para poder ver que respondio Central One.
    console.log(`[validate-player] status=${r.status} reason=${r.reason || "-"} name=${r.name || "-"} msg=${r.message || "-"}`);
    if (r.status === "valid") return reply({ success: true, data: { player_name: r.name || "" } });
    if (r.status === "invalid") return reply({ success: false, error: { code: "PLAYER_NOT_FOUND" } });
    if (r.status === "unverified") {
      // Sin verificacion NO se deja continuar: primero se verifica el ID, despues se cobra.
      return reply({
        success: false,
        message:
          r.reason === "temporarily_unavailable"
            ? "No se pudo comprobar el ID ahora, intenta en unos segundos."
            : "No se puede verificar este juego automaticamente, contactanos para ayudarte.",
      });
    }
    return reply({ success: false, message: r.message || "No se pudo verificar el ID" });
  } catch {
    return reply({ success: false, message: "No se pudo contactar a Central One" }, 502);
  }
};
