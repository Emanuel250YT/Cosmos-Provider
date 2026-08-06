/**
 * Tests for AbroadProvider and the provider-priced quoting path it exercises
 * in CosmosRamp.
 *
 * All against a mock fetch — never the live API. Abroad has no sandbox, so a
 * test that talked to it for real would mint genuine PIX charges.
 */

import { describe, expect, it } from "vitest";
import { CosmosRamp } from "@/core/CosmosRamp";
import { AbroadProvider } from "@/providers/abroad/AbroadProvider";
import { AbroadKycRequiredError, AbroadQuoteError } from "@/client/abroad/errors";
import { createMockFetch } from "./helpers/mockFetch";

/** An oracle that must never be consulted for a provider-priced rail — calling it fails the test. */
const forbiddenOracle = {
  getRate: async () => {
    throw new Error("the oracle must not be used to price a provider that quotes its own orders");
  },
};

const ONRAMP_QUOTE = {
  quote_id: "q-onramp-1",
  value: 18.975411,
  fee: { amount: "0.189754", currency: "USDC", type: "percentage" },
  expiration_time: 1786030685661,
};

const REVERSE_QUOTE = {
  quote_id: "q-reverse-1",
  value: 97.72,
  fee: { amount: "0.491505", currency: "USDC", type: "combined" },
  expiration_time: 1786030688347,
};

function provider(rules: Parameters<typeof createMockFetch>[0], options?: { name?: string }) {
  const mock = createMockFetch(rules);
  return {
    mock,
    abroad: new AbroadProvider({ apiKey: "partner_test", userId: "user-1", fetch: mock.fetchImpl, ...options }),
  };
}

describe("AbroadProvider quoting", () => {
  it("prices an onramp from the fiat side and reports the provider's own fee", async () => {
    const { abroad, mock } = provider([{ route: "POST /quote/onramp", response: ONRAMP_QUOTE }]);
    const ramp = new CosmosRamp({ providers: [abroad], oracle: forbiddenOracle });

    const quote = await ramp.quote({ direction: "onramp", provider: "abroad", currency: "BRL", amount: 100 });

    expect(quote).toMatchObject({
      source: "provider",
      provider: "abroad",
      providerQuoteId: "q-onramp-1",
      fiatAmount: 100,
      cryptoAmount: 18.975411,
      spread: 0,
      fee: { amount: 0.189754, currency: "USDC", type: "percentage" },
      expiresAt: 1786030685661,
    });
    // No invented mid rate: with no spread applied, both rates are the same.
    expect(quote.rate).toBe(quote.effectiveRate);
    expect(mock.requests[0]!.body).toMatchObject({
      target_currency: "BRL",
      payment_method: "PIX",
      network: "STELLAR",
      crypto_currency: "USDC",
      fiat_amount: 100,
    });
    expect(mock.requests[0]!.headers["x-api-key"]).toBe("partner_test");
  });

  it("uses the reverse endpoint when an offramp is quoted from the crypto side", async () => {
    const { abroad, mock } = provider([{ route: "POST /quote/reverse", response: REVERSE_QUOTE }]);
    const ramp = new CosmosRamp({ providers: [abroad], oracle: forbiddenOracle });

    const quote = await ramp.quote({ direction: "offramp", provider: "abroad", currency: "BRL", cryptoAmount: 20 });

    // `value` is FIAT on this endpoint — reading it as crypto would silently
    // quote the user ~5x what they asked to sell.
    expect(quote.fiatAmount).toBe(97.72);
    expect(quote.cryptoAmount).toBe(20);
    expect(mock.requests[0]!.body).toMatchObject({ source_amount: 20, target_currency: "BRL", payment_method: "PIX" });
  });

  it("routes COP over BREB rather than PIX", async () => {
    const { abroad, mock } = provider([{ route: "POST /quote/reverse", response: REVERSE_QUOTE }]);
    await abroad.getQuote({ direction: "offramp", currency: "COP", asset: "USDC", cryptoAmount: 20 });
    expect(mock.requests[0]!.body).toMatchObject({ target_currency: "COP", payment_method: "BREB" });
  });

  it("refuses an onramp quoted from the crypto side instead of approximating one", async () => {
    const { abroad } = provider([]);
    await expect(abroad.getQuote({ direction: "onramp", currency: "BRL", asset: "USDC", cryptoAmount: 20 })).rejects.toThrow(/fiat side only/i);
  });

  it("rejects a currency Abroad does not settle, naming the ones it does", async () => {
    const { abroad } = provider([]);
    await expect(abroad.getQuote({ direction: "onramp", currency: "ARS", asset: "USDC", amount: 1000 })).rejects.toThrow(/does not settle ARS.*BRL.*COP/is);
  });

  it("surfaces a below-minimum refusal as a typed, coded error", async () => {
    const { abroad } = provider([
      {
        route: "POST /quote/onramp",
        status: 400,
        response: { code: "minimum", reason: "The minimum allowed amount for BRL is 10 BRL", retryable: false },
      },
    ]);
    await expect(abroad.getQuote({ direction: "onramp", currency: "BRL", asset: "USDC", amount: 1 })).rejects.toMatchObject({
      name: "AbroadQuoteError",
      code: "minimum",
      retryable: false,
    });
    await expect(abroad.getQuote({ direction: "onramp", currency: "BRL", asset: "USDC", amount: 1 })).rejects.toBeInstanceOf(AbroadQuoteError);
  });
});

