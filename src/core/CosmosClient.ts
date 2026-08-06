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
 *
 * AUTO-DISPATCH (optional, less code): every `mercadopago`/`koywe` method is
 * also callable directly on the client — `client.createPixCharge(...)`
 * instead of `client.mercadopago!.createPixCharge(...)`. If only one of
 * the two is configured, that's the one used, automatically. If you've
 * configured accounts that could plausibly answer the same call under both,
 * pick one explicitly with `{ provider: "mercadopago" | "koywe", ... }` as
 * the first argument (stripped before the call reaches the real method) —
 * omitting it while more than one candidate exists throws, it never guesses.
 * This is purely a convenience layer: `client.mercadopago`/`client.koywe`
 * keep working exactly as before, and nothing here changes what either
 * class does — see {@link AUTO_DISPATCH_METHODS} for the exact method list.
 *
 * `client.createPaymentLink(...)` is a level up from that: it's a real,
 * hand-written method (not a forward) that runs the SAME process no matter
 * which provider ends up handling it — including the "quote, then order"
 * two-step Etherfuse/Koywe need that Mercado Pago doesn't — and always
 * returns one normalized shape with a `qr` (synthesized from the link/
 * deposit instructions when the provider doesn't hand back one natively).
 * See {@link UnifiedPaymentRequest}/{@link UnifiedPaymentResult}.
 */

import type { Chain } from "@/atoms/enums";
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
import QRCode from "qrcode";

/**
 * Method names forwarded by the auto-dispatch proxy (see the bottom of this
 * file), grouped by which configured client implements them. Only
 * `mercadopago`/`koywe` are flat, single-account-style clients where this
 * makes sense — `etherfuse` is a full atomic-design client with its own
 * namespaced sub-managers (`client.etherfuse.quotes`, `.bankAccounts`, ...),
 * so it's addressed explicitly instead. `createPaymentLink` is deliberately
 * NOT in this list — it's a real cross-provider method on the class itself
 * (see {@link CosmosClient.createPaymentLink}), not a 1:1 forward.
 */
const AUTO_DISPATCH_METHODS = {
  mercadopago: [
    "createCharge",
    "createPixCharge",
    "getCharge",
    "verifyWebhook",
    "parseWebhook",
    "buildTestWebhook",
    "createPayout",
  ] as const,
  koywe: [
    "getTokenCurrencies",
    "getPaymentProviders",
    "getQuote",
    "createOnRampOrder",
    "createBankAccount",
    "getBankAccounts",
    "createOffRampOrder",
    "submitTxHash",
    "getOrder",
    "getOrderByExternalId",
    "createAccount",
    "checkAccount",
  ] as const,
} satisfies Record<string, readonly (keyof MercadoPagoProvider | keyof KoyweClient)[]>;

/** Which configured client resolved (or should resolve) a {@link CosmosClient.createPaymentLink} call. */
export type UnifiedPaymentProvider = "mercadopago" | "etherfuse" | "koywe";

/**
 * Request for {@link CosmosClient.createPaymentLink} — the same shape no
 * matter which provider ends up handling it. Fields only some providers
 * need (`wallet`, `chain`, `bankAccountId`) are optional here but required
 * once that provider is the one resolved; `createPaymentLink` throws a
 * specific, named error rather than guessing when one's missing.
 */
export interface UnifiedPaymentRequest {
  /** Explicit provider selection. Auto-picked if omitted and exactly one of mercadopago/etherfuse/koywe is configured. */
  provider?: UnifiedPaymentProvider;
  /** Fiat amount to collect. */
  amount: number | string;
  /** Fiat currency, e.g. "ARS", "BRL", "MXN". */
  currency: string;
  /** Your own reference/idempotency id. Default: a generated one. */
  reference?: string;
  /** Shown at checkout (Mercado Pago only). */
  description?: string;
  /** Destination crypto address. Required when etherfuse or koywe resolves this call — they deliver crypto directly. Ignored by Mercado Pago. */
  wallet?: string;
  /** Target chain (`Chain.Stellar`, `"solana"`, ...). Required when etherfuse resolves this call. */
  chain?: string;
  /** A bank account already registered with `client.etherfuse.bankAccounts`. Required when etherfuse resolves this call — there's no safe way to fabricate the KYC details a new one needs. */
  bankAccountId?: string;
  /** Override the resolved Etherfuse stablebond mint. Leave unset to resolve it live (never hardcode — see the Etherfuse section of the README). */
  targetAsset?: string;
  /** Payer email. Koywe: falls back to the client's configured default. Mercado Pago: required for PIX/QR-style methods. */
  email?: string;
  /** Koywe: a specific rail id from `client.koywe.getPaymentProviders(currency)`. Default: Koywe picks one. */
  paymentMethodId?: string;
  /** Mercado Pago only: payer hints for methods that need them. */
  payer?: { email?: string; name?: string; document?: string };
}

/**
 * Normalized result of {@link CosmosClient.createPaymentLink} — the same
 * shape no matter which provider handled the request. `qr`/`qrImage` are
 * ALWAYS present: when the provider returns a native QR (Mercado Pago PIX,
 * Etherfuse PIX) that's used as-is; otherwise one is generated from the
 * `link`/deposit instructions (`synthesizedQr: true`) so callers never have
 * to branch on "does this rail have a QR".
 */
export interface UnifiedPaymentResult {
  /** Which client actually handled this. */
  provider: UnifiedPaymentProvider;
  /** Provider-side id (charge/order id). */
  id: string;
  amount: string;
  currency: string;
  /** Crypto asset being delivered, when known (etherfuse/koywe always know it; Mercado Pago doesn't move crypto itself). */
  asset?: string;
  /** Hosted checkout / redirect URL, when the rail has one. */
  link?: string;
  /** Scannable QR payload — always present (see class doc comment). */
  qr: string;
  /** `image/png` data URL of `qr` — always present, ready for `<img src>`. */
  qrImage: string;
  /** `true` if `qr`/`qrImage` were generated by this method rather than returned natively by the provider. */
  synthesizedQr: boolean;
  status?: string;
  /** The provider's own response object, untouched, for anything this shape doesn't cover. */
  raw: unknown;
}

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

    // See AUTO_DISPATCH_METHODS / the class doc comment above: wraps `this`
    // in a Proxy so `client.createPixCharge(...)` etc. work without going
    // through `client.mercadopago!`. Everything not in that method list
    // passes straight through untouched — including `createPaymentLink`
    // below, a real method the proxy never intercepts.
    return createAutoDispatchProxy(this);
  }

  /** Closes the Etherfuse WebSocket, if connected. Call when you're done with this client (long-running processes only — scripts that exit don't need it). */
  destroy(): void {
    this.etherfuse?.destroy();
  }

  /**
   * Create a receivable — payment link, PIX/deposit QR, whatever the
   * resolved provider calls it — through the SAME process regardless of
   * provider. For Mercado Pago that's one call; for Etherfuse/Koywe it's
   * "quote, then order" run for you, with the target asset resolved live
   * (Etherfuse) rather than hardcoded. Always resolves to one normalized
   * {@link UnifiedPaymentResult}, always with a `qr` — see that type's doc
   * comment for exactly what "always" means when a rail has no native one.
   *
   * Auto-picks the provider when exactly one of mercadopago/etherfuse/koywe
   * is configured; pass `{ provider: "..." }` to choose when more than one
   * is. This never silently guesses — an unresolvable or under-specified
   * request (e.g. etherfuse without `chain`) throws, naming what's missing.
   */
  async createPaymentLink(request: UnifiedPaymentRequest): Promise<UnifiedPaymentResult> {
    const provider = resolvePaymentProvider(this, request.provider);
    switch (provider) {
      case "mercadopago":
        return createPaymentLinkViaMercadoPago(this.mercadopago!, request);
      case "etherfuse":
        return createPaymentLinkViaEtherfuse(this.etherfuse!, request);
      case "koywe":
        return createPaymentLinkViaKoywe(this.koywe!, request);
    }
  }
}

