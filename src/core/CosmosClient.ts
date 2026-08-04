/**
 * CosmosClient — single entry point that wires up every piece of the
 * toolkit from ONE config object: the Mercado Pago provider (with its
 * per-currency accounts), the Etherfuse client, the Koywe client, the
 * CoinGecko oracle, and the ramp engine that ties fiat providers to
 * settlement. Construct one `CosmosClient` and pull whatever you need off
 * it — `client.ramp`, `client.etherfuse`, `client.koywe` — instead of
 * importing and constructing `CosmosRamp`, `MercadoPagoProvider`,
 * `EtherfuseClient`, `KoyweClient` and `CoinGeckoOracle` separately.
 *
 * ```ts
 * import { CosmosClient } from "cosmos-providers";
 *
 * const cosmos = new CosmosClient({
 *   mercadopago: {
 *     accounts: {
 *       ARS: { accessToken: process.env.MP_AR_ACCESS_TOKEN!, webhookSecret: process.env.MP_AR_WEBHOOK_SECRET },
 *       BRL: { accessToken: process.env.MP_BR_ACCESS_TOKEN!, webhookSecret: process.env.MP_BR_WEBHOOK_SECRET },
 *     },
 *   },
 *   etherfuse: { apiKey: process.env.ETHERFUSE_API_KEY!, environment: "sandbox" },
 *   koywe: { clientId: process.env.KOYWE_CLIENT_ID!, secret: process.env.KOYWE_SECRET!, baseUrl: "...", usdcIssuer: "..." },
 *   settlement: async ({ wallet, amount, asset }) => ({ txId: await myWallet.transfer(asset, amount, wallet) }),
 * });
 *
 * await cosmos.ramp.onramp({ provider: "mercadopago", currency: "ARS", amount: 50000, wallet });
 * await cosmos.etherfuse.customers.me();
 * await cosmos.koywe.getQuote({ ramp: "onramp", fiatCurrency: "ARS", amount: "10000" });
 * await cosmos.sep.fetchStellarToml("testanchor.stellar.org");
 * ```
 *
 * Everything is optional except at least one way to move fiat/crypto — pass
 * only the sections you actually use. `client.ramp` is only built (and only
 * non-`undefined`) when at least one fiat `PaymentProvider` is configured
 * (`mercadopago` and/or `customProviders`); Etherfuse and Koywe are full
 * ramp clients in their own right and don't need `ramp` to be useful.
 */

import { EtherfuseClient, type EtherfuseClientOptions } from "@/client/EtherfuseClient";
import { KoyweClient, type KoyweClientOptions } from "@/client/koywe";
import {
  fetchStellarToml,
  getSep10Challenge,
  submitSep10Challenge,
  authenticateSep10,
  getSep24Info,
  startDeposit,
  startWithdraw,
  getSep24Transaction,
  listSep24Transactions,
} from "@/client/sep";
import { CosmosRamp, type CosmosRampOptions } from "@/core/CosmosRamp";
import { CosmosError } from "@/core/errors";
import type { OrderStore, PaymentProvider, RateOracle, SettlementAdapter, SettlementFn } from "@/core/types";
import { CoinGeckoOracle, type CoinGeckoOracleOptions } from "@/oracles/CoinGeckoOracle";
import { MercadoPagoProvider, type MercadoPagoProviderOptions } from "@/providers/mercadopago/MercadoPagoProvider";
import type { WebhookEndpoint } from "@/webhooks/WebhookEmitter";

/** The composable SEP-1/10/24 helpers, bound together as `client.sep.*` — no separate import needed. */
export interface SepHelpers {
  fetchStellarToml: typeof fetchStellarToml;
  getSep10Challenge: typeof getSep10Challenge;
  submitSep10Challenge: typeof submitSep10Challenge;
  authenticateSep10: typeof authenticateSep10;
  getSep24Info: typeof getSep24Info;
  startDeposit: typeof startDeposit;
  startWithdraw: typeof startWithdraw;
  getSep24Transaction: typeof getSep24Transaction;
  listSep24Transactions: typeof listSep24Transactions;
}

