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

describe("CosmosClient — auto-dispatch (client.<method> without client.mercadopago!/client.koywe!)", () => {
  it("forwards a mercadopago-only method straight to client.mercadopago", async () => {
    const { fetchImpl, requests } = createMockFetch([
      {
        route: "POST /v1/payments",
        response: { id: 55, point_of_interaction: { transaction_data: { qr_code: "00020126...pix" } } },
      },
    ]);
    const client = new CosmosClient({
      mercadopago: { accessToken: "APP_USR-token", sandbox: false, defaultPayerEmail: "buyer@example.com.br", fetch: fetchImpl },
    });

    const charge = await client.createPixCharge({ amount: 50, reference: "order-1" });

    expect(charge).toMatchObject({ id: "55", qr: "00020126...pix" });
    expect(requests[0]!.headers["authorization"]).toBe("Bearer APP_USR-token");
  });

  it("forwards a koywe-only method straight to client.koywe", async () => {
    const { fetchImpl } = createMockFetch([
      { route: "POST /rest/auth", response: { token: "app-jwt" } },
      {
        route: "POST /rest/quotes",
        response: { quoteId: "q-1", amountIn: 100, symbolIn: "ARS", amountOut: 0.1, symbolOut: "USDC Stellar" },
      },
    ]);
    const client = new CosmosClient({
      koywe: { clientId: "id", secret: "secret", baseUrl: "https://api-sandbox.koywe.com", usdcIssuer: "GISSUER", fetch: fetchImpl },
    });

    const quote = await client.getQuote({ ramp: "onramp", fiatCurrency: "ARS", amount: "100" });
    expect(quote.id).toBe("q-1");
  });

  it("throws a clear error when the needed provider isn't configured", async () => {
    const client = new CosmosClient({
      koywe: { clientId: "id", secret: "secret", baseUrl: "https://api-sandbox.koywe.com", usdcIssuer: "GISSUER" },
    });

    await expect(client.createPixCharge({ amount: 1, reference: "x" })).rejects.toThrow(
      /needs "mercadopago" configured/,
    );
  });

  it("still resolves unambiguous methods correctly when both mercadopago and koywe are configured", async () => {
    const { fetchImpl: mpFetch } = createMockFetch([
      {
        route: "POST /v1/payments",
        response: { id: 66, point_of_interaction: { transaction_data: { qr_code: "00020126...pix2" } } },
      },
    ]);
    const { fetchImpl: koyweFetch } = createMockFetch([
      { route: "POST /rest/auth", response: { token: "app-jwt" } },
      {
        route: "POST /rest/quotes",
        response: { quoteId: "q-2", amountIn: 100, symbolIn: "ARS", amountOut: 0.1, symbolOut: "USDC Stellar" },
      },
    ]);
    const client = new CosmosClient({
      mercadopago: { accessToken: "APP_USR-token", sandbox: false, defaultPayerEmail: "buyer@example.com.br", fetch: mpFetch },
      koywe: { clientId: "id", secret: "secret", baseUrl: "https://api-sandbox.koywe.com", usdcIssuer: "GISSUER", fetch: koyweFetch },
    });

    const charge = await client.createPixCharge({ amount: 50, reference: "order-2" });
    expect(charge.id).toBe("66");
    const quote = await client.getQuote({ ramp: "onramp", fiatCurrency: "ARS", amount: "100" });
    expect(quote.id).toBe("q-2");
  });

  it("leaves client.mercadopago/client.koywe/client.ramp/client.destroy working normally", () => {
    const { fetchImpl } = createMockFetch([]);
    const client = new CosmosClient({ mercadopago: { accessToken: "TEST-token", fetch: fetchImpl } });

    expect(client.mercadopago).toBeInstanceOf(Object);
    expect(client.ramp).toBeDefined();
    expect(client.koywe).toBeUndefined();
    expect(() => client.destroy()).not.toThrow();
  });
});

