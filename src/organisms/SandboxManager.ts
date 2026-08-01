/** Organism: SandboxManager — `client.sandbox` (solo entorno sandbox). */

import { Routes } from "@/atoms/constants";
import { EtherfuseError } from "@/atoms/errors";
import { BaseManager } from "@/organisms/BaseManager";

export class SandboxManager extends BaseManager {
  /**
   * Simula el depósito fiat de una orden onramp (`created` → `funded` →
   * `completed`). Solo funciona contra el sandbox; en producción los
   * depósitos se detectan automáticamente.
   */
  fiatReceived(orderId: string): Promise<unknown> {
    if (this.rest.environment !== "sandbox") {
      throw new EtherfuseError("sandbox.fiatReceived() solo está disponible en environment: 'sandbox'.");
    }
    return this.rest.post(Routes.orderFiatReceived(), { orderId });
  }
}
