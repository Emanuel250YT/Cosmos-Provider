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
import { EtherfuseClient, EtherfuseAPIError, type Quote } from "../src/index";

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

  // ── 2. Cuenta bancaria (intenta PIX/BRL, cae a CLABE/MXN) ──────────────
  let currency: "BRL" | "MXN" = "BRL";
  let bankAccountId: string;
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
    console.warn(`⚠ PIX no disponible (HTTP ${error.status}) — probando CLABE/MXN...`);
    currency = "MXN";
    const clabe = await client.bankAccounts.createClabePersonal(me.id, {
      firstName: "Ana",
      paternalLastName: "García",
      maternalLastName: "López",
      birthDate: "19900515",
      birthCountryIsoCode: "MX",
      curp: "GALA900515MDFRPN08",
      rfc: "XEXX010101000", // RFC mágico del sandbox: auto-aprueba
      clabe: "646180157000000004",
    });
    bankAccountId = clabe.id;
    console.log(`✔ Cuenta CLABE creada: ${clabe.id}`);
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
  } else if (receipt.deposit) {
    console.log("✔ Depósito SPEI:", receipt.deposit);
  } else {
    console.log("ℹ La respuesta no trajo instrucciones de depósito:", receipt.raw);
  }

  // ── 6. Sandbox: simular que el fiat llegó ──────────────────────────────
  await client.sandbox.fiatReceived(receipt.orderId);
  console.log("✔ Depósito fiat simulado");

  // ── 7. Esperar a que la orden complete ─────────────────────────────────
  const order = await receipt.fetch();
  const completed = await order.waitForStatus("completed", {
    intervalMs: 3_000,
    timeoutMs: 180_000,
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
