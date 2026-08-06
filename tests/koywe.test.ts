/** Tests for the Koywe client (ARS/CLP/MXN/COP/PEN/BRL <-> USDC on Stellar). */

import { describe, expect, it } from "vitest";
import { KoyweClient, KoyweError, isValidStellarPublicKey, resolveFiatLimits } from "@/client/koywe";
import { createMockFetch } from "./helpers/mockFetch";

// Deterministic, self-consistent "G..." address (valid StrKey checksum).
const STELLAR_ADDRESS = "GAAQEAYEAUDAOCAJBIFQYDIOB4IBCEQTCQKRMFYYDENBWHA5DYPSABOV";

const client = (fetchImpl: typeof fetch) =>
  new KoyweClient({
    clientId: "client-1",
    secret: "secret-1",
    baseUrl: "https://api-sandbox.koywe.com",
    usdcIssuer: "GISSUER",
    fetch: fetchImpl,
  });

describe("KoyweClient construction", () => {
  it("requires clientId and secret", () => {
    expect(
      () => new KoyweClient({ clientId: "", secret: "", baseUrl: "https://x", usdcIssuer: "G" }),
    ).toThrow(KoyweError);
  });

  it("exposes the injected USDC issuer in supportedTokens", () => {
    const { fetchImpl } = createMockFetch([]);
    const koywe = client(fetchImpl);
    expect(koywe.supportedTokens).toEqual([
      { symbol: "USDC", name: "USD Coin", issuer: "GISSUER", koyweSymbol: "USDC Stellar", decimals: 6 },
    ]);
  });
});

describe("KoyweClient environment/baseUrl", () => {
  it("defaults to sandbox and its base URL when neither is given", () => {
    const koywe = new KoyweClient({ clientId: "a", secret: "b", usdcIssuer: "G" });
    expect(koywe.environment).toBe("sandbox");
    expect(koywe.baseUrl).toBe("https://api-sandbox.koywe.com");
  });

  it("resolves the production base URL from environment: \"production\"", () => {
    const koywe = new KoyweClient({ clientId: "a", secret: "b", usdcIssuer: "G", environment: "production" });
    expect(koywe.environment).toBe("production");
    expect(koywe.baseUrl).toBe("https://api.koywe.com");
  });

  it("an explicit baseUrl overrides the environment default", () => {
    const koywe = new KoyweClient({
      clientId: "a",
      secret: "b",
      usdcIssuer: "G",
      environment: "production",
      baseUrl: "https://proxy.example.com/koywe/",
    });
    expect(koywe.baseUrl).toBe("https://proxy.example.com/koywe"); // trailing slash trimmed
  });

  it("falls through to the environment default when baseUrl is an empty string", () => {
    const koywe = new KoyweClient({ clientId: "a", secret: "b", usdcIssuer: "G", baseUrl: "" });
    expect(koywe.baseUrl).toBe("https://api-sandbox.koywe.com");
  });
});

describe("isValidStellarPublicKey", () => {
  it("accepts a well-formed StrKey ed25519 address", () => {
    expect(isValidStellarPublicKey(STELLAR_ADDRESS)).toBe(true);
  });

  it("rejects a tampered checksum", () => {
    const tampered = STELLAR_ADDRESS.slice(0, -1) + (STELLAR_ADDRESS.endsWith("V") ? "A" : "V");
    expect(isValidStellarPublicKey(tampered)).toBe(false);
  });

  it("rejects non-address strings", () => {
    expect(isValidStellarPublicKey("not-an-address")).toBe(false);
    expect(isValidStellarPublicKey("")).toBe(false);
  });
});

