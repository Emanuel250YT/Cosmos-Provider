/**
 * Flujo completo contra la API real de Mercado Pago (no el simulador de
 * `npm run demo`): cotización con tasa en vivo de CoinGecko → una orden por
 * cada método de pago que el proveedor soporta → link/QR reales → chequeo
 * de estado sin bloquear.
 *
 * Preparación: `MP_ACCESS_TOKEN` en `.env` (un `TEST-...` de sandbox es lo
 * más seguro para probar; con `APP_USR-...` de producción las órdenes son
 * reales, aunque no se cobra nada hasta que alguien abra el link y pague).
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
 *   pagarlo (con tarjetas de prueba si el token es `TEST-...`).
 * - Al final SIEMPRE se imprime un resumen con todo lo creado — links, QRs,
 *   quotes, ids — aunque algún método haya fallado.
 *
 * Con credenciales de producción reales, ya vimos que Checkout Pro (link)
 * funciona pero PIX/QR directo (`POST /v1/payments`) puede devolver
 * "Unauthorized use of live credentials" — Mercado Pago aprueba el acceso a
 * la Payments API por separado del Checkout Pro básico. Es una restricción
 * real de la cuenta/aplicación, no un bug de esta librería.
 */

import "dotenv/config";
import { CosmosRamp, CoinGeckoOracle, MercadoPagoProvider, FiatCurrency, type RampOrderData } from "../src/index";
import { isMainModule } from "./helpers/isMain";

interface MethodPlan {
  label: string;
  currency: string;
  amount: number;
  method: "link" | "qr";
}

/** Un plan por método/moneda que el proveedor documenta soportar. `qr` real solo aplica a BRL (PIX); en el resto cae a link. */
const PLANS: MethodPlan[] = [
  { label: "Checkout Pro (link) — ARS", currency: FiatCurrency.ARS, amount: 50_000, method: "link" },
  { label: "PIX (QR) — BRL", currency: FiatCurrency.BRL, amount: 500, method: "qr" },
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

async function runPlan(mp: MercadoPagoProvider, ramp: CosmosRamp, plan: MethodPlan): Promise<MethodResult> {
  const result: MethodResult = { label: plan.label };
  console.log(`\n── ${plan.label} ──────────────────────────────────────────`);

  let order: RampOrderData;
  try {
    order = await ramp.onramp({
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
    const charge = await mp.getCharge(order.charge!.id);
    result.status = charge.status;
    console.log(`  Estado: ${charge.status}`);
  } catch (error) {
    result.status = "pending";
    console.warn(`  No se pudo consultar el estado — queda como "pending".`, error);
  }
  return result;
}

/**
 * Corre el flujo de Mercado Pago completo (un plan por método de pago) y
 * devuelve el detalle de cada uno. `null` si falta `MP_ACCESS_TOKEN` — no
 * lanza, para que `all-flows.ts` pueda saltear esta sección prolijamente y
 * seguir con las demás.
 */
export async function runMercadoPagoFlow(): Promise<MethodResult[] | null> {
  const ACCESS_TOKEN = process.env.MP_ACCESS_TOKEN;
  if (!ACCESS_TOKEN) {
    console.error("⚠ Falta MP_ACCESS_TOKEN (ponelo en .env) — salteo el flujo de Mercado Pago.");
    return null;
  }
  if (!ACCESS_TOKEN.startsWith("TEST-")) {
    console.warn(
      "⚠ MP_ACCESS_TOKEN no empieza con \"TEST-\": es un token de PRODUCCIÓN. " +
        "Las órdenes que se crean acá son reales (aunque no se cobra nada sin abrir y pagar el link).",
    );
  }

  const mp = new MercadoPagoProvider({
    accessToken: ACCESS_TOKEN,
    webhookSecret: process.env.MP_WEBHOOK_SECRET,
    defaultPayerEmail: "sandbox-buyer@example.com",
  });
  const ramp = new CosmosRamp({
    providers: [mp],
    oracle: new CoinGeckoOracle({ apiKey: process.env.COINGECKO_API_KEY }),
    settlement: async ({ wallet, amount, asset }) => {
      console.log(`   ⛓  (simulado) enviaría ${amount} ${asset} → ${wallet}`);
      return { txId: "not-settled-demo-only" };
    },
  });

  const results: MethodResult[] = [];
  for (const plan of PLANS) {
    results.push(await runPlan(mp, ramp, plan));
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
