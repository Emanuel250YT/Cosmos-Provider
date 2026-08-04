/** Molecule: Wallet — a registered on-chain address. */

import type { Blockchain } from "@/atoms/constants";
import type { APIWallet } from "@/types/index";
import { Base } from "@/molecules/Base";

export class Wallet extends Base<APIWallet> {
  /** Etherfuse's internal id for this wallet (not the on-chain address). */
  get id(): string {
    return this.raw.walletId;
  }

  /** On-chain address/public key, when the API reports it. */
  get publicKey(): string | undefined {
    return this.raw.publicKey;
  }

  /** Network this wallet lives on (Solana, Stellar, Base, Polygon...). */
  get blockchain(): Blockchain | undefined {
    return this.raw.blockchain;
  }

  /** Re-fetches this wallet from the API to get its latest status. */
  fetch(): Promise<Wallet> {
    return this.client.wallets.fetch(this.id);
  }

  /** Deletes this wallet's registration in Etherfuse (doesn't affect the on-chain account). */
  delete(): Promise<unknown> {
    return this.client.wallets.delete(this.id);
  }
}
