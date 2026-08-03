/** Tests for the provider-agnostic ramp engine + CoinGecko oracle. */

import { describe, expect, it, vi } from "vitest";
import { CosmosRamp } from "@/core/CosmosRamp";
import { OracleError } from "@/core/errors";
import type {
  Charge,
  ChargeState,
  CreateChargeRequest,
  PaymentProvider,
  RateOracle,
  WebhookRequest,
} from "@/core/types";
import { applySpread, CoinGeckoOracle } from "@/oracles/CoinGeckoOracle";
import { createMockFetch } from "./helpers/mockFetch";

// ---------------------------------------------------------------------------
// Test doubles
// ---------------------------------------------------------------------------

const fixedOracle = (rate: number): RateOracle => ({ getRate: async () => rate });

interface FakeProviderState {
  charges: CreateChargeRequest[];
  chargeState: ChargeState;
  verify: boolean;
}

function fakeProvider(overrides: Partial<FakeProviderState> = {}) {
  const state: FakeProviderState = {
    charges: [],
    chargeState: { id: "pay-1", status: "approved", amount: 0, currency: "ARS", reference: "" },
    verify: true,
    ...overrides,
  };

  const provider: PaymentProvider = {
    name: "fake",
    regions: ["AR"],
    currencies: ["ARS"],
    async createCharge(request) {
      state.charges.push(request);
      const charge: Charge = { id: "charge-1", method: "link", link: "https://pay.example/1" };
      return charge;
    },
    async getCharge() {
      return state.chargeState;
    },
    async verifyWebhook() {
      return state.verify;
    },
    async parseWebhook(request: WebhookRequest) {
      const body = typeof request.body === "string" ? JSON.parse(request.body) : request.body;
      if (body.type !== "payment") return null;
      return { chargeId: String(body.data.id), kind: "payment" };
    },
  };

  return { provider, state };
}

const webhook = (paymentId = "pay-1"): WebhookRequest => ({
  body: JSON.stringify({ type: "payment", data: { id: paymentId } }),
  headers: {},
});

// ---------------------------------------------------------------------------
// Quote math
// ---------------------------------------------------------------------------

describe("CosmosRamp.quote", () => {
  const ramp = (rate = 1000) =>
    new CosmosRamp({ providers: [fakeProvider().provider], oracle: fixedOracle(rate) });

  it("applies the spread on top of the oracle rate for onramps", async () => {
    const quote = await ramp().quote({
      direction: "onramp",
      currency: "ARS",
      amount: 51000,
      spread: 0.02,
    });
    expect(quote.rate).toBe(1000);
    expect(quote.effectiveRate).toBe(1020);
    expect(quote.cryptoAmount).toBe(50); // 51000 / 1020
    expect(quote.asset).toBe("USDC");
  });

  it("pays less fiat per crypto unit on offramps", async () => {
    const quote = await ramp().quote({
      direction: "offramp",
      currency: "ARS",
      cryptoAmount: 100,
      spread: 0.02,
    });
    expect(quote.effectiveRate).toBe(980);
    expect(quote.fiatAmount).toBe(98000);
  });

  it("derives the fiat amount from a crypto amount", async () => {
    const quote = await ramp().quote({
      direction: "onramp",
      currency: "ARS",
      cryptoAmount: 10,
      spread: 0.05,
    });
    expect(quote.fiatAmount).toBe(10500);
  });

  it("rejects invalid spreads and missing amounts", async () => {
    await expect(
      ramp().quote({ direction: "onramp", currency: "ARS", amount: 1, spread: 1.5 }),
    ).rejects.toThrow(/spread/i);
    await expect(ramp().quote({ direction: "onramp", currency: "ARS" })).rejects.toThrow(
      /amount/i,
    );
  });
});

// ---------------------------------------------------------------------------
// Onramp + webhook settlement flow
// ---------------------------------------------------------------------------

