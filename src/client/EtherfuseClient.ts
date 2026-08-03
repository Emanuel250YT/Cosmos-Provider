/**
 * EtherfuseClient — client for the Etherfuse ramp API (PIX/BRL and SPEI/MXN).
 *
 * A single client with one manager per resource and live events:
 *
 * ```ts
 * const client = new EtherfuseClient({ apiKey: "...", environment: "sandbox" });
 * const quote = await client.quotes.create({ ... });
 * const order = await quote.createOrder({ bankAccountId });
 * const qr = order.createPixQr();
 * client.on("orderUpdated", ({ order }) => console.log(order?.status));
 * await client.connect();
 * ```
 */

import { REST } from "@/atoms/REST";
import { TypedEventEmitter } from "@/atoms/EventEmitter";
import type { Environment } from "@/atoms/constants";
import { AssetManager } from "@/organisms/AssetManager";
import { BankAccountManager } from "@/organisms/BankAccountManager";
import { CustomerManager } from "@/organisms/CustomerManager";
import { LookupManager } from "@/organisms/LookupManager";
import { OrderManager } from "@/organisms/OrderManager";
import { QuoteManager } from "@/organisms/QuoteManager";
import { SandboxManager } from "@/organisms/SandboxManager";
import { SwapManager } from "@/organisms/SwapManager";
import { WalletManager } from "@/organisms/WalletManager";
import { WebhookManager } from "@/organisms/WebhookManager";
import {
  WebSocketManager,
  type OrderUpdatedPayload,
  type WebSocketConstructorLike,
} from "@/client/WebSocketManager";

export interface EtherfuseClientOptions {
  /** API key de Etherfuse. En frontend NO pongas la key: usa LookupClient o un proxy propio. */
  apiKey: string;
  /** `sandbox` (default) o `production`. */
  environment?: Environment;
  /** Anula la URL base (p. ej. para un proxy). */
  baseUrl?: string;
  /** customerId usado por defecto al pedir quotes (normalmente tu organización). */
  defaultCustomerId?: string;
  /** Implementación de fetch (default: global). */
  fetch?: typeof fetch;
  /** Implementación de WebSocket (Node < 22: pasa la clase del paquete `ws`). */
  webSocket?: WebSocketConstructorLike;
  /** Si `false`, los eventos `orderUpdated` no re-leen la orden vía REST. Default: `true`. */
  hydrateEvents?: boolean;
  /** Timeout HTTP por intento en ms. Default: 30 000. */
  timeoutMs?: number;
  /** Reintentos HTTP ante errores transitorios (424/429/5xx). Default: 2. */
  retries?: number;
}

export interface ClientEvents extends Record<string, unknown[]> {
  /** Conexión WebSocket establecida. */
  ready: [];
  /** Mensajes de diagnóstico internos. */
  debug: [message: string];
  /** Errores asíncronos (gateway, hidratación de eventos...). */
  error: [error: Error];
  /** Frame crudo del WebSocket, sin procesar. */
  raw: [payload: unknown];
  /** Una orden cambió de estado. */
  orderUpdated: [payload: OrderUpdatedPayload];
  /** El WebSocket se cerró (se reintenta automáticamente). */
  disconnect: [info: { code?: number; reason?: string }];
}

export class EtherfuseClient extends TypedEventEmitter<ClientEvents> {
  readonly options: Readonly<EtherfuseClientOptions>;
  /** Capa HTTP de bajo nivel — escape hatch para endpoints aún no tipados. */
  readonly rest: REST;
  /** Gateway de eventos en vivo. */
  readonly ws: WebSocketManager;

  readonly quotes: QuoteManager;
  readonly orders: OrderManager;
  readonly customers: CustomerManager;
  readonly bankAccounts: BankAccountManager;
  readonly wallets: WalletManager;
  readonly assets: AssetManager;
  readonly lookup: LookupManager;
  readonly swaps: SwapManager;
  readonly webhooks: WebhookManager;
  readonly sandbox: SandboxManager;

  constructor(options: EtherfuseClientOptions) {
    super();
    this.options = Object.freeze({ ...options });
    this.rest = new REST({
      apiKey: options.apiKey,
      environment: options.environment,
      baseUrl: options.baseUrl,
      fetch: options.fetch,
      timeoutMs: options.timeoutMs,
      retries: options.retries,
      onDebug: (message) => this.emit("debug", message),
    });

    this.ws = new WebSocketManager(this);
    this.quotes = new QuoteManager(this);
    this.orders = new OrderManager(this);
    this.customers = new CustomerManager(this);
    this.bankAccounts = new BankAccountManager(this);
    this.wallets = new WalletManager(this);
    this.assets = new AssetManager(this);
    this.lookup = new LookupManager(this);
    this.swaps = new SwapManager(this);
    this.webhooks = new WebhookManager(this);
    this.sandbox = new SandboxManager(this);
  }

  get environment(): Environment {
    return this.rest.environment;
  }

  /** Conecta el stream de eventos en vivo (`orderUpdated`, `ready`, ...). */
  connect(): Promise<void> {
    return this.ws.connect();
  }

  /** Cierra el WebSocket y limpia listeners. */
  destroy(): void {
    this.ws.destroy();
    this.removeAllListeners();
  }
}
