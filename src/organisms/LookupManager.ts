/**
 * Organism: LookupManager — `client.lookup`.
 * Public endpoints (no API key): safe for direct frontend use.
 */

import { Routes } from "@/atoms/constants";
import type { ExchangeRatePair, ExchangeRates } from "@/types/index";
import { BaseManager } from "@/organisms/BaseManager";

export class LookupManager extends BaseManager {
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

  /** Cost/yield of a specific stablebond. */
  stablebondCost(query?: Record<string, string | number>): Promise<unknown> {
    return this.rest.get(Routes.lookupStablebondCost(), { auth: false, query });
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
