/**
 * CosmosRamp — the provider-agnostic onramp/offramp engine.
 *
 * You compose it from three pluggable pieces:
 *
 * - **providers**: regional payment rails (Mercado Pago, PIX, ...) that turn
 *   fiat charges into QRs / payment links and report payments via webhooks.
 * - **oracle**: prices crypto in fiat (CoinGecko by default) — the spread is
 *   configured per payment at build time.
 * - **settlement**: your function that actually moves the crypto (e.g. sends
 *   USDC from your treasury). The engine never touches private keys.
 *
 * Flow (onramp): `ramp.onramp(...)` builds the charge and freezes the quote →
 * user pays the QR/link → the provider webhook hits `ramp.handleWebhook(...)`
 * → the engine verifies it, re-fetches the payment from the provider API,
 * checks the amount, and calls your settlement to release the crypto.
 */

import { TypedEventEmitter } from "@/atoms/EventEmitter";
import { randomUUID } from "@/atoms/constants";
import { CosmosError, SettlementError } from "@/core/errors";
import { MemoryStore } from "@/core/MemoryStore";
import type {
  ChargeState,
  CreateChargeRequest,
  CryptoAssetCode,
  FiatCurrencyCode,
  OrderStore,
  PaymentMethod,
  PaymentProvider,
  PayoutResult,
  QuoteBreakdown,
  RampDirection,
  RampOrderData,
  RateOracle,
  SettlementAdapter,
  SettlementFn,
  WebhookRequest,
} from "@/core/types";
import { WebhookEmitter, type WebhookEndpoint } from "@/webhooks/WebhookEmitter";

export interface CosmosRampOptions {
  /** Regional payment providers, selected by name on each order. */
  providers: PaymentProvider[];
  /** Crypto/fiat price source (e.g. `new CoinGeckoOracle()`). */
  oracle: RateOracle;
  /** Releases crypto after an approved onramp payment. */
  settlement?: SettlementAdapter | SettlementFn;
  /** Order persistence. Default: in-memory (dev only). */
  store?: OrderStore;
  /** Outgoing webhooks: engine events are signed and POSTed to these URLs. */
  webhooks?: { endpoints: WebhookEndpoint[]; maxAttempts?: number; fetch?: typeof fetch };
  defaults?: {
    /** Default spread when an order doesn't set one. Default: 0. */
    spread?: number;
    /** Default crypto asset. Default: "USDC". */
    asset?: CryptoAssetCode;
    /** Allowed fiat amount drift when reconciling payments. Default: 0.01. */
    amountTolerance?: number;
  };
}

export interface OnrampParams {
  /** Provider name, e.g. "mercadopago". */
  provider: string;
  /** Fiat amount to collect (set this or `cryptoAmount`). */
  amount?: number;
  /** Crypto amount to deliver (set this or `amount`). */
  cryptoAmount?: number;
  /** Fiat currency, e.g. "ARS", "BRL", "MXN". */
  currency: FiatCurrencyCode;
  /** Crypto asset to release. Default: engine default ("USDC"). */
  asset?: CryptoAssetCode;
  /** Destination wallet passed to your settlement adapter. */
  wallet?: string;
  /** Spread over the oracle mid rate for THIS payment (0.02 = 2%). */
  spread?: number;
  /** Payment method: "qr", "link", "transfer" or "auto" (default). */
  method?: PaymentMethod;
  description?: string;
  payer?: { email?: string; name?: string; document?: string };
  expiresInMinutes?: number;
  metadata?: Record<string, unknown>;
  /** Provider-specific pass-through options. */
  providerOptions?: Record<string, unknown>;
}

export interface OfframpParams {
  provider: string;
  /** Crypto amount the user will send you. */
  cryptoAmount: number;
  asset?: CryptoAssetCode;
  /** Fiat currency to pay out. */
  currency: FiatCurrencyCode;
  /** Provider-specific payout destination (CVU, PIX key, BREB key, CPF/tax id, MP email...). */
  destination?: Record<string, unknown>;
  spread?: number;
  metadata?: Record<string, unknown>;
  /** Provider-specific pass-through options. */
  providerOptions?: Record<string, unknown>;
}