describe("KoyweClient auth", () => {
  it("caches the app token across catalogue calls", async () => {
    const { fetchImpl, requests } = createMockFetch([
      { route: "POST /rest/auth", response: { token: "app-jwt" } },
      { route: "GET /rest/token-currencies", response: [] },
    ]);
    const koywe = client(fetchImpl);

    await koywe.getTokenCurrencies();
    await koywe.getTokenCurrencies();

    const authCalls = requests.filter((r) => r.path === "/rest/auth");
    expect(authCalls).toHaveLength(1);
    const tokenCalls = requests.filter((r) => r.path === "/rest/token-currencies");
    expect(tokenCalls).toHaveLength(2);
    expect(tokenCalls[0]!.headers["authorization"]).toBe("Bearer app-jwt");
  });

  it("caches a separate token per email", async () => {
    const { fetchImpl, requests } = createMockFetch([
      { route: "POST /rest/auth", response: { token: "user-jwt" } },
      { route: "GET /rest/accounts/*", response: { canOperate: true, accountStatus: "approved" } },
    ]);
    const koywe = client(fetchImpl);

    await koywe.checkAccount("alice@example.com");
    await koywe.checkAccount("alice@example.com");

    expect(requests.filter((r) => r.path === "/rest/auth")).toHaveLength(1);
    expect(requests[0]!.body).toMatchObject({ clientId: "client-1", secret: "secret-1", email: "alice@example.com" });
  });
});

describe("KoyweClient discovery", () => {
  it("resolves fiat limits from the token-currencies catalogue", async () => {
    const tokens = [
      {
        symbol: "USDC Stellar",
        currencies: [{ symbol: "ARS", minimum: 1000, maximum: 500000 }],
      },
    ];
    expect(resolveFiatLimits(tokens, "ARS")).toEqual({ min: 1000, max: 500000 });
    expect(resolveFiatLimits(tokens, "BRL")).toBeNull();
  });

  it("maps payment providers to labeled rails", async () => {
    const { fetchImpl } = createMockFetch([
      { route: "POST /rest/auth", response: { token: "app-jwt" } },
      {
        route: "GET /rest/payment-providers*",
        response: [{ _id: "p1", name: "WIREAR", fee: 0 }],
      },
    ]);
    const methods = await client(fetchImpl).getPaymentProviders("ARS");
    expect(methods).toEqual([
      { id: "p1", name: "WIREAR", label: "Bank transfer (CVU)", rail: "wirear", fee: 0, details: undefined, deposit: undefined },
    ]);
  });

  it("parses a WIREAR payment method's `details` into structured deposit instructions", async () => {
    const { fetchImpl } = createMockFetch([
      { route: "POST /rest/auth", response: { token: "app-jwt" } },
      {
        route: "GET /rest/payment-providers*",
        response: [
          {
            _id: "p1",
            name: "WIREAR",
            fee: 0,
            details: " CVU 0000053600000017871248 \n alias 30718280229.KOYWE1 \n Banco Coinag \n tef@koywe.com ",
          },
        ],
      },
    ]);
    const [method] = await client(fetchImpl).getPaymentProviders("ARS");
    expect(method!.details).toContain("CVU");
    expect(method!.deposit).toEqual({
      raw: expect.stringContaining("CVU"),
      cvu: "0000053600000017871248",
      alias: "30718280229.KOYWE1",
      bankName: "Banco Coinag",
      email: "tef@koywe.com",
    });
  });
});

describe("KoyweClient quotes", () => {
  it("builds an onramp quote", async () => {
    const { fetchImpl, requests } = createMockFetch([
      { route: "POST /rest/auth", response: { token: "app-jwt" } },
      {
        route: "POST /rest/quotes",
        response: {
          quoteId: "q1",
          amountIn: 10000,
          amountOut: 9.5,
          symbolIn: "ARS",
          symbolOut: "USDC Stellar",
          exchangeRate: 1052.6,
          koyweFee: 10,
          networkFee: 0,
          validUntil: Math.floor(Date.now() / 1000) + 120,
        },
      },
    ]);

    const quote = await client(fetchImpl).getQuote({
      ramp: "onramp",
      fiatCurrency: "ARS",
      amount: "10000",
      paymentMethodId: "p1",
    });

    expect(quote).toMatchObject({ id: "q1", targetAsset: "USDC", sourceAsset: "ARS", destinationAmount: "9.5" });
    const body = requests[1]!.body as Record<string, unknown>;
    expect(body).toMatchObject({ amountIn: 10000, symbolIn: "ARS", symbolOut: "USDC Stellar", paymentMethodId: "p1" });
  });
});

