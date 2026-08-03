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
  /** `sandbox` o `production` (default). Ambos sirven la misma Lookup API pública. */
  environment?: Environment;
  /** Anula la URL base (p. ej. para un proxy propio). */
  baseUrl?: string;
  /** Implementación de fetch (default: global — necesario para SSR o entornos sin fetch nativo). */
  fetch?: typeof fetch;
  /** Timeout HTTP por intento en ms. */
  timeoutMs?: number;
  /** Reintentos HTTP ante errores transitorios (424/429/5xx). */
  retries?: number;
}

export class LookupClient {
  /** Capa HTTP de bajo nivel, por si hace falta pegarle a un endpoint de Lookup aún no tipado. */
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

  /** Códigos de país soportados por Etherfuse. */
  countryCodes(): Promise<unknown> {
    return this.rest.get(Routes.lookupCountryCodes(), { auth: false });
  }

  /** Países restringidos (no operables) para el ramp. */
  restrictedCountries(): Promise<unknown> {
    return this.rest.get(Routes.lookupRestrictedCountries(), { auth: false });
  }
}
