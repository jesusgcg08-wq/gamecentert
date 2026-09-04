// Netlify Function: intermediario seguro entre el frontend y Shop2Topup.
// La API key vive SOLO aqui (variable de entorno en Netlify), nunca en el
// navegador. El frontend llama a /.netlify/functions/validate-player en
// vez de llamar directo a portal.shop2topup.com.

exports.handler = async function (event) {
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, body: JSON.stringify({ success: false, message: "Metodo no permitido" }) };
  }

  let body;
  try {
    body = JSON.parse(event.body);
  } catch {
    return { statusCode: 400, body: JSON.stringify({ success: false, message: "Body invalido" }) };
  }

  const { sub_category_id, player_id, zone_id } = body;
  if (!sub_category_id || !player_id) {
    return {
      statusCode: 400,
      body: JSON.stringify({ success: false, message: "Faltan sub_category_id o player_id" }),
    };
  }

  const apiKey = process.env.SHOP2TOPUP_API_KEY;
  if (!apiKey) {
    return {
      statusCode: 500,
      body: JSON.stringify({ success: false, message: "Falta configurar SHOP2TOPUP_API_KEY en Netlify" }),
    };
  }

  try {
    const res = await fetch("https://portal.shop2topup.com/api/endpoints/v1/player/validate", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        sub_category_id,
        player_id,
        ...(zone_id ? { zone_id } : {}),
      }),
    });
    const data = await res.json();

    return {
      statusCode: 200,
      body: JSON.stringify(data),
    };
  } catch (err) {
    return {
      statusCode: 502,
      body: JSON.stringify({ success: false, message: "No se pudo contactar a Shop2Topup" }),
    };
  }
};