/** Tests for the custom provider factory (createCustomProvider). */

import { createHmac } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { CosmosRamp } from "@/core/CosmosRamp";
import { createCustomProvider } from "@/providers/custom/CustomProvider";

const noopCharges = {
  createCharge: async () => ({}),
  getCharge: async () => ({}),
};

describe("CustomProvider charges", () => {
  it("auto-maps common payment link aliases", async () => {
    const provider = createCustomProvider({
      name: "acme",
      createCharge: async () => ({
        payment_id: 991,
        checkout_url: "https://pay.acme.test/991",
      }),
      getCharge: async () => ({}),
    });

    const charge = await provider.createCharge({
      amount: 100,
      currency: "ARS",
      method: "link",
      reference: "order-1",
    });

    expect(charge).toMatchObject({
      id: "991",
      method: "link",
      link: "https://pay.acme.test/991",
    });
  });

  it("auto-maps QR fields, including nested data objects", async () => {
    const provider = createCustomProvider({
      name: "acme",
      createCharge: async () => ({
        data: { id: "ch_1", qr_code: "00020126...", qr_code_base64: "iVBOR..." },
      }),
      getCharge: async () => ({}),
    });

    const charge = await provider.createCharge({
      amount: 100,
      currency: "BRL",
      method: "qr",
      reference: "order-2",
    });

    expect(charge).toMatchObject({
      id: "ch_1",
      method: "qr",
      qr: "00020126...",
      qrBase64: "iVBOR...",
    });
  });

  it("applies adapt.charge over auto-mapping and falls back to the reference id", async () => {
    const provider = createCustomProvider({
      name: "acme",
      createCharge: async () => ({ weird: { deep_link: "https://pay.acme.test/x" } }),
      getCharge: async () => ({}),
      adapt: {
        charge: (raw) => ({
          link: (raw as { weird: { deep_link: string } }).weird.deep_link,
        }),
      },
    });

    const charge = await provider.createCharge({
      amount: 100,
      currency: "ARS",
      method: "link",
      reference: "order-3",
    });

    expect(charge).toMatchObject({ id: "order-3", method: "link", link: "https://pay.acme.test/x" });
  });

  it("rejects charges without any payable output (link/qr/deposit)", async () => {
    const provider = createCustomProvider({
      name: "acme",
      createCharge: async () => ({ id: "nope" }),
      getCharge: async () => ({}),
    });

    await expect(
      provider.createCharge({ amount: 1, currency: "ARS", method: "link", reference: "x" }),
    ).rejects.toMatchObject({ name: "ProviderError", message: expect.stringContaining("payment link") });
  });

  it("derives expiresAt from expiresInMinutes when the API returns none", async () => {
    const provider = createCustomProvider({
      name: "acme",
      createCharge: async () => ({ id: "1", url: "https://pay.acme.test/1" }),
      getCharge: async () => ({}),
    });
    const before = Date.now();
    const charge = await provider.createCharge({
      amount: 1,
      currency: "ARS",
      method: "link",
      reference: "x",
      expiresInMinutes: 10,
    });
    expect(charge.expiresAt).toBeGreaterThanOrEqual(before + 10 * 60_000 - 5);
  });
});

describe("CustomProvider charge states", () => {
  it("normalizes common status aliases by default", async () => {
    const provider = createCustomProvider({
      name: "acme",
      createCharge: async () => ({}),
      getCharge: async () => ({
        id: 55,
        state: "PAID",
        total: "1500.50",
        currency_code: "ars",
        external_reference: "order-9",
      }),
    });

    const state = await provider.getCharge("55");
    expect(state).toMatchObject({
      id: "55",
      status: "approved",
      amount: 1500.5,
      currency: "ARS",
      reference: "order-9",
    });
  });

  it("honors a custom statusMap and never approves unknown statuses", async () => {
    let status = "ok_dale";
    const provider = createCustomProvider({
      name: "acme",
      createCharge: async () => ({}),
      getCharge: async () => ({ id: 1, status }),
      statusMap: { OK_DALE: "approved", bounced: "rejected" },
    });

    expect((await provider.getCharge("1")).status).toBe("approved");
    status = "bounced";
    expect((await provider.getCharge("1")).status).toBe("rejected");
    status = "something-nobody-mapped";
    expect((await provider.getCharge("1")).status).toBe("pending");
  });
});

