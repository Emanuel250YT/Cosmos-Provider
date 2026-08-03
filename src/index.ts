/**
 * cosmos-providers — provider-agnostic crypto onramp/offramp toolkit for
 * Latin America: regional payment rails (Mercado Pago, PIX, SPEI), a
 * CoinGecko rate oracle with configurable spread, automatic settlement,
 * and a webhook system.
 *
 * Isomorphic entry: works in the backend (Node >= 18) and the browser.
 * Node-only webhook verification lives in `cosmos-providers/webhooks`.
 */

// Core engine (provider-agnostic onramp/offramp)
export { CosmosRamp } from "@/core/CosmosRamp";
export type {
  CosmosRampOptions,
  OnrampParams,
  OfframpParams,
  RampEvents,
  WebhookHandleResult,
} from "@/core/CosmosRamp";
export { MemoryStore } from "@/core/MemoryStore";
export {
  CosmosError,
  ProviderError,
  OracleError,
  SettlementError,
  WebhookSignatureError,
} from "@/core/errors";
export { hmacSha256Hex, timingSafeEqualStr } from "@/core/signature";
export type * from "@/core/types";

// Rate oracles
export { CoinGeckoOracle, applySpread } from "@/oracles/CoinGeckoOracle";
export type { CoinGeckoOracleOptions } from "@/oracles/CoinGeckoOracle";

// Payment providers
export { MercadoPagoProvider } from "@/providers/mercadopago/MercadoPagoProvider";
export type { MercadoPagoProviderOptions } from "@/providers/mercadopago/MercadoPagoProvider";

// Outgoing webhooks (signed deliveries) + receiver-side verification
export {
  WebhookEmitter,
  verifyCosmosSignature,
  COSMOS_SIGNATURE_HEADER,
} from "@/webhooks/WebhookEmitter";
export type {
  WebhookEmitterOptions,
  WebhookEndpoint,
  WebhookDeliveryResult,
  CosmosWebhookEvent,
} from "@/webhooks/WebhookEmitter";

// Etherfuse provider (PIX/SPEI ramp API client)
export { EtherfuseClient } from "@/client/EtherfuseClient";
export type { EtherfuseClientOptions, ClientEvents } from "@/client/EtherfuseClient";
export { LookupClient } from "@/client/LookupClient";
export type { LookupClientOptions } from "@/client/LookupClient";
export { WebSocketManager } from "@/client/WebSocketManager";
export type {
  OrderUpdatedPayload,
  WebSocketConstructorLike,
  WebSocketLike,
} from "@/client/WebSocketManager";

// Organisms (managers)
export { BaseManager } from "@/organisms/BaseManager";
export { QuoteManager } from "@/organisms/QuoteManager";
export { OrderManager } from "@/organisms/OrderManager";
export { CustomerManager } from "@/organisms/CustomerManager";
export { BankAccountManager } from "@/organisms/BankAccountManager";
export { WalletManager } from "@/organisms/WalletManager";
export { AssetManager } from "@/organisms/AssetManager";
export { LookupManager } from "@/organisms/LookupManager";
export { SwapManager } from "@/organisms/SwapManager";
export { WebhookManager } from "@/organisms/WebhookManager";
export { SandboxManager } from "@/organisms/SandboxManager";

// Molecules (structures)
export { Base } from "@/molecules/Base";
export { Order, OrderReceipt, extractDeposit } from "@/molecules/Order";
export { Quote } from "@/molecules/Quote";
export { BankAccount } from "@/molecules/BankAccount";
export { Customer } from "@/molecules/Customer";
export { Wallet } from "@/molecules/Wallet";
export { Webhook } from "@/molecules/Webhook";
export { Pix, PixQr } from "@/molecules/Pix";
export type {
  ParsedPix,
  PixQrImageOptions,
  PixStaticOptions,
} from "@/molecules/Pix";

// Atoms
export { REST } from "@/atoms/REST";
export type { RESTOptions, RequestOptions } from "@/atoms/REST";
export { TypedEventEmitter } from "@/atoms/EventEmitter";
export { crc16ccitt } from "@/atoms/crc16";
export {
  EtherfuseError,
  EtherfuseAPIError,
  EtherfuseNetworkError,
  PixError,
  WebhookVerificationError,
} from "@/atoms/errors";
export {
  BASE_URLS,
  Blockchains,
  ClientEventNames,
  Environments,
  FiatCurrencies,
  OrderDirections,
  OrderStatuses,
  PixKeyTypes,
  Routes,
  TERMINAL_ORDER_STATUSES,
  randomUUID,
} from "@/atoms/constants";
export type {
  Blockchain,
  Environment,
  FiatCurrency,
  OrderDirection,
  OrderStatus,
  PixKeyType,
} from "@/atoms/constants";

// Tipos de la API
export type * from "@/types/index";
