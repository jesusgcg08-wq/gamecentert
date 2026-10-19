// Verifica el ID del jugador ANTES de pagar (POST /player/validate de Central One).
// Respuesta para el frontend (formato de siempre): { success, data:{player_name} }.
const { validatePlayer } = require("./lib/centralone");

const reply = (obj, statusCode = 200) => ({ statusCode, body: JSON.stringify(obj) });

exports.handler = async function (event) {
  if (event.httpMethod !== "POST") return reply({ success: false, message: "Metodo no permitido" }, 405);
  let body;
  try { body = JSON.parse(event.body); } catch { return reply({ success: false, message: "Body invalido" }, 400); }

  const { sub_category_id, player_id, zone_id } = body;
  if (!sub_category_id || !player_id) return reply({ success: false, message: "Faltan sub_category_id o player_id" }, 400);
  if (!process.env.CENTRALONE_API_KEY) return reply({ success: false, message: "Falta configurar CENTRALONE_API_KEY en Netlify" }, 500);

  try {
    const r = await validatePlayer({ productId: sub_category_id, playerId: player_id, zoneId: zone_id });
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
