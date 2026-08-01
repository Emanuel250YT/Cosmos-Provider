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

  it("lista los assets soportados", async () => {
    const assets = await client.assets.list();
    expect(Array.isArray(assets)).toBe(true);
  });

  it("cotiza un onramp BRL → token (o reporta que el par no está disponible)", async () => {
    const me = await client.customers.me();
    try {
      const quote = await client.quotes.create({
        customerId: me.id,
        blockchain: "solana",
        sourceAmount: "500",
        quoteAssets: {
          type: "onramp",
          sourceAsset: "BRL",
          // USDC en Solana; si tu organización usa otro asset, ajústalo.
          targetAsset: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
        },
      });
      expect(Number(quote.destinationAmount)).toBeGreaterThan(0);
      expect(quote.isExpired).toBe(false);
    } catch (error) {
      // 404 = par no soportado para esta org/blockchain: no es un fallo de la librería.
      if (error instanceof EtherfuseAPIError && (error.status === 404 || error.status === 424)) {
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
