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

  it("detects sandbox mode from TEST- tokens and prefers sandbox_init_point", async () => {
    const { fetchImpl } = createMockFetch([
      {
        route: "POST /checkout/preferences",
        response: {
          id: "pref-sbx",
          init_point: "https://mp.example/prod/pref-sbx",
          sandbox_init_point: "https://sandbox.mp.example/pref-sbx",
        },
      },
    ]);
    const mp = provider(fetchImpl); // accessToken: "TEST-token"
    expect(mp.sandbox).toBe(true);

    const charge = await mp.createCharge({
      amount: 1000,
      currency: "ARS",
      method: "link",
      reference: "order-sbx",
    });
    expect(charge.link).toBe("https://sandbox.mp.example/pref-sbx");
  });

  it("prefers init_point on production credentials", async () => {
    const { fetchImpl } = createMockFetch([
      {
        route: "POST /checkout/preferences",
        response: {
          id: "pref-prod",
          init_point: "https://mp.example/prod/pref-prod",
          sandbox_init_point: "https://sandbox.mp.example/pref-prod",
        },
      },
    ]);
    const mp = new MercadoPagoProvider({ accessToken: "APP_USR-token", fetch: fetchImpl });
    expect(mp.sandbox).toBe(false);

    const charge = await mp.createCharge({
      amount: 1000,
      currency: "ARS",
      method: "link",
      reference: "order-prod",
    });
    expect(charge.link).toBe("https://mp.example/prod/pref-prod");
  });

  it("allows overriding sandbox detection explicitly", () => {
    const { fetchImpl } = createMockFetch([]);
    const mp = new MercadoPagoProvider({ accessToken: "APP_USR-token", sandbox: true, fetch: fetchImpl });
    expect(mp.sandbox).toBe(true);
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

  it("builds signed test webhooks that pass its own verification", async () => {
    const { fetchImpl } = createMockFetch([]);
    const mp = provider(fetchImpl, { webhookSecret: SECRET });

    const request = await mp.buildTestWebhook(12345);
    expect(await mp.verifyWebhook(request)).toBe(true);

    const notification = await mp.parseWebhook(request);
    expect(notification).toMatchObject({ chargeId: "12345", kind: "payment" });

    // Tampering with the payment id must break the signature.
    request.query!["data.id"] = "99999";
    expect(await mp.verifyWebhook(request)).toBe(false);
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

describe("MercadoPagoProvider multi-account (per-country credentials)", () => {
  it("defaults to name \"mercadopago\" and all seven markets", () => {
    const { fetchImpl } = createMockFetch([]);
    const mp = provider(fetchImpl);
    expect(mp.name).toBe("mercadopago");
    expect(mp.regions).toEqual(["AR", "BR", "MX", "CL", "CO", "PE", "UY"]);
    expect(mp.currencies).toEqual(["ARS", "BRL", "MXN", "CLP", "COP", "PEN", "UYU"]);
  });

  it("accepts a custom name and a narrowed regions/currencies set", () => {
    const { fetchImpl } = createMockFetch([]);
    const ar = new MercadoPagoProvider({
      accessToken: "TEST-ar-token",
      name: "mercadopago-ar",
      regions: ["AR"],
      currencies: ["ARS"],
      fetch: fetchImpl,
    });
    expect(ar.name).toBe("mercadopago-ar");
    expect(ar.regions).toEqual(["AR"]);
    expect(ar.currencies).toEqual(["ARS"]);
  });

  it("registers two country-scoped instances in the same CosmosRamp under distinct names", async () => {
    const { CosmosRamp } = await import("@/core/CosmosRamp");
    const { fetchImpl: arFetch, requests: arRequests } = createMockFetch([
      { route: "POST /checkout/preferences", response: { id: "ar-pref", init_point: "https://mp.example/ar" } },
    ]);
    const { fetchImpl: brFetch, requests: brRequests } = createMockFetch([
      {
        route: "POST /v1/payments",
        response: { id: 999, point_of_interaction: { transaction_data: { qr_code: "00020126...BR" } } },
      },
    ]);

    const ar = new MercadoPagoProvider({
      accessToken: "TEST-ar-token",
      name: "mercadopago-ar",
      regions: ["AR"],
      currencies: ["ARS"],
      fetch: arFetch,
    });
    const br = new MercadoPagoProvider({
      accessToken: "TEST-br-token",
      name: "mercadopago-br",
      regions: ["BR"],
      currencies: ["BRL"],
      defaultPayerEmail: "buyer@example.com.br",
      fetch: brFetch,
    });

    const ramp = new CosmosRamp({
      providers: [ar, br],
      oracle: { getRate: async () => 1000 },
    });

    const arOrder = await ramp.onramp({ provider: "mercadopago-ar", amount: 1000, currency: "ARS", method: "link" });
    expect(arOrder.charge?.link).toBe("https://mp.example/ar");
    expect(arRequests[0]!.headers["authorization"]).toBe("Bearer TEST-ar-token");

    const brOrder = await ramp.onramp({ provider: "mercadopago-br", amount: 100, currency: "BRL", method: "qr" });
    expect(brOrder.charge?.qr).toBe("00020126...BR");
    expect(brRequests[0]!.headers["authorization"]).toBe("Bearer TEST-br-token");

    // Cada instancia solo acepta la moneda de su propio mercado — pedirle a
    // la de Argentina que cobre en reales es un error claro, no un 401
    // confuso de la API real.
    await expect(
      ramp.onramp({ provider: "mercadopago-ar", amount: 100, currency: "BRL", method: "qr" }),
    ).rejects.toThrow(/does not support BRL/);
  });
});

describe("MercadoPagoProvider per-account baseUrl", () => {
  it("defaults every account to https://api.mercadopago.com", () => {
    const { fetchImpl } = createMockFetch([]);
    const mp = provider(fetchImpl);
    expect(mp.baseUrl).toBe("https://api.mercadopago.com");
  });

  it("lets an `accounts` entry route through its own base URL, independent of the others", async () => {
    const { fetchImpl: arFetch, requests: arRequests } = createMockFetch([
      { route: "POST /checkout/preferences", response: { id: "ar-pref", init_point: "https://mp.example/ar" } },
    ]);
    const { fetchImpl: proxyFetch, requests: proxyRequests } = createMockFetch([
      { route: "POST /mp/checkout/preferences", response: { id: "br-pref", init_point: "https://mp.example/br" } },
    ]);
    const dispatch: typeof fetch = (async (input, init) => {
      const url = String(input);
      return url.startsWith("https://proxy.example.com") ? proxyFetch(input, init) : arFetch(input, init);
    }) as typeof fetch;

    const mp = new MercadoPagoProvider({
      accessToken: "TEST-ar-token", // default account, uses the top-level baseUrl
      accounts: {
        BRL: { accessToken: "TEST-br-token", baseUrl: "https://proxy.example.com/mp" },
      },
      fetch: dispatch,
    });

    await mp.createCharge({ amount: 100, currency: "ARS", method: "link", reference: "ar-1" });
    expect(arRequests[0]!.url.startsWith("https://api.mercadopago.com")).toBe(true);

    await mp.createCharge({ amount: 100, currency: "BRL", method: "link", reference: "br-1" });
    expect(proxyRequests[0]!.url).toBe("https://proxy.example.com/mp/checkout/preferences");
  });
});
