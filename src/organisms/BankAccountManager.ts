/** Organism: BankAccountManager — `client.bankAccounts`. */

import { randomUUID, Routes } from "@/atoms/constants";
import { BankAccount } from "@/molecules/BankAccount";
import type {
  APIBankAccount,
  CreateBankAccountPayload,
  CreateClabeBusinessAccount,
  CreateClabePersonalAccount,
  CreatePixBusinessAccount,
  CreatePixPersonalAccount,
  Page,
  PageQuery,
} from "@/types/index";
import { BaseManager } from "@/organisms/BaseManager";

export class BankAccountManager extends BaseManager {
  /** Creates a bank account with the API's raw payload. */
  async create(customerId: string, payload: CreateBankAccountPayload): Promise<BankAccount> {
    const raw = await this.rest.post<APIBankAccount>(Routes.customerBankAccount(customerId), {
      ...payload,
      account: { transactionId: randomUUID(), ...payload.account },
    });
    return new BankAccount(this.client, raw);
  }

  /** Shortcut: individual PIX account (BRL). */
  createPixPersonal(
    customerId: string,
    account: CreatePixPersonalAccount,
    label?: string,
  ): Promise<BankAccount> {
    return this.create(customerId, { account, label });
  }

  /** Shortcut: business PIX account (BRL). */
  createPixBusiness(
    customerId: string,
    account: CreatePixBusinessAccount,
    label?: string,
  ): Promise<BankAccount> {
    return this.create(customerId, { account, label });
  }

  /** Shortcut: individual CLABE account (MXN). */
  createClabePersonal(
    customerId: string,
    account: CreateClabePersonalAccount,
    label?: string,
  ): Promise<BankAccount> {
    return this.create(customerId, { account, label });
  }

  /** Shortcut: business CLABE account (MXN). */
  createClabeBusiness(
    customerId: string,
    account: CreateClabeBusinessAccount,
    label?: string,
  ): Promise<BankAccount> {
    return this.create(customerId, { account, label });
  }

  /** A bank account by id. */
  async fetch(bankAccountId: string): Promise<BankAccount> {
    const raw = await this.rest.get<APIBankAccount>(Routes.bankAccountById(bankAccountId));
    return new BankAccount(this.client, raw);
  }

  /** Paginated list of the organization's bank accounts. */
  async list(query: PageQuery = {}): Promise<Page<BankAccount>> {
    const raw = await this.rest.get<Page<APIBankAccount>>(Routes.bankAccounts(), {
      query: { pageNumber: query.pageNumber, pageSize: query.pageSize },
    });
    return { ...raw, items: (raw.items ?? []).map((a) => new BankAccount(this.client, a)) };
  }

  /** Accounts belonging to a specific customer. */
  async listForCustomer(customerId: string): Promise<BankAccount[]> {
    const raw = await this.rest.get<Page<APIBankAccount> | APIBankAccount[]>(
      Routes.customerBankAccounts(customerId),
    );
    const items = Array.isArray(raw) ? raw : (raw.items ?? []);
    return items.map((a) => new BankAccount(this.client, a));
  }
}
