/** Molecule: BankAccount — a PIX (BRL) or CLABE (MXN) settlement account. */

import type { APIBankAccount } from "@/types/index";
import { Base } from "@/molecules/Base";

export class BankAccount extends Base<APIBankAccount> {
  /** This bank account's id in Etherfuse. */
  get id(): string {
    return this.raw.bankAccountId;
  }

  /** Id of the customer who owns the account. */
  get customerId(): string {
    return this.raw.customerId;
  }

  /** Settlement currency ("BRL", "MXN"...). */
  get currency(): string {
    return this.raw.currency;
  }

  /** `true` if this is a Brazilian account settled via PIX. The API returns the currency lowercased. */
  get isPix(): boolean {
    return this.currency?.toUpperCase() === "BRL";
  }

  /** `true` if this is a Mexican account settled via SPEI. */
  get isSpei(): boolean {
    return this.currency?.toUpperCase() === "MXN";
  }

  /** `true` if the account can be used to transact. */
  get compliant(): boolean {
    return this.raw.compliant === true;
  }

  /** Re-fetches this account from the API to get its latest status (e.g. `compliant`). */
  fetch(): Promise<BankAccount> {
    return this.client.bankAccounts.fetch(this.id);
  }
}
