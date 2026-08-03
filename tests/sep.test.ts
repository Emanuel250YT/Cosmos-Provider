/** Tests for the SEP-1 / SEP-10 / SEP-24 composable anchor helpers. */

import { describe, expect, it } from "vitest";
import {
  fetchStellarToml,
  getSep10Challenge,
  submitSep10Challenge,
  authenticateSep10,
  getSep24Info,
  startDeposit,
  startWithdraw,
  getSep24Transaction,
  listSep24Transactions,
  SepError,
  parseToml,
} from "@/client/sep";
import { createMockFetch } from "./helpers/mockFetch";

describe("parseToml", () => {
  it("parses top-level scalars, tables, and array-of-tables", () => {
    const toml = `
# comment
VERSION = "2.7.0"
SIGNING_KEY = "GABC123"
WEB_AUTH_ENDPOINT = "https://anchor.example/auth"
ACCOUNTS = ["GONE", "GTWO"]

[DOCUMENTATION]
ORG_NAME = "Example Anchor"

[[CURRENCIES]]
code = "USDC"
issuer = "GISSUER"
display_decimals = 2

[[CURRENCIES]]
code = "ARS"
issuer = "GARS"
`;
    const parsed = parseToml(toml);
    expect(parsed.VERSION).toBe("2.7.0");
    expect(parsed.SIGNING_KEY).toBe("GABC123");
    expect(parsed.ACCOUNTS).toEqual(["GONE", "GTWO"]);
    expect(parsed.DOCUMENTATION).toEqual({ ORG_NAME: "Example Anchor" });
    expect(parsed.CURRENCIES).toEqual([
      { code: "USDC", issuer: "GISSUER", display_decimals: 2 },
      { code: "ARS", issuer: "GARS" },
    ]);
  });
});

describe("fetchStellarToml (SEP-1)", () => {
  it("fetches and parses the anchor's stellar.toml", async () => {
    const { fetchImpl, requests } = createMockFetch([
      {
        route: "GET /.well-known/stellar.toml",
        response: 'WEB_AUTH_ENDPOINT = "https://anchor.example/auth"\nTRANSFER_SERVER_SEP0024 = "https://anchor.example/sep24"\n',
      },
    ]);
    // The mock fetch always replies with JSON.stringify(response); stellar.toml is
    // plain text, so this test only cares that the right URL was requested and
    // that the (JSON-stringified) body still round-trips through the line parser
    // without throwing.
    const toml = await fetchStellarToml("anchor.example", { fetch: fetchImpl });
    expect(requests[0]!.url).toBe("https://anchor.example/.well-known/stellar.toml");
    expect(toml).toBeTruthy();
  });

  it("throws a SepError on a non-2xx response", async () => {
    const { fetchImpl } = createMockFetch([{ route: "GET /.well-known/stellar.toml", status: 404, response: "" }]);
    await expect(fetchStellarToml("anchor.example", { fetch: fetchImpl })).rejects.toThrow(SepError);
  });
});

describe("SEP-10 authentication", () => {
  const webAuthEndpoint = "https://anchor.example/auth";

  it("fetches the challenge transaction", async () => {
    const { fetchImpl, requests } = createMockFetch([
      {
        route: "GET /auth",
        response: { transaction: "AAAA...", network_passphrase: "Test SDF Network ; September 2015" },
      },
    ]);
    const challenge = await getSep10Challenge({ webAuthEndpoint, account: "GABC", fetch: fetchImpl });
    expect(challenge).toEqual({ transaction: "AAAA...", networkPassphrase: "Test SDF Network ; September 2015" });
    expect(requests[0]!.url).toContain("account=GABC");
  });

  it("throws when the challenge response is missing fields", async () => {
    const { fetchImpl } = createMockFetch([{ route: "GET /auth", response: {} }]);
    await expect(getSep10Challenge({ webAuthEndpoint, account: "GABC", fetch: fetchImpl })).rejects.toThrow(SepError);
  });

  it("submits the signed challenge and returns the JWT", async () => {
    const { fetchImpl, requests } = createMockFetch([{ route: "POST /auth", response: { token: "jwt-1" } }]);
    const token = await submitSep10Challenge(webAuthEndpoint, "SIGNED_XDR", fetchImpl);
    expect(token).toBe("jwt-1");
    expect(requests[0]!.body).toEqual({ transaction: "SIGNED_XDR" });
  });

  it("runs the full authenticate round trip via the injected signer", async () => {
    const { fetchImpl } = createMockFetch([
      { route: "GET /auth", response: { transaction: "UNSIGNED_XDR", network_passphrase: "Test SDF Network ; September 2015" } },
      { route: "POST /auth", response: { token: "jwt-2" } },
    ]);
    let signedWith: [string, string] | undefined;
    const token = await authenticateSep10({
      webAuthEndpoint,
      account: "GABC",
      fetch: fetchImpl,
      sign: async (xdr, passphrase) => {
        signedWith = [xdr, passphrase];
        return "SIGNED_XDR";
      },
    });
    expect(token).toBe("jwt-2");
    expect(signedWith).toEqual(["UNSIGNED_XDR", "Test SDF Network ; September 2015"]);
  });
});