/** Outcome of processing an incoming provider webhook. */
export interface WebhookHandleResult {
  /** Suggested HTTP status to respond with. */
  status: number;
  ok: boolean;
  /** What happened: "settled", "ignored", "invalid_signature", ... */
  outcome:
    | "settled"
    | "paid"
    | "pending"
    | "rejected"
    | "ignored"
    | "duplicate"
    | "order_not_found"
    | "amount_mismatch"
    | "invalid_signature"
    | "unknown_provider"
    | "settlement_failed";
  orderId?: string;
}

export interface RampEvents extends Record<string, unknown[]> {
  "order:created": [order: RampOrderData];
  "payment:pending": [order: RampOrderData, charge: ChargeState];
  "payment:approved": [order: RampOrderData, charge: ChargeState];
  "payment:rejected": [order: RampOrderData, charge: ChargeState];
  "payment:mismatch": [order: RampOrderData, charge: ChargeState];
  "settlement:released": [order: RampOrderData, result: { txId?: string }];
  "settlement:failed": [order: RampOrderData, error: Error];
  "payout:sent": [order: RampOrderData, result: PayoutResult];
  "payout:required": [order: RampOrderData];
  "order:completed": [order: RampOrderData];
  "webhook:received": [info: { provider: string; chargeId: string }];
  "webhook:ignored": [info: { provider: string; reason: string }];
  error: [error: Error];
  debug: [message: string];
}

export class CosmosRamp extends TypedEventEmitter<RampEvents> {
  readonly store: OrderStore;
  readonly oracle: RateOracle;

  #providers = new Map<string, PaymentProvider>();
  #settlement?: SettlementAdapter;
  #emitter?: WebhookEmitter;
  #defaultSpread: number;
  #defaultAsset: CryptoAssetCode;
  #amountTolerance: number;

