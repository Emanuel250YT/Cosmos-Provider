/** Molecule: BankAccount — cuenta de liquidación PIX (BRL) o CLABE (MXN). */

import type { APIBankAccount } from "@/types/index";
import { Base } from "@/molecules/Base";

export class BankAccount extends Base<APIBankAccount> {
  /** Id de esta cuenta bancaria en Etherfuse. */
  get id(): string {
    return this.raw.bankAccountId;
  }

  /** Id del customer dueño de la cuenta. */
  get customerId(): string {
    return this.raw.customerId;
  }

  /** Moneda de liquidación ("BRL", "MXN"...). */
  get currency(): string {
    return this.raw.currency;
  }

  /** `true` si es una cuenta brasileña liquidada por PIX. La API devuelve la moneda en minúsculas. */
  get isPix(): boolean {
    return this.currency?.toUpperCase() === "BRL";
  }

  /** `true` si es una cuenta mexicana liquidada por SPEI. */
  get isSpei(): boolean {
    return this.currency?.toUpperCase() === "MXN";
  }

  /** `true` si la cuenta puede usarse para transaccionar. */
  get compliant(): boolean {
    return this.raw.compliant === true;
  }

  /** Vuelve a pedir esta cuenta a la API para obtener su estado más reciente (p. ej. `compliant`). */
  fetch(): Promise<BankAccount> {
    return this.client.bankAccounts.fetch(this.id);
  }
}
