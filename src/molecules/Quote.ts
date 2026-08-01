/** Molecule: Quote — cotización con expiración (2 minutos) y atajo a crear orden. */

import type { APIQuote, CreateOrderOptions } from "@/types/index";
import type { OrderReceipt } from "@/molecules/Order";
import { Base } from "@/molecules/Base";

export class Quote extends Base<APIQuote> {
  get id(): string {
    return this.raw.quoteId;
  }

  get expiresAt(): Date {
    return new Date(this.raw.expiresAt);
  }

  /** Milisegundos hasta que expire (negativo si ya expiró). */
  get expiresIn(): number {
    return this.expiresAt.getTime() - Date.now();
  }

  get isExpired(): boolean {
    return this.expiresIn <= 0;
  }

  /** Monto neto que recibirá el destinatario. */
  get destinationAmount(): string {
    return this.raw.destinationAmount;
  }

  get exchangeRate(): string {
    return this.raw.exchangeRate;
  }

  /**
   * Crea una orden fijando el precio de esta quote.
   * Equivale a `client.orders.create({ quoteId: quote.id, ...options })`.
   */
  createOrder(options: CreateOrderOptions): Promise<OrderReceipt> {
    return this.client.orders.create({ ...options, quoteId: this.id });
  }
}