  constructor(options: CosmosRampOptions) {
    super();
    if (!options.providers?.length) {
      throw new CosmosError("At least one payment provider is required.");
    }
    for (const provider of options.providers) {
      this.#providers.set(provider.name, provider);
    }
    this.oracle = options.oracle;
    this.store = options.store ?? new MemoryStore();
    this.#defaultSpread = options.defaults?.spread ?? 0;
    this.#defaultAsset = options.defaults?.asset ?? "USDC";
    this.#amountTolerance = options.defaults?.amountTolerance ?? 0.01;

    if (options.settlement) {
      this.#settlement =
        typeof options.settlement === "function" ? { release: options.settlement } : options.settlement;
    }
    if (options.webhooks?.endpoints.length) {
      this.#emitter = new WebhookEmitter({
        endpoints: options.webhooks.endpoints,
        maxAttempts: options.webhooks.maxAttempts,
        fetch: options.webhooks.fetch,
      });
    }
  }

  /** Registered provider by name. Throws for unknown names. */
  provider(name: string): PaymentProvider {
    const provider = this.#providers.get(name);
    if (!provider) {
      throw new CosmosError(
        `Unknown provider "${name}". Registered: ${[...this.#providers.keys()].join(", ")}`,
      );
    }
    return provider;
  }

  /** All registered providers, e.g. to let the user pick one in a UI. */
  get providers(): readonly PaymentProvider[] {
    return [...this.#providers.values()];
  }

  // -------------------------------------------------------------------------
  // Quotes
  // -------------------------------------------------------------------------

  /**
   * Take a quote without creating an order.
   *
   * Pass `provider` and the quote comes from that rail's own pricing when it
   * publishes any ({@link PaymentProvider.getQuote}) — the real number the
   * user will be charged there, fee included, which is the only basis on
   * which two rails can honestly be compared. Without `provider` (or for a
   * rail that only collects fiat, like Mercado Pago) it falls back to the
   * oracle mid rate plus your spread, which is identical whoever collects.
   */
  async quote(params: {
    direction: RampDirection;
    currency: FiatCurrencyCode;
    asset?: CryptoAssetCode;
    amount?: number;
    cryptoAmount?: number;
    spread?: number;
    /** Price on this rail specifically, when it prices its own orders. */
    provider?: string;
    /** Payment method, for rails that price per method. */
    method?: PaymentMethod;
    providerOptions?: Record<string, unknown>;
  }): Promise<QuoteBreakdown> {
    const asset = params.asset ?? this.#defaultAsset;
    const spread = params.spread ?? this.#defaultSpread;
    if (spread < 0 || spread >= 1) {
      throw new CosmosError(`Invalid spread ${spread}. Use a fraction like 0.02 for 2%.`);
    }
    if (params.amount === undefined && params.cryptoAmount === undefined) {
      throw new CosmosError("Provide either `amount` (fiat) or `cryptoAmount`.");
    }

    const provider = params.provider ? this.provider(params.provider) : undefined;
    if (provider?.getQuote) {
      return this.#providerQuote(provider, { ...params, asset });
    }

    const rate = await this.oracle.getRate(asset, params.currency);
    const effectiveRate = params.direction === "onramp" ? rate * (1 + spread) : rate * (1 - spread);

    let fiatAmount: number;
    let cryptoAmount: number;
    if (params.amount !== undefined) {
      fiatAmount = round(params.amount, 2);
      cryptoAmount = round(params.amount / effectiveRate, 6);
    } else {
      cryptoAmount = round(params.cryptoAmount!, 6);
      fiatAmount = round(params.cryptoAmount! * effectiveRate, 2);
    }

    return {
      asset,
      currency: params.currency.toUpperCase(),
      rate,
      spread,
      effectiveRate: round(effectiveRate, 8),
      fiatAmount,
      cryptoAmount,
      quotedAt: Date.now(),
      source: "oracle",
    };
  }

  /**
   * Normalize a provider's own quote into a {@link QuoteBreakdown}.
   *
   * `spread` is 0 here and `rate` equals `effectiveRate` on purpose: the
   * provider quoted a single all-in price and the engine applied nothing on
   * top, so presenting a mid rate and a spread would be inventing a
   * breakdown the provider never gave. What it *does* publish — its fee —
   * is carried verbatim in `fee`.
   */
  async #providerQuote(
    provider: PaymentProvider,
    params: {
      direction: RampDirection;
      currency: FiatCurrencyCode;
      asset: CryptoAssetCode;
      amount?: number;
      cryptoAmount?: number;
      method?: PaymentMethod;
      providerOptions?: Record<string, unknown>;
    },
  ): Promise<QuoteBreakdown> {
    const quoted = await provider.getQuote!({
      direction: params.direction,
      currency: params.currency.toUpperCase(),
      asset: params.asset,
      amount: params.amount,
      cryptoAmount: params.cryptoAmount,
      method: params.method,
      providerOptions: params.providerOptions,
    });

    const fiatAmount = round(quoted.fiatAmount, 2);
    const cryptoAmount = round(quoted.cryptoAmount, 6);
    if (!(fiatAmount > 0) || !(cryptoAmount > 0)) {
      throw new CosmosError(
        `Provider "${provider.name}" returned an unusable quote (${fiatAmount} ${params.currency} ↔ ${cryptoAmount} ${params.asset}).`,
      );
    }
    const rate = round(fiatAmount / cryptoAmount, 8);

    return {
      asset: params.asset,
      currency: params.currency.toUpperCase(),
      rate,
      spread: 0,
      effectiveRate: rate,
      fiatAmount,
      cryptoAmount,
      quotedAt: Date.now(),
      source: "provider",
      provider: provider.name,
      providerQuoteId: quoted.quoteId,
      fee: quoted.fee,
      expiresAt: quoted.expiresAt,
    };
  }

  // -------------------------------------------------------------------------
  // Onramp
  // -------------------------------------------------------------------------

  /**
   * Build an onramp order: freezes the quote (oracle rate + your spread) and
   * creates the fiat charge (QR / link / deposit) with the provider. When the
   * provider confirms payment via webhook, the engine releases the crypto
   * through your settlement adapter automatically.
   */
  async onramp(params: OnrampParams): Promise<RampOrderData> {
    const provider = this.provider(params.provider);
    this.#assertCurrency(provider, params.currency);

    const quote = await this.quote({
      direction: "onramp",
      currency: params.currency,
      asset: params.asset,
      amount: params.amount,
      cryptoAmount: params.cryptoAmount,
      spread: params.spread,
      provider: provider.name,
      method: params.method,
      providerOptions: params.providerOptions,
    });

    const id = randomUUID();
    const chargeRequest: CreateChargeRequest = {
      amount: quote.fiatAmount,
      currency: quote.currency,
      method: params.method ?? "auto",
      reference: id,
      description: params.description,
      payer: params.payer,
      expiresInMinutes: params.expiresInMinutes,
      // Rails that priced this order themselves need their own quote id back
      // (see CreateChargeRequest.quote) — re-quoting inside createCharge would
      // charge a price the user was never shown.
      quote,
      destinationAddress: params.wallet,
      providerOptions: params.providerOptions,
    };
    const charge = await provider.createCharge(chargeRequest);

    const now = Date.now();
    const order: RampOrderData = {
      id,
      direction: "onramp",
      status: "created",
      provider: provider.name,
      quote,
      wallet: params.wallet,
      charge,
      chargeId: charge.id,
      metadata: params.metadata,
      createdAt: now,
      updatedAt: now,
    };
    await this.store.save(order);
    this.emit("order:created", order);
    await this.#broadcast("order.created", order);
    return order;
  }

  // -------------------------------------------------------------------------
  // Offramp
  // -------------------------------------------------------------------------

  /**
   * Build an offramp order: freezes the quote for crypto → fiat. Once you
   * confirm the crypto arrived (`confirmCryptoReceived`), the engine pays out
   * fiat through the provider (or emits `payout:required` when the provider
   * has no payout rail).
   */
  async offramp(params: OfframpParams): Promise<RampOrderData> {
    const provider = this.provider(params.provider);
    this.#assertCurrency(provider, params.currency);

    const quote = await this.quote({
      direction: "offramp",
      currency: params.currency,
      asset: params.asset,
      cryptoAmount: params.cryptoAmount,
      spread: params.spread,
      provider: provider.name,
      providerOptions: params.providerOptions,
    });

    const id = randomUUID();
    // Rails that custody the crypto leg only mint the deposit address (and
    // its memo) once the order exists on their side — ask for it now, so the
    // order the caller gets back can actually tell the user where to send
    // funds. Rails where you collect the crypto yourself skip this entirely.
    const deposit = provider.createOfframpDeposit
      ? await provider.createOfframpDeposit({
          cryptoAmount: quote.cryptoAmount,
          asset: quote.asset,
          currency: quote.currency,
          reference: id,
          destination: params.destination ?? {},
          quote,
          providerOptions: params.providerOptions,
        })
      : undefined;

    const now = Date.now();
    const order: RampOrderData = {
      id,
      direction: "offramp",
      status: "created",
      provider: provider.name,
      quote,
      payoutDestination: params.destination,
      deposit,
      chargeId: deposit?.id,
      metadata: params.metadata,
      createdAt: now,
      updatedAt: now,
    };
    await this.store.save(order);
    this.emit("order:created", order);
    await this.#broadcast("order.created", order);
    return order;
  }

  /**
   * Confirm the crypto leg of an offramp order arrived (e.g. you saw the
   * USDC transfer on-chain). Triggers the fiat payout automatically.
   */
  async confirmCryptoReceived(orderId: string, info?: { txId?: string }): Promise<RampOrderData> {
    const order = await this.#requireOrder(orderId);
    if (order.direction !== "offramp") {
      throw new CosmosError(`Order ${orderId} is not an offramp order.`);
    }
    if (order.status !== "created") {
      throw new CosmosError(`Order ${orderId} is "${order.status}", expected "created".`);
    }

    let updated = (await this.store.update(orderId, {
      status: "paid",
      settlementTxId: info?.txId,
    }))!;

    const provider = this.provider(order.provider);
    if (provider.createPayout && order.payoutDestination) {
      updated = (await this.store.update(orderId, { status: "settling" }))!;
      try {
        const payout = await provider.createPayout({
          amount: order.quote.fiatAmount,
          currency: order.quote.currency,
          reference: order.id,
          destination: order.payoutDestination,
        });
        updated = (await this.store.update(orderId, { status: "completed" }))!;
        this.emit("payout:sent", updated, payout);
        this.emit("order:completed", updated);
        await this.#broadcast("order.completed", updated);
      } catch (error) {
        this.emit("error", error as Error);
        throw new SettlementError(`Fiat payout failed for order ${orderId}.`, { cause: error });
      }
    } else if (order.deposit) {
      // The provider custodies the crypto and pays the fiat out itself (it
      // gave us the deposit address), so there's no payout call to make —
      // but it isn't done either. Park it in "settling" and let the caller
      // confirm from the provider's own transaction status; completing it
      // here would claim a payout nobody has seen land.
      updated = (await this.store.update(orderId, { status: "settling" }))!;
      this.emit("payout:required", updated);
      await this.#broadcast("payout.required", updated);
    } else {
      // No automatic payout rail: hand off to the integrator.
      this.emit("payout:required", updated);
      await this.#broadcast("payout.required", updated);
    }
    return updated;
  }

  /** Mark a manual payout as done, completing the offramp order. */
  async confirmPayoutSent(orderId: string, info?: { payoutId?: string }): Promise<RampOrderData> {
    const order = await this.#requireOrder(orderId);
    const updated = (await this.store.update(orderId, {
      status: "completed",
      metadata: { ...order.metadata, payoutId: info?.payoutId },
    }))!;
    this.emit("order:completed", updated);
    await this.#broadcast("order.completed", updated);
    return updated;
  }

  // -------------------------------------------------------------------------
  // Incoming webhooks
  // -------------------------------------------------------------------------

  /**
   * Process an incoming provider webhook end to end: verify the signature,
   * re-fetch the payment from the provider API (never trust the webhook
   * body), match it to an order, check the paid amount, and settle.
   *
   * Framework-agnostic: pass the raw body, headers and query/url.
   * Respond with `result.status`.
   */
  async handleWebhook(providerName: string, request: WebhookRequest): Promise<WebhookHandleResult> {
    const provider = this.#providers.get(providerName);
    if (!provider) {
      this.emit("webhook:ignored", { provider: providerName, reason: "unknown_provider" });
      return { status: 404, ok: false, outcome: "unknown_provider" };
    }

    let valid: boolean;
    try {
      valid = await provider.verifyWebhook(request);
    } catch {
      valid = false;
    }
    if (!valid) {
      this.emit("webhook:ignored", { provider: providerName, reason: "invalid_signature" });
      return { status: 401, ok: false, outcome: "invalid_signature" };
    }

    const notification = await provider.parseWebhook(request);
    if (!notification) {
      this.emit("webhook:ignored", { provider: providerName, reason: "not_a_payment" });
      return { status: 200, ok: true, outcome: "ignored" };
    }
    this.emit("webhook:received", { provider: providerName, chargeId: notification.chargeId });

    // Always fetch the trusted state from the provider API.
    const charge = await provider.getCharge(notification.chargeId);

    const order =
      (charge.reference ? await this.store.get(charge.reference) : null) ??
      (await this.store.findByChargeId(providerName, charge.id));
    if (!order) {
      this.emit("webhook:ignored", { provider: providerName, reason: "order_not_found" });
      return { status: 200, ok: true, outcome: "order_not_found" };
    }

    if (order.status === "completed" || order.status === "settling") {
      return { status: 200, ok: true, outcome: "duplicate", orderId: order.id };
    }

    if (charge.status === "pending") {
      this.emit("payment:pending", order, charge);
      return { status: 200, ok: true, outcome: "pending", orderId: order.id };
    }
    if (charge.status !== "approved") {
      const updated = (await this.store.update(order.id, { status: "failed", chargeId: charge.id }))!;
      this.emit("payment:rejected", updated, charge);
      await this.#broadcast("payment.rejected", updated);
      return { status: 200, ok: true, outcome: "rejected", orderId: order.id };
    }

    // Approved — make sure the paid amount matches the quoted amount.
    if (Math.abs(charge.amount - order.quote.fiatAmount) > this.#amountTolerance) {
      this.emit("payment:mismatch", order, charge);
      await this.#broadcast("payment.mismatch", { order, paidAmount: charge.amount });
      return { status: 400, ok: false, outcome: "amount_mismatch", orderId: order.id };
    }

    let updated = (await this.store.update(order.id, { status: "paid", chargeId: charge.id }))!;
    this.emit("payment:approved", updated, charge);
    await this.#broadcast("payment.approved", updated);

    if (order.direction !== "onramp" || !this.#settlement) {
      return { status: 200, ok: true, outcome: "paid", orderId: order.id };
    }

    // Release the crypto leg.
    updated = (await this.store.update(order.id, { status: "settling" }))!;
    try {
      const result =
        (await this.#settlement.release({
          order: updated,
          asset: updated.quote.asset,
          amount: updated.quote.cryptoAmount,
          wallet: updated.wallet,
        })) ?? {};
      updated = (await this.store.update(order.id, {
        status: "completed",
        settlementTxId: result.txId,
      }))!;
      this.emit("settlement:released", updated, result);
      this.emit("order:completed", updated);
      await this.#broadcast("settlement.released", updated);
      await this.#broadcast("order.completed", updated);
      return { status: 200, ok: true, outcome: "settled", orderId: order.id };
    } catch (error) {
      // Keep the order in "settling"; retry explicitly with retrySettlement().
      this.emit("settlement:failed", updated, error as Error);
      this.emit("error", error as Error);
      await this.#broadcast("settlement.failed", { order: updated, error: String(error) });
      return { status: 200, ok: false, outcome: "settlement_failed", orderId: order.id };
    }
  }

  /** Retry a settlement that previously failed (order stuck in "settling"). */
  async retrySettlement(orderId: string): Promise<RampOrderData> {
    const order = await this.#requireOrder(orderId);
    if (order.direction !== "onramp") throw new CosmosError(`Order ${orderId} is not an onramp order.`);
    if (order.status !== "settling" && order.status !== "paid") {
      throw new CosmosError(`Order ${orderId} is "${order.status}", expected "settling" or "paid".`);
    }
    if (!this.#settlement) throw new CosmosError("No settlement adapter configured.");

    const result =
      (await this.#settlement.release({
        order,
        asset: order.quote.asset,
        amount: order.quote.cryptoAmount,
        wallet: order.wallet,
      })) ?? {};
    const updated = (await this.store.update(orderId, {
      status: "completed",
      settlementTxId: result.txId,
    }))!;
    this.emit("settlement:released", updated, result);
    this.emit("order:completed", updated);
    await this.#broadcast("settlement.released", updated);
    await this.#broadcast("order.completed", updated);
    return updated;
  }

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  /** Look up an order by id. */
  async getOrder(orderId: string): Promise<RampOrderData | null> {
    return this.store.get(orderId);
  }

  async #requireOrder(orderId: string): Promise<RampOrderData> {
    const order = await this.store.get(orderId);
    if (!order) throw new CosmosError(`Order ${orderId} not found.`);
    return order;
  }

  #assertCurrency(provider: PaymentProvider, currency: FiatCurrencyCode): void {
    const upper = currency.toUpperCase();
    if (provider.currencies.length && !provider.currencies.includes(upper)) {
      throw new CosmosError(
        `Provider "${provider.name}" does not support ${upper}. Supported: ${provider.currencies.join(", ")}`,
      );
    }
  }

  /** Fan out an event to outgoing webhook endpoints (fire and forget). */
  async #broadcast(type: string, data: unknown): Promise<void> {
    if (!this.#emitter) return;
    try {
      const results = await this.#emitter.emit(type, data);
      for (const result of results) {
        if (!result.ok) {
          this.emit("debug", `webhook delivery failed: ${result.event} → ${result.url}`);
        }
      }
    } catch (error) {
      this.emit("error", error as Error);
    }
  }
}

function round(value: number, decimals: number): number {
  const factor = 10 ** decimals;
  return Math.round((value + Number.EPSILON) * factor) / factor;
}