describe("AbroadProvider onramp", () => {
  const chargeRules = [
    { route: "POST /quote/onramp", response: ONRAMP_QUOTE },
    {
      route: "POST /transaction",
      response: {
        id: "tx-1",
        kycRequired: false,
        transaction_reference: "ref-1",
        payment_instructions: { br_code: "00020126PIXPAYLOAD", expires_at: 1786030999000 },
      },
    },
  ];

  it("binds the charge to the quote it issued and to the buyer's wallet", async () => {
    const { abroad, mock } = provider(chargeRules);
    const ramp = new CosmosRamp({ providers: [abroad], oracle: forbiddenOracle });

    const order = await ramp.onramp({ provider: "abroad", currency: "BRL", amount: 100, wallet: "GBUYER", method: "qr" });

    expect(order.charge).toMatchObject({ id: "tx-1", method: "qr", qr: "00020126PIXPAYLOAD", expiresAt: 1786030999000 });
    const created = mock.requests.find((r) => r.path === "/transaction")!;
    // The same quote the user was shown — not a fresh one at a price they never saw.
    expect(created.body).toMatchObject({ quote_id: "q-onramp-1", user_id: "user-1", destination_address: "GBUYER" });
  });

  it("refuses to build a charge with no destination wallet, since Abroad delivers the crypto itself", async () => {
    const { abroad } = provider(chargeRules);
    const ramp = new CosmosRamp({ providers: [abroad], oracle: forbiddenOracle });
    await expect(ramp.onramp({ provider: "abroad", currency: "BRL", amount: 100, method: "qr" })).rejects.toThrow(/destination wallet/i);
  });

  it("refuses to sell COP, which is payout-only", async () => {
    const { abroad } = provider([{ route: "POST /quote/onramp", response: ONRAMP_QUOTE }]);
    const ramp = new CosmosRamp({ providers: [abroad], oracle: forbiddenOracle });
    await expect(ramp.onramp({ provider: "abroad", currency: "COP", amount: 80000, wallet: "GBUYER" })).rejects.toThrow(/payout-only|does not settle/i);
  });

  it("raises a distinct, recoverable error when the user needs verifying", async () => {
    const { abroad } = provider([
      { route: "POST /quote/onramp", response: ONRAMP_QUOTE },
      { route: "POST /transaction", response: { id: null, kycRequired: true, transaction_reference: null } },
    ]);
    const ramp = new CosmosRamp({ providers: [abroad], oracle: forbiddenOracle });

    // A 200 with kycRequired must NOT read as "the charge had no payment code".
    await expect(ramp.onramp({ provider: "abroad", currency: "BRL", amount: 100, wallet: "GBUYER" })).rejects.toBeInstanceOf(AbroadKycRequiredError);
  });

  it("remembers the charged amount so a webhook can be reconciled against the order", async () => {
    const { abroad } = provider([
      ...chargeRules,
      { route: "GET /transaction/tx-1", response: { id: "tx-1", status: "PAYMENT_COMPLETED", kycRequired: false, transaction_reference: "ref-1", user_id: "user-1", on_chain_tx_hash: "abc" } },
    ]);
    const ramp = new CosmosRamp({ providers: [abroad], oracle: forbiddenOracle });
    const order = await ramp.onramp({ provider: "abroad", currency: "BRL", amount: 100, wallet: "GBUYER", method: "qr" });

    // Abroad's status response carries no amount; without the creation-time
    // record this reads 0 and every reconciliation fails as a mismatch.
    const state = await abroad.getCharge("tx-1");
    expect(state).toMatchObject({ id: "tx-1", status: "approved", amount: 100, currency: "BRL", reference: order.id });
  });

  it("maps a wrong-amount payment to rejected rather than to approved or pending", async () => {
    const { abroad } = provider([
      { route: "GET /transaction/tx-9", response: { id: "tx-9", status: "WRONG_AMOUNT", kycRequired: false, transaction_reference: "r", user_id: "u", on_chain_tx_hash: null } },
    ]);
    expect((await abroad.getCharge("tx-9")).status).toBe("rejected");
  });
});

