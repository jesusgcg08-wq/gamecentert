// netlify/functions/lib/wallet.js
// Saldo REAL de la Wallet.
//
// Problema que resuelve: las reglas de Firestore dejan que cada cliente edite
// su propio documento users/{uid}, y el saldo vivia ahi (walletBalanceUsd),
// asi que un cliente podia ponerse el saldo que quisiera y comprar con el.
//
// Ahora el saldo que vale esta en wallets/{uid}, una coleccion que las reglas
// NO dejan leer ni escribir desde el navegador (solo el servidor, con
// firebase-admin). users/{uid}.walletBalanceUsd queda solo como COPIA para
// mostrar en pantalla; si alguien la cambia, solo cambia lo que ve, no lo que
// puede gastar.
//
// Migracion: la primera vez que un cliente usa la wallet despues de este
// cambio, su saldo real se calcula con su historial (depositos completados
// menos compras cobradas con wallet) y se toma el MENOR entre ese calculo y el
// numero que tenia en su perfil. Asi nadie gana saldo por haberlo editado.

const admin = require("./firebase");
const { saldoNumero } = require("./seguridad");

const r2 = (n) => Math.round(n * 100) / 100;

function walletRef(db, uid) {
  return db.collection("wallets").doc(uid);
}

// ¿Este pedido descontó saldo de la wallet? (sirve para pedidos viejos y nuevos)
function pedidoCobrado(o) {
  if (!o || o.paymentMethod !== "wallet") return false;
  if (typeof o.walletCharged === "boolean") return o.walletCharged; // pedidos nuevos
  if (o.autoRecharge) {
    // Codigo viejo: en automaticas solo se cobraba si Central One aceptaba.
    if (o.status === "rechazado") return false;
    if (String(o.adminNote || "").includes("problema al descontar")) return false;
    return true;
  }
  return true; // manuales: se cobraban al crear el pedido
}

// Lee el saldo real DENTRO de una transaccion (llamar antes de cualquier
// escritura de esa transaccion). excluirDepositoId: deposito que se esta
// acreditando en este momento (para no contarlo dos veces).
async function leerSaldo(tx, db, uid, { excluirDepositoId = null } = {}) {
  const snap = await tx.get(walletRef(db, uid));
  if (snap.exists) return { saldo: r2(saldoNumero(snap.data().saldoUsd)), migracion: null };

  const [userSnap, depositos, pedidos] = await Promise.all([
    tx.get(db.collection("users").doc(uid)),
    tx.get(db.collection("walletDeposits").where("uid", "==", uid)),
    tx.get(db.collection("orders").where("userId", "==", uid)),
  ]);

  let entradas = 0;
  depositos.forEach((d) => {
    if (d.id === excluirDepositoId) return;
    const x = d.data();
    if (x.status === "completado") entradas += saldoNumero(x.amountUsdRequested);
  });
  let salidas = 0;
  pedidos.forEach((d) => {
    const x = d.data();
    if (pedidoCobrado(x)) salidas += saldoNumero(x.totalUsd);
  });

  const libro = Math.max(0, r2(entradas - salidas));
  const perfil = userSnap.exists ? Math.max(0, saldoNumero(userSnap.data().walletBalanceUsd)) : 0;
  return {
    saldo: r2(Math.min(perfil, libro)),
    migracion: { saldoPerfil: perfil, saldoHistorial: libro, depositos: r2(entradas), compras: r2(salidas) },
  };
}

// Guarda el saldo real y la copia para mostrar (en la misma transaccion).
function guardarSaldo(tx, db, uid, saldo, migracion) {
  const datos = { saldoUsd: r2(saldo), actualizado: admin.firestore.FieldValue.serverTimestamp() };
  if (migracion) {
    datos.migracion = migracion;
    datos.migradoEn = admin.firestore.FieldValue.serverTimestamp();
  }
  tx.set(walletRef(db, uid), datos, { merge: true });
  tx.set(db.collection("users").doc(uid), { walletBalanceUsd: r2(saldo) }, { merge: true });
}

module.exports = { leerSaldo, guardarSaldo, pedidoCobrado };
