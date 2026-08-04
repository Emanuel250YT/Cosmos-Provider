/** Organism: QuoteManager — `client.quotes`. */

import { randomUUID, Routes } from "@/atoms/constants";
import { EtherfuseError } from "@/atoms/errors";
import { Quote } from "@/molecules/Quote";
import type { APIQuote, CreateQuoteOptions } from "@/types/index";
import { BaseManager } from "@/organisms/BaseManager";

export class QuoteManager extends BaseManager {
  /**
   * Requests a quote. `quoteId` is generated automatically, and
   * `customerId` falls back to the client's `defaultCustomerId` if omitted.
   *
   * Note: quotes expire after 2 minutes (`quote.isExpired`).
   */
  async create(options: CreateQuoteOptions): Promise<Quote> {
    const customerId = options.customerId ?? this.client.options.defaultCustomerId;
    if (!customerId) {
      throw new EtherfuseError(
        "Missing customerId: pass it in the options or set defaultCustomerId when creating the client.",
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