describe("CosmosRamp onramp flow", () => {
  it("builds the charge with the order id as reference", async () => {
    const { provider, state } = fakeProvider();
    const ramp = new CosmosRamp({ providers: [provider], oracle: fixedOracle(1000) });

    const order = await ramp.onramp({
      provider: "fake",
      amount: 10200,
      currency: "ARS",
      spread: 0.02,
      wallet: "WALLET",
      method: "link",
    });

    expect(order.status).toBe("created");
    expect(order.charge?.link).toBe("https://pay.example/1");
    expect(order.quote.cryptoAmount).toBe(10);
    expect(state.charges[0]?.reference).toBe(order.id);
    expect(state.charges[0]?.amount).toBe(10200);
  });

  it("rejects currencies the provider does not support", async () => {
    const ramp = new CosmosRamp({ providers: [fakeProvider().provider], oracle: fixedOracle(1) });
    await expect(
      ramp.onramp({ provider: "fake", amount: 10, currency: "EUR" }),
    ).rejects.toThrow(/does not support EUR/);
  });

  it("settles automatically when the webhook confirms the payment", async () => {
    const { provider, state } = fakeProvider();
    const settlement = vi.fn(async () => ({ txId: "tx-99" }));
    const ramp = new CosmosRamp({
      providers: [provider],
      oracle: fixedOracle(1000),
      settlement,
    });

    const order = await ramp.onramp({
      provider: "fake",
      amount: 10200,
      currency: "ARS",
      spread: 0.02,
      wallet: "WALLET",
    });
    state.chargeState = {
      id: "pay-1",
      status: "approved",
      amount: 10200,
      currency: "ARS",
      reference: order.id,
    };

    const events: string[] = [];
    ramp.on("payment:approved", () => events.push("approved"));
    ramp.on("settlement:released", () => events.push("released"));
    ramp.on("order:completed", () => events.push("completed"));

    const result = await ramp.handleWebhook("fake", webhook());

    expect(result).toMatchObject({ status: 200, ok: true, outcome: "settled", orderId: order.id });
    expect(settlement).toHaveBeenCalledWith(
      expect.objectContaining({ asset: "USDC", amount: 10, wallet: "WALLET" }),
    );
    expect(events).toEqual(["approved", "released", "completed"]);

    const stored = await ramp.getOrder(order.id);
    expect(stored?.status).toBe("completed");
    expect(stored?.settlementTxId).toBe("tx-99");

    // Duplicate webhook → idempotent, settlement not called again.
    const dup = await ramp.handleWebhook("fake", webhook());
    expect(dup.outcome).toBe("duplicate");
    expect(settlement).toHaveBeenCalledTimes(1);
  });

  it("rejects webhooks with invalid signatures", async () => {
    const { provider } = fakeProvider({ verify: false });
    const ramp = new CosmosRamp({ providers: [provider], oracle: fixedOracle(1000) });
    const result = await ramp.handleWebhook("fake", webhook());
    expect(result).toMatchObject({ status: 401, outcome: "invalid_signature" });
  });

  it("flags amount mismatches and does not settle", async () => {
    const { provider, state } = fakeProvider();
    const settlement = vi.fn(async () => ({}));
    const ramp = new CosmosRamp({ providers: [provider], oracle: fixedOracle(1000), settlement });

    const order = await ramp.onramp({ provider: "fake", amount: 10000, currency: "ARS" });
    state.chargeState = {
      id: "pay-1",
      status: "approved",
      amount: 5000, // user paid half
      currency: "ARS",
      reference: order.id,
    };

    const result = await ramp.handleWebhook("fake", webhook());
    expect(result).toMatchObject({ status: 400, outcome: "amount_mismatch" });
    expect(settlement).not.toHaveBeenCalled();
  });

  it("keeps the order in settling on failure and supports retrySettlement", async () => {
    const { provider, state } = fakeProvider();
    const settlement = vi
      .fn(async () => ({ txId: "tx-ok" }))
      .mockRejectedValueOnce(new Error("rpc down"));
    const ramp = new CosmosRamp({ providers: [provider], oracle: fixedOracle(1000), settlement });

    const order = await ramp.onramp({ provider: "fake", amount: 1000, currency: "ARS" });
    state.chargeState = {
      id: "pay-1",
      status: "approved",
      amount: 1000,
      currency: "ARS",
      reference: order.id,
    };
    ramp.on("error", () => {}); // swallow the emitted settlement error

    const result = await ramp.handleWebhook("fake", webhook());
    expect(result.outcome).toBe("settlement_failed");
    expect((await ramp.getOrder(order.id))?.status).toBe("settling");

    const retried = await ramp.retrySettlement(order.id);
    expect(retried.status).toBe("completed");
    expect(retried.settlementTxId).toBe("tx-ok");
  });

  it("ignores webhooks for unknown orders and non-payment events", async () => {
    const { provider, state } = fakeProvider();
    const ramp = new CosmosRamp({ providers: [provider], oracle: fixedOracle(1000) });
    state.chargeState.reference = "someone-elses-order";

    const unknown = await ramp.handleWebhook("fake", webhook());
    expect(unknown.outcome).toBe("order_not_found");
    expect(unknown.status).toBe(200);

    const test = await ramp.handleWebhook("fake", {
      body: JSON.stringify({ type: "test", data: {} }),
      headers: {},
    });
    expect(test.outcome).toBe("ignored");
  });
});

