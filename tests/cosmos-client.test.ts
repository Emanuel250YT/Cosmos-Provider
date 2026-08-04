/** Tests for CosmosClient — the single entry point wiring ramp + Etherfuse + Koywe + SEP helpers. */

import { describe, expect, it } from "vitest";
import { CosmosClient } from "@/core/CosmosClient";
import { CoinGeckoOracle } from "@/oracles/CoinGeckoOracle";
import { fetchStellarToml } from "@/client/sep";
import { createMockFetch } from "./helpers/mockFetch";

describe("CosmosClient — mercadopago only", () => {
  it("builds client.ramp and client.mercadopago; leaves etherfuse/koywe undefined", () => {
    const { fetchImpl } = createMockFetch([]);
    const client = new CosmosClient({
      mercadopago: { accessToken: "TEST-token", fetch: fetchImpl },
    });

    expect(client.ramp).toBeDefined();
    expect(client.mercadopago).toBeDefined();
    expect(client.etherfuse).toBeUndefined();
    expect(client.koywe).toBeUndefined();
    expect(client.oracle).toBeInstanceOf(CoinGeckoOracle);
  });

  it("routes onramp calls through client.ramp to the right per-currency account", async () => {
    const { fetchImpl: arFetch, requests: arRequests } = createMockFetch([
      { route: "POST /checkout/preferences", response: { id: "ar-pref", init_point: "https://mp.example/ar" } },
    ]);
    const { fetchImpl: brFetch, requests: brRequests } = createMockFetch([
      {
        route: "POST /v1/payments",
        response: { id: 42, point_of_interaction: { transaction_data: { qr_code: "00020126...BR" } } },
      },
    ]);
    // A single fetch that dispatches by which mock recorded the call — since
    // CosmosClient only takes one `fetch` for the whole provider, we merge
    // both mock request logs by trying AR's mock first, then BR's, per call.
    const merged: typeof fetch = (async (input, init) => {
      const url = String(input);
      if (url.includes("/checkout/preferences")) return arFetch(input, init);
      return brFetch(input, init);
    }) as typeof fetch;

    const client = new CosmosClient({
      mercadopago: {
        accounts: {
          ARS: { accessToken: "TEST-ar-token" },
          BRL: { accessToken: "TEST-br-token", defaultPayerEmail: "buyer@example.com.br" },
        },
        fetch: merged,
      },
    });

    const arOrder = await client.ramp!.onramp({ provider: "mercadopago", amount: 1000, currency: "ARS", method: "link" });
    expect(arOrder.charge?.link).toBe("https://mp.example/ar");
    expect(arRequests[0]!.headers["authorization"]).toBe("Bearer TEST-ar-token");

    const brOrder = await client.ramp!.onramp({ provider: "mercadopago", amount: 100, currency: "BRL", method: "qr" });
    expect(brOrder.charge?.qr).toBe("00020126...BR");
    expect(brRequests[0]!.headers["authorization"]).toBe("Bearer TEST-br-token");
  });
});

describe("CosmosClient — etherfuse/koywe only", () => {
  it("builds client.etherfuse/client.koywe and leaves client.ramp undefined", () => {
    const client = new CosmosClient({
      etherfuse: { apiKey: "api_sand:test", environment: "sandbox" },
      koywe: { clientId: "id", secret: "secret", baseUrl: "https://api-sandbox.koywe.com", usdcIssuer: "GISSUER" },
    });

    expect(client.etherfuse).toBeDefined();
    expect(client.koywe).toBeDefined();
    expect(client.ramp).toBeUndefined();
    expect(client.mercadopago).toBeUndefined();
  });

  it("rejects settlement/store/webhooks with no fiat provider configured", () => {
    expect(
      () =>
        new CosmosClient({
          etherfuse: { apiKey: "api_sand:test", environment: "sandbox" },
          settlement: async () => ({}),
        }),
    ).toThrow(/needs at least one fiat provider/);
  });
});

describe("CosmosClient — shared oracle and sep helpers", () => {
  it("uses a RateOracle instance passed in as-is", () => {
    const { fetchImpl } = createMockFetch([]);
    const customOracle = { getRate: async () => 1234 };
    const client = new CosmosClient({
      mercadopago: { accessToken: "TEST-token", fetch: fetchImpl },
      oracle: customOracle,
    });
    expect(client.oracle).toBe(customOracle);
  });

  it("exposes the real SEP helper functions under client.sep", () => {
    const { fetchImpl } = createMockFetch([]);
    const client = new CosmosClient({ mercadopago: { accessToken: "TEST-token", fetch: fetchImpl } });
    expect(client.sep.fetchStellarToml).toBe(fetchStellarToml);
  });
});
