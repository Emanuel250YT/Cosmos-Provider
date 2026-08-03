/**
 * Default in-memory order store. Good for development and tests; use a
 * database-backed `OrderStore` implementation in production.
 */

import type { OrderStore, RampOrderData } from "@/core/types";

export class MemoryStore implements OrderStore {
  #orders = new Map<string, RampOrderData>();

  async save(order: RampOrderData): Promise<void> {
    this.#orders.set(order.id, { ...order });
  }

  async get(id: string): Promise<RampOrderData | null> {
    const order = this.#orders.get(id);
    return order ? { ...order } : null;
  }

  async findByChargeId(provider: string, chargeId: string): Promise<RampOrderData | null> {
    for (const order of this.#orders.values()) {
      if (order.provider !== provider) continue;
      if (order.chargeId === chargeId || order.charge?.id === chargeId) return { ...order };
    }
    return null;
  }

  async update(id: string, patch: Partial<RampOrderData>): Promise<RampOrderData | null> {
    const current = this.#orders.get(id);
    if (!current) return null;
    const next = { ...current, ...patch, id, updatedAt: Date.now() };
    this.#orders.set(id, next);
    return { ...next };
  }

  async list(): Promise<RampOrderData[]> {
    return [...this.#orders.values()].map((order) => ({ ...order }));
  }
}