describe("KoyweClient on-ramp orders", () => {
  it("rejects a missing stellarAddress", async () => {
    const { fetchImpl } = createMockFetch([{ route: "POST /rest/auth", response: { token: "t" } }]);
    await expect(
      client(fetchImpl).createOnRampOrder({ quoteId: "q1", stellarAddress: "" }),
    ).rejects.toThrow(/`stellarAddress` is required/);
  });

  it("rejects an invalid stellarAddress", async () => {
    const { fetchImpl } = createMockFetch([{ route: "POST /rest/auth", response: { token: "t" } }]);
    await expect(
      client(fetchImpl).createOnRampOrder({ quoteId: "q1", stellarAddress: "not-valid" }),
    ).rejects.toThrow(/Invalid Stellar public key/);
  });

  it("returns the order's interactiveUrl (returned for every rail, including WIREAR)", async () => {
    const { fetchImpl } = createMockFetch([
      { route: "POST /rest/auth", response: { token: "t" } },
      {
        route: "POST /rest/orders",
        response: {
          orderId: "o1",
          quoteId: "q1",
          status: "WAITING",
          amountIn: 10000,
          amountOut: 9.5,
          symbolIn: "ARS",
          symbolOut: "USDC Stellar",
          providedAction: "https://koywe.example/pay/o1",
        },
      },
    ]);

    const order = await client(fetchImpl).createOnRampOrder({
      quoteId: "q1",
      stellarAddress: STELLAR_ADDRESS,
      email: "alice@example.com",
    });

    expect(order.interactiveUrl).toBe("https://koywe.example/pay/o1");
  });

  it("surfaces a hosted redirect URL for QRI/Khipu orders", async () => {
    const { fetchImpl } = createMockFetch([
      { route: "POST /rest/auth", response: { token: "t" } },
      {
        route: "POST /rest/orders",
        response: {
          orderId: "o2",
          quoteId: "q1",
          status: "WAITING",
          amountIn: 10000,
          amountOut: 9.5,
          symbolIn: "ARS",
          symbolOut: "USDC Stellar",
          providedAction: "https://koywe.example/pay/o2",
        },
      },
    ]);

    const order = await client(fetchImpl).createOnRampOrder({ quoteId: "q1", stellarAddress: STELLAR_ADDRESS });
    expect(order.interactiveUrl).toBe("https://koywe.example/pay/o2");
  });
});

describe("KoyweClient off-ramp orders", () => {
  it("registers a bank account and creates an off-ramp order", async () => {
    const { fetchImpl, requests } = createMockFetch([
      { route: "POST /rest/auth", response: { token: "t" } },
      {
        route: "POST /rest/bank-accounts",
        response: { _id: "ba1", accountNumber: "123", countryCode: "AR", currencySymbol: "ARS", name: "Banco X" },
      },
      {
        route: "POST /rest/orders",
        response: {
          orderId: "o3",
          quoteId: "q2",
          status: "WAITING",
          amountIn: 10,
          amountOut: 10500,
          symbolIn: "USDC Stellar",
          symbolOut: "ARS",
          providedAction: "https://koywe.example/pay/o3",
        },
      },
    ]);
    const koywe = client(fetchImpl);

    const account = await koywe.createBankAccount({
      email: "bob@example.com",
      accountNumber: "123",
      countryCode: "AR",
      currencySymbol: "ARS",
    });
    expect(account).toEqual({ id: "ba1", accountNumber: "123", countryCode: "AR", currencySymbol: "ARS", bankCode: undefined, bankName: "Banco X" });

    const order = await koywe.createOffRampOrder({ quoteId: "q2", bankAccountId: account.id, email: "bob@example.com" });
    expect(order).toMatchObject({ id: "o3", bankAccountId: "ba1", interactiveUrl: "https://koywe.example/pay/o3" });
    expect(requests.find((r) => r.path === "/rest/orders")!.body).toMatchObject({ destinationAddress: "ba1" });
  });

  it("fetches the deposit address for an off-ramp crypto symbol", async () => {
    const { fetchImpl, requests } = createMockFetch([
      { route: "POST /rest/auth", response: { token: "t" } },
      { route: "GET /rest/client/getAddress", response: { address: STELLAR_ADDRESS } },
    ]);
    const address = await client(fetchImpl).getClientAddress();
    expect(address).toBe(STELLAR_ADDRESS);
    expect(requests[1]!.path).toBe("/rest/client/getAddress");
    expect(requests[1]!.url).toContain("cryptoSymbol=USDC%20Stellar");
  });

  it("returns an empty string when the API omits the address", async () => {
    const { fetchImpl } = createMockFetch([
      { route: "POST /rest/auth", response: { token: "t" } },
      { route: "GET /rest/client/getAddress", response: {} },
    ]);
    expect(await client(fetchImpl).getClientAddress("BTC")).toBe("");
  });

  it("submits a tx hash for reconciliation", async () => {
    const { fetchImpl, requests } = createMockFetch([
      { route: "POST /rest/auth", response: { token: "t" } },
      { route: "POST /rest/orders/o3/txHash", response: {} },
    ]);
    await client(fetchImpl).submitTxHash("o3", "abcd1234", "bob@example.com");
    expect(requests[1]!.body).toEqual({ txHash: "abcd1234" });
  });
});

