/** Molecule: Wallet — dirección on-chain registrada. */

import type { Blockchain } from "@/atoms/constants";
import type { APIWallet } from "@/types/index";
import { Base } from "@/molecules/Base";

export class Wallet extends Base<APIWallet> {
  get id(): string {
    return this.raw.walletId;
  }

  get publicKey(): string | undefined {
    return this.raw.publicKey;
  }

  get blockchain(): Blockchain | undefined {
    return this.raw.blockchain;
  }

  fetch(): Promise<Wallet> {
    return this.client.wallets.fetch(this.id);
  }

  delete(): Promise<unknown> {
    return this.client.wallets.delete(this.id);
  }
}
