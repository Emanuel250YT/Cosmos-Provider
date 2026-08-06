/** Organism: AssetManager — `client.assets`. */

import { Routes, type Blockchain, type FiatCurrency } from "@/atoms/constants";
import type { APIAsset } from "@/types/index";
import { BaseManager } from "@/organisms/BaseManager";

export interface ListAssetsOptions {
  blockchain: Blockchain;
  /** Ramp fiat currency (MXN or BRL). */
  currency: FiatCurrency | string;
  /** User's on-chain address: the API uses it for checks (e.g. trustlines on Stellar). */
  wallet: string;
}

export class AssetManager extends BaseManager {
  /**
   * Lists the supported assets for blockchain + currency + wallet
   * (Solana: Base58 mint; Stellar: `CODE:ISSUER`; EVM: contract address).
   * The API requires all three parameters.
   */
  async list({ blockchain, currency, wallet }: ListAssetsOptions): Promise<APIAsset[]> {
    const raw = await this.rest.get<APIAsset[] | { items?: APIAsset[] }>(Routes.assets(), {
      query: { blockchain, currency, wallet },
    });
    return Array.isArray(raw) ? raw : (raw.items ?? []);
  }
}
