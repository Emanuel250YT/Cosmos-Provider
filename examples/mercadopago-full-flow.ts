/**
 * Flujo completo contra la API real de Mercado Pago (no el simulador de
 * `npm run demo`), a través de UN SOLO `CosmosClient` — no una instancia
 * separada por país: cotización con tasa en vivo de CoinGecko → una orden
 * por cada método de pago que el proveedor soporta → link/QR reales →
 * chequeo de estado sin bloquear.
 *
 * MULTI-CUENTA: Mercado Pago emite una cuenta de comercio (y access token)
 * DISTINTA por país — un token de Argentina no puede procesar un cobro de
 * Brasil/PIX, y viceversa. En vez de crear un `CosmosClient` por país, este
 * script arma UNO SOLO con `mercadopago.accounts` — una entrada por moneda
 * (ARS, BRL...) — y `client.ramp.onramp({ provider: "mercadopago",
 * currency: "ARS" | "BRL", ... })` rutea sola a la cuenta correcta. Ver la
 * sección "Mercado Pago multi-account" del README.
 *
 * Preparación: `MP_AR_ACCESS_TOKEN` / `MP_BR_ACCESS_TOKEN` en `.env`, con
 * tokens `TEST-...` de sandbox (si solo tenés una cuenta, `MP_ACCESS_TOKEN`
 * solo también funciona). Ejecutá `npm run flow:mercadopago`. Si lo único
 * que tenés cargado es un token de producción (`APP_USR-...`), el flujo lo
 * salta y te avisa por qué — ver "POR DEFECTO, SOLO SANDBOX" más abajo.
 *
 * DISEÑO (igual que examples/full-flow.ts):
 * - Cada método de pago corre en su propio try/catch — si uno falla (p. ej.
 *   esta cuenta no tiene PIX/BRL habilitado), se anota el error y se sigue
 *   con el siguiente, nunca se corta el script entero.
 * - No hay pago real que simular acá (a diferencia del sandbox de
 *   Etherfuse, Mercado Pago no tiene un endpoint de "depósito simulado") —
 *   por eso se hace UN chequeo de estado (`getCharge`) después de crear cada
 *   orden y lo que no sea un estado terminal queda anotado "pending". Para
 *   ver una orden pasar a "approved" de verdad hay que abrir el link y
 *   pagarlo (con tarjetas de prueba si el token es `TEST-...`).
 * - Al final SIEMPRE se imprime un resumen con todo lo creado — links, QRs,
 *   quotes, ids — aunque algún método haya fallado.
 *
 * Con credenciales de producción reales, ya vimos que Checkout Pro (link)
 * funciona pero PIX/QR directo (`POST /v1/payments`) puede devolver
 * "Unauthorized use of live credentials" — Mercado Pago aprueba el acceso a
 * la Payments API por separado del Checkout Pro básico. Es una restricción
 * real de la cuenta/aplicación, no un bug de esta librería.
 *
 * POR DEFECTO, SOLO SANDBOX — y el modo se declara EXPLÍCITAMENTE, no se
 * adivina del prefijo del token: Mercado Pago genera credenciales
 * `APP_USR-...` (formato "producción") tanto para tu cuenta real como para
 * cada "usuario de prueba" (cuenta sandbox) que crees — el prefijo NO
 * distingue una de otra, solo la cuenta que la emitió lo sabe. Por eso cada
 * cuenta tiene su propio flag `MP_*_SANDBOX` en `.env`:
 *   - `"true"`  → sandbox de verdad (aunque el token sea `APP_USR-...`):
 *                 corre por defecto, y `MercadoPagoProvider` usa
 *                 `sandbox_init_point` para los links de Checkout Pro.
 *   - `"false"` o sin declarar → se asume producción; el flujo la SALTEA
 *                 salvo que pongas `MP_ALLOW_PRODUCTION="true"` en `.env`.
 * Un token que sí empieza con `TEST-` se trata como sandbox aunque no
 * declares el flag (ese prefijo sí es inequívoco).
 */

import "dotenv/config";
import { CosmosClient, FiatCurrency, type MercadoPagoProviderOptions, type RampOrderData } from "../src/index";
import { isMainModule } from "./helpers/isMain";

const ALLOW_PRODUCTION = process.env.MP_ALLOW_PRODUCTION === "true";

/**
 * `true`/`false` si `envFlag` lo declara explícitamente (p. ej.
 * `MP_BR_SANDBOX`); si no está seteado, cae al prefijo `TEST-...` del token
 * — el único caso donde el prefijo alcanza para saber el modo sin dudar.
 */
