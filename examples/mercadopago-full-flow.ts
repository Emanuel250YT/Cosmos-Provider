/**
 * Flujo completo contra la API real de Mercado Pago (no el simulador de
 * `npm run demo`), a través de UN SOLO `CosmosClient` — no una instancia
 * separada por país: cotización con tasa en vivo de CoinGecko → una orden
 * por cada método de pago que el proveedor soporta → link/QR reales →
 * chequeo de estado sin bloquear.
 *
 * MULTI-CUENTA: Mercado Pago emite una cuenta de comercio (y access token)
 * DISTINTA por país — no existe una cuenta "por defecto". Por eso este
 * script no tiene fallback a una sola credencial: arma `mercadopago.accounts`
 * directo con una entrada por moneda (ARS desde `MP_AR_ACCESS_TOKEN`, BRL
 * desde `MP_BR_ACCESS_TOKEN` — alcanza con tener una de las dos en `.env`) y
 * `client.ramp.onramp({ provider: "mercadopago", currency: "ARS" | "BRL",
 * ... })` rutea sola a la cuenta correcta. Ver la sección "Mercado Pago
 * multi-account" del README.
 *
 * Preparación: `MP_AR_ACCESS_TOKEN` y/o `MP_BR_ACCESS_TOKEN` en `.env`.
 * Ejecutá `npm run flow:mercadopago`.
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
 *   pagarlo (con tarjetas de prueba si la cuenta es de sandbox).
 * - Al final SIEMPRE se imprime un resumen con todo lo creado — links, QRs,
 *   quotes, ids — aunque algún método haya fallado.
 *
 * SANDBOX: esto es una LIBRERÍA — el modo sandbox/producción no se adivina
 * del formato del token ni se lee de ninguna variable de entorno, es una
 * decisión de código que toma quien construye el provider. Mercado Pago
 * emite el mismo prefijo `APP_USR-...` tanto para cuentas reales como para
 * cada "usuario de prueba" (cuenta sandbox) que crees, así que el prefijo
 * nunca es una señal confiable. Por eso `buildMercadoPagoConfig()` más abajo
 * pasa `sandbox: true` A MANO en cada cuenta: este es un script de
 * ejemplo/test, así que SIEMPRE corre en modo sandbox por defecto, sin
 * importar qué token cargues en `.env`. Si alguna vez necesitás correr este
 * mismo script contra la cuenta real, cambiá ese `sandbox: true` por
 * `sandbox: false` ahí mismo — a mano, en el código.
 *
 * Con credenciales de producción reales, ya vimos que Checkout Pro (link)
 * funciona pero PIX/QR directo (`POST /v1/payments`) puede devolver
 * "Unauthorized use of live credentials" — Mercado Pago aprueba el acceso a
 * la Payments API por separado del Checkout Pro básico. Es una restricción
 * real de la cuenta/aplicación, no un bug de esta librería.
 */

import "dotenv/config";
import { CosmosClient, FiatCurrency, type MercadoPagoProviderOptions, type RampOrderData } from "../src/index";
import { isMainModule } from "./helpers/isMain";

/**
 * Arma la config de `mercadopago` a partir de `.env`: una entrada por país
 * en `accounts` (ARS desde `MP_AR_ACCESS_TOKEN`, BRL desde
 * `MP_BR_ACCESS_TOKEN`) — sin cuenta "por defecto", porque Mercado Pago no
 * tiene una. `sandbox: true` va fijo a mano acá (ver cabecera del archivo):
 * `null` si no hay ninguna credencial en `.env` — el flujo entero se
 * saltea.
 */
function buildMercadoPagoConfig(): MercadoPagoProviderOptions | null {
  const ar = process.env.MP_AR_ACCESS_TOKEN;
  const br = process.env.MP_BR_ACCESS_TOKEN;
  if (!ar && !br) return null;

  const accounts: NonNullable<MercadoPagoProviderOptions["accounts"]> = {};
  if (ar) {
    accounts[FiatCurrency.ARS] = {
      accessToken: ar,
      sandbox: true,
      webhookSecret: process.env.MP_AR_WEBHOOK_SECRET,
    };
  }
  if (br) {
    accounts[FiatCurrency.BRL] = {
      accessToken: br,
      sandbox: true,
      webhookSecret: process.env.MP_BR_WEBHOOK_SECRET,
      defaultPayerEmail: "sandbox-buyer@example.com.br",
    };
  }
  return { accounts };
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
      "⚠ Faltan credenciales de Mercado Pago (MP_AR_ACCESS_TOKEN y/o MP_BR_ACCESS_TOKEN en .env) — salteo este flujo.",
    );
    return null;
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
