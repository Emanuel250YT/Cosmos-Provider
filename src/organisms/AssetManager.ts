/** Organism: AssetManager — `client.assets`. */

import { Routes, type Blockchain, type FiatCurrency } from "@/atoms/constants";
import type { APIAsset } from "@/types/index";
import { BaseManager } from "@/organisms/BaseManager";

export interface ListAssetsOptions {
  blockchain: Blockchain;
  /** Moneda fiat del ramp (MXN o BRL). */
  currency: FiatCurrency | string;
  /** Dirección on-chain del usuario: la API la usa para chequeos (p. ej. trustlines en Stellar). */
  wallet: string;
}

export class AssetManager extends BaseManager {
  /**
   * Lista los activos soportados para blockchain + moneda + wallet
   * (Solana: mint Base58; Stellar: `CODE:ISSUER`; EVM: dirección del contrato).
   * La API exige los tres parámetros.
   */
  async list({ blockchain, currency, wallet }: ListAssetsOptions): Promise<APIAsset[]> {
    const raw = await this.rest.get<APIAsset[] | { items?: APIAsset[] }>(Routes.assets(), {
      query: { blockchain, currency, wallet },
    });
    return Array.isArray(raw) ? raw : (raw.items ?? []);
  }
}