// ---------------------------------------------------------------------------
// createPaymentLink — cross-provider orchestration
// ---------------------------------------------------------------------------

/** Resolves which configured client handles a {@link CosmosClient.createPaymentLink} call — explicit `provider`, or the sole one configured. */
function resolvePaymentProvider(
  client: CosmosClient,
  explicit: UnifiedPaymentProvider | undefined,
): UnifiedPaymentProvider {
  const configured: UnifiedPaymentProvider[] = [];
  if (client.mercadopago) configured.push("mercadopago");
  if (client.etherfuse) configured.push("etherfuse");
  if (client.koywe) configured.push("koywe");

  if (explicit) {
    if (!configured.includes(explicit)) {
      throw new CosmosError(
        `createPaymentLink(): provider "${explicit}" is not configured on this CosmosClient. Configured: ` +
          `${configured.join(", ") || "none"}.`,
      );
    }
    return explicit;
  }
  if (configured.length === 1) return configured[0]!;
  if (configured.length === 0) {
    throw new CosmosError(
      'createPaymentLink(): no provider configured — set "mercadopago", "etherfuse", and/or "koywe" in ' +
        "CosmosClient options.",
    );
  }
  throw new CosmosError(
    `createPaymentLink(): more than one provider is configured (${configured.join(", ")}) — pass ` +
      `{ provider: "..." } to pick one.`,
  );
}