export interface CosmosClientOptions {
  /** Mercado Pago provider config — one or more accounts (see {@link MercadoPagoProviderOptions.accounts}). Omit if you don't use Mercado Pago. */
  mercadopago?: MercadoPagoProviderOptions;
  /** Extra fiat `PaymentProvider`s to register alongside `mercadopago` (e.g. from `createCustomProvider`). */
  customProviders?: PaymentProvider[];
  /** Etherfuse client config (PIX/SPEI ramp API, full anchor to Stellar/Solana/Base/Polygon/Monad). Omit if you don't use Etherfuse. */
  etherfuse?: EtherfuseClientOptions;
  /** Koywe client config (ARS/CLP/MXN/COP/PEN/BRL ramp to USDC on Stellar). Omit if you don't use Koywe. */
  koywe?: KoyweClientOptions;
  /**
   * Rate oracle for `client.ramp`. Pass a `RateOracle` instance directly, or
   * `CoinGeckoOracleOptions` to have `CosmosClient` build one for you.
   * Default: `new CoinGeckoOracle()` (no key, public rate limits).
   */
  oracle?: RateOracle | CoinGeckoOracleOptions;
  /** Releases crypto after an approved onramp payment, for `client.ramp`. */
  settlement?: SettlementAdapter | SettlementFn;
  /** Order persistence for `client.ramp`. Default: in-memory (dev only). */
  store?: OrderStore;
  /** Outgoing webhooks: `client.ramp` events signed and POSTed to these URLs. */
  webhooks?: { endpoints: WebhookEndpoint[]; maxAttempts?: number; fetch?: typeof fetch };
  /** Ramp engine defaults (spread, asset, amount tolerance). */
  defaults?: CosmosRampOptions["defaults"];
}

function isRateOracle(value: unknown): value is RateOracle {
  return !!value && typeof (value as RateOracle).getRate === "function";
}

export class CosmosClient {
  /**
   * The provider-agnostic onramp/offramp engine, wired with every fiat
   * `PaymentProvider` you configured (`mercadopago`, `customProviders`).
   * `undefined` if you configured neither — Etherfuse/Koywe don't need this,
   * they're full ramp clients on their own.
   */
  readonly ramp?: CosmosRamp;
  /** The Mercado Pago provider, for calls `client.ramp` doesn't expose directly (`getCharge`, `buildTestWebhook`...). `undefined` if `mercadopago` wasn't configured. */
  readonly mercadopago?: MercadoPagoProvider;
  /** The Etherfuse client. `undefined` if `etherfuse` wasn't configured. */
  readonly etherfuse?: EtherfuseClient;
  /** The Koywe client. `undefined` if `koywe` wasn't configured. */
  readonly koywe?: KoyweClient;
  /** The rate oracle `client.ramp` uses (the one you passed, or the `CoinGeckoOracle` built from `oracle` options). */
  readonly oracle: RateOracle;
  /** SEP-1/10/24 helpers, bound together so you don't need a separate import. */
  readonly sep: SepHelpers = {
    fetchStellarToml,
    getSep10Challenge,
    submitSep10Challenge,
    authenticateSep10,
    getSep24Info,
    startDeposit,
    startWithdraw,
    getSep24Transaction,
    listSep24Transactions,
  };

  constructor(options: CosmosClientOptions) {
    const providers: PaymentProvider[] = [];

    if (options.mercadopago) {
      this.mercadopago = new MercadoPagoProvider(options.mercadopago);
      providers.push(this.mercadopago);
    }
    if (options.customProviders?.length) providers.push(...options.customProviders);

    if (options.etherfuse) this.etherfuse = new EtherfuseClient(options.etherfuse);
    if (options.koywe) this.koywe = new KoyweClient(options.koywe);

    this.oracle = isRateOracle(options.oracle) ? options.oracle : new CoinGeckoOracle(options.oracle);

    if (providers.length > 0) {
      this.ramp = new CosmosRamp({
        providers,
        oracle: this.oracle,
        settlement: options.settlement,
        store: options.store,
        webhooks: options.webhooks,
        defaults: options.defaults,
      });
    } else if (options.settlement || options.store || options.webhooks) {
      throw new CosmosError(
        "`settlement`/`store`/`webhooks` configure `client.ramp`, which needs at least one fiat provider " +
          "(`mercadopago` and/or `customProviders`) to exist. Etherfuse/Koywe don't use `client.ramp`.",
      );
    }
  }

  /** Closes the Etherfuse WebSocket, if connected. Call when you're done with this client (long-running processes only — scripts that exit don't need it). */
  destroy(): void {
    this.etherfuse?.destroy();
  }
}
