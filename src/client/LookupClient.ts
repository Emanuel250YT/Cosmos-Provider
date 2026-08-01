/**
 * LookupClient: cliente público SIN API key, seguro para el navegador.
 * Solo expone la Lookup API (/lookup/*) de Etherfuse.
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
  environment?: Environment;
  baseUrl?: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
  retries?: number;
}

export class LookupClient {
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

  exchangeRates(maxAgeSeconds?: number): Promise<ExchangeRates> {
    return this.rest.get<ExchangeRates>(Routes.lookupExchangeRate(), {
      auth: false,
      query: { max_age: maxAgeSeconds },
    });
  }

  async usdToBrl(maxAgeSeconds?: number): Promise<ExchangeRatePair | undefined> {
    const rates = await this.exchangeRates(maxAgeSeconds);
    return rates["usd_to_brl"];
  }

  async usdToMxn(maxAgeSeconds?: number): Promise<ExchangeRatePair | undefined> {
    const rates = await this.exchangeRates(maxAgeSeconds);
    return rates["usd_to_mxn"];
  }

  stablebonds(): Promise<unknown> {
    return this.rest.get(Routes.lookupStablebonds(), { auth: false });
  }

  countryCodes(): Promise<unknown> {
    return this.rest.get(Routes.lookupCountryCodes(), { auth: false });
  }

  restrictedCountries(): Promise<unknown> {
    return this.rest.get(Routes.lookupRestrictedCountries(), { auth: false });
  }
}
