/** Tests for the Mercado Pago provider and the outgoing webhook emitter. */

import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { MercadoPagoProvider } from "@/providers/mercadopago/MercadoPagoProvider";
import { verifyCosmosSignature, WebhookEmitter } from "@/webhooks/WebhookEmitter";
import { createMockFetch } from "./helpers/mockFetch";

const provider = (fetchImpl: typeof fetch, extra = {}) =>
  new MercadoPagoProvider({
    accessToken: "TEST-token",
    notificationUrl: "https://app.example/webhooks/mercadopago",
    ...extra,
    fetch: fetchImpl,
  });

describe("MercadoPagoProvider charges", () => {
  it("creates a Checkout Pro preference for link charges", async () => {
    const { fetchImpl, requests } = createMockFetch([
      {
        route: "POST /checkout/preferences",
        response: { id: "pref-1", init_point: "https://mp.example/checkout/pref-1" },
      },
    ]);

    const charge = await provider(fetchImpl).createCharge({
      amount: 50000,
      currency: "ARS",
      method: "link",
      reference: "order-1",
      description: "Buy USDC",
    });

    expect(charge).toMatchObject({ id: "pref-1", method: "link", link: "https://mp.example/checkout/pref-1" });
    const body = requests[0]!.body as Record<string, any>;
    expect(body.external_reference).toBe("order-1");
    expect(body.notification_url).toContain("/webhooks/mercadopago");
    expect(body.items[0]).toMatchObject({ unit_price: 50000, currency_id: "ARS" });
    expect(requests[0]!.headers["authorization"]).toBe("Bearer TEST-token");
  });

  it("creates a PIX payment for BRL QR charges", async () => {
    const { fetchImpl, requests } = createMockFetch([
      {
        route: "POST /v1/payments",
        response: {
          id: 123,
          point_of_interaction: {
            transaction_data: {
              qr_code: "00020126...",
              qr_code_base64: "iVBOR...",
              ticket_url: "https://mp.example/ticket",
            },
          },
        },
      },
    ]);

    const charge = await provider(fetchImpl).createCharge({
      amount: 500,
      currency: "BRL",
      method: "qr",
      reference: "order-2",
      payer: { email: "user@example.com.br" },
    });

    expect(charge).toMatchObject({ id: "123", method: "qr", qr: "00020126...", qrBase64: "iVBOR..." });
    const body = requests[0]!.body as Record<string, any>;
    expect(body.payment_method_id).toBe("pix");
    expect(body.external_reference).toBe("order-2");
    expect(requests[0]!.headers["x-idempotency-key"]).toBe("order-2");
  });

  it("requires a payer email for PIX", async () => {
    const { fetchImpl } = createMockFetch([]);
    await expect(
      provider(fetchImpl).createCharge({ amount: 1, currency: "BRL", method: "qr", reference: "x" }),
    ).rejects.toThrow(/payer email/i);
  });

  it("falls back to a payment link for QR in regions without a POS", async () => {
    const { fetchImpl } = createMockFetch([
      { route: "POST /checkout/preferences", response: { id: "pref-2", init_point: "https://mp/2" } },
    ]);
    const charge = await provider(fetchImpl).createCharge({
      amount: 100,
      currency: "ARS",
      method: "qr",
      reference: "order-3",
    });
    expect(charge.method).toBe("link");
  });

  it("creates an in-store dynamic QR when a POS is configured", async () => {
    const { fetchImpl, requests } = createMockFetch([
      {
        route: "PUT /instore/orders/qr/seller/collectors/123/pos/POS01/qrs",
        response: { qr_data: "00020101MOCKQR", in_store_order_id: "instore-1" },
      },
    ]);
    const mp = provider(fetchImpl, { qrPos: { collectorId: "123", posId: "POS01" } });

    const charge = await mp.createCharge({
      amount: 7000,
      currency: "ARS",
      method: "qr",
      reference: "order-9",
    });

    expect(charge).toMatchObject({ id: "instore-1", method: "qr", qr: "00020101MOCKQR" });
    expect((requests[0]!.body as Record<string, any>).external_reference).toBe("order-9");
  });

  it("creates payouts through the money transfer endpoint", async () => {
    const { fetchImpl, requests } = createMockFetch([
      { route: "POST /v1/money_transfers", response: { id: 42, status: "approved" } },
    ]);

    const payout = await provider(fetchImpl).createPayout({
      amount: 98000,
      currency: "ARS",
      reference: "order-1",
      destination: { email: "user@example.com" },
    });

    expect(payout).toMatchObject({ id: "42", status: "sent" });
    const body = requests[0]!.body as Record<string, any>;
    expect(body).toMatchObject({ transaction_amount: 98000, currency_id: "ARS", email: "user@example.com" });
    expect(requests[0]!.headers["x-idempotency-key"]).toBe("payout-order-1");
  });

  it("wraps API failures in ProviderError with status and body", async () => {
    const { fetchImpl } = createMockFetch([
      {
        route: "POST /checkout/preferences",
        status: 400,
        response: { message: "invalid_items" },
      },
    ]);

    await expect(
      provider(fetchImpl).createCharge({ amount: 1, currency: "ARS", method: "link", reference: "x" }),
    ).rejects.toMatchObject({
      name: "ProviderError",
      provider: "mercadopago",
      status: 400,
      message: expect.stringContaining("invalid_items"),
    });
  });

  it("normalizes payment states", async () => {
    const { fetchImpl } = createMockFetch([
      {
        route: "GET /v1/payments/55",
        response: {
          id: 55,
          status: "approved",
          transaction_amount: 50000,
          currency_id: "ars",
          external_reference: "order-1",
        },
      },
    ]);

    const state = await provider(fetchImpl).getCharge("55");
    expect(state).toMatchObject({
      id: "55",
      status: "approved",
      amount: 50000,
      currency: "ARS",
      reference: "order-1",
    });
  });
});

