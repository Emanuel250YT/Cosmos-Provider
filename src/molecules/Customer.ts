/** Molecule: Customer — an organization or child customer. */

import type { APICustomer, CreateBankAccountPayload, RegisterWalletOptions } from "@/types/index";
import type { BankAccount } from "@/molecules/BankAccount";
import type { Wallet } from "@/molecules/Wallet";
import { Base } from "@/molecules/Base";

export class Customer extends Base<APICustomer> {
  get id(): string {
    // /ramp/me returns `id`; every other endpoint uses `customerId`.
    return this.raw.customerId ?? (this.raw.id as string);
  }

  /** Display name of the organization/customer, when the API reports it. */
  get displayName(): string | undefined {
    return this.raw.displayName;
  }

  /** Registers a bank account (PIX or CLABE) for this customer. */
  createBankAccount(payload: CreateBankAccountPayload): Promise<BankAccount> {
    return this.client.bankAccounts.create(this.id, payload);
  }

  /** Registers an on-chain wallet for this customer. */
  registerWallet(options: RegisterWalletOptions): Promise<Wallet> {
    return this.client.wallets.registerForCustomer(this.id, options);
  }

  /** Lists the customer's bank accounts. */
  fetchBankAccounts(): Promise<BankAccount[]> {
    return this.client.bankAccounts.listForCustomer(this.id);
  }

  /** Lists the customer's wallets. */
  fetchWallets(): Promise<Wallet[]> {
    return this.client.wallets.listForCustomer(this.id);
  }
}
