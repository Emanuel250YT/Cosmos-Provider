/**
 * Organism: LookupManager — `client.lookup`.
 * Endpoints públicos (sin API key): apto para uso directo en frontend.
 */

import { Routes } from "@/atoms/constants";
import type { ExchangeRatePair, ExchangeRates } from "@/types/index";
import { BaseManager } from "@/organisms/BaseManager";

export class LookupManager extends BaseManager {
  /**
   * Tipos de cambio actuales (claves tipo `usd_to_brl`, `usd_to_mxn`).
   * @param maxAgeSeconds Excluye fuentes más viejas que este umbral.
   */
  exchangeRates(maxAgeSeconds?: number): Promise<ExchangeRates> {
    return this.rest.get<ExchangeRates>(Routes.lookupExchangeRate(), {
      auth: false,
      query: { max_age: maxAgeSeconds },
    });
  }

  /** Atajo: el par USD→BRL. */
  async usdToBrl(maxAgeSeconds?: number): Promise<ExchangeRatePair | undefined> {
    const rates = await this.exchangeRates(maxAgeSeconds);
    return rates["usd_to_brl"];
  }

  /** Atajo: el par USD→MXN. */
  async usdToMxn(maxAgeSeconds?: number): Promise<ExchangeRatePair | undefined> {
    const rates = await this.exchangeRates(maxAgeSeconds);
    return rates["usd_to_mxn"];
  }

  /** Catálogo de stablebonds disponibles. */
  stablebonds(): Promise<unknown> {
    return this.rest.get(Routes.lookupStablebonds(), { auth: false });
  }

  /** Costo/rendimiento de un stablebond concreto. */
  stablebondCost(query?: Record<string, string | number>): Promise<unknown> {
    return this.rest.get(Routes.lookupStablebondCost(), { auth: false, query });
  }

  /** Códigos de país soportados por Etherfuse. */
  countryCodes(): Promise<unknown> {
    return this.rest.get(Routes.lookupCountryCodes(), { auth: false });
  }

  /** Países restringidos (no operables) para el ramp. */
  restrictedCountries(): Promise<unknown> {
    return this.rest.get(Routes.lookupRestrictedCountries(), { auth: false });
  }
}
