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
 *
 * IMPORTANTE sobre el activo destino: el onramp de Etherfuse entrega uno de
 * SUS stablebonds tokenizados (CETES para MXN, TESOURO para BRL) — no USDC
 * directo. La API rechaza el mint real de USDC en Solana con "Non-stable
 * assets are not supported". Para convertir el stablebond a USDC hace falta
 * un swap aparte (`client.swaps`). Los mints de abajo salen de
 * `client.lookup.stablebonds()` (público, sin API key) y son estables entre
 * corridas; igual, la doc oficial recomienda no hardcodearlos en producción.
 *
 * DISEÑO: ningún paso aborta el script. Cada uno se corre en su propio
 * try/catch; si falla, se registra el error y se sigue con lo que se pueda
 * (los pasos que dependen de un recurso que no se creó se marcan como
 * "saltado", no se intentan). Al final SIEMPRE se imprime un resumen con
 * todo lo que sí se creó — ids, montos, direcciones, códigos, tx — aunque
 * algún paso intermedio haya fallado.
 */

import "dotenv/config";
import { EtherfuseClient, EtherfuseAPIError, Pix, type Quote } from "../src/index";

const API_KEY = process.env.ETHERFUSE_API_KEY;
if (!API_KEY) {
  console.error("Falta ETHERFUSE_API_KEY (ponla en .env o en el entorno). Aborto.");
  process.exit(1);
}

const BLOCKCHAIN = (process.env.ETHERFUSE_BLOCKCHAIN ?? "solana") as never;
/** Mint de Solana del stablebond de Etherfuse, por moneda (ver comentario arriba). */
const DEFAULT_TARGET_ASSET: Record<"BRL" | "MXN", string> = {
  BRL: "EyvBnTz9QDVc2oaBVeu77kndynmD5njrWjZghYh5xpUk", // TESOURO
  MXN: "AvvetPGuuB5FD5m86fpw3LtDKyQoUFT1mG9WarNQLW4q", // CETES
};
// `||` (no `??`): un string vacío en .env también debe caer al default.
const targetAssetFor = (cur: "BRL" | "MXN") =>
  process.env.ETHERFUSE_TARGET_ASSET || DEFAULT_TARGET_ASSET[cur];
const WALLET = process.env.ETHERFUSE_WALLET; // opcional: tu dirección on-chain

const client = new EtherfuseClient({ apiKey: API_KEY, environment: "sandbox" });
client.on("debug", (m) => process.env.DEBUG && console.log(m));

/** Todo lo que se va creando/observando, para el resumen final. Nunca se lanza — solo se llena. */
interface FlowSummary {
  organizationId?: string;
  organizationName?: string;
  bankAccountId?: string;
  bankAccountCurrency?: "BRL" | "MXN";
  bankAccountCompliant?: boolean;
  bankAccountError?: string;
  walletId?: string;
  walletPublicKey?: string;
  walletKycStatus?: string;
  walletError?: string;
  quoteId?: string;
  quoteSourceAmount?: string;
  quoteCurrency?: string;
  quoteDestinationAmount?: string;
  quoteRate?: string;
  quoteTargetAsset?: string;
  quoteError?: string;
  orderId?: string;
  orderDirection?: string;
  orderError?: string;
  depositMethod?: string;
  depositPixCode?: string;
  depositClabe?: string;
  depositBankName?: string;
  fiatReceivedSimulated?: boolean;
  fiatReceivedError?: string;
  finalStatus?: string;
  confirmedTxSignature?: string;
  statusPage?: string;
  waitNote?: string;
}

const summary: FlowSummary = {};