function resolveSandbox(token: string, envFlag: string | undefined): boolean {
  if (envFlag === "true") return true;
  if (envFlag === "false") return false;
  return token.startsWith("TEST-");
}

/**
 * Arma la config de `mercadopago` a partir de `.env`: si hay credenciales
 * por país (`MP_AR_ACCESS_TOKEN`/`MP_BR_ACCESS_TOKEN`) arma `accounts` con
 * una entrada por moneda; si no, cae a la única `MP_ACCESS_TOKEN` como
 * cuenta por defecto. Una cuenta que resuelve a NO-sandbox (ver
 * `resolveSandbox`) se ignora salvo `MP_ALLOW_PRODUCTION=true` (ver cabecera
 * del archivo). `null` si no queda ninguna credencial usable — el flujo
 * entero se saltea.
 */
function buildMercadoPagoConfig(): MercadoPagoProviderOptions | null {
  const ar = process.env.MP_AR_ACCESS_TOKEN;
  const br = process.env.MP_BR_ACCESS_TOKEN;
  const single = process.env.MP_ACCESS_TOKEN;
  const skippedProduction: string[] = [];

  const accounts: NonNullable<MercadoPagoProviderOptions["accounts"]> = {};
  const tryAdd = (
    currency: string,
    token: string | undefined,
    webhookSecret: string | undefined,
    sandboxFlag: string | undefined,
    extra?: Record<string, unknown>,
  ) => {
    if (!token) return;
    const sandbox = resolveSandbox(token, sandboxFlag);
    if (!sandbox && !ALLOW_PRODUCTION) {
      skippedProduction.push(currency);
      return;
    }
    accounts[currency] = { accessToken: token, sandbox, webhookSecret, ...extra };
  };
  tryAdd(FiatCurrency.ARS, ar, process.env.MP_AR_WEBHOOK_SECRET, process.env.MP_AR_SANDBOX);
  tryAdd(FiatCurrency.BRL, br, process.env.MP_BR_WEBHOOK_SECRET, process.env.MP_BR_SANDBOX, {
    defaultPayerEmail: "sandbox-buyer@example.com.br",
  });

  if (Object.keys(accounts).length > 0) return { accounts };

  if (single) {
    const sandbox = resolveSandbox(single, process.env.MP_SANDBOX);
    if (sandbox || ALLOW_PRODUCTION) {
      return {
        accessToken: single,
        sandbox,
        webhookSecret: process.env.MP_WEBHOOK_SECRET,
        defaultPayerEmail: "sandbox-buyer@example.com",
      };
    }
    skippedProduction.push("default (MP_ACCESS_TOKEN)");
  }

  if (skippedProduction.length > 0) {
    console.error(
      `⚠ Mercado Pago (${skippedProduction.join(", ")}) resuelve a PRODUCCIÓN (ni el prefijo del token es ` +
        `"TEST-..." ni hay un MP_*_SANDBOX="true" declarado) y MP_ALLOW_PRODUCTION no es "true" — por defecto ` +
        `este flujo solo corre en sandbox. Si en realidad es un usuario de prueba, declará MP_AR_SANDBOX/` +
        `MP_BR_SANDBOX/MP_SANDBOX="true" en .env; si es tu cuenta real, seteá MP_ALLOW_PRODUCTION="true".`,
    );
  }
  return null;
}

interface MethodPlan {
  label: string;
  currency: string;
  amount: number;
  method: "link" | "qr";
}

/** Un plan por método/moneda que el proveedor documenta soportar. `qr` real solo aplica a BRL (PIX); en el resto cae a link. */
const PLANS: MethodPlan[] = [
  { label: "Checkout Pro (link) — ARS", currency: FiatCurrency.ARS, amount: 5_000, method: "link" },
  { label: "PIX (QR) — BRL", currency: FiatCurrency.BRL, amount: 50, method: "qr" },
];

export interface MethodResult {
  label: string;
  orderId?: string;
  chargeId?: string;
  link?: string;
  qr?: string;
  cryptoAmount?: string;
  rate?: string;
  error?: string;
  status?: string;
}

