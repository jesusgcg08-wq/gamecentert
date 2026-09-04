# GameCenter — Guia de instalacion y despliegue

## 0. Importante sobre PHP y Netlify

Me pediste PHP como opcion, pero Netlify **no ejecuta PHP** (solo sirve
archivos estaticos y funciones serverless en Node.js). Como tambien
mencionaste JavaScript como opcion, arme todo el backend en **Node.js +
Express + MongoDB**, que si funciona perfecto con Netlify (el frontend
en Netlify, el backend en otro servicio gratuito compatible, ver paso 3).

Estructura del proyecto:

```
gamecenter/
  backend/     -> API en Node.js + Express + MongoDB (NO va en Netlify)
  frontend/    -> HTML + CSS + JS (esto SI va en Netlify)
```

---

## 1. Crear tu base de datos en MongoDB Atlas (gratis)

1. Entra a https://www.mongodb.com/cloud/atlas/register y crea una cuenta.
2. Crea un cluster gratuito (M0).
3. En "Database Access" crea un usuario con contrasena (guardala).
4. En "Network Access" agrega la IP `0.0.0.0/0` (permitir desde cualquier lugar), asi tu backend puede conectarse desde donde lo despliegues.
5. En "Database" -> "Connect" -> "Drivers", copia la cadena de conexion. Se ve asi:
   ```
   mongodb+srv://usuario:password@cluster0.xxxxx.mongodb.net/?retryWrites=true&w=majority
   ```
6. Agrega el nombre de tu base al final, por ejemplo `.../gamecenter?retryWrites=true...`

---

## 2. Configurar y probar el backend en tu computador

```bash
cd backend
npm install
cp .env.example .env
```

Abre `.env` y coloca:
- `MONGODB_URI`: la cadena que copiaste de Atlas.
- `JWT_SECRET` y `JWT_ADMIN_SECRET`: inventa dos textos largos y aleatorios (diferentes entre si).
- `ADMIN_ACCESS_KEY`: la clave que usaras tu para entrar a `/admin.html`. Nadie mas debe saberla.
- `FRONTEND_URL`: por ahora déjalo como `http://localhost:5500` (o el puerto que uses para abrir el frontend).

Luego:
```bash
npm start
```

Si todo esta bien veras: `Conectado a MongoDB` y `Servidor GameCenter escuchando en puerto 4000`.

---

## 3. Desplegar el backend (Render, gratis)

Netlify no puede correr este backend, asi que lo subimos a Render:

1. Sube la carpeta `backend/` a un repositorio de GitHub.
2. Entra a https://render.com, crea cuenta y elige "New Web Service".
3. Conecta tu repositorio.
4. Build command: `npm install` — Start command: `npm start`
5. En "Environment", agrega las mismas variables de tu `.env` (MONGODB_URI, JWT_SECRET, JWT_ADMIN_SECRET, ADMIN_ACCESS_KEY, FRONTEND_URL: pon aqui la URL que te dara Netlify, ej `https://gamecenter.netlify.app`).
6. Al terminar, Render te da una URL como `https://gamecenter-backend.onrender.com`.

(Railway.app funciona igual de facil si prefieres esa opcion.)

---

## 4. Configurar el frontend

Abre `frontend/js/config.js` y cambia la URL por la de tu backend ya desplegado:

```js
const API_BASE = "https://gamecenter-backend.onrender.com/api";
```

Coloca tus archivos de imagenes/video dentro de `frontend/assets/`:
`hero1.png`, `hero2.png`, `hero3.mp4`, `hero4.mp4`, `binanceqr.png`.

---

## 5. Subir el frontend a Netlify

1. Sube la carpeta `frontend/` a un repositorio de GitHub (o arrastra la carpeta directo en https://app.netlify.com/drop para probar rapido).
2. En Netlify: "Add new site" -> "Import an existing project" -> selecciona el repositorio -> Publish directory: `frontend` (o `.` si subiste solo esa carpeta).
3. Netlify te da una URL, ej `https://gamecenter.netlify.app`.
4. Regresa a Render y actualiza `FRONTEND_URL` con esa URL exacta (esto es importante para que la seguridad CORS deje pasar tus peticiones).

---

## 6. Usar el panel de administracion

Entra a `https://tu-sitio.netlify.app/admin.html`, ingresa la clave que pusiste en `ADMIN_ACCESS_KEY`. Ahi puedes:
- Agregar productos con imagen, categoria, region, varias opciones de recarga y marcar si es evento especial.
- Crear o eliminar cupones de descuento.
- Ver todos los pedidos y cambiar su estado (Recibido / En proceso / Completado / Rechazado) a medida que gestionas la recarga manual por WhatsApp.
- Configurar la tasa de cambio, los datos de Pago Movil, tu Binance ID y el numero de WhatsApp donde te llegan los pedidos.

## 7. Seguridad ya incluida

- Contrasenas de clientes cifradas con bcrypt (nunca se guardan en texto plano).
- Sesiones firmadas con JWT, separadas entre clientes y administrador.
- Limite de intentos de inicio de sesion (rate limiting) contra ataques de fuerza bruta.
- Cabeceras HTTP endurecidas con Helmet.
- CORS restringido solo a tu dominio de Netlify.
- El panel admin no aparece enlazado en ningun lado del sitio publico; solo quien conozca la ruta y la clave puede entrar.

## 8. Recomendaciones extra (opcionales, para mas adelante)

- Cambia `ADMIN_ACCESS_KEY` de vez en cuando.
- Considera agregar HTTPS forzado (Netlify y Render ya lo hacen automatico).
- Cuando quieras agregar mas metodos de pago o mas paises, el codigo ya esta preparado para extenderse en `backend/models/Settings.js` y `backend/routes/settings.js`.