describe("AbroadProvider offramp", () => {
  const offrampRules = [
    { route: "POST /quote/reverse", response: REVERSE_QUOTE },
    {
      route: "POST /transaction",
      response: {
        id: "tx-off-1",
        kycRequired: false,
        transaction_reference: "ref-off-1",
        payment_context: {
          blockchain: "STELLAR",
          chainFamily: "stellar",
          chainId: "stellar:pubnet",
          cryptoCurrency: "USDC",
          depositAddress: "GDEPOSIT",
          memo: "memo-token",
          memoType: "text",
          amount: 20,
          decimals: 7,
          mintAddress: null,
          rpcUrl: null,
          notify: { required: false, endpoint: null },
        },
      },
    },
  ];

  it("puts the deposit address and memo on the order the moment it is created", async () => {
    const { abroad, mock } = provider(offrampRules);
    const ramp = new CosmosRamp({ providers: [abroad], oracle: forbiddenOracle });

    const order = await ramp.offramp({
      provider: "abroad",
      cryptoAmount: 20,
      currency: "BRL",
      destination: { accountNumber: "seller@pix.test", taxId: "00000000000" },
    });

    expect(order.deposit).toMatchObject({
      id: "tx-off-1",
      address: "GDEPOSIT",
      memo: "memo-token",
      memoType: "text",
      amount: 20,
      asset: "USDC",
      network: "STELLAR",
      chainId: "stellar:pubnet",
      fiatAmount: 97.72,
      currency: "BRL",
    });
    expect(mock.requests.find((r) => r.path === "/transaction")!.body).toMatchObject({
      quote_id: "q-reverse-1",
      account_number: "seller@pix.test",
      tax_id: "00000000000",
    });
  });

  it("refuses to open an offramp without the payee's bank details", async () => {
    const { abroad } = provider(offrampRules);
    const ramp = new CosmosRamp({ providers: [abroad], oracle: forbiddenOracle });

    await expect(ramp.offramp({ provider: "abroad", cryptoAmount: 20, currency: "BRL", destination: {} })).rejects.toThrow(/PIX key/i);
    await expect(ramp.offramp({ provider: "abroad", cryptoAmount: 20, currency: "BRL", destination: { accountNumber: "a@b.c" } })).rejects.toThrow(/tax id/i);
  });

  it("accepts the destination spellings a caller's own form is likely to produce", async () => {
    const { abroad, mock } = provider(offrampRules);
    const ramp = new CosmosRamp({ providers: [abroad], oracle: forbiddenOracle });
    await ramp.offramp({ provider: "abroad", cryptoAmount: 20, currency: "BRL", destination: { pixKey: "seller@pix.test", cpf: "123" } });
    expect(mock.requests.find((r) => r.path === "/transaction")!.body).toMatchObject({ account_number: "seller@pix.test", tax_id: "123" });
  });

  it("refuses when the provider returns no deposit address, rather than returning an unusable order", async () => {
    const { abroad } = provider([
      { route: "POST /quote/reverse", response: REVERSE_QUOTE },
      { route: "POST /transaction", response: { id: "tx-off-2", kycRequired: false, transaction_reference: "r", payment_context: null } },
    ]);
    const ramp = new CosmosRamp({ providers: [abroad], oracle: forbiddenOracle });
    await expect(
      ramp.offramp({ provider: "abroad", cryptoAmount: 20, currency: "BRL", destination: { accountNumber: "a@b.c", taxId: "1" } }),
    ).rejects.toThrow(/no deposit address/i);
  });
});

