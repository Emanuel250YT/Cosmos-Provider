/** Organism: OrderManager — `client.orders`. */

import { randomUUID, Routes } from "@/atoms/constants";
import { Order, OrderReceipt } from "@/molecules/Order";
import type {
  APICreateOrderResult,
  APIOrder,
  CreateOrderOptions,
  Page,
  PageQuery,
} from "@/types/index";
import { BaseManager } from "@/organisms/BaseManager";

export class OrderManager extends BaseManager {
  /**
   * Creates an order (onramp or offramp). For BRL onramps, the resulting
   * {@link OrderReceipt} carries the PIX code and `createPixQr()`.
   */
  async create(options: CreateOrderOptions): Promise<OrderReceipt> {
    const raw = await this.rest.post<APICreateOrderResult>(Routes.order(), {
      ...options,
      orderId: options.orderId ?? randomUUID(),
    });
    return new OrderReceipt(this.client, raw ?? {});
  }

  /** Reads an order by id — the order's authoritative status. */
  async fetch(orderId: string): Promise<Order> {
    const raw = await this.rest.get<APIOrder>(Routes.orderById(orderId));
    return new Order(this.client, raw);
  }

  /** Lists the organization's orders (paginated via pageNumber/pageSize). */
  async list(query: PageQuery = {}): Promise<Page<Order>> {
    const raw = await this.rest.get<Page<APIOrder>>(Routes.orders(), {
      query: { pageNumber: query.pageNumber, pageSize: query.pageSize },
    });
    return { ...raw, items: (raw.items ?? []).map((o) => new Order(this.client, o)) };
  }

  /** Advanced search (POST variant with filters/pagination). */
  async search(filters: Record<string, unknown>): Promise<Page<Order>> {
    const raw = await this.rest.post<Page<APIOrder>>(Routes.orders(), filters);
    return { ...raw, items: (raw.items ?? []).map((o) => new Order(this.client, o)) };
  }

  /** Cancels an order. */
  cancel(orderId: string): Promise<unknown> {
    return this.rest.delete(Routes.orderById(orderId));
  }
}