async function runPlan(cosmos: CosmosClient, plan: MethodPlan): Promise<MethodResult> {
  const result: MethodResult = { label: plan.label };
  console.log(`\n── ${plan.label} ──────────────────────────────────────────`);

  let order: RampOrderData;
  try {
    order = await cosmos.ramp!.onramp({
      provider: "mercadopago",
      amount: plan.amount,
      currency: plan.currency,
      asset: "USDC",
      spread: 0.02,
      wallet: "DEMO_WALLET_ADDRESS",
      method: plan.method,
      description: `Cosmos-Provider demo (${plan.label})`,
    });
  } catch (error) {
    result.error = String(error instanceof Error ? error.message : error);
    console.error(`✘ No se pudo crear la orden — sigo con el siguiente método:`, error);
    return result;
  }

  result.orderId = order.id;
  result.chargeId = order.charge?.id;
  result.link = order.charge?.link;
  result.qr = order.charge?.qr;
  result.cryptoAmount = String(order.quote.cryptoAmount);
  result.rate = String(order.quote.effectiveRate);
  console.log(`✔ Orden creada: ${order.id}`);
  console.log(`  ${plan.amount} ${plan.currency} → ${order.quote.cryptoAmount} USDC (rate efectivo ${order.quote.effectiveRate})`);
  if (order.charge?.link) console.log(`  Link de pago: ${order.charge.link}`);
  if (order.charge?.qr) console.log(`  QR (copia e cola): ${order.charge.qr}`);

  // Chequeo de estado — UN solo intento, sin poll. `order.charge.id` para un
  // método "link" es el id de la PREFERENCIA, no de un pago: no existe como
  // recurso en /v1/payments hasta que alguien realmente paga (da 404), así
  // que ahí ni lo intentamos. Para "qr" (PIX) sí es un id de pago real desde
  // el vamos — se puede consultar, y sin transferencia real se queda en
  // "pending", que es lo esperable.
  if (plan.method === "link") {
    result.status = "pending";
    console.log(`  Estado: pending (una preferencia no es un recurso de pago hasta que alguien paga — abrí el link para probar)`);
    return result;
  }
  try {
    const charge = await cosmos.mercadopago!.getCharge(order.charge!.id);
    result.status = charge.status;
    console.log(`  Estado: ${charge.status}`);
  } catch (error) {
    result.status = "pending";
    console.warn(`  No se pudo consultar el estado — queda como "pending".`, error);
  }
  return result;
}

/**
 * Corre el flujo de Mercado Pago completo (un plan por método de pago),
 * TODO a través de un único `CosmosClient` que enruta por moneda a la
 * cuenta correcta. Devuelve el detalle de cada plan. `null` si no hay
 * ninguna credencial en `.env` — no lanza, para que `all-flows.ts` pueda
 * saltear esta sección prolijamente y seguir con las demás.
 */
export async function runMercadoPagoFlow(): Promise<MethodResult[] | null> {
  const mercadopago = buildMercadoPagoConfig();
  if (!mercadopago) {
    console.error(
      "⚠ Faltan credenciales de Mercado Pago (MP_AR_ACCESS_TOKEN/MP_BR_ACCESS_TOKEN o MP_ACCESS_TOKEN en .env) — salteo este flujo.",
    );
    return null;
  }
  if (ALLOW_PRODUCTION) {
    console.warn(
      "⚠ MP_ALLOW_PRODUCTION=\"true\": las órdenes que se crean acá son reales " +
        "(aunque no se cobra nada sin abrir y pagar el link).",
    );
  }

  const cosmos = new CosmosClient({
    mercadopago,
    oracle: { apiKey: process.env.COINGECKO_API_KEY },
    settlement: async ({ wallet, amount, asset }) => {
      console.log(`   ⛓  (simulado) enviaría ${amount} ${asset} → ${wallet}`);
      return { txId: "not-settled-demo-only" };
    },
  });

  const results: MethodResult[] = [];
  for (const plan of PLANS) {
    results.push(await runPlan(cosmos, plan));
  }
  return results;
}

export function printMercadoPagoSummary(results: MethodResult[]) {
  console.log("\n══ Resumen final — Mercado Pago ═══════════════════════════");
  for (const r of results) {
    console.log(`\n${r.label}:`);
    console.log("  Orden:  ", r.orderId ?? `n/a${r.error ? ` — error: ${r.error}` : ""}`);
    if (r.link) console.log("  Link:   ", r.link);
    if (r.qr) console.log("  QR:     ", r.qr);
    if (r.cryptoAmount) console.log("  USDC:   ", r.cryptoAmount, `(rate ${r.rate})`);
    console.log("  Estado: ", r.status ?? "n/a");
  }
  console.log("\n═════════════════════════════════════════════════════════");
}

if (isMainModule(import.meta.url)) {
  runMercadoPagoFlow()
    .then((results) => {
      if (results) printMercadoPagoSummary(results);
    })
    .catch((error) => {
      console.error("\n✘ Error inesperado:", error);
    });
}