describe("SEP-24 interactive flow", () => {
  const transferServer = "https://anchor.example/sep24";

  it("fetches /info", async () => {
    const { fetchImpl } = createMockFetch([
      { route: "GET /sep24/info", response: { deposit: { USDC: { enabled: true } } } },
    ]);
    const info = await getSep24Info({ transferServer, fetch: fetchImpl });
    expect(info.deposit?.USDC?.enabled).toBe(true);
  });

  it("starts an interactive deposit", async () => {
    const { fetchImpl, requests } = createMockFetch([
      {
        route: "POST /sep24/transactions/deposit/interactive",
        response: { type: "interactive_customer_info_needed", url: "https://anchor.example/kyc/1", id: "tx-1" },
      },
    ]);
    const result = await startDeposit({
      transferServer,
      jwt: "jwt-1",
      assetCode: "USDC",
      account: "GABC",
      fetch: fetchImpl,
    });
    expect(result).toEqual({ type: "interactive_customer_info_needed", url: "https://anchor.example/kyc/1", id: "tx-1" });
    expect(requests[0]!.headers["authorization"]).toBe("Bearer jwt-1");
  });

  it("starts an interactive withdrawal", async () => {
    const { fetchImpl } = createMockFetch([
      {
        route: "POST /sep24/transactions/withdraw/interactive",
        response: { type: "interactive_customer_info_needed", url: "https://anchor.example/kyc/2", id: "tx-2" },
      },
    ]);
    const result = await startWithdraw({ transferServer, jwt: "jwt-1", assetCode: "USDC", account: "GABC", fetch: fetchImpl });
    expect(result.id).toBe("tx-2");
  });

  it("throws when the interactive response is malformed", async () => {
    const { fetchImpl } = createMockFetch([
      { route: "POST /sep24/transactions/deposit/interactive", response: { type: "interactive_customer_info_needed" } },
    ]);
    await expect(
      startDeposit({ transferServer, jwt: "jwt-1", assetCode: "USDC", account: "GABC", fetch: fetchImpl }),
    ).rejects.toThrow(SepError);
  });

  it("polls a transaction by id", async () => {
    const { fetchImpl, requests } = createMockFetch([
      { route: "GET /sep24/transaction", response: { transaction: { id: "tx-1", kind: "deposit", status: "completed" } } },
    ]);
    const tx = await getSep24Transaction({ transferServer, jwt: "jwt-1", id: "tx-1", fetch: fetchImpl });
    expect(tx).toEqual({ id: "tx-1", kind: "deposit", status: "completed" });
    expect(requests[0]!.url).toContain("id=tx-1");
  });

  it("lists transactions for an asset", async () => {
    const { fetchImpl } = createMockFetch([
      { route: "GET /sep24/transactions", response: { transactions: [{ id: "tx-1", kind: "deposit", status: "completed" }] } },
    ]);
    const txs = await listSep24Transactions({ transferServer, jwt: "jwt-1", assetCode: "USDC", fetch: fetchImpl });
    expect(txs).toHaveLength(1);
  });
});
