/** Organism: WalletManager — `client.wallets`. */

import { Routes } from "@/atoms/constants";
import { Wallet } from "@/molecules/Wallet";
import type { APIWallet, Page, PageQuery, RegisterWalletOptions } from "@/types/index";
import { BaseManager } from "@/organisms/BaseManager";

export class WalletManager extends BaseManager {
  /** Registra una wallet a nivel organización (soporta wallets embebidas). */
  async register(options: RegisterWalletOptions): Promise<Wallet> {
    const raw = await this.rest.post<APIWallet>(Routes.wallet(), options);
    return new Wallet(this.client, raw);
  }

  /** Registra la wallet de un customer hijo. */
  async registerForCustomer(
    customerId: string,
    options: RegisterWalletOptions,
  ): Promise<Wallet> {
    const raw = await this.rest.post<APIWallet>(Routes.customerWallet(customerId), options);
    return new Wallet(this.client, raw);
  }

  async fetch(walletId: string): Promise<Wallet> {
    const raw = await this.rest.get<APIWallet>(Routes.walletById(walletId));
    return new Wallet(this.client, raw);
  }

  async list(query: PageQuery = {}): Promise<Page<Wallet>> {
    const raw = await this.rest.get<Page<APIWallet>>(Routes.wallets(), {
      query: { pageNumber: query.pageNumber, pageSize: query.pageSize },
    });
    return { ...raw, items: (raw.items ?? []).map((w) => new Wallet(this.client, w)) };
  }

  async listForCustomer(customerId: string): Promise<Wallet[]> {
    const raw = await this.rest.get<Page<APIWallet> | APIWallet[]>(
      Routes.customerWallets(customerId),
    );
    const items = Array.isArray(raw) ? raw : (raw.items ?? []);
    return items.map((w) => new Wallet(this.client, w));
  }

  delete(walletId: string): Promise<unknown> {
    return this.rest.delete(Routes.walletById(walletId));
  }
}
