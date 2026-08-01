/** Organism: QuoteManager — `client.quotes`. */

import { randomUUID, Routes } from "@/atoms/constants";
import { EtherfuseError } from "@/atoms/errors";
import { Quote } from "@/molecules/Quote";
import type { APIQuote, CreateQuoteOptions } from "@/types/index";
import { BaseManager } from "@/organisms/BaseManager";

export class QuoteManager extends BaseManager {
  /**
   * Solicita una cotización. `quoteId` se genera automáticamente y
   * `customerId` cae al `defaultCustomerId` del cliente si se omite.
   *
   * Nota: las quotes expiran a los 2 minutos (`quote.isExpired`).
   */
  async create(options: CreateQuoteOptions): Promise<Quote> {
    const customerId = options.customerId ?? this.client.options.defaultCustomerId;
    if (!customerId) {
      throw new EtherfuseError(
        "Falta customerId: pásalo en las opciones o configura defaultCustomerId al crear el cliente.",
      );
    }
    const raw = await this.rest.post<APIQuote>(Routes.quote(), {
      ...options,
      quoteId: options.quoteId ?? randomUUID(),
      customerId,
    });
    return new Quote(this.client, raw);
  }
}
