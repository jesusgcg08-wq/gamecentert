# GameCenter — gamecentervzla.com

Tienda de recargas de juegos y giftcards. Página estática (HTML + CSS + JS) con
**Firebase** (cuentas y base de datos) y **Netlify Functions** (todo lo que
necesita llaves secretas: pagos, recargas, correos).

No hay servidor propio: Netlify sirve la página y corre las funciones.

## Estructura

```
/                     páginas del sitio (se publican tal cual)
  index.html          inicio (carrusel con hero1–4.mp4)
  catalogo-completo   catálogo de productos
  producto.html       ficha del producto, verificar ID y pagar
  login / register    cuenta del cliente
  dashboard.html      "Mis pedidos"
  wallet.html         saldo del cliente (recargar y pagar con saldo)
  resenas.html        reseñas
  admin.html          panel de administración (solo usuarios con role "admin")
  mantenimiento.html  se muestra cuando el modo mantenimiento está activo
  catalogo.html       catálogo de Central One (página aparte, no enlazada)
  cobertura.json      datos de cobertura de Central One (no lo usa ninguna página)
assets/               logos, QR de pago y videos del carrusel
css/style.css         estilos de todo el sitio
js/                   lógica de cada página
  firebase-config.js  conexión a Firebase (proyecto "gamecenternuevo")
  config.js           sin uso (quedó del backend viejo en Node/Mongo)
netlify/functions/    funciones del servidor (ver abajo)
  lib/                código compartido: Firebase admin, Central One, Pabilo,
                      Binance, Shop2Topup
netlify.toml          configuración de Netlify
```

## Funciones del servidor (`netlify/functions/`)

| Función | Para qué sirve |
|---|---|
| `validate-player` | Verifica el ID del jugador antes de pagar (Central One). |
| `verify-pago-movil-order` + `-background` | Verifica un pago móvil con Pabilo y crea el pedido. La parte lenta corre en segundo plano para no gastar créditos de Pabilo dos veces. |
| `verify-binance-pay-order` | Verifica un pago por Binance y crea el pedido. |
| `wallet-verify-deposit` / `wallet-verify-binance-deposit` | Acredita saldo a la Wallet (pago móvil o Binance). |
| `wallet-pay-order` | Paga un pedido con saldo de la Wallet. |
| `create-centralone-order` | Botón del panel admin: hace la recarga en Central One. |
| `check-centralone-order-status` | Consulta el estado de una recarga (solo el dueño del pedido). |
| `centralone-webhook` | Central One avisa cuando una orden cambia; guarda los códigos. |
| `centralone-voucher-followup-background` | Pregunta a Central One hasta que el código de la giftcard esté listo. |
| `*-shop2topup-*` | Proveedor anterior (Shop2Topup). Central One lo reemplazó; se mantiene por pedidos viejos. |
| `request-password-reset` / `verify-password-reset-code` | "Olvidé mi contraseña" con código por correo (EmailJS). |

Todas las funciones revalidan precios y permisos contra Firestore; nunca confían
en lo que manda el navegador.

## Variables de entorno (en Netlify → Site settings → Environment variables)

Nunca van en el código ni en GitHub.

| Variable | Qué es |
|---|---|
| `FIREBASE_PROJECT_ID`, `FIREBASE_CLIENT_EMAIL`, `FIREBASE_PRIVATE_KEY` | Cuenta de servicio de Firebase (o todo junto en `FIREBASE_SERVICE_ACCOUNT_BASE64`). |
| `CENTRALONE_API_KEY` | Llave de Central One (`co_live_...`). Necesita los permisos catalog:read, orders:read, orders:write y **codes:read**. |
| `CENTRALONE_WEBHOOK_SECRET` (y `_PREVIOUS` al rotarla) | Secreto para validar los webhooks de Central One (`whsec_...`). |
| `PABILO_API_KEY`, `PABILO_USER_BANK_ID`, `PABILO_MOVEMENT_TYPE` | Verificación de pago móvil. |
| `PABILO_BINANCE_USER_BANK_ID`, `PABILO_BINANCE_MOVEMENT_TYPE` | Verificación de pagos Binance vía Pabilo. |
| `PABILO_AMOUNT_TOLERANCE_BS`, `PABILO_BINANCE_AMOUNT_TOLERANCE_USD` | Margen aceptado en el monto (opcional). |
| `BINANCE_API_KEY`, `BINANCE_API_SECRET` | API normal de la cuenta Binance. |
| `EMAILJS_PRIVATE_KEY` | Correo de recuperación de contraseña. |
| `SHOP2TOPUP_API_KEY`, `SHOP2TOPUP_WEBHOOK_SECRET` | Solo para el proveedor anterior. |

## Webhooks a registrar

- Central One → Integración → Webhooks:
  `https://gamecentervzla.com/.netlify/functions/centralone-webhook`

## Probar en la computadora

Necesitas Netlify CLI (`npm install -g netlify-cli`) una sola vez. Luego:

```bash
npm install
netlify dev
```

Abre la dirección que muestra `netlify dev` (normalmente http://localhost:8888).
Usa las mismas variables de entorno que el sitio en Netlify.

## Publicar

El código está en GitHub (`origin`). Después de hacer commit:

```bash
git push
```

Si el sitio de Netlify está conectado al repositorio, publica solo. Si no,
publica a mano con `netlify deploy --prod`.

## Panel de administración

Entra a `/admin.html` con una cuenta cuyo documento `users/{uid}` en Firestore
tenga `role: "admin"`. Desde ahí se manejan productos, cupones, pedidos,
recargas en Central One, tasa de cambio, datos de pago y el modo mantenimiento.
