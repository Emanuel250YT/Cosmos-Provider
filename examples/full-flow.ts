/**
 * Flujo completo contra el sandbox de Etherfuse:
 *
 *   organización → cuenta bancaria PIX (BRL) → quote → orden → QR PIX
 *   → simular depósito fiat → esperar a "completed"
 *
 * Preparación:
 *   1. Crea un .env en la raíz con:  ETHERFUSE_API_KEY=tu_key_de_sandbox
 *   2. (Opcional) ETHERFUSE_TARGET_ASSET, ETHERFUSE_BLOCKCHAIN, ETHERFUSE_WALLET
 *   3. Ejecuta:  npm run flow
 *
 * Si tu cuenta sandbox no tiene BRL habilitado, el script cae a MXN/SPEI
 * automáticamente para completar el flujo.
 */

import "dotenv/config";
import { EtherfuseClient, EtherfuseAPIError, Pix, type Quote } from "../src/index";

const API_KEY = process.env.ETHERFUSE_API_KEY;
if (!API_KEY) {
  console.error("Falta ETHERFUSE_API_KEY (ponla en .env o en el entorno). Aborto.");
  process.exit(1);
}

const BLOCKCHAIN = (process.env.ETHERFUSE_BLOCKCHAIN ?? "solana") as never;
const TARGET_ASSET =
  process.env.ETHERFUSE_TARGET_ASSET ?? "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"; // USDC (Solana)
const WALLET = process.env.ETHERFUSE_WALLET; // opcional: tu dirección on-chain

const client = new EtherfuseClient({ apiKey: API_KEY, environment: "sandbox" });
client.on("debug", (m) => process.env.DEBUG && console.log(m));