describe("CosmosClient — createPaymentLink (unified, cross-provider)", () => {
  it("mercadopago: returns a normalized result and synthesizes a QR from the link", async () => {
    const { fetchImpl } = createMockFetch([
      { route: "POST /checkout/preferences", response: { id: "pref-1", init_point: "https://mp.example/pref-1" } },
    ]);
    const client = new CosmosClient({ mercadopago: { accessToken: "TEST-token", fetch: fetchImpl } });

    const result = await client.createPaymentLink({ amount: 1000, currency: "ARS", reference: "order-1" });

    expect(result.provider).toBe("mercadopago");
    expect(result.id).toBe("pref-1");
    expect(result.link).toBe("https://mp.example/pref-1");
    expect(result.qr).toBe("https://mp.example/pref-1"); // synthesized from the link, no native QR on a payment link
    expect(result.qrImage).toMatch(/^data:image\/png;base64,/);
    expect(result.synthesizedQr).toBe(true);
  });

  it("koywe: runs quote + createOnRampOrder and returns a normalized result", async () => {
    const { fetchImpl } = createMockFetch([
      { route: "POST /rest/auth", response: { token: "app-jwt" } },
      {
        route: "POST /rest/quotes",
        response: { quoteId: "q-1", amountIn: 10000, symbolIn: "ARS", amountOut: 9.8, symbolOut: "USDC Stellar" },
      },
      {
        route: "POST /rest/orders",
        response: {
          orderId: "order-1",
          quoteId: "q-1",
          status: "WAITING",
          amountIn: 10000,
          amountOut: 9.8,
          symbolIn: "ARS",
          symbolOut: "USDC Stellar",
          providedAction: "https://koywe.example/checkout/order-1",
        },
      },
    ]);
    const client = new CosmosClient({
      koywe: { clientId: "id", secret: "secret", baseUrl: "https://api-sandbox.koywe.com", usdcIssuer: "GISSUER", fetch: fetchImpl },
    });

    const result = await client.createPaymentLink({
      amount: 10000,
      currency: "ARS",
      wallet: "GDU6YICHDXCDNI2RTOSRD3OS67CCFWATQABYIUQU7AK63QLA5D23K4CH",
    });

    expect(result.provider).toBe("koywe");
    expect(result.id).toBe("order-1");
    expect(result.link).toBe("https://koywe.example/checkout/order-1");
    expect(result.qr).toBe("https://koywe.example/checkout/order-1");
    expect(result.qrImage).toMatch(/^data:image\/png;base64,/);
    expect(result.synthesizedQr).toBe(true);
    expect(result.status).toBe("WAITING");
  });

  it("koywe: requires wallet", async () => {
    const { fetchImpl } = createMockFetch([]);
    const client = new CosmosClient({
      koywe: { clientId: "id", secret: "secret", baseUrl: "https://api-sandbox.koywe.com", usdcIssuer: "GISSUER", fetch: fetchImpl },
    });

    await expect(client.createPaymentLink({ amount: 100, currency: "ARS" })).rejects.toThrow(/"wallet".*required/);
  });

  it("etherfuse: requires wallet, chain, and bankAccountId", async () => {
    const client = new CosmosClient({ etherfuse: { apiKey: "api_sand:test", environment: "sandbox" } });

    await expect(client.createPaymentLink({ amount: 100, currency: "BRL" })).rejects.toThrow(/"wallet".*required/);
    await expect(client.createPaymentLink({ amount: 100, currency: "BRL", wallet: "W" })).rejects.toThrow(/"chain".*required/);
    await expect(
      client.createPaymentLink({ amount: 100, currency: "BRL", wallet: "W", chain: "solana" }),
    ).rejects.toThrow(/"bankAccountId".*required/);
  });

  it("throws when no provider is configured at all", async () => {
    const client = new CosmosClient({});
    await expect(client.createPaymentLink({ amount: 1, currency: "ARS" })).rejects.toThrow(/no provider configured/);
  });

  it("throws asking for an explicit provider when more than one is configured", async () => {
    const { fetchImpl: mpFetch } = createMockFetch([]);
    const client = new CosmosClient({
      mercadopago: { accessToken: "TEST-token", fetch: mpFetch },
      koywe: { clientId: "id", secret: "secret", baseUrl: "https://api-sandbox.koywe.com", usdcIssuer: "GISSUER" },
    });

    await expect(client.createPaymentLink({ amount: 1, currency: "ARS" })).rejects.toThrow(
      /more than one provider is configured/,
    );
  });

  it("respects an explicit { provider } even when only one candidate is configured for real dispatch", async () => {
    const { fetchImpl } = createMockFetch([
      { route: "POST /checkout/preferences", response: { id: "pref-3", init_point: "https://mp.example/pref-3" } },
    ]);
    const client = new CosmosClient({ mercadopago: { accessToken: "TEST-token", fetch: fetchImpl } });

    const result = await client.createPaymentLink({ provider: "mercadopago", amount: 500, currency: "ARS" });
    expect(result.id).toBe("pref-3");

    await expect(
      client.createPaymentLink({ provider: "koywe", amount: 500, currency: "ARS" }),
    ).rejects.toThrow(/provider "koywe" is not configured/);
  });
});
