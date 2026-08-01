/**
 * Atom: constantes globales y tabla de rutas de la API de Etherfuse.
 *
 * `Routes` es la única fuente de verdad de los paths (estilo discord.js):
 * si Etherfuse cambia un endpoint, se corrige aquí y toda la librería lo hereda.
 */

export const Environments = {
  Sandbox: "sandbox",
  Production: "production",
} as const;

export type Environment = (typeof Environments)[keyof typeof Environments];

export const BASE_URLS: Record<Environment, string> = {
  sandbox: "https://api.sand.etherfuse.com",
  production: "https://api.etherfuse.com",
};

export const Blockchains = {
  Stellar: "stellar",
  Solana: "solana",
  Base: "base",
  Polygon: "polygon",
  Monad: "monad",
} as const;

export type Blockchain = (typeof Blockchains)[keyof typeof Blockchains];

export const FiatCurrencies = {
  /** Peso mexicano — liquidación vía SPEI/CLABE. */
  MXN: "MXN",
  /** Real brasileño — liquidación vía PIX. */
  BRL: "BRL",
} as const;

export type FiatCurrency = (typeof FiatCurrencies)[keyof typeof FiatCurrencies];

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

/** Estados desde los que la orden ya no avanza. */
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

/** Eventos que emite {@link EtherfuseClient}. */
export const ClientEventNames = {
  Ready: "ready",
  Debug: "debug",
  Error: "error",
  Raw: "raw",
  OrderUpdated: "orderUpdated",
  Disconnect: "disconnect",
} as const;

/**
 * Tabla de rutas. Las marcadas con `@inferred` no aparecen literalmente en la
 * documentación pública y siguen la convención del resto de la API; verifícalas
 * contra https://docs.etherfuse.com si un endpoint devuelve 404.
 */
export const Routes = {
  // Quotes
  quote: () => `/ramp/quote` as const,

  // Orders
  order: () => `/ramp/order` as const,
  orderById: (orderId: string) => `/ramp/order/${orderId}` as const,
  /** @inferred */
  orders: () => `/ramp/orders` as const,
  /** Sandbox: simula el depósito fiat de una orden onramp. */
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

  // Lookup (público, sin API key)
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

/** UUID v4 aleatorio (disponible en Node >= 18 y en todos los navegadores modernos). */
export function randomUUID(): string {
  const c = globalThis.crypto;
  if (c?.randomUUID) return c.randomUUID();
  // Fallback muy improbable (entornos sin WebCrypto)
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (ch) => {
    const r = (Math.random() * 16) | 0;
    const v = ch === "x" ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}
