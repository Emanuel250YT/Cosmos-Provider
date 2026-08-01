/** Organism: SwapManager — `client.swaps` (swaps on-chain entre activos). */

import { Routes } from "@/atoms/constants";
import type { SwapOptions } from "@/types/index";
import { BaseManager } from "@/organisms/BaseManager";

export class SwapManager extends BaseManager {
  /** Ejecuta un swap entre activos (usa una quote con `type: "swap"`). */
  create(options: SwapOptions): Promise<unknown> {
    return this.rest.post(Routes.swap(), options);
  }
}