describe("MercadoPagoProvider webhooks", () => {
  const SECRET = "super-secret";

  function signedRequest(paymentId: string, requestId = "req-1", ts = "1700000000") {
    const manifest = `id:${paymentId.toLowerCase()};request-id:${requestId};ts:${ts};`;
    const v1 = createHmac("sha256", SECRET).update(manifest).digest("hex");
    return {
      body: JSON.stringify({ type: "payment", data: { id: paymentId } }),
      headers: { "x-signature": `ts=${ts},v1=${v1}`, "x-request-id": requestId },
      query: { "data.id": paymentId },
    };
  }

  it("accepts valid x-signature headers", async () => {
    const { fetchImpl } = createMockFetch([]);
    const mp = provider(fetchImpl, { webhookSecret: SECRET });
    expect(await mp.verifyWebhook(signedRequest("12345"))).toBe(true);
  });

  it("rejects tampered signatures", async () => {
    const { fetchImpl } = createMockFetch([]);
    const mp = provider(fetchImpl, { webhookSecret: SECRET });
    const request = signedRequest("12345");
    request.query["data.id"] = "99999"; // notification altered
    expect(await mp.verifyWebhook(request)).toBe(false);
  });

  it("rejects missing or malformed headers when a secret is set", async () => {
    const { fetchImpl } = createMockFetch([]);
    const mp = provider(fetchImpl, { webhookSecret: SECRET });
    expect(await mp.verifyWebhook({ body: "{}", headers: {} })).toBe(false);
    expect(await mp.verifyWebhook({ body: "{}", headers: { "x-signature": "garbage" } })).toBe(false);
  });

  it("accepts everything when no secret is configured", async () => {
    const { fetchImpl } = createMockFetch([]);
    expect(await provider(fetchImpl).verifyWebhook({ body: "{}", headers: {} })).toBe(true);
  });

  it("parses payment notifications from body or query", async () => {
    const { fetchImpl } = createMockFetch([]);
    const mp = provider(fetchImpl);

    const fromBody = await mp.parseWebhook({
      body: JSON.stringify({ type: "payment", data: { id: 777 } }),
      headers: {},
    });
    expect(fromBody).toMatchObject({ chargeId: "777", kind: "payment" });

    const fromQuery = await mp.parseWebhook({
      body: JSON.stringify({ action: "payment.updated" }),
      headers: {},
      url: "/webhooks/mercadopago?data.id=888&type=payment",
    });
    expect(fromQuery).toMatchObject({ chargeId: "888" });

    const ignored = await mp.parseWebhook({
      body: JSON.stringify({ type: "test", data: { id: 1 } }),
      headers: {},
    });
    expect(ignored).toBeNull();
  });
});

describe("WebhookEmitter", () => {
  it("signs deliveries and the receiver can verify them", async () => {
    const { fetchImpl, requests } = createMockFetch([
      { route: "POST /hooks/cosmos", response: { ok: true } },
    ]);
    const emitter = new WebhookEmitter({
      endpoints: [{ url: "https://app.example/hooks/cosmos", secret: "hook-secret" }],
      fetch: fetchImpl,
    });

    const results = await emitter.emit("order.completed", { orderId: "o-1" });
    expect(results[0]).toMatchObject({ ok: true, status: 200, attempts: 1 });

    const request = requests[0]!;
    const rawBody = JSON.stringify(request.body);
    const header = request.headers["x-cosmos-signature"];
    expect(header).toMatch(/^t=\d+,v1=[0-9a-f]{64}$/);

    expect(await verifyCosmosSignature(rawBody, header, "hook-secret")).toBe(true);
    expect(await verifyCosmosSignature(rawBody, header, "wrong-secret")).toBe(false);
    expect(await verifyCosmosSignature(rawBody + "x", header, "hook-secret")).toBe(false);
  });

  it("filters endpoints by event type", async () => {
    const { fetchImpl, requests } = createMockFetch([
      { route: "POST /hooks/cosmos", response: {} },
    ]);
    const emitter = new WebhookEmitter({
      endpoints: [
        { url: "https://app.example/hooks/cosmos", secret: "s", events: ["order.completed"] },
      ],
      fetch: fetchImpl,
    });

    await emitter.emit("payment.approved", {});
    expect(requests).toHaveLength(0);
    await emitter.emit("order.completed", {});
    expect(requests).toHaveLength(1);
  });

  it("retries transient failures", async () => {
    const { fetchImpl, requests } = createMockFetch([
      {
        route: "POST /hooks/cosmos",
        sequence: [{ status: 500 }, { status: 200, response: {} }],
      },
    ]);
    const emitter = new WebhookEmitter({
      endpoints: [{ url: "https://app.example/hooks/cosmos", secret: "s" }],
      backoffMs: 1,
      fetch: fetchImpl,
    });

    const [result] = await emitter.emit("order.created", {});
    expect(result).toMatchObject({ ok: true, attempts: 2 });
    expect(requests).toHaveLength(2);
  });
});
