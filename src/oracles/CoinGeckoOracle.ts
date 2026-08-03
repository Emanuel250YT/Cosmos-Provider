/**
 * CoinGecko-backed rate oracle.
 *
 * Uses the public `/simple/price` endpoint (no key required; a demo or pro
 * key can be supplied for higher limits). Results are cached briefly so a
 * burst of quotes doesn't hit the API on every call.
 */

import { Asset } from "@/atoms/enums";
import { OracleError } from "@/core/errors";
import type { CryptoAssetCode, FiatCurrencyCode, RateOracle } from "@/core/types";

/** Common symbols mapped to CoinGecko coin ids. Extendable via options. */
const DEFAULT_COIN_IDS: Record<string, string> = {
  [Asset.USDC]: "usd-coin",
  [Asset.USDT]: "tether",
  [Asset.DAI]: "dai",
  [Asset.BTC]: "bitcoin",
  [Asset.ETH]: "ethereum",
  [Asset.SOL]: "solana",
  [Asset.XLM]: "stellar",
};

export interface CoinGeckoOracleOptions {
  /** CoinGecko API key (demo or pro). Optional for light usage. */
  apiKey?: string;
  /** Set to `true` when using a paid (pro) key — switches base URL. */
  pro?: boolean;
  /** Override the base URL entirely. */
  baseUrl?: string;
  /** Cache TTL for rates, in ms. Default: 30 000. */
  cacheTtlMs?: number;
  /** Extra symbol → CoinGecko id mappings (merged over the defaults). */
  coinIds?: Record<string, string>;
  /** Custom fetch implementation. */
  fetch?: typeof fetch;
}

interface CacheEntry {
  rate: number;
  expiresAt: number;
}

export class CoinGeckoOracle implements RateOracle {
  readonly baseUrl: string;

  #apiKey?: string;
  #pro: boolean;
  #cacheTtlMs: number;
  #coinIds: Record<string, string>;
  #fetch: typeof fetch;
  #cache = new Map<string, CacheEntry>();

  constructor(options: CoinGeckoOracleOptions = {}) {
    this.#pro = options.pro ?? false;
    this.baseUrl = (
      options.baseUrl ??
      (this.#pro ? "https://pro-api.coingecko.com/api/v3" : "https://api.coingecko.com/api/v3")
    ).replace(/\/+$/, "");
    this.#apiKey = options.apiKey;
    this.#cacheTtlMs = options.cacheTtlMs ?? 30_000;
    this.#coinIds = { ...DEFAULT_COIN_IDS, ...options.coinIds };
    this.#fetch = options.fetch ?? globalThis.fetch?.bind(globalThis);
    if (typeof this.#fetch !== "function") {
      throw new OracleError("No fetch implementation available. Use Node >= 18 or pass `fetch`.");
    }
  }

  /** Resolve a symbol like "USDC" to its CoinGecko id ("usd-coin"). */
  coinIdFor(asset: CryptoAssetCode): string {
    return this.#coinIds[asset.toUpperCase()] ?? asset.toLowerCase();
  }

  /** Fiat units per 1 unit of `asset`, e.g. `getRate("USDC", "ARS")`. */
  async getRate(asset: CryptoAssetCode, currency: FiatCurrencyCode): Promise<number> {
    const coinId = this.coinIdFor(asset);
    const vs = currency.toLowerCase();
    const cacheKey = `${coinId}:${vs}`;

    const cached = this.#cache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) return cached.rate;

    const url = new URL(`${this.baseUrl}/simple/price`);
    url.searchParams.set("ids", coinId);
    url.searchParams.set("vs_currencies", vs);

    const headers: Record<string, string> = { accept: "application/json" };
    if (this.#apiKey) {
      headers[this.#pro ? "x-cg-pro-api-key" : "x-cg-demo-api-key"] = this.#apiKey;
    }

    let response: Response;
    try {
      response = await this.#fetch(url.toString(), { headers });
    } catch (cause) {
      throw new OracleError(`CoinGecko request failed for ${asset}/${currency}`, { cause });
    }
    if (!response.ok) {
      throw new OracleError(`CoinGecko responded ${response.status} for ${asset}/${currency}`);
    }

    const data = (await response.json()) as Record<string, Record<string, number>>;
    const rate = data?.[coinId]?.[vs];
    if (typeof rate !== "number" || !Number.isFinite(rate) || rate <= 0) {
      throw new OracleError(
        `CoinGecko has no ${currency} price for "${coinId}". ` +
          `Check the asset symbol or add a mapping via \`coinIds\`.`,
      );
    }

    this.#cache.set(cacheKey, { rate, expiresAt: Date.now() + this.#cacheTtlMs });
    return rate;
  }
}

/**
 * Apply a spread to a mid-market rate.
 * Onramp: the user pays more fiat per crypto unit → `rate * (1 + spread)`.
 * Offramp: the user receives less fiat per crypto unit → `rate * (1 - spread)`.
 */
export function applySpread(rate: number, spread: number, direction: "onramp" | "offramp"): number {
  if (spread < 0 || spread >= 1) {
    throw new OracleError(`Invalid spread ${spread}. Use a fraction like 0.02 for 2%.`);
  }
  return direction === "onramp" ? rate * (1 + spread) : rate * (1 - spread);
}
