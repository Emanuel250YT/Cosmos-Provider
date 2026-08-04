/**
 * Random amounts/references for the demo & example flows — so re-running
 * one doesn't collide with an order a previous run already created (several
 * sandboxes, Etherfuse's included, reject a second pending order for the
 * same account + amount) and so the flows don't all look identical.
 */

import { randomUUID } from "node:crypto";

/** Random amount in `[min, max]`, with cents (2 decimals). */
export function randomAmount(min: number, max: number): number {
  return Math.round((min + Math.random() * (max - min)) * 100) / 100;
}

/** Random reference/idempotency key: `${prefix}-<uuid>`. */
export function randomReference(prefix = "cosmos-demo"): string {
  return `${prefix}-${randomUUID()}`;
}

/** BRL amount range used throughout the demo/example flows. */
export const BRL_RANGE = [20, 100] as const;
/** ARS amount range used throughout the demo/example flows. */
export const ARS_RANGE = [1000, 2000] as const;

export const randomBrlAmount = (): number => randomAmount(...BRL_RANGE);
export const randomArsAmount = (): number => randomAmount(...ARS_RANGE);
