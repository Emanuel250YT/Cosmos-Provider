/**
 * LookupClient: public client with NO API key, safe for the browser.
 * Only exposes Etherfuse's Lookup API (/lookup/*).
 *
 * ```ts
 * const lookup = new LookupClient();
 * const rates = await lookup.exchangeRates();
 * console.log(rates.usd_to_brl?.rate);
 * ```
 */

import { REST } from "@/atoms/REST";
import { Routes, type Environment } from "@/atoms/constants";
import type { ExchangeRatePair, ExchangeRates } from "@/types/index";

export interface LookupClientOptions {
  /** `sandbox` or `production` (default). Both serve the same public Lookup API. */
  environment?: Environment;
  /** Overrides the base URL (e.g. for a custom proxy). */
  baseUrl?: string;
  /** Fetch implementation (default: global — needed for SSR or environments without native fetch). */
  fetch?: typeof fetch;
  /** HTTP timeout per attempt, in ms. */
  timeoutMs?: number;
  /** HTTP retries on transient errors (424/429/5xx). */
  retries?: number;
}

export class LookupClient {
  /** Low-level HTTP layer, in case you need to hit a Lookup endpoint that isn't typed yet. */
  readonly rest: REST;

  constructor(options: LookupClientOptions = {}) {
    this.rest = new REST({
      environment: options.environment ?? "production",
      baseUrl: options.baseUrl,
      fetch: options.fetch,
      timeoutMs: options.timeoutMs,
      retries: options.retries,
    });
  }

  /**
   * Current exchange rates (keys like `usd_to_brl`, `usd_to_mxn`).
   * @param maxAgeSeconds Excludes sources older than this threshold.
   */
  exchangeRates(maxAgeSeconds?: number): Promise<ExchangeRates> {
    return this.rest.get<ExchangeRates>(Routes.lookupExchangeRate(), {
      auth: false,
      query: { max_age: maxAgeSeconds },
    });
  }

  /** Shortcut: the USD→BRL pair. */
  async usdToBrl(maxAgeSeconds?: number): Promise<ExchangeRatePair | undefined> {
    const rates = await this.exchangeRates(maxAgeSeconds);
    return rates["usd_to_brl"];
  }

  /** Shortcut: the USD→MXN pair. */
  async usdToMxn(maxAgeSeconds?: number): Promise<ExchangeRatePair | undefined> {
    const rates = await this.exchangeRates(maxAgeSeconds);
    return rates["usd_to_mxn"];
  }

  /** Catalog of available stablebonds. */
  stablebonds(): Promise<unknown> {
    return this.rest.get(Routes.lookupStablebonds(), { auth: false });
  }

  /** Country codes supported by Etherfuse. */
  countryCodes(): Promise<unknown> {
    return this.rest.get(Routes.lookupCountryCodes(), { auth: false });
  }

  /** Restricted (non-operable) countries for the ramp. */
  restrictedCountries(): Promise<unknown> {
    return this.rest.get(Routes.lookupRestrictedCountries(), { auth: false });
  }
}