async function main() {
  // ── 1. Organización ────────────────────────────────────────────────────
  let orgId: string | undefined;
  try {
    const me = await client.customers.me();
    orgId = me.id;
    summary.organizationId = me.id;
    summary.organizationName = me.displayName;
    console.log(`✔ Organización: ${me.id} (${me.displayName ?? "sin nombre"})`);
  } catch (error) {
    console.error("✘ No se pudo leer la organización — el resto del flujo depende de esto:", error);
    return; // sin org no hay nada más que intentar
  }

  // ── 2. Cuenta bancaria: reutiliza una compliant o crea una PIX ─────────
  // El sandbox solo permite UNA cuenta BRL por organización.
  let currency: "BRL" | "MXN" = "BRL";
  let bankAccountId: string | undefined;
  try {
    const accounts = await client.bankAccounts.listForCustomer(orgId);
    const usable = (cur: string) =>
      accounts.find((a) => a.currency?.toUpperCase() === cur && a.compliant && !a.raw.deletedAt);

    const existing = usable("BRL") ?? usable("MXN");
    if (existing) {
      currency = existing.isPix ? "BRL" : "MXN";
      bankAccountId = existing.id;
      summary.bankAccountId = existing.id;
      summary.bankAccountCurrency = currency;
      summary.bankAccountCompliant = existing.compliant;
      console.log(`✔ Reutilizando cuenta ${currency} existente: ${existing.id}`);
    } else {
      try {
        const pix = await client.bankAccounts.createPixPersonal(orgId, {
          firstName: "João",
          lastName: "Silva",
          cpf: "12345678909",
          pixKey: "joao.sandbox@exemplo.com.br",
          pixKeyType: "email",
        });
        bankAccountId = pix.id;
        summary.bankAccountId = pix.id;
        summary.bankAccountCurrency = "BRL";
        summary.bankAccountCompliant = pix.compliant;
        console.log(`✔ Cuenta PIX creada: ${pix.id} (compliant: ${pix.compliant})`);
      } catch (error) {
        if (!(error instanceof EtherfuseAPIError)) throw error;
        console.warn(`⚠ PIX no disponible (${error.message}) — probando CLABE/MXN...`);
        currency = "MXN";
        const clabe = await client.bankAccounts.createClabePersonal(orgId, {
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
        summary.bankAccountId = clabe.id;
        summary.bankAccountCurrency = "MXN";
        summary.bankAccountCompliant = clabe.compliant;
        console.log(`✔ Cuenta CLABE creada: ${clabe.id}`);
      }
    }
  } catch (error) {
    summary.bankAccountError = String(error instanceof Error ? error.message : error);
    console.error("✘ No se pudo obtener/crear una cuenta bancaria — sigo sin ella:", error);
  }

  // ── 2b. Wallet: la orden exige publicKey registrada (o cryptoWalletId) ─
  if (WALLET) {
    try {
      const wallets = await client.wallets.listForCustomer(orgId).catch(() => []);
      const registered = wallets.find((w) => w.publicKey === WALLET);
      if (registered) {
        summary.walletId = registered.id;
        summary.walletPublicKey = registered.publicKey;
        summary.walletKycStatus = registered.raw.kycStatus ?? undefined;
        console.log(`✔ Wallet ya registrada: ${registered.id}`);
      } else {
        const wallet = await client.wallets.register({ publicKey: WALLET, blockchain: BLOCKCHAIN });
        summary.walletId = wallet.id;
        summary.walletPublicKey = wallet.publicKey;
        summary.walletKycStatus = wallet.raw.kycStatus ?? undefined;
        console.log(`✔ Wallet registrada: ${wallet.id} (kyc: ${wallet.raw.kycStatus})`);
      }
    } catch (error) {
      summary.walletError = String(error instanceof Error ? error.message : error);
      console.error("✘ No se pudo registrar/leer la wallet — sigo sin ella:", error);
    }
  }

  // ── 3. Quote (expira en 2 minutos) ─────────────────────────────────────
  let quote: Quote | undefined;
  try {
    try {
      quote = await client.quotes.create({
        customerId: orgId,
        blockchain: BLOCKCHAIN,
        sourceAmount: "500",
        quoteAssets: { type: "onramp", sourceAsset: currency, targetAsset: targetAssetFor(currency) },
      });
    } catch (error) {
      if (error instanceof EtherfuseAPIError && error.status === 404 && currency === "BRL") {
        console.warn("⚠ Par BRL no soportado — recotizando en MXN...");
        currency = "MXN";
        quote = await client.quotes.create({
          customerId: orgId,
          blockchain: BLOCKCHAIN,
          sourceAmount: "500",
          quoteAssets: { type: "onramp", sourceAsset: currency, targetAsset: targetAssetFor(currency) },
        });
      } else {
        throw error;
      }
    }
    summary.quoteId = quote.id;
    summary.quoteSourceAmount = "500";
    summary.quoteCurrency = currency;
    summary.quoteDestinationAmount = quote.destinationAmount;
    summary.quoteRate = quote.exchangeRate;
    summary.quoteTargetAsset = targetAssetFor(currency);
    console.log(
      `✔ Quote ${quote.id}: 500 ${currency} → ${quote.destinationAmount} ` +
        `(rate ${quote.exchangeRate}, expira en ${Math.round(quote.expiresIn / 1000)}s)`,
    );
  } catch (error) {
    summary.quoteError = String(error instanceof Error ? error.message : error);
    console.error("✘ No se pudo obtener una quote — sigo sin ella:", error);
  }

  // ── 4. Orden ───────────────────────────────────────────────────────────
  // Necesita quote + cuenta bancaria; si falta cualquiera de las dos, se salta.
  if (!quote) {
    console.log("ℹ Salteo la creación de orden: no hay quote.");
  } else if (!bankAccountId) {
    console.log("ℹ Salteo la creación de orden: no hay cuenta bancaria.");
  } else {
    try {
      const receipt = await quote.createOrder({
        bankAccountId,
        ...(WALLET ? { publicKey: WALLET, blockchain: BLOCKCHAIN } : {}),
      });
      summary.orderId = receipt.orderId;
      summary.orderDirection = receipt.direction;
      console.log(`✔ Orden creada: ${receipt.orderId} (${receipt.direction})`);

      // ── 5. Instrucciones de pago / QR PIX ────────────────────────────
      if (receipt.deposit?.method === "pix") {
        summary.depositMethod = "pix";
        summary.depositPixCode = receipt.deposit.pixCode;
        const qr = receipt.createPixQr()!;
        console.log("✔ Código PIX (copia e cola):", qr.toString());
        console.log(await qr.toTerminal());
      } else if (receipt.deposit?.method === "spei") {
        summary.depositMethod = "spei";
        summary.depositClabe = receipt.deposit.clabe;
        summary.depositBankName = receipt.deposit.bankName;
        console.log("✔ Depósito SPEI:", receipt.deposit);
      } else if (currency === "BRL") {
        // El sandbox no devuelve el BR Code (en producción el pagador lo
        // obtiene vía estas instrucciones / statusPage). Demostramos el QR
        // generándolo localmente con el mismo monto usando el motor PIX:
        console.log("ℹ El sandbox no expone el copia-e-cola; genero un QR PIX local de demo:");
        const demo = Pix.create({
          pixKey: "sandbox@etherfuse.com.br",
          merchantName: "Etherfuse Sandbox",
          merchantCity: "Sao Paulo",
          amount: "500",
          txid: receipt.orderId.replace(/-/g, "").slice(0, 25),
        });
        summary.depositMethod = "pix (demo local)";
        summary.depositPixCode = demo.toString();
        console.log("  copia e cola:", demo.toString());
        console.log(await demo.toTerminal());
      } else {
        console.log("ℹ La respuesta no trajo instrucciones de depósito:", receipt.raw);
      }

      // ── 6. Sandbox: simular que el fiat llegó ────────────────────────
      try {
        await client.sandbox.fiatReceived(receipt.orderId);
        summary.fiatReceivedSimulated = true;
        console.log("✔ Depósito fiat simulado");
      } catch (error) {
        summary.fiatReceivedError = String(error instanceof Error ? error.message : error);
        console.error("✘ No se pudo simular el depósito fiat — sigo igual:", error);
      }

      // ── 7. Esperar a que la orden complete ───────────────────────────
      // La liquidación on-chain requiere que la wallet YA pueda recibir el
      // activo destino: trustline abierta (Stellar) o cuenta de token
      // asociada ya inicializada (Solana). Sin eso la orden queda en
      // "funded" para siempre (el sandbox rechaza el trustline/ATA en tu
      // nombre — nunca manejamos claves privadas). Si usás una wallet
      // nueva/de prueba, es normal no ver "completed"; el resumen final
      // igual muestra todo lo que sí se creó con datos reales.
      try {
        const order = await receipt.fetch();
        const completed = await order.waitForStatus("completed", {
          intervalMs: 5_000,
          timeoutMs: 420_000, // la liquidación on-chain del sandbox puede tardar varios minutos
        });
        summary.finalStatus = completed.status;
        summary.confirmedTxSignature = completed.raw.confirmedTxSignature ?? undefined;
        summary.statusPage = completed.statusPage;
        console.log(`✔ Orden completada. Tx: ${completed.raw.confirmedTxSignature ?? "n/a"}`);
        console.log(`  Página de estado: ${completed.statusPage ?? "n/a"}`);
      } catch {
        const current = await receipt.fetch();
        summary.finalStatus = current.status;
        summary.statusPage = current.statusPage;
        summary.waitNote =
          `no llegó a "completed" — asegurate de que la wallet ya pueda recibir ` +
          `${summary.quoteTargetAsset} (trustline en Stellar / cuenta de token asociada en Solana)`;
        console.log(`ℹ Orden en estado "${current.status}" (no llegó a "completed" en este tiempo).`);
        console.log(`  Wallet destino: ${WALLET ?? "(sin wallet propia registrada)"}`);
        console.log(`  ${summary.waitNote}.`);
        console.log(`  Página de estado: ${current.statusPage ?? "n/a"}`);
      }
    } catch (error) {
      summary.orderError = String(error instanceof Error ? error.message : error);
      console.error("✘ No se pudo crear la orden — sigo sin ella:", error);
    }
  }
}

function printSummary() {
  console.log("\n── Resumen final ───────────────────────────────────────────");
  console.log("Organización:      ", summary.organizationId ?? "n/a", `(${summary.organizationName ?? "sin nombre"})`);
  console.log(
    "Cuenta bancaria:   ",
    summary.bankAccountId ?? `n/a${summary.bankAccountError ? ` — error: ${summary.bankAccountError}` : ""}`,
    summary.bankAccountCurrency ? `(${summary.bankAccountCurrency}, compliant: ${summary.bankAccountCompliant})` : "",
  );
  if (WALLET || summary.walletId) {
    console.log(
      "Wallet:            ",
      summary.walletId ?? `n/a${summary.walletError ? ` — error: ${summary.walletError}` : ""}`,
      summary.walletPublicKey ? `(${summary.walletPublicKey}, kyc: ${summary.walletKycStatus ?? "n/a"})` : "",
    );
  }
  console.log(
    "Quote:             ",
    summary.quoteId ?? `n/a${summary.quoteError ? ` — error: ${summary.quoteError}` : ""}`,
    summary.quoteDestinationAmount
      ? `(${summary.quoteSourceAmount} ${summary.quoteCurrency} → ${summary.quoteDestinationAmount}, rate ${summary.quoteRate})`
      : "",
  );
  console.log("Orden:             ", summary.orderId ?? `n/a${summary.orderError ? ` — error: ${summary.orderError}` : ""}`, summary.orderDirection ?? "");
  if (summary.depositMethod) {
    console.log("Depósito:          ", summary.depositMethod);
    if (summary.depositPixCode) console.log("  PIX copia e cola: ", summary.depositPixCode);
    if (summary.depositClabe) console.log("  CLABE:            ", summary.depositClabe, summary.depositBankName ?? "");
  }
  console.log(
    "Depósito simulado:  ",
    summary.fiatReceivedSimulated ? "sí" : `no${summary.fiatReceivedError ? ` — error: ${summary.fiatReceivedError}` : ""}`,
  );
  console.log("Estado final:      ", summary.finalStatus ?? "n/a");
  console.log("Tx confirmada:     ", summary.confirmedTxSignature ?? "n/a");
  console.log("Página de estado:  ", summary.statusPage ?? "n/a");
  if (summary.waitNote) console.log("Nota:              ", summary.waitNote);
  console.log("─────────────────────────────────────────────────────────────");
}

main()
  .catch((error) => {
    // Nunca debería llegar acá (cada paso atrapa lo suyo) — red de seguridad
    // por si algo inesperado se escapa; igual imprimimos el resumen abajo.
    console.error("\n✘ Error inesperado:", error);
  })
  .finally(() => {
    printSummary();
    client.destroy();
  });
