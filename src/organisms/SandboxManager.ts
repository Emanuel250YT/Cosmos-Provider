/** Organism: SandboxManager — `client.sandbox` (sandbox environment only). */

import { Routes } from "@/atoms/constants";
import { EtherfuseError } from "@/atoms/errors";
import { BaseManager } from "@/organisms/BaseManager";

export class SandboxManager extends BaseManager {
  /**
   * Simulates the fiat deposit for an onramp order (`created` → `funded` →
   * `completed`). Only works against the sandbox; in production, deposits
   * are detected automatically.
   */
  fiatReceived(orderId: string): Promise<unknown> {
    if (this.rest.environment !== "sandbox") {
      throw new EtherfuseError("sandbox.fiatReceived() is only available with environment: 'sandbox'.");
    }
    return this.rest.post(Routes.orderFiatReceived(), { orderId });
  }
}
