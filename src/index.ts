/**
 * cosmos-providers — cliente para la API de Etherfuse con soporte de primera
 * clase para PIX/BRL (QR de pagos), estilo discord.js y atomic design.
 *
 * Entry isomórfico: funciona en backend (Node >= 18) y frontend.
 * La verificación de webhooks (Node-only) vive en `cosmos-providers/webhooks`.
 */

// Pages / Clients
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
