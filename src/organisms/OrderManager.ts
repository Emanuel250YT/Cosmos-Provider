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
   * Crea una orden (onramp u offramp). Para onramps BRL, el
   * {@link OrderReceipt} resultante trae el código PIX y `createPixQr()`.
   */
  async create(options: CreateOrderOptions): Promise<OrderReceipt> {
    const raw = await this.rest.post<APICreateOrderResult>(Routes.order(), {
      ...options,
      orderId: options.orderId ?? randomUUID(),
    });
    return new OrderReceipt(this.client, raw ?? {});
  }

  /** Lee una orden por id — el estado autoritativo de la orden. */
  async fetch(orderId: string): Promise<Order> {
    const raw = await this.rest.get<APIOrder>(Routes.orderById(orderId));
    return new Order(this.client, raw);
  }

  /** Lista las órdenes de la organización (paginado pageNumber/pageSize). */
  async list(query: PageQuery = {}): Promise<Page<Order>> {
    const raw = await this.rest.get<Page<APIOrder>>(Routes.orders(), {
      query: { pageNumber: query.pageNumber, pageSize: query.pageSize },
    });
    return { ...raw, items: (raw.items ?? []).map((o) => new Order(this.client, o)) };
  }

  /** Búsqueda avanzada (variante POST con filtros/paginación). */
  async search(filters: Record<string, unknown>): Promise<Page<Order>> {
    const raw = await this.rest.post<Page<APIOrder>>(Routes.orders(), filters);
    return { ...raw, items: (raw.items ?? []).map((o) => new Order(this.client, o)) };
  }

  /** Cancela una orden. */
  cancel(orderId: string): Promise<unknown> {
    return this.rest.delete(Routes.orderById(orderId));
  }
}
