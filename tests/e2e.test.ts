/**
 * E2E contra el sandbox real de Etherfuse.
 *
 * Solo corre si hay una API key de sandbox disponible:
 *   - variable de entorno ETHERFUSE_API_KEY, o
 *   - archivo .env en la raíz con ETHERFUSE_API_KEY=...
 *
 * Ejecutar: npm run test:e2e
 * (sin key, la suite entera se marca como skipped)
 */

import "dotenv/config";
import { describe, expect, it } from "vitest";
import { EtherfuseClient } from "@/client/EtherfuseClient";
import { LookupClient } from "@/client/LookupClient";
import { EtherfuseAPIError } from "@/atoms/errors";

const API_KEY = process.env.ETHERFUSE_API_KEY;

describe("Lookup público (sin API key, producción real)", () => {
  it("devuelve tipos de cambio con USD→BRL y USD→MXN", async () => {
    const lookup = new LookupClient();
    const rates = await lookup.exchangeRates();
    expect(Number(rates["usd_to_brl"]?.rate)).toBeGreaterThan(0);
    expect(Number(rates["usd_to_mxn"]?.rate)).toBeGreaterThan(0);
  });
});

describe.skipIf(!API_KEY)("Sandbox autenticado (requiere ETHERFUSE_API_KEY)", () => {
  const client = new EtherfuseClient({ apiKey: API_KEY!, environment: "sandbox" });

  it("GET /ramp/me devuelve la organización", async () => {
    const me = await client.customers.me();
    expect(me.id).toBeTruthy();
  });

  it.skipIf(!process.env.ETHERFUSE_WALLET)(
    "lista los assets soportados en Stellar para BRL",
    async () => {
      const assets = await client.assets.list({
        blockchain: "stellar",
        currency: "BRL",
        wallet: process.env.ETHERFUSE_WALLET!,
      });
      expect(Array.isArray(assets)).toBe(true);
    },
  );

  it("cotiza un onramp BRL → token (o reporta que el par no está disponible)", async () => {
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
      // Par no soportado para esta org/blockchain: no es un fallo de la librería.
      if (error instanceof EtherfuseAPIError && [400, 404, 424].includes(error.status)) {
        console.warn(`Par BRL no disponible en esta cuenta sandbox (HTTP ${error.status}).`);
        return;
      }
      throw error;
    }
  });

  it("lista órdenes existentes", async () => {
    const page = await client.orders.list({ pageSize: 5 });
    expect(Array.isArray(page.items)).toBe(true);
  });
});