describe("AbroadProvider KYC", () => {
  it("reads the verification status for its configured user", async () => {
    const { abroad, mock } = provider([{ route: "GET /kyc/status", response: { hasApproved: false, status: "PENDING" } }]);
    expect(await abroad.getKycStatus()).toEqual({ approved: false, status: "PENDING" });
    expect(mock.requests[0]!.url).toContain("userId=user-1");
  });

  it("submits identity fields and the document as multipart", async () => {
    const { abroad, mock } = provider([{ route: "POST /kyc", status: 201, response: { status: "APPROVED" } }]);

    const result = await abroad.client.submitKyc(
      {
        userId: "user-1",
        fullName: "Ada Lovelace",
        documentType: "ID",
        documentNumber: "123",
        dateOfBirth: "1990-01-31",
        nationality: "BR",
        city: "São Paulo",
        address: "Rua 1",
        email: "ada@example.com",
        phone: "+5511999999999",
      },
      new Blob([new Uint8Array([1, 2, 3])], { type: "image/jpeg" }),
    );

    expect(result.status).toBe("APPROVED");
    const body = mock.requests[0]!.body as Record<string, unknown>;
    expect(body).toMatchObject({ userId: "user-1", fullName: "Ada Lovelace", nationality: "BR" });
    expect(body.document).toBeDefined();
    // fetch must set its own multipart boundary — a hand-set Content-Type breaks the body.
    expect(mock.requests[0]!.headers["content-type"]).toBeUndefined();
  });
});

describe("oracle fallback still applies to fiat-only rails", () => {
  it("prices a provider without getQuote from the oracle plus the spread", async () => {
    const fiatOnly = {
      name: "plain",
      regions: ["AR"],
      currencies: ["ARS"],
      createCharge: async () => ({ id: "c1", method: "link" as const }),
      getCharge: async () => ({ id: "c1", status: "pending" as const, amount: 0, currency: "ARS" }),
      verifyWebhook: async () => true,
      parseWebhook: async () => null,
    };
    const ramp = new CosmosRamp({ providers: [fiatOnly], oracle: { getRate: async () => 1000 } });

    const quote = await ramp.quote({ direction: "onramp", provider: "plain", currency: "ARS", amount: 1020, spread: 0.02 });
    expect(quote).toMatchObject({ source: "oracle", rate: 1000, spread: 0.02, effectiveRate: 1020, cryptoAmount: 1 });
    expect(quote.providerQuoteId).toBeUndefined();
  });
});
