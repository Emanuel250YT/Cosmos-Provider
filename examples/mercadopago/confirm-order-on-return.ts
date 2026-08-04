/**
 * Confirm-on-return fallback: when the user comes back to your app from
 * Mercado Pago's checkout before the webhook has arrived (slow delivery, or
 * a local dev server MP can't reach), re-check the payment through the same
 * verified pipeline instead of re-implementing signature/amount/idempotency
 * checks by hand.
 *
 * Run with: npx tsx examples/mercadopago/confirm-order-on-return.ts
 */

import { CosmosRamp, MercadoPagoProvider, FiatCurrency } from "../../src/index";
import { createMockMercadoPago } from "../helpers/mock-mercadopago";
import { isMainModule } from "../helpers/isMain";

// Exported so tests can drive the exact same instances this script runs —
// swap `mp.fetchImpl` for nothing (real network) and a real TEST-... token
// to point this at the real Mercado Pago sandbox.
export const mp = createMockMercadoPago({ webhookSecret: "demo-secret" });

export const provider = new MercadoPagoProvider({
  accessToken: "TEST-demo",
  webhookSecret: "demo-secret",
  fetch: mp.fetchImpl,
});

export const ramp = new CosmosRamp({
  providers: [provider],
  oracle: { getRate: async () => 1000 },
  settlement: async ({ wallet, amount, asset }) => {
    console.log(`   ⛓  releasing ${amount} ${asset} → ${wallet}`);
    return { txId: "simulated-tx" };
  },
});

/**
 * Call this from your "return from checkout" route. Idempotent: if the
 * webhook already settled the order (it won the race), this is a no-op.
 *
 * `buildTestWebhook` signs a real notification for a real payment id — not
 * fake data, just built locally instead of delivered by Mercado Pago. That
 * re-enters the exact verify → re-fetch → amount-check → settle pipeline
 * `ramp.handleWebhook` uses for real webhooks, instead of duplicating those
 * checks by hand against `paymentId`.
 */
export async function confirmOrderOnReturn(orderId: string, paymentId: string) {
  const order = await ramp.getOrder(orderId);
  if (!order) return { status: "not_found" as const, alreadyProcessed: false };
  if (order.status === "completed" || order.status === "settling") {
    return { status: order.status, alreadyProcessed: true };
  }

  const webhookRequest = await provider.buildTestWebhook(paymentId);
  const result = await ramp.handleWebhook("mercadopago", webhookRequest);

  const updated = await ramp.getOrder(orderId);
  return { status: updated?.status ?? order.status, outcome: result.outcome, alreadyProcessed: false };
}

async function main() {
  const order = await ramp.onramp({
    provider: "mercadopago",
    amount: 5_000,
    currency: FiatCurrency.ARS,
    wallet: "USER_WALLET",
    method: "link",
  });
  console.log("order created:", order.id, "| pay at:", order.charge?.link);

  // Simulate the user paying, then returning to your app with the payment id
  // Mercado Pago appends to the redirect URL (`?payment_id=...`).
  const webhook = mp.pay(order.charge!.id);
  const paymentId = String((JSON.parse(webhook.body) as { data: { id: number } }).data.id);

  console.log("confirming:         ", await confirmOrderOnReturn(order.id, paymentId));
  console.log("confirming again:    ", await confirmOrderOnReturn(order.id, paymentId));
}

if (isMainModule(import.meta.url)) {
  main().catch(console.error);
}
