/**
 * Flujo completo contra el sandbox real de Koywe: descubrimiento de rieles
 * de pago → quote on-ramp (ARS → USDC en Stellar) → orden con dirección
 * Stellar real (generada y fondeada acá mismo) → instrucciones de depósito
 * → chequeo de estado sin bloquear → un vistazo rápido al lado off-ramp
 * (cuenta bancaria + quote) y al KYC delegado.
 *
 * Preparación: `KOYWE_CLIENT_ID` / `KOYWE_SECRET` en `.env` (sandbox:
 * https://api-sandbox.koywe.com, pedilos en https://docs-crypto.koywe.com).
 * Ejecutá `npm run flow:koywe`. Sin credenciales, el script avisa y termina
 * — no hay nada más que mostrar sin ellas.
 *
 * DISEÑO (igual que examples/full-flow.ts):
 * - Cada sección (on-ramp, off-ramp, KYC) corre en su propio try/catch: si
 *   una falla (p. ej. el sandbox no tiene el número de cuenta bancaria de
 *   prueba que probamos), se anota el error y se sigue con la siguiente
 *   sección, nunca se corta el script entero.
 * - No hay forma de simular que el dinero llegó (a diferencia del sandbox
 *   de Etherfuse) — por eso el chequeo de estado es UN solo intento
 *   (`getOrder`), sin poll; lo que no sea terminal queda anotado "pending".
 * - Al final SIEMPRE se imprime un resumen con todo lo creado.
 */

import "dotenv/config";
import { Keypair, Horizon } from "@stellar/stellar-sdk";
import { KoyweClient, KoyweError } from "../src/index";
import { isMainModule } from "./helpers/isMain";

const DEMO_EMAIL = "sandbox-demo@example.com";
const stellarServer = new Horizon.Server("https://horizon-testnet.stellar.org");

export interface KoyweFlowSummary {
  paymentProviders?: string[];
  onRampQuoteId?: string;
  onRampDestination?: string;
  onRampError?: string;
  stellarAddress?: string;
  orderId?: string;
  orderError?: string;
  depositCvu?: string;
  depositAlias?: string;
  interactiveUrl?: string;
  orderStatus?: string;
  bankAccountId?: string;
  bankAccountError?: string;
  offRampQuoteId?: string;
  offRampError?: string;
  kycStatus?: string;
  kycError?: string;
}

async function runOnRamp(koywe: KoyweClient, summary: KoyweFlowSummary) {
  console.log("\n── On-ramp: ARS → USDC (Stellar) ───────────────────────────");
  let paymentMethodId: string | undefined;
  try {
    const providers = await koywe.getPaymentProviders("ARS");
    summary.paymentProviders = providers.map((p) => `${p.label} (${p.id})`);
    console.log(`✔ Rieles disponibles para ARS: ${providers.map((p) => p.label).join(", ") || "ninguno"}`);
    paymentMethodId = providers[0]?.id;
  } catch (error) {
    console.error("✘ No se pudo listar los payment providers — sigo sin uno específico:", error);
  }

  let quoteId: string;
  try {
    const quote = await koywe.getQuote({ ramp: "onramp", fiatCurrency: "ARS", amount: "10000", paymentMethodId });
    quoteId = quote.id;
    summary.onRampQuoteId = quote.id;
    summary.onRampDestination = `${quote.destinationAmount} ${quote.targetAsset}`;
    console.log(`✔ Quote ${quote.id}: ${quote.sourceAmount} ARS → ${quote.destinationAmount} ${quote.targetAsset}`);
  } catch (error) {
    summary.onRampError = String(error instanceof Error ? error.message : error);
    console.error("✘ No se pudo obtener una quote de on-ramp — sigo con el resto del flujo:", error);
    return;
  }

  // Dirección Stellar real y fondeada, generada acá — Koywe entrega USDC
  // directo a esta cuenta (a diferencia de Etherfuse, acá no hace falta
  // trustline: USDC en Stellar la abren la mayoría de las wallets por
  // default, y de todos modos esta orden nunca liquida sin un pago real).
  let stellarAddress: string;
  try {
    const keypair = Keypair.random();
    await stellarServer.friendbot(keypair.publicKey()).call();
    stellarAddress = keypair.publicKey();
    summary.stellarAddress = stellarAddress;
    console.log(`✔ Dirección Stellar de destino: ${stellarAddress}`);
  } catch (error) {
    console.error("✘ No se pudo generar/fondear una dirección Stellar — sigo con el resto del flujo:", error);
    return;
  }

  try {
    const order = await koywe.createOnRampOrder({ quoteId, stellarAddress, email: DEMO_EMAIL });
    summary.orderId = order.id;
    summary.depositCvu = order.deposit?.cvu;
    summary.depositAlias = order.deposit?.alias;
    summary.interactiveUrl = order.interactiveUrl;
    console.log(`✔ Orden creada: ${order.id} (status ${order.status})`);
    if (order.deposit) console.log(`  Depósito: CVU ${order.deposit.cvu ?? "n/a"} / alias ${order.deposit.alias ?? "n/a"}`);
    if (order.interactiveUrl) console.log(`  Checkout hosteado: ${order.interactiveUrl}`);

    // Chequeo de estado — UN solo intento, sin poll: sin transferencia real
    // no va a pasar de "WAITING", y es lo esperable sin pagar de verdad.
    try {
      const current = await koywe.getOrder(order.id, DEMO_EMAIL);
      summary.orderStatus = current?.status ?? "pending";
      console.log(`  Estado: ${summary.orderStatus}`);
    } catch (error) {
      summary.orderStatus = "pending";
      console.warn("  No se pudo chequear el estado — queda como \"pending\".", error);
    }
  } catch (error) {
    summary.orderError = String(error instanceof Error ? error.message : error);
    console.error("✘ No se pudo crear la orden de on-ramp:", error);
  }
}

