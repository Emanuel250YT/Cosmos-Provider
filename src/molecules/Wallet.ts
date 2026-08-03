/** Molecule: Wallet — dirección on-chain registrada. */

import type { Blockchain } from "@/atoms/constants";
import type { APIWallet } from "@/types/index";
import { Base } from "@/molecules/Base";

export class Wallet extends Base<APIWallet> {
  /** Id interno de Etherfuse para esta wallet (no es la dirección on-chain). */
  get id(): string {
    return this.raw.walletId;
  }

  /** Dirección/clave pública on-chain, cuando la API la informa. */
  get publicKey(): string | undefined {
    return this.raw.publicKey;
  }

  /** Red sobre la que vive esta wallet (Solana, Stellar, Base, Polygon...). */
  get blockchain(): Blockchain | undefined {
    return this.raw.blockchain;
  }

  /** Vuelve a pedir esta wallet a la API para obtener su estado más reciente. */
  fetch(): Promise<Wallet> {
    return this.client.wallets.fetch(this.id);
  }

  /** Elimina el registro de esta wallet en Etherfuse (no afecta la cuenta on-chain). */
  delete(): Promise<unknown> {
    return this.client.wallets.delete(this.id);
  }
}
