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
  /** Etherfuse API key. Do NOT put the key on the frontend: use LookupClient or your own proxy. */
  apiKey: string;
  /** `sandbox` (default) or `production`. */
  environment?: Environment;
  /** Overrides the base URL (e.g. for a proxy). */
  baseUrl?: string;
  /** Default customerId used when requesting quotes (usually your organization). */
  defaultCustomerId?: string;
  /** Fetch implementation (default: global). */
  fetch?: typeof fetch;
  /** WebSocket implementation (Node < 22: pass the class from the `ws` package). */
  webSocket?: WebSocketConstructorLike;
  /** If `false`, `orderUpdated` events don't re-read the order via REST. Default: `true`. */
  hydrateEvents?: boolean;
  /** HTTP timeout per attempt, in ms. Default: 30,000. */
  timeoutMs?: number;
  /** HTTP retries on transient errors (424/429/5xx). Default: 2. */
  retries?: number;
}

export interface ClientEvents extends Record<string, unknown[]> {
  /** WebSocket connection established. */
  ready: [];
  /** Internal diagnostic messages. */
  debug: [message: string];
  /** Asynchronous errors (gateway, event hydration...). */
  error: [error: Error];
  /** Raw, unprocessed WebSocket frame. */
  raw: [payload: unknown];
  /** An order changed status. */
  orderUpdated: [payload: OrderUpdatedPayload];
  /** The WebSocket closed (automatically retried). */
  disconnect: [info: { code?: number; reason?: string }];
}

export class EtherfuseClient extends TypedEventEmitter<ClientEvents> {
  readonly options: Readonly<EtherfuseClientOptions>;
  /** Low-level HTTP layer — escape hatch for endpoints that aren't typed yet. */
  readonly rest: REST;
  /** Live events gateway. */
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

  /** Connects the live event stream (`orderUpdated`, `ready`, ...). */
  connect(): Promise<void> {
    return this.ws.connect();
  }

  /** Closes the WebSocket and clears listeners. */
  destroy(): void {
    this.ws.destroy();
    this.removeAllListeners();
  }
}