async function runOffRamp(koywe: KoyweClient, summary: KoyweFlowSummary) {
  console.log("\n── Off-ramp: registrar cuenta bancaria + quote ─────────────");
  try {
    const account = await koywe.createBankAccount({
      email: DEMO_EMAIL,
      accountNumber: "0000053600000017871248", // cuenta de ejemplo — el sandbox exige una de sus números validados
      countryCode: "AR",
      currencySymbol: "ARS",
    });
    summary.bankAccountId = account.id;
    console.log(`✔ Cuenta bancaria registrada: ${account.id}`);
  } catch (error) {
    summary.bankAccountError = String(error instanceof Error ? error.message : error);
    console.error(
      "✘ No se pudo registrar la cuenta bancaria (el sandbox exige un número de cuenta de prueba validado para el país) — sigo igual:",
      error,
    );
  }

  try {
    const quote = await koywe.getQuote({ ramp: "offramp", fiatCurrency: "ARS", amount: "100" });
    summary.offRampQuoteId = quote.id;
    console.log(`✔ Quote off-ramp ${quote.id}: ${quote.sourceAmount} USDC → ${quote.destinationAmount} ARS`);
  } catch (error) {
    summary.offRampError = String(error instanceof Error ? error.message : error);
    console.error("✘ No se pudo obtener una quote de off-ramp:", error);
  }
}

async function runKyc(koywe: KoyweClient, summary: KoyweFlowSummary) {
  console.log("\n── KYC delegado ─────────────────────────────────────────────");
  try {
    const check = await koywe.checkAccount(DEMO_EMAIL);
    summary.kycStatus = check.accountStatus;
    console.log(`✔ Estado de cuenta para ${DEMO_EMAIL}: ${check.accountStatus} (puede operar: ${check.canOperate})`);
  } catch (error) {
    summary.kycError = String(error instanceof Error ? error.message : error);
    console.error("✘ No se pudo chequear el estado de KYC:", error);
  }
}

/**
 * Corre el flujo de Koywe completo (on-ramp, off-ramp, KYC) y devuelve el
 * resumen. `null` si faltan `KOYWE_CLIENT_ID`/`KOYWE_SECRET` — no lanza,
 * para que `all-flows.ts` pueda saltear esta sección prolijamente y seguir
 * con las demás.
 */
export async function runKoyweFlow(): Promise<KoyweFlowSummary | null> {
  const CLIENT_ID = process.env.KOYWE_CLIENT_ID;
  const SECRET = process.env.KOYWE_SECRET;
  if (!CLIENT_ID || !SECRET) {
    console.error(
      "⚠ Faltan KOYWE_CLIENT_ID / KOYWE_SECRET (ponelos en .env, sacalos de https://docs-crypto.koywe.com) — salteo el flujo de Koywe.",
    );
    return null;
  }

  const koywe = new KoyweClient({
    clientId: CLIENT_ID,
    secret: SECRET,
    baseUrl: process.env.KOYWE_BASE_URL || "https://api-sandbox.koywe.com",
    usdcIssuer: process.env.PUBLIC_USDC_ISSUER || "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5",
    debug: Boolean(process.env.DEBUG),
  });

  const summary: KoyweFlowSummary = {};
  try {
    await runOnRamp(koywe, summary);
    await runOffRamp(koywe, summary);
    await runKyc(koywe, summary);
  } catch (error) {
    if (error instanceof KoyweError) {
      console.error(`\n✘ Error de Koywe [${error.code}]:`, error.message);
    } else {
      console.error("\n✘ Error inesperado:", error);
    }
  }
  return summary;
}

export function printKoyweSummary(summary: KoyweFlowSummary) {
  console.log("\n══ Resumen final — Koywe ═══════════════════════════════════");
  console.log("Rieles ARS:            ", summary.paymentProviders?.join(", ") ?? "n/a");
  console.log(
    "Quote on-ramp:         ",
    summary.onRampQuoteId ?? `n/a${summary.onRampError ? ` — error: ${summary.onRampError}` : ""}`,
    summary.onRampDestination ?? "",
  );
  console.log("Dirección Stellar:     ", summary.stellarAddress ?? "n/a");
  console.log("Orden on-ramp:         ", summary.orderId ?? `n/a${summary.orderError ? ` — error: ${summary.orderError}` : ""}`);
  if (summary.depositCvu) console.log("  CVU / alias:         ", summary.depositCvu, summary.depositAlias ?? "");
  if (summary.interactiveUrl) console.log("  Checkout hosteado:   ", summary.interactiveUrl);
  console.log("Estado orden:          ", summary.orderStatus ?? "n/a");
  console.log(
    "Cuenta bancaria:       ",
    summary.bankAccountId ?? `n/a${summary.bankAccountError ? ` — error: ${summary.bankAccountError}` : ""}`,
  );
  console.log(
    "Quote off-ramp:        ",
    summary.offRampQuoteId ?? `n/a${summary.offRampError ? ` — error: ${summary.offRampError}` : ""}`,
  );
  console.log("KYC:                   ", summary.kycStatus ?? `n/a${summary.kycError ? ` — error: ${summary.kycError}` : ""}`);
  console.log("═════════════════════════════════════════════════════════");
}

if (isMainModule(import.meta.url)) {
  runKoyweFlow()
    .then((summary) => {
      if (summary) printKoyweSummary(summary);
    })
    .catch((error) => {
      console.error("\n✘ Error inesperado:", error);
    });
}
