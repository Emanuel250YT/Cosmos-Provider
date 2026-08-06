/**
 * Atom: global constants and route table for the Etherfuse API.
 *
 * `Routes` is the single source of truth for API paths: if Etherfuse changes
 * an endpoint, fix it here and the whole library inherits the change.
 */

import { Chain, FiatCurrency } from "@/atoms/enums";

export const Environments = {
  Sandbox: "sandbox",
  Production: "production",
} as const;

export type Environment = (typeof Environments)[keyof typeof Environments];

export const BASE_URLS: Record<Environment, string> = {
  sandbox: "https://api.sand.etherfuse.com",
  production: "https://api.etherfuse.com",
};

/**
 * @deprecated Use {@link Chain} from `@/atoms/enums` (same values, same
 * object — kept here so existing `Blockchains`/`Blockchain` imports don't
 * break).
 */
export const Blockchains = Chain;
/** @deprecated Use {@link Chain} from `@/atoms/enums`. */
export type Blockchain = Chain;

/**
 * @deprecated Use {@link FiatCurrency} from `@/atoms/enums` (same values,
 * same object — kept here so existing `FiatCurrencies`/`FiatCurrency`
 * imports don't break). Etherfuse itself only settles BRL/MXN today; the
 * other markets in the shared enum are for Mercado Pago/Koywe.
 */
export const FiatCurrencies = FiatCurrency;
/** @deprecated Use {@link FiatCurrency} from `@/atoms/enums`. */
export type { FiatCurrency };

export const OrderDirections = {
  Onramp: "onramp",
  Offramp: "offramp",
} as const;

export type OrderDirection = (typeof OrderDirections)[keyof typeof OrderDirections];

export const OrderStatuses = {
  Created: "created",
  Funded: "funded",
  Completed: "completed",
  Failed: "failed",
  Refunded: "refunded",
  Canceled: "canceled",
  Finalized: "finalized",
} as const;

export type OrderStatus = (typeof OrderStatuses)[keyof typeof OrderStatuses];

/** Statuses from which the order no longer advances. */
export const TERMINAL_ORDER_STATUSES: readonly OrderStatus[] = [
  OrderStatuses.Completed,
  OrderStatuses.Failed,
  OrderStatuses.Refunded,
  OrderStatuses.Canceled,
  OrderStatuses.Finalized,
];

export const PixKeyTypes = {
  Cpf: "cpf",
  Cnpj: "cnpj",
  Email: "email",
  Phone: "phone",
  Random: "random",
} as const;

export type PixKeyType = (typeof PixKeyTypes)[keyof typeof PixKeyTypes];

/** Events emitted by {@link EtherfuseClient}. */
export const ClientEventNames = {
  Ready: "ready",
  Debug: "debug",
  Error: "error",
  Raw: "raw",
  OrderUpdated: "orderUpdated",
  Disconnect: "disconnect",
} as const;

/**
 * Route table. Entries marked `@inferred` don't appear literally in the
 * public docs and follow the convention of the rest of the API; verify them
 * against https://docs.etherfuse.com if an endpoint returns 404.
 */
export const Routes = {
  // Quotes
  quote: () => `/ramp/quote` as const,

  // Orders
  order: () => `/ramp/order` as const,
  orderById: (orderId: string) => `/ramp/order/${orderId}` as const,
  /** @inferred */
  orders: () => `/ramp/orders` as const,
  /** Sandbox: simulates the fiat deposit for an onramp order. */
  orderFiatReceived: () => `/ramp/order/fiat_received` as const,

  // Customers
  me: () => `/ramp/me` as const,
  customers: () => `/ramp/customers` as const,
  /** @inferred */
  customerById: (customerId: string) => `/ramp/customer/${customerId}` as const,

  // Bank accounts
  customerBankAccount: (customerId: string) =>
    `/ramp/customer/${customerId}/bank-account` as const,
  /** @inferred */
  customerBankAccounts: (customerId: string) =>
    `/ramp/customer/${customerId}/bank-accounts` as const,
  /** @inferred */
  bankAccountById: (bankAccountId: string) => `/ramp/bank-account/${bankAccountId}` as const,
  /** @inferred */
  bankAccounts: () => `/ramp/bank-accounts` as const,

  // Wallets
  wallet: () => `/ramp/wallet` as const,
  customerWallet: (customerId: string) => `/ramp/customer/${customerId}/wallet` as const,
  /** @inferred */
  customerWallets: (customerId: string) => `/ramp/customer/${customerId}/wallets` as const,
  /** @inferred */
  walletById: (walletId: string) => `/ramp/wallet/${walletId}` as const,
  /** @inferred */
  wallets: () => `/ramp/wallets` as const,

  // Assets & swaps
  assets: () => `/ramp/assets` as const,
  /** @inferred */
  swap: () => `/ramp/swap` as const,

  // Webhooks
  /** @inferred */
  webhook: () => `/ramp/webhook` as const,
  /** @inferred */
  webhookById: (webhookId: string) => `/ramp/webhook/${webhookId}` as const,
  /** @inferred */
  webhooks: () => `/ramp/webhooks` as const,

  // WebSocket
  wsToken: () => `/ramp/ws-api-token` as const,
  wsGateway: () => `/ramp/ws` as const,

  // Lookup (public, no API key required)
  lookupExchangeRate: () => `/lookup/exchange_rate` as const,
  /** @inferred */
  lookupStablebonds: () => `/lookup/stablebonds` as const,
  /** @inferred */
  lookupStablebondCost: () => `/lookup/stablebond_cost` as const,
  /** @inferred */
  lookupCountryCodes: () => `/lookup/country_codes` as const,
  /** @inferred */
  lookupRestrictedCountries: () => `/lookup/restricted_countries` as const,
} as const;

/** Random UUID v4 (available in Node >= 18 and all modern browsers). */
export function randomUUID(): string {
  const c = globalThis.crypto;
  if (c?.randomUUID) return c.randomUUID();
  // Highly unlikely fallback (environments without WebCrypto)
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (ch) => {
    const r = (Math.random() * 16) | 0;
    const v = ch === "x" ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}
