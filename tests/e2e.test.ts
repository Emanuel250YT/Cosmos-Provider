/**
 * E2E against the real Etherfuse sandbox.
 *
 * Only runs if a sandbox API key is available:
 *   - ETHERFUSE_API_KEY environment variable, or
 *   - a .env file at the root with ETHERFUSE_API_KEY=...
 *
 * Run: npm run test:e2e
 * (without a key, the entire suite is marked as skipped)
 */

import "dotenv/config";
import { describe, expect, it } from "vitest";
import { EtherfuseClient } from "@/client/EtherfuseClient";
import { LookupClient } from "@/client/LookupClient";
import { EtherfuseAPIError } from "@/atoms/errors";

const API_KEY = process.env.ETHERFUSE_API_KEY;

describe("Public lookup (no API key, real production)", () => {
  it("returns exchange rates with USD→BRL and USD→MXN", async () => {
    const lookup = new LookupClient();
    const rates = await lookup.exchangeRates();
    expect(Number(rates["usd_to_brl"]?.rate)).toBeGreaterThan(0);
    expect(Number(rates["usd_to_mxn"]?.rate)).toBeGreaterThan(0);
  });
});

describe.skipIf(!API_KEY)("Authenticated sandbox (requires ETHERFUSE_API_KEY)", () => {
  const client = new EtherfuseClient({ apiKey: API_KEY!, environment: "sandbox" });

  it("GET /ramp/me returns the organization", async () => {
    const me = await client.customers.me();
    expect(me.id).toBeTruthy();
  });

  it.skipIf(!process.env.ETHERFUSE_WALLET)(
    "lists the assets supported on Stellar for BRL",
    async () => {
      const assets = await client.assets.list({
        blockchain: "stellar",
        currency: "BRL",
        wallet: process.env.ETHERFUSE_WALLET!,
      });
      expect(Array.isArray(assets)).toBe(true);
    },
  );

  it("quotes an onramp BRL → token (or reports that the pair is unavailable)", async () => {
    const me = await client.customers.me();
    const blockchain = (process.env.ETHERFUSE_BLOCKCHAIN ?? "stellar") as never;
    const targetAsset =
      process.env.ETHERFUSE_TARGET_ASSET ??
      "CETES-GC3CW7EDYRTWQ635VDIGY6S4ZUF5L6TQ7AA4MWS7LEQDBLUSZXV7UPS4";
    try {
      const quote = await client.quotes.create({
        customerId: me.id,
        blockchain,
        sourceAmount: "500",
        quoteAssets: { type: "onramp", sourceAsset: "BRL", targetAsset },
      });
      expect(Number(quote.destinationAmount)).toBeGreaterThan(0);
      expect(quote.isExpired).toBe(false);
    } catch (error) {
      // Pair not supported for this org/blockchain: not a library failure.
      if (error instanceof EtherfuseAPIError && [400, 404, 424].includes(error.status)) {
        console.warn(`BRL pair not available on this sandbox account (HTTP ${error.status}).`);
        return;
      }
      throw error;
    }
  });

  it("lists existing orders", async () => {
    const page = await client.orders.list({ pageSize: 5 });
    expect(Array.isArray(page.items)).toBe(true);
  });
});
