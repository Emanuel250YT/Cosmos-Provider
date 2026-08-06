/** Molecule: Quote — a quote with expiration (2 minutes) and a shortcut to create an order. */

import type { APIQuote, CreateOrderOptions } from "@/types/index";
import type { OrderReceipt } from "@/molecules/Order";
import { Base } from "@/molecules/Base";

export class Quote extends Base<APIQuote> {
  /** This quote's id — passed as `quoteId` when creating the order. */
  get id(): string {
    return this.raw.quoteId;
  }

  /** Exact moment this quote stops being valid for creating an order. */
  get expiresAt(): Date {
    return new Date(this.raw.expiresAt);
  }

  /** Milliseconds until expiration (negative if already expired). */
  get expiresIn(): number {
    return this.expiresAt.getTime() - Date.now();
  }

  /** `true` if `expiresAt` has already passed — creating an order with this quote will fail. */
  get isExpired(): boolean {
    return this.expiresIn <= 0;
  }

  /** Net amount the recipient will receive. */
  get destinationAmount(): string {
    return this.raw.destinationAmount;
  }

  /** Exchange rate applied, locked in at the time the quote was requested. */
  get exchangeRate(): string {
    return this.raw.exchangeRate;
  }

  /**
   * Creates an order locking in this quote's price.
   * Equivalent to `client.orders.create({ quoteId: quote.id, ...options })`.
   */
  createOrder(options: CreateOrderOptions): Promise<OrderReceipt> {
    return this.client.orders.create({ ...options, quoteId: this.id });
  }
}
