/** Molecule: Customer — organización o cliente hijo. */

import type { APICustomer, CreateBankAccountPayload, RegisterWalletOptions } from "@/types/index";
import type { BankAccount } from "@/molecules/BankAccount";
import type { Wallet } from "@/molecules/Wallet";
import { Base } from "@/molecules/Base";

export class Customer extends Base<APICustomer> {
  get id(): string {
    return this.raw.customerId;
  }

  get displayName(): string | undefined {
    return this.raw.displayName;
  }

  /** Registra una cuenta bancaria (PIX o CLABE) para este customer. */
  createBankAccount(payload: CreateBankAccountPayload): Promise<BankAccount> {
    return this.client.bankAccounts.create(this.id, payload);
  }

  /** Registra una wallet on-chain para este customer. */
  registerWallet(options: RegisterWalletOptions): Promise<Wallet> {
    return this.client.wallets.registerForCustomer(this.id, options);
  }

  /** Lista las cuentas bancarias del customer. */
  fetchBankAccounts(): Promise<BankAccount[]> {
    return this.client.bankAccounts.listForCustomer(this.id);
  }

  /** Lista las wallets del customer. */
  fetchWallets(): Promise<Wallet[]> {
    return this.client.wallets.listForCustomer(this.id);
  }
}