/**
 * Builds the guaranteed `{ qr, qrImage, synthesizedQr }` for a {@link
 * UnifiedPaymentResult} from an ordered list of candidates — the first one
 * with a `payload` wins. `image`, when given alongside a `payload`, is used
 * as-is (the provider's own native QR image); otherwise one is rendered
 * from `payload` with the `qrcode` package.
 */
async function buildQrResult(
  candidates: Array<{ payload: string | undefined; image?: string }>,
): Promise<{ qr: string; qrImage: string; synthesizedQr: boolean }> {
  for (const candidate of candidates) {
    if (!candidate.payload) continue;
    const qrImage = candidate.image ?? (await QRCode.toDataURL(candidate.payload, { width: 320, margin: 2 }));
    return { qr: candidate.payload, qrImage, synthesizedQr: !candidate.image };
  }
  throw new CosmosError(
    "createPaymentLink(): the provider returned nothing to build a QR from (no native QR, link, or deposit instructions).",
  );
}

/** Live stablebond catalog lookup for Etherfuse — same "never hardcode, pick the highest-supply match" resolution as examples/etherfuse/full-flow.ts. */
async function resolveEtherfuseTargetAsset(client: EtherfuseClient, currency: string, chain: string): Promise<string> {
  const catalog = (await client.lookup.stablebonds()) as {
    stablebonds?: { bondCurrency: string; blockchains: { blockchain: string; tokenIdentifier: string; totalSupply?: string }[] }[];
  };
  const best = (catalog.stablebonds ?? [])
    .filter((bond) => bond.bondCurrency === currency.toUpperCase())
    .flatMap((bond) =>
      bond.blockchains
        .filter((entry) => entry.blockchain === chain)
        .map((entry) => ({ asset: entry.tokenIdentifier, supply: Number(entry.totalSupply ?? 0) })),
    )
    .filter((candidate) => candidate.supply > 0)
    .sort((a, b) => b.supply - a.supply)[0];

  if (!best) {
    throw new CosmosError(
      `createPaymentLink(): no active Etherfuse stablebond for ${currency.toUpperCase()} on ${chain} right now — ` +
        "pass `targetAsset` explicitly to override.",
    );
  }
  return best.asset;
}

async function createPaymentLinkViaMercadoPago(
  mercadopago: MercadoPagoProvider,
  request: UnifiedPaymentRequest,
): Promise<UnifiedPaymentResult> {
  const charge = await mercadopago.createPaymentLink({
    amount: Number(request.amount),
    currency: request.currency,
    reference: request.reference ?? `cosmos-${Date.now()}`,
    description: request.description,
    payer: request.payer,
  });

  const { qr, qrImage, synthesizedQr } = await buildQrResult([
    { payload: charge.qr, image: charge.qrBase64 },
    { payload: charge.link },
  ]);

  return {
    provider: "mercadopago",
    id: charge.id,
    amount: String(request.amount),
    currency: request.currency.toUpperCase(),
    link: charge.link,
    qr,
    qrImage,
    synthesizedQr,
    raw: charge,
  };
}

