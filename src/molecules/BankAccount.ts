/** Molecule: BankAccount — cuenta de liquidación PIX (BRL) o CLABE (MXN). */

import type { APIBankAccount } from "@/types/index";
import { Base } from "@/molecules/Base";

export class BankAccount extends Base<APIBankAccount> {
  get id(): string {
    return this.raw.bankAccountId;
  }

  get customerId(): string {
    return this.raw.customerId;
  }

  get currency(): string {
    return this.raw.currency;
  }

  /** `true` si es una cuenta brasileña liquidada por PIX. */
  get isPix(): boolean {
    return this.currency === "BRL";
  }

  /** `true` si es una cuenta mexicana liquidada por SPEI. */
  get isSpei(): boolean {
    return this.currency === "MXN";
  }

  /** `true` si la cuenta puede usarse para transaccionar. */
  get compliant(): boolean {
    return this.raw.compliant === true;
  }

  fetch(): Promise<BankAccount> {
    return this.client.bankAccounts.fetch(this.id);
  }
}