describe("KoyweClient order lookup", () => {
  it("returns null on 404", async () => {
    const { fetchImpl } = createMockFetch([
      { route: "POST /rest/auth", response: { token: "t" } },
      { route: "GET /rest/orders/missing", status: 404, response: { message: "not found" } },
    ]);
    await expect(client(fetchImpl).getOrder("missing")).resolves.toBeNull();
  });

  it("looks up an order by externalId", async () => {
    const { fetchImpl } = createMockFetch([
      { route: "POST /rest/auth", response: { token: "t" } },
      {
        route: "GET /rest/orders/external_id/ext-1",
        response: { orderId: "o4", status: "completed", amountIn: 1, amountOut: 2, symbolIn: "ARS", symbolOut: "USDC Stellar" },
      },
    ]);
    const order = await client(fetchImpl).getOrderByExternalId("ext-1");
    expect(order).toMatchObject({ id: "o4", status: "completed" });
  });
});

describe("KoyweClient KYC", () => {
  it("reports not_started for an account that was never registered", async () => {
    const { fetchImpl } = createMockFetch([
      { route: "POST /rest/auth", response: { token: "t" } },
      { route: "GET /rest/accounts/*", status: 404, response: { message: "not found" } },
    ]);
    const check = await client(fetchImpl).checkAccount("new@example.com");
    expect(check).toEqual({ canOperate: false, accountStatus: "not_started", missing: [] });
  });

  it("requires an email to check an account", async () => {
    const { fetchImpl } = createMockFetch([]);
    await expect(client(fetchImpl).checkAccount()).rejects.toThrow(/email is required/);
  });

  it("registers a delegated-KYC account", async () => {
    const { fetchImpl, requests } = createMockFetch([
      { route: "POST /rest/auth", response: { token: "t" } },
      { route: "POST /rest/accounts", response: {} },
    ]);
    await client(fetchImpl).createAccount({
      email: "carol@example.com",
      document: { documentNumber: "1", documentType: "DNI", country: "AR" },
      address: { country: "AR", zipCode: "1000", state: "CABA", city: "CABA", street: "Main 1" },
      personalInfo: { firstName: "Carol" },
    });
    const body = requests[1]!.body as Record<string, any>;
    expect(body.document).toMatchObject({ documentNumber: "1", isCompany: false });
    expect(body.address).toMatchObject({ addressCountry: "AR", addressZipCode: "1000" });
  });
});

describe("KoyweClient error handling", () => {
  it("wraps a non-404 API error as KoyweError with status and code", async () => {
    const { fetchImpl } = createMockFetch([
      { route: "POST /rest/auth", response: { token: "t" } },
      { route: "GET /rest/token-currencies", status: 500, response: { message: "boom", error: "INTERNAL" } },
    ]);
    await expect(client(fetchImpl).getTokenCurrencies()).rejects.toMatchObject({
      code: "INTERNAL",
      statusCode: 500,
    });
  });

  it("surfaces auth failures", async () => {
    const { fetchImpl } = createMockFetch([{ route: "POST /rest/auth", status: 401, response: "invalid credentials" }]);
    await expect(client(fetchImpl).getTokenCurrencies()).rejects.toMatchObject({ code: "AUTH_FAILED" });
  });
});