async function createPaymentLinkViaEtherfuse(
  etherfuse: EtherfuseClient,
  request: UnifiedPaymentRequest,
): Promise<UnifiedPaymentResult> {
  if (!request.wallet) {
    throw new CosmosError('createPaymentLink(): "wallet" (destination address) is required when etherfuse resolves this call.');
  }
  if (!request.chain) {
    throw new CosmosError('createPaymentLink(): "chain" is required when etherfuse resolves this call (e.g. Chain.Stellar, "solana").');
  }
  if (!request.bankAccountId) {
    throw new CosmosError(
      'createPaymentLink(): "bankAccountId" is required when etherfuse resolves this call — register one first ' +
        "with client.etherfuse.bankAccounts (there's no safe way to fabricate the KYC details a new one needs), " +
        "then pass its id.",
    );
  }

  // `chain` is a plain `string` on the public request (any consumer, any
  // future chain) — Etherfuse's SDK types it as the `Chain` union; an
  // unsupported value still fails clearly at the API ("Unsupported
  // blockchain: ..."), same as passing one directly to `EtherfuseClient`.
  const chain = request.chain as Chain;

  const me = await etherfuse.customers.me();
  const targetAsset = request.targetAsset ?? (await resolveEtherfuseTargetAsset(etherfuse, request.currency, chain));

  // Required before the wallet can receive an order ("Wallet not found or not authorized" otherwise).
  await etherfuse.wallets.register({ publicKey: request.wallet, blockchain: chain });

  const quote = await etherfuse.quotes.create({
    customerId: me.id,
    blockchain: chain,
    sourceAmount: String(request.amount),
    quoteAssets: { type: "onramp", sourceAsset: request.currency.toUpperCase(), targetAsset },
  });
  const receipt = await quote.createOrder({
    bankAccountId: request.bankAccountId,
    publicKey: request.wallet,
    blockchain: chain,
  });

  const pixQr = receipt.createPixQr();
  const depositText = receipt.deposit
    ? [
        receipt.deposit.pixCode && `PIX: ${receipt.deposit.pixCode}`,
        receipt.deposit.clabe && `CLABE: ${receipt.deposit.clabe}`,
        receipt.deposit.bankName,
        receipt.deposit.accountHolder,
      ]
        .filter(Boolean)
        .join(" / ")
    : undefined;

  // Last resort: the sandbox occasionally creates an order without deposit
  // instructions attached yet (a known Etherfuse-sandbox quirk, not
  // something either side can fix from here) — the order's own status page
  // is still always meaningful, so it's a better fallback than failing.
  const statusPage = !pixQr && !depositText ? (await receipt.fetch()).statusPage : undefined;

  const { qr, qrImage, synthesizedQr } = await buildQrResult([
    { payload: pixQr?.toString(), image: pixQr ? await pixQr.toDataURL() : undefined },
    { payload: depositText },
    { payload: statusPage },
  ]);

  return {
    provider: "etherfuse",
    id: receipt.orderId,
    amount: String(request.amount),
    currency: request.currency.toUpperCase(),
    asset: targetAsset,
    qr,
    qrImage,
    synthesizedQr,
    raw: receipt,
  };
}

async function createPaymentLinkViaKoywe(koywe: KoyweClient, request: UnifiedPaymentRequest): Promise<UnifiedPaymentResult> {
  if (!request.wallet) {
    throw new CosmosError('createPaymentLink(): "wallet" (destination Stellar address) is required when koywe resolves this call.');
  }

  const quote = await koywe.getQuote({
    ramp: "onramp",
    fiatCurrency: request.currency.toUpperCase(),
    amount: String(request.amount),
    paymentMethodId: request.paymentMethodId,
  });
  const order = await koywe.createOnRampOrder({
    quoteId: quote.id,
    stellarAddress: request.wallet,
    email: request.email,
    externalId: request.reference,
  });

  // Koywe returns `interactiveUrl` for every order regardless of rail — for
  // WIREAR-style bank transfers, the CVU/alias to pay is static per payment
  // method, not per order (see `koywe.getPaymentProviders(...)[i].deposit`).
  const { qr, qrImage, synthesizedQr } = await buildQrResult([{ payload: order.interactiveUrl }]);

  return {
    provider: "koywe",
    id: order.id,
    amount: quote.sourceAmount,
    currency: request.currency.toUpperCase(),
    asset: quote.targetAsset,
    link: order.interactiveUrl,
    status: order.status,
    qr,
    qrImage,
    synthesizedQr,
    raw: order,
  };
}