describe("CustomProvider webhooks", () => {
  const SECRET = "acme-secret";

  it("verifies HMAC-SHA256 signatures over the raw body", async () => {
    const provider = createCustomProvider({
      ...noopCharges,
      name: "acme",
      webhook: { hmac: { secret: SECRET, header: "x-acme-signature" } },
    });

    const body = JSON.stringify({ id: "pay_1", event: "payment.approved" });
    const signature = createHmac("sha256", SECRET).update(body).digest("hex");

    expect(
      await provider.verifyWebhook({ body, headers: { "x-acme-signature": signature } }),
    ).toBe(true);
    // GitHub-style "sha256=" prefixes are tolerated.
    expect(
      await provider.verifyWebhook({ body, headers: { "x-acme-signature": `sha256=${signature}` } }),
    ).toBe(true);
    expect(
      await provider.verifyWebhook({ body: body + "x", headers: { "x-acme-signature": signature } }),
    ).toBe(false);
    expect(await provider.verifyWebhook({ body, headers: {} })).toBe(false);
  });

  it("prefers a custom verify function", async () => {
    const verify = vi.fn().mockResolvedValue(false);
    const provider = createCustomProvider({ ...noopCharges, name: "acme", webhook: { verify } });
    expect(await provider.verifyWebhook({ body: "{}", headers: {} })).toBe(false);
    expect(verify).toHaveBeenCalled();
  });

  it("accepts webhooks when no verification is configured", async () => {
    const provider = createCustomProvider({ ...noopCharges, name: "acme" });
    expect(await provider.verifyWebhook({ body: "{}", headers: {} })).toBe(true);
  });

  it("parses the charge id from default paths in body and query", async () => {
    const provider = createCustomProvider({ ...noopCharges, name: "acme" });

    const fromBody = await provider.parseWebhook({
      body: JSON.stringify({ event: "payment.updated", data: { id: 777 } }),
      headers: {},
    });
    expect(fromBody).toMatchObject({ chargeId: "777", kind: "payment" });

    const fromQuery = await provider.parseWebhook({
      body: "{}",
      headers: {},
      url: "/hooks/acme?data.id=888",
    });
    expect(fromQuery).toMatchObject({ chargeId: "888" });

    const noId = await provider.parseWebhook({ body: JSON.stringify({ hello: 1 }), headers: {} });
    expect(noId).toBeNull();
  });

  it("supports custom chargeIdPaths and parse functions", async () => {
    const withPaths = createCustomProvider({
      ...noopCharges,
      name: "acme",
      webhook: { chargeIdPaths: ["payload.charge.identifier"] },
    });
    const parsed = await withPaths.parseWebhook({
      body: JSON.stringify({ payload: { charge: { identifier: "abc" } } }),
      headers: {},
    });
    expect(parsed).toMatchObject({ chargeId: "abc" });

    const withParse = createCustomProvider({
      ...noopCharges,
      name: "acme",
      webhook: { parse: () => ({ chargeId: "custom-1", kind: "payment" }) },
    });
    expect(await withParse.parseWebhook({ body: "{}", headers: {} })).toMatchObject({
      chargeId: "custom-1",
    });
  });
});

describe("CustomProvider payouts", () => {
  it("normalizes payout results", async () => {
    const provider = createCustomProvider({
      ...noopCharges,
      name: "acme",
      createPayout: async () => ({ id: 42, status: "succeeded" }),
    });

    const payout = await provider.createPayout({
      amount: 100,
      currency: "ARS",
      reference: "order-1",
      destination: { cbu: "000..." },
    });
    expect(payout).toMatchObject({ id: "42", status: "sent" });
  });

  it("throws a clear error when no payout rail is configured", async () => {
    const provider = createCustomProvider({ ...noopCharges, name: "acme" });
    await expect(
      provider.createPayout({ amount: 1, currency: "ARS", reference: "x", destination: {} }),
    ).rejects.toThrow(/payout rail/i);
  });
});

describe("CustomProvider inside CosmosRamp (end to end)", () => {
  it("runs the full onramp: charge → webhook → verify → fetch → settle", async () => {
    // Fake "provider API": one charge that flips to paid.
    const payments = new Map<string, { status: string; amount: number; reference: string }>();

    const provider = createCustomProvider({
      name: "acme",
      currencies: ["ARS"],
      createCharge: async (request) => {
        payments.set("pay_1", {
          status: "waiting_payment",
          amount: request.amount,
          reference: request.reference,
        });
        return { id: "pay_1", checkout_url: "https://pay.acme.test/pay_1" };
      },
      getCharge: async (id) => {
        const payment = payments.get(id)!;
        return {
          id,
          status: payment.status,
          amount: payment.amount,
          currency: "ARS",
          external_reference: payment.reference,
        };
      },
      webhook: { hmac: { secret: "s3cret", header: "x-acme-signature" } },
    });

    const released: string[] = [];
    const ramp = new CosmosRamp({
      providers: [provider],
      oracle: { getRate: async () => 1000 },
      settlement: async ({ order }) => {
        released.push(order.id);
        return { txId: "0xdeadbeef" };
      },
    });

    const order = await ramp.onramp({
      provider: "acme",
      amount: 50000,
      currency: "ARS",
      wallet: "WALLET",
    });
    expect(order.charge?.link).toBe("https://pay.acme.test/pay_1");

    // The user pays; the provider notifies us.
    payments.get("pay_1")!.status = "paid";
    const body = JSON.stringify({ event: "payment.updated", data: { id: "pay_1" } });
    const signature = createHmac("sha256", "s3cret").update(body).digest("hex");

    const result = await ramp.handleWebhook("acme", {
      body,
      headers: { "x-acme-signature": signature },
    });

    expect(result).toMatchObject({ ok: true, outcome: "settled", orderId: order.id });
    expect(released).toEqual([order.id]);
    expect((await ramp.getOrder(order.id))?.status).toBe("completed");

    // A tampered webhook is rejected before touching anything.
    const tampered = await ramp.handleWebhook("acme", {
      body: body.replace("pay_1", "pay_2"),
      headers: { "x-acme-signature": signature },
    });
    expect(tampered).toMatchObject({ ok: false, outcome: "invalid_signature" });
  });
});
