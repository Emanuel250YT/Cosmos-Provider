/** Tests for MemoryStore, HMAC helpers and engine → outgoing webhook wiring. */

import { describe, expect, it } from "vitest";
import { CosmosRamp } from "@/core/CosmosRamp";
import { MemoryStore } from "@/core/MemoryStore";
import { hmacSha256Hex, timingSafeEqualStr } from "@/core/signature";
import type { PaymentProvider, RampOrderData } from "@/core/types";
import { verifyCosmosSignature } from "@/webhooks/WebhookEmitter";
import { createMockFetch } from "./helpers/mockFetch";

const sampleOrder = (id: string, extra: Partial<RampOrderData> = {}): RampOrderData => ({
  id,
  direction: "onramp",
  status: "created",
  provider: "fake",
  quote: {
    asset: "USDC",
    currency: "ARS",
    rate: 1000,
    spread: 0.02,
    effectiveRate: 1020,
    fiatAmount: 10200,
    cryptoAmount: 10,
    quotedAt: Date.now(),
  },
  createdAt: Date.now(),
  updatedAt: Date.now(),
  ...extra,
});

describe("MemoryStore", () => {
  it("saves, gets, updates and lists orders", async () => {
    const store = new MemoryStore();
    await store.save(sampleOrder("a"));
    await store.save(sampleOrder("b"));

    expect((await store.get("a"))?.id).toBe("a");
    expect(await store.get("missing")).toBeNull();
    expect(await store.list()).toHaveLength(2);

    const updated = await store.update("a", { status: "paid" });
    expect(updated?.status).toBe("paid");
    expect((await store.get("a"))?.status).toBe("paid");
    expect(await store.update("missing", { status: "paid" })).toBeNull();
  });

  it("finds orders by provider charge id", async () => {
    const store = new MemoryStore();
    await store.save(sampleOrder("a", { chargeId: "pay-9" }));
    await store.save(
      sampleOrder("b", { charge: { id: "pref-7", method: "link", link: "https://x" } }),
    );

    expect((await store.findByChargeId("fake", "pay-9"))?.id).toBe("a");
    expect((await store.findByChargeId("fake", "pref-7"))?.id).toBe("b");
    expect(await store.findByChargeId("other-provider", "pay-9")).toBeNull();
    expect(await store.findByChargeId("fake", "nope")).toBeNull();
  });

  it("returns copies, not live references", async () => {
    const store = new MemoryStore();
    await store.save(sampleOrder("a"));
    const copy = (await store.get("a"))!;
    copy.status = "failed";
    expect((await store.get("a"))!.status).toBe("created");
  });
});

describe("signature helpers", () => {
  it("computes stable HMAC-SHA256 hex digests", async () => {
    const digest = await hmacSha256Hex("secret", "message");
    expect(digest).toMatch(/^[0-9a-f]{64}$/);
    expect(await hmacSha256Hex("secret", "message")).toBe(digest);
    expect(await hmacSha256Hex("other", "message")).not.toBe(digest);
  });

  it("compares strings in constant time semantics", () => {
    expect(timingSafeEqualStr("abc", "abc")).toBe(true);
    expect(timingSafeEqualStr("abc", "abd")).toBe(false);
    expect(timingSafeEqualStr("abc", "abcd")).toBe(false);
  });
});

describe("CosmosRamp outgoing webhooks", () => {
  it("broadcasts signed order events to configured endpoints", async () => {
    const { fetchImpl, requests } = createMockFetch([
      { route: "POST /hooks/cosmos", response: {} },
    ]);

    const provider: PaymentProvider = {
      name: "fake",
      regions: ["AR"],
      currencies: ["ARS"],
      createCharge: async () => ({ id: "c1", method: "link", link: "https://pay" }),
      getCharge: async () => ({
        id: "c1",
        status: "approved",
        amount: 10200,
        currency: "ARS",
        reference: "",
      }),
      verifyWebhook: async () => true,
      parseWebhook: async () => ({ chargeId: "c1", kind: "payment" }),
    };

    const ramp = new CosmosRamp({
      providers: [provider],
      oracle: { getRate: async () => 1000 },
      settlement: async () => ({ txId: "tx" }),
      webhooks: {
        endpoints: [{ url: "https://app.example/hooks/cosmos", secret: "hook-secret" }],
        fetch: fetchImpl,
      },
    });

    const order = await ramp.onramp({
      provider: "fake",
      amount: 10200,
      currency: "ARS",
      spread: 0.02,
      wallet: "W",
    });
    await ramp.handleWebhook("fake", { body: "{}", headers: {} });

    const types = requests.map((request) => (request.body as { type: string }).type);
    expect(types).toEqual([
      "order.created",
      "payment.approved",
      "settlement.released",
      "order.completed",
    ]);

    // Every delivery is verifiable with the shared secret.
    for (const request of requests) {
      const ok = await verifyCosmosSignature(
        JSON.stringify(request.body),
        request.headers["x-cosmos-signature"],
        "hook-secret",
      );
      expect(ok).toBe(true);
    }

    const data = requests[3]!.body as { data: RampOrderData };
    expect(data.data.id).toBe(order.id);
    expect(data.data.status).toBe("completed");
  });
});