/** Which configured client(s) implement a given auto-dispatch method name, and under what id. */
function autoDispatchCandidates(
  client: CosmosClient,
  method: string,
): Array<{ id: "mercadopago" | "koywe"; instance: MercadoPagoProvider | KoyweClient }> {
  const candidates: Array<{ id: "mercadopago" | "koywe"; instance: MercadoPagoProvider | KoyweClient }> = [];
  if (
    client.mercadopago &&
    (AUTO_DISPATCH_METHODS.mercadopago as readonly string[]).includes(method) &&
    typeof (client.mercadopago as unknown as Record<string, unknown>)[method] === "function"
  ) {
    candidates.push({ id: "mercadopago", instance: client.mercadopago });
  }
  if (
    client.koywe &&
    (AUTO_DISPATCH_METHODS.koywe as readonly string[]).includes(method) &&
    typeof (client.koywe as unknown as Record<string, unknown>)[method] === "function"
  ) {
    candidates.push({ id: "koywe", instance: client.koywe });
  }
  return candidates;
}

const ALL_AUTO_DISPATCH_METHODS = new Set<string>([
  ...AUTO_DISPATCH_METHODS.mercadopago,
  ...AUTO_DISPATCH_METHODS.koywe,
]);

/**
 * Wraps a `CosmosClient` so every name in {@link AUTO_DISPATCH_METHODS} is
 * callable directly on it, forwarding to whichever configured client
 * (`mercadopago`/`koywe`) implements it. Every other property/method passes
 * straight through to the real instance, unchanged.
 */
function createAutoDispatchProxy(client: CosmosClient): CosmosClient {
  return new Proxy(client, {
    get(target, prop, receiver) {
      const existing = Reflect.get(target, prop, receiver);
      if (existing !== undefined || typeof prop !== "string" || !ALL_AUTO_DISPATCH_METHODS.has(prop)) {
        return existing;
      }

      // `async`, not a plain function: every wrapped method returns a
      // Promise, so a bad call (unconfigured/ambiguous provider) must
      // REJECT, not throw synchronously — otherwise `cosmos.x().catch(...)`
      // would need a try/catch around the call itself too, defeating the point.
      return async (...args: unknown[]) => {
        const candidates = autoDispatchCandidates(target, prop);
        if (candidates.length === 0) {
          const owner = (AUTO_DISPATCH_METHODS.mercadopago as readonly string[]).includes(prop)
            ? "mercadopago"
            : "koywe";
          throw new CosmosError(
            `cosmos.${prop}(...) needs "${owner}" configured on this CosmosClient — pass it in the constructor ` +
              `options, or call cosmos.${owner}!.${prop}(...) once you have.`,
          );
        }

        let picked = candidates[0]!.instance;
        const callArgs = [...args];
        if (candidates.length > 1) {
          const first = callArgs[0];
          const explicit = first && typeof first === "object" ? (first as { provider?: string }).provider : undefined;
          const match = explicit && candidates.find((c) => c.id === explicit);
          if (!match) {
            const ids = candidates.map((c) => c.id).join(", ");
            throw new CosmosError(
              `cosmos.${prop}(...) is ambiguous — both ${ids} are configured and implement it. Pass ` +
                `{ provider: "${candidates[0]!.id}" | "${candidates[1]!.id}", ... } as the first argument, or ` +
                `call cosmos.<provider>!.${prop}(...) directly.`,
            );
          }
          picked = match.instance;
        }
        // `provider` is only ever our own disambiguation hint — the real
        // method never expects it, so it's stripped before forwarding.
        if (callArgs.length > 0 && callArgs[0] && typeof callArgs[0] === "object" && "provider" in (callArgs[0] as object)) {
          const { provider: _drop, ...rest } = callArgs[0] as Record<string, unknown>;
          callArgs[0] = rest;
        }
        return (picked as unknown as Record<string, (...a: unknown[]) => unknown>)[prop]!(...callArgs);
      };
    },
  }) as CosmosClient;
}

/**
 * Auto-dispatch method signatures (see the class doc comment and {@link
 * AUTO_DISPATCH_METHODS}) — declaration-merged onto the class so
 * `cosmos.createPaymentLink(...)`, `cosmos.getQuote(...)`, etc. type-check
 * and autocomplete with their real signatures, without duplicating them.
 */
export interface CosmosClient
  extends Pick<MercadoPagoProvider, (typeof AUTO_DISPATCH_METHODS.mercadopago)[number]>,
    Pick<KoyweClient, (typeof AUTO_DISPATCH_METHODS.koywe)[number]> {}
