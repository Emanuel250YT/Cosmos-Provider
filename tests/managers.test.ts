import { describe, expect, it } from "vitest";
import { EtherfuseClient } from "@/client/EtherfuseClient";
import { LookupClient } from "@/client/LookupClient";
import { EtherfuseError } from "@/atoms/errors";
import { Quote } from "@/molecules/Quote";
import { createMockFetch, type MockRule } from "./helpers/mockFetch";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function makeClient(rules: MockRule[], options: Record<string, unknown> = {}) {
  const { fetchImpl, requests } = createMockFetch(rules);
  const client = new EtherfuseClient({ apiKey: "sk_test", fetch: fetchImpl, ...options });
  return { client, requests };
}

describe("QuoteManager", () => {
  const quoteResponse = {
    quoteId: "q-1",
    blockchain: "solana",
    sourceAmount: "500",
    destinationAmount: "91.20",
    exchangeRate: "5.48",
    expiresAt: new Date(Date.now() + 120_000).toISOString(),
  };

  it("generates quoteId automatically and uses defaultCustomerId", async () => {
    const { client, requests } = makeClient(
      [{ route: "POST /ramp/quote", response: quoteResponse }],
      { defaultCustomerId: "org-123" },
    );
    const quote = await client.quotes.create({
      blockchain: "solana",
      sourceAmount: "500",
      quoteAssets: { type: "onramp", sourceAsset: "BRL", targetAsset: "USDC..." },
    });
    expect(quote).toBeInstanceOf(Quote);
    expect(quote.isExpired).toBe(false);
    const body = requests[0]!.body as Record<string, unknown>;
    expect(body["quoteId"]).toMatch(UUID_RE);
    expect(body["customerId"]).toBe("org-123");
  });

  it("throws if there is neither customerId nor defaultCustomerId", async () => {
    const { client } = makeClient([]);
    await expect(
      client.quotes.create({
        blockchain: "solana",
        sourceAmount: "500",
        quoteAssets: { type: "onramp", sourceAsset: "BRL", targetAsset: "X" },
      }),
    ).rejects.toThrow(EtherfuseError);
  });

  it("quote.createOrder sets the quoteId from the quote", async () => {
    const { client, requests } = makeClient(
      [
        { route: "POST /ramp/quote", response: quoteResponse },
        { route: "POST /ramp/order", response: { onramp: { orderId: "o-1" } } },
      ],
      { defaultCustomerId: "org-123" },
    );
    const quote = await client.quotes.create({
      blockchain: "solana",
      sourceAmount: "500",
      quoteAssets: { type: "onramp", sourceAsset: "BRL", targetAsset: "X" },
    });
    const receipt = await quote.createOrder({ bankAccountId: "ba-1" });
    expect(receipt.orderId).toBe("o-1");
    const orderBody = requests[1]!.body as Record<string, unknown>;
    expect(orderBody["quoteId"]).toBe("q-1");
    expect(orderBody["bankAccountId"]).toBe("ba-1");
    expect(orderBody["orderId"]).toMatch(UUID_RE);
  });
});

describe("BankAccountManager", () => {
  it("createPixPersonal sends the payload to the customer route with transactionId", async () => {
    const { client, requests } = makeClient([
      {
        route: "POST /ramp/customer/org-123/bank-account",
        status: 201,
        response: { bankAccountId: "ba-1", customerId: "org-123", currency: "BRL" },
      },
    ]);
    const account = await client.bankAccounts.createPixPersonal("org-123", {
      firstName: "João",
      lastName: "Silva",
      cpf: "12345678909",
      pixKey: "joao@exemplo.com.br",
      pixKeyType: "email",
    });
    expect(account.isPix).toBe(true);
    const body = requests[0]!.body as { account: Record<string, unknown> };
    expect(body.account["transactionId"]).toMatch(UUID_RE);
    expect(body.account["pixKey"]).toBe("joao@exemplo.com.br");
  });

  it("respects an explicit transactionId (idempotency)", async () => {
    const { client, requests } = makeClient([
      {
        route: "POST /ramp/customer/org-123/bank-account",
        response: { bankAccountId: "ba-1", customerId: "org-123", currency: "MXN" },
      },
    ]);
    await client.bankAccounts.createClabePersonal("org-123", {
      transactionId: "11111111-2222-4333-8444-555555555555",
      firstName: "Ana",
      paternalLastName: "García",
      birthDate: "19900515",
      birthCountryIsoCode: "MX",
      curp: "GALA900515MDFRPN08",
      rfc: "GALA900515AB1",
      clabe: "646180157000000004",
    });
    const body = requests[0]!.body as { account: Record<string, unknown> };
    expect(body.account["transactionId"]).toBe("11111111-2222-4333-8444-555555555555");
  });
});

describe("SandboxManager", () => {
  it("fiatReceived calls the sandbox endpoint with the orderId", async () => {
    const { client, requests } = makeClient([
      { route: "POST /ramp/order/fiat_received", response: {} },
    ]);
    await client.sandbox.fiatReceived("o-1");
    expect(requests[0]!.body).toEqual({ orderId: "o-1" });
  });

  it("refuses to run against production", async () => {
    const { client } = makeClient([], { environment: "production" });
    expect(() => client.sandbox.fiatReceived("o-1")).toThrow(/sandbox/);
  });
});

describe("LookupManager / LookupClient", () => {
  const rates = { usd_to_brl: { rate: "5.07" }, usd_to_mxn: { rate: "17.34" } };

  it("client.lookup does not send Authorization (public endpoint)", async () => {
    const { client, requests } = makeClient([
      { route: "GET /lookup/exchange_rate", response: rates },
    ]);
    const brl = await client.lookup.usdToBrl();
    expect(brl?.rate).toBe("5.07");
    expect(requests[0]!.headers["authorization"]).toBeUndefined();
  });

  it("passes max_age as a query param", async () => {
    const { client, requests } = makeClient([
      { route: "GET /lookup/exchange_rate", response: rates },
    ]);
    await client.lookup.exchangeRates(60);
    expect(new URL(requests[0]!.url).searchParams.get("max_age")).toBe("60");
  });

  it("LookupClient works without an API key and points to production by default", async () => {
    const { fetchImpl, requests } = createMockFetch([
      { route: "GET /lookup/exchange_rate", response: rates },
    ]);
    const lookup = new LookupClient({ fetch: fetchImpl });
    const mxn = await lookup.usdToMxn();
    expect(mxn?.rate).toBe("17.34");
    expect(requests[0]!.url).toContain("https://api.etherfuse.com");
    expect(requests[0]!.headers["authorization"]).toBeUndefined();
  });
});

describe("OrderManager", () => {
  it("fetch returns a hydrated Order", async () => {
    const { client } = makeClient([
      {
        route: "GET /ramp/order/o-9",
        response: { orderId: "o-9", status: "funded", orderType: "onramp" },
      },
    ]);
    const order = await client.orders.fetch("o-9");
    expect(order.id).toBe("o-9");
    expect(order.status).toBe("funded");
  });

  it("list maps items to Order structures", async () => {
    const { client } = makeClient([
      {
        route: "GET /ramp/orders",
        response: {
          items: [{ orderId: "a" }, { orderId: "b" }],
          pageNumber: 0,
          pageSize: 30,
          totalItems: 2,
          totalPages: 1,
        },
      },
    ]);
    const page = await client.orders.list();
    expect(page.items.map((o) => o.id)).toEqual(["a", "b"]);
    expect(page.totalItems).toBe(2);
  });
});
