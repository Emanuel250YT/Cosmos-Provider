/** Organism: AssetManager — `client.assets`. */

import { Routes } from "@/atoms/constants";
import type { APIAsset } from "@/types/index";
import { BaseManager } from "@/organisms/BaseManager";

export class AssetManager extends BaseManager {
  /**
   * Lista los activos soportados y sus identificadores por blockchain
   * (Solana: mint Base58; Stellar: `CODE:ISSUER`; EVM: dirección del contrato).
   */
  async list(): Promise<APIAsset[]> {
    const raw = await this.rest.get<APIAsset[] | { items?: APIAsset[] }>(Routes.assets());
    return Array.isArray(raw) ? raw : (raw.items ?? []);
  }
}
