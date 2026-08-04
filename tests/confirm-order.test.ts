/**
 * Tests for the `confirmOrderOnReturn` fallback in
 * `examples/mercadopago/confirm-order-on-return.ts` — settles an order when
 * the user returns from checkout before the Mercado Pago webhook has arrived.
 *
 * Drives the exact `ramp`/`provider`/`mp` instances the runnable script uses
 * (exported for this purpose), so this is the same end-to-end path, just
 * without going through `main()`.
 */

import { describe, expect, it } from "vitest";
import { confirmOrderOnReturn, ramp, mp } from "../examples/mercadopago/confirm-order-on-return";

function extractPaymentId(webhookBody: string): string {
  return String((JSON.parse(webhookBody) as { data: { id: number } }).data.id);
}

describe("confirmOrderOnReturn", () => {
  it("settles an order when the user returns before the webhook lands", async () => {
    const order = await ramp.onramp({
      provider: "mercadopago",
      amount: 50_000,
      currency: "ARS",
      wallet: "USER_WALLET",
      method: "link",
    });

    const webhook = mp.pay(order.charge!.id);
    const paymentId = extractPaymentId(webhook.body);

    const result = await confirmOrderOnReturn(order.id, paymentId);
    expect(result).toEqual({ status: "completed", outcome: "settled", alreadyProcessed: false });

    const updated = await ramp.getOrder(order.id);
    expect(updated?.status).toBe("completed");
  });

  it("is idempotent: confirming twice doesn't settle twice", async () => {
    const order = await ramp.onramp({
      provider: "mercadopago",
      amount: 20_000,
      currency: "ARS",
      wallet: "USER_WALLET_2",
      method: "link",
    });
    const webhook = mp.pay(order.charge!.id);
    const paymentId = extractPaymentId(webhook.body);

    await confirmOrderOnReturn(order.id, paymentId);
    const second = await confirmOrderOnReturn(order.id, paymentId);

    expect(second).toEqual({ status: "completed", alreadyProcessed: true });
  });

  it("returns not_found for an unknown order", async () => {
    const result = await confirmOrderOnReturn("does-not-exist", "1");
    expect(result).toEqual({ status: "not_found", alreadyProcessed: false });
  });
});