// ---------------------------------------------------------------------------
// Offramp flow
// ---------------------------------------------------------------------------

describe("CosmosRamp offramp flow", () => {
  it("pays out through the provider when supported", async () => {
    const { provider } = fakeProvider();
    const payout = vi.fn(async () => ({ id: "payout-1", status: "sent" as const }));
    (provider as PaymentProvider).createPayout = payout;

    const ramp = new CosmosRamp({ providers: [provider], oracle: fixedOracle(1000) });
    const order = await ramp.offramp({
      provider: "fake",
      cryptoAmount: 100,
      currency: "ARS",
      spread: 0.02,
      destination: { email: "user@example.com" },
    });
    expect(order.quote.fiatAmount).toBe(98000);

    const done = await ramp.confirmCryptoReceived(order.id, { txId: "0xabc" });
    expect(done.status).toBe("completed");
    expect(payout).toHaveBeenCalledWith(
      expect.objectContaining({ amount: 98000, currency: "ARS", reference: order.id }),
    );
  });

  it("emits payout:required when the provider cannot pay out", async () => {
    const { provider } = fakeProvider();
    const ramp = new CosmosRamp({ providers: [provider], oracle: fixedOracle(1000) });
    const required = vi.fn();
    ramp.on("payout:required", required);

    const order = await ramp.offramp({ provider: "fake", cryptoAmount: 1, currency: "ARS" });
    await ramp.confirmCryptoReceived(order.id);
    expect(required).toHaveBeenCalledTimes(1);

    const done = await ramp.confirmPayoutSent(order.id, { payoutId: "manual-1" });
    expect(done.status).toBe("completed");
  });
});

// ---------------------------------------------------------------------------
// CoinGecko oracle
// ---------------------------------------------------------------------------

describe("CoinGeckoOracle", () => {
  it("fetches and caches simple prices", async () => {
    const { fetchImpl, requests } = createMockFetch([
      { route: "GET /api/v3/simple/price", response: { "usd-coin": { ars: 1350.5 } } },
    ]);
    const oracle = new CoinGeckoOracle({ fetch: fetchImpl });

    expect(await oracle.getRate("USDC", "ARS")).toBe(1350.5);
    expect(await oracle.getRate("USDC", "ARS")).toBe(1350.5); // served from cache
    expect(requests).toHaveLength(1);
    expect(requests[0]!.url).toContain("ids=usd-coin");
    expect(requests[0]!.url).toContain("vs_currencies=ars");
  });

  it("maps known symbols and falls back to lowercase ids", () => {
    const oracle = new CoinGeckoOracle({ fetch: (() => {}) as unknown as typeof fetch });
    expect(oracle.coinIdFor("USDC")).toBe("usd-coin");
    expect(oracle.coinIdFor("Bitcoin")).toBe("bitcoin");
  });

  it("throws OracleError when the pair has no price", async () => {
    const { fetchImpl } = createMockFetch([
      { route: "GET /api/v3/simple/price", response: {} },
    ]);
    const oracle = new CoinGeckoOracle({ fetch: fetchImpl });
    await expect(oracle.getRate("USDC", "ARS")).rejects.toThrow(OracleError);
  });

  it("applySpread respects direction", () => {
    expect(applySpread(1000, 0.02, "onramp")).toBe(1020);
    expect(applySpread(1000, 0.02, "offramp")).toBe(980);
    expect(() => applySpread(1000, -0.1, "onramp")).toThrow(OracleError);
  });
});
