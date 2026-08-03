/**
 * Default in-memory order store. Good for development and tests; use a
 * database-backed `OrderStore` implementation in production.
 */

import type { OrderStore, RampOrderData } from "@/core/types";

export class MemoryStore implements OrderStore {
  // Cloned on every read/write so callers can't mutate our internal state
  // through the object references they get back.
  #orders = new Map<string, RampOrderData>();

  /** Insert or overwrite an order by id. */
  async save(order: RampOrderData): Promise<void> {
    this.#orders.set(order.id, { ...order });
  }

  /** Look up an order by its engine-generated id. `null` if it doesn't exist. */
  async get(id: string): Promise<RampOrderData | null> {
    const order = this.#orders.get(id);
    return order ? { ...order } : null;
  }

  /**
   * Look up an order by the provider's charge id — needed when a webhook
   * only carries the payment id, not our order id. Linear scan: fine for
   * dev/tests, a database-backed store should index this column.
   */
  async findByChargeId(provider: string, chargeId: string): Promise<RampOrderData | null> {
    for (const order of this.#orders.values()) {
      if (order.provider !== provider) continue;
      if (order.chargeId === chargeId || order.charge?.id === chargeId) return { ...order };
    }
    return null;
  }

  /** Merge `patch` into the stored order, bumping `updatedAt`. `null` if the order doesn't exist. */
  async update(id: string, patch: Partial<RampOrderData>): Promise<RampOrderData | null> {
    const current = this.#orders.get(id);
    if (!current) return null;
    const next = { ...current, ...patch, id, updatedAt: Date.now() };
    this.#orders.set(id, next);
    return { ...next };
  }

  /** All stored orders. Dev/debug only — a real store should paginate/filter instead. */
  async list(): Promise<RampOrderData[]> {
    return [...this.#orders.values()].map((order) => ({ ...order }));
  }
}