async function main() {
  // ── 1. Organización ────────────────────────────────────────────────────
  const me = await client.customers.me();
  console.log(`✔ Organización: ${me.id} (${me.displayName ?? "sin nombre"})`);

  // ── 2. Cuenta bancaria: reutiliza una compliant o crea una PIX ─────────
  // El sandbox solo permite UNA cuenta BRL por organización.
  let currency: "BRL" | "MXN" = "BRL";
  let bankAccountId: string;

  const accounts = await client.bankAccounts.listForCustomer(me.id);
  const usable = (cur: string) =>
    accounts.find(
      (a) => a.currency?.toUpperCase() === cur && a.compliant && !a.raw.deletedAt,
    );

  const existing = usable("BRL") ?? usable("MXN");
  if (existing) {
    currency = existing.isPix ? "BRL" : "MXN";
    bankAccountId = existing.id;
    console.log(`✔ Reutilizando cuenta ${currency} existente: ${existing.id}`);
  } else {
    try {
      const pix = await client.bankAccounts.createPixPersonal(me.id, {
        firstName: "João",
        lastName: "Silva",
        cpf: "12345678909",
        pixKey: "joao.sandbox@exemplo.com.br",
        pixKeyType: "email",
      });
      bankAccountId = pix.id;
      console.log(`✔ Cuenta PIX creada: ${pix.id} (compliant: ${pix.compliant})`);
    } catch (error) {
      if (!(error instanceof EtherfuseAPIError)) throw error;
      console.warn(`⚠ PIX no disponible (${error.message}) — probando CLABE/MXN...`);
      currency = "MXN";
      const clabe = await client.bankAccounts.createClabePersonal(me.id, {
        firstName: "Ana",
        paternalLastName: "García",
        maternalLastName: "López",
        birthDate: "19900515",
        birthCountryIsoCode: "MX",
        curp: "GALA900515MDFRPN08",
        rfc: "XEXX010101000", // RFC mágico del sandbox: auto-aprueba
        clabe: "012180015700000000", // CLABE de ejemplo no-STP (el sandbox rechaza 646)
      });
      bankAccountId = clabe.id;
      console.log(`✔ Cuenta CLABE creada: ${clabe.id}`);
    }
  }

  // ── 2b. Wallet: la orden exige publicKey registrada (o cryptoWalletId) ─
  if (WALLET) {
    const wallets = await client.wallets.listForCustomer(me.id).catch(() => []);
    const registered = wallets.find((w) => w.publicKey === WALLET);
    if (registered) {
      console.log(`✔ Wallet ya registrada: ${registered.id}`);
    } else {
      const wallet = await client.wallets.register({
        publicKey: WALLET,
        blockchain: BLOCKCHAIN,
      });
      console.log(`✔ Wallet registrada: ${wallet.id} (kyc: ${wallet.raw.kycStatus})`);
    }
  }

  // ── 3. Quote (expira en 2 minutos) ─────────────────────────────────────
  let quote: Quote;
  try {
    quote = await client.quotes.create({
      customerId: me.id,
      blockchain: BLOCKCHAIN,
      sourceAmount: "500",
      quoteAssets: { type: "onramp", sourceAsset: currency, targetAsset: TARGET_ASSET },
    });
  } catch (error) {
    if (error instanceof EtherfuseAPIError && error.status === 404 && currency === "BRL") {
      console.warn("⚠ Par BRL no soportado — recotizando en MXN...");
      currency = "MXN";
      quote = await client.quotes.create({
        customerId: me.id,
        blockchain: BLOCKCHAIN,
        sourceAmount: "500",
        quoteAssets: { type: "onramp", sourceAsset: currency, targetAsset: TARGET_ASSET },
      });
    } else {
      throw error;
    }
  }
  console.log(
    `✔ Quote ${quote.id}: 500 ${currency} → ${quote.destinationAmount} ` +
      `(rate ${quote.exchangeRate}, expira en ${Math.round(quote.expiresIn / 1000)}s)`,
  );

  // ── 4. Orden ───────────────────────────────────────────────────────────
  const receipt = await quote.createOrder({
    bankAccountId,
    ...(WALLET ? { publicKey: WALLET, blockchain: BLOCKCHAIN } : {}),
  });
  console.log(`✔ Orden creada: ${receipt.orderId} (${receipt.direction})`);

  // ── 5. Instrucciones de pago / QR PIX ──────────────────────────────────
  if (receipt.deposit?.method === "pix") {
    const qr = receipt.createPixQr()!;
    console.log("✔ Código PIX (copia e cola):", qr.toString());
    console.log(await qr.toTerminal());
  } else if (receipt.deposit?.method === "spei") {
    console.log("✔ Depósito SPEI:", receipt.deposit);
  } else if (currency === "BRL") {
    // El sandbox no devuelve el BR Code (en producción el pagador lo obtiene
    // vía estas instrucciones / statusPage). Demostramos el QR generándolo
    // localmente con el mismo monto usando el motor PIX de la librería:
    console.log("ℹ El sandbox no expone el copia-e-cola; genero un QR PIX local de demo:");
    const demo = Pix.create({
      pixKey: "sandbox@etherfuse.com.br",
      merchantName: "Etherfuse Sandbox",
      merchantCity: "Sao Paulo",
      amount: "500",
      txid: receipt.orderId.replace(/-/g, "").slice(0, 25),
    });
    console.log("  copia e cola:", demo.toString());
    console.log(await demo.toTerminal());
  } else {
    console.log("ℹ La respuesta no trajo instrucciones de depósito:", receipt.raw);
  }

  // ── 6. Sandbox: simular que el fiat llegó ──────────────────────────────
  await client.sandbox.fiatReceived(receipt.orderId);
  console.log("✔ Depósito fiat simulado");

  // ── 7. Esperar a que la orden complete ─────────────────────────────────
  const order = await receipt.fetch();
  const completed = await order.waitForStatus("completed", {
    intervalMs: 5_000,
    timeoutMs: 420_000, // la liquidación on-chain del sandbox puede tardar varios minutos
  });
  console.log(`✔ Orden completada. Tx: ${completed.raw.confirmedTxSignature ?? "n/a"}`);
  console.log(`  Página de estado: ${completed.statusPage ?? "n/a"}`);
}

main()
  .then(() => {
    console.log("\n✅ Flujo completo OK");
    client.destroy();
  })
  .catch((error) => {
    console.error("\n❌ El flujo falló:", error);
    client.destroy();
    process.exit(1);
  });
