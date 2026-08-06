/**
 * AbroadProvider — wraps {@link AbroadClient} as a `PaymentProvider` for
 * {@link CosmosRamp}.
 *
 * Abroad is a complete ramp on BOTH legs, which makes it different from a
 * fiat-collection rail like Mercado Pago in three ways worth knowing before
 * you wire it up:
 *
 * 1. **It prices its own orders.** `getQuote` hits Abroad's quote endpoints,
 *    so the engine skips the oracle+spread entirely for this provider (see
 *    `CosmosRamp.quote`). The quote id is bound to the order and replayed on
 *    `createCharge`, so the user is charged the price they were shown.
 * 2. **It delivers the crypto itself** (`settlesCrypto: true`). Do NOT also
 *    run your own `SettlementAdapter` for its orders — check
 *    `order.provider` and skip, or the buyer gets paid twice.
 * 3. **Offramp runs backwards from the usual shape.** You can't collect the
 *    crypto into your own treasury and then ask Abroad to pay out: Abroad
 *    custodies the crypto leg, so the order must exist on its side first to
 *    mint a per-order deposit address and memo. That's
 *    `createOfframpDeposit`, called by `CosmosRamp.offramp`; `createPayout`
 *    is deliberately absent.
 *
 * ⚠ NO SANDBOX, EVER. Every Abroad corridor is mainnet — see
 * {@link AbroadClient}'s docstring. There is no environment option on this
 * class because there is no environment to choose: a charge built here is a
 * real PIX charge, and an onramp delivers real Circle USDC to
 * `destinationAddress` on Stellar pubnet. A wallet that doesn't already
 * trust mainnet USDC cannot receive it — check that before you take money,
 * not after.
 *
 * COVERAGE (from `GET /public/corridors`, and worth re-reading at runtime
 * rather than trusting this comment): buying is BRL/PIX only; selling adds
 * COP/BREB. ARS and MXN are not Abroad corridors at all.
 */

import { Asset, Country, FiatCurrency } from "@/atoms/enums";
import { ProviderError } from "@/core/errors";
import { hmacSha256Hex, timingSafeEqualStr } from "@/core/signature";
import { AbroadClient, type AbroadClientOptions } from "@/client/abroad/AbroadClient";
import { AbroadKycRequiredError } from "@/client/abroad/errors";
import type {
  AbroadCryptoCurrency,
  AbroadPaymentMethod,
  AbroadTargetCurrency,
  AbroadTransactionStatus,
} from "@/client/abroad/types";
import type {
  Charge,
  ChargeState,
  ChargeStatus,
  CreateChargeRequest,
  CreateOfframpDepositRequest,
  FiatCurrencyCode,
  OfframpDeposit,
  PaymentProvider,
  ProviderQuote,
  ProviderQuoteRequest,
  WebhookNotification,
  WebhookRequest,
} from "@/core/types";

/** Abroad's local rail per currency. BRL settles over PIX, COP over BREB. */
const RAIL_BY_CURRENCY: Record<string, AbroadPaymentMethod> = {
  [FiatCurrency.BRL]: "PIX",
  [FiatCurrency.COP]: "BREB",
};

const COUNTRY_BY_CURRENCY: Record<string, string> = {
  [FiatCurrency.BRL]: Country.BR,
  [FiatCurrency.COP]: Country.CO,
};

export interface AbroadProviderOptions {
  /** Abroad partner API key (`partner_...`). */
  apiKey: string;
  /** Provider name used to select it on each ramp call. Default: `"abroad"`. */
  name?: string;
  /** ISO 3166-1 country codes. Default: derived from `currencies`. */
  regions?: readonly string[];
  /**
   * Fiat currencies this instance handles. Default: `["BRL", "COP"]` —
   * everything Abroad settles. Note only BRL supports BUYING; COP is
   * sell-only, which `createCharge` enforces.
   */
  currencies?: readonly FiatCurrencyCode[];
  logoUrl?: string;
  /** Short fee summary for a provider picker, e.g. `"2.3%"`. Live quotes carry the exact per-order number. */
  feeLabel?: string;
  /**
   * Crypto asset to move. Default: `USDC`. Abroad also supports USDT, but
   * not on the Stellar corridors this adapter targets.
   */
  cryptoCurrency?: AbroadCryptoCurrency;
  /**
   * Partner-scoped id for the end user, used for KYC and transaction
   * ownership. Can be overridden per call via `providerOptions.userId`.
   * Default: `"cosmos-demo-user"` — replace it with your own stable user id
   * in anything real, or every user shares one KYC record.
   */
  userId?: string;
  /** Where Abroad sends the buyer after a hosted step, when it uses one. */
  redirectUrl?: string;
  /** HMAC secret for verifying Abroad's webhooks, if you register one. */
  webhookSecret?: string;
  baseUrl?: AbroadClientOptions["baseUrl"];
  fetch?: typeof fetch;
  onDebug?: (message: string) => void;
}

/**
 * `AWAITING_PAYMENT`/`PROCESSING_PAYMENT` are both still in flight.
 * `WRONG_AMOUNT` means the user paid something other than the quoted amount
 * — not a success, and not something the engine can settle against, so it
 * maps to `rejected` rather than being quietly treated as pending.
 */
function mapTransactionStatus(status: AbroadTransactionStatus | undefined): ChargeStatus {
  switch (status) {
    case "PAYMENT_COMPLETED":
      return "approved";
    case "PAYMENT_FAILED":
    case "WRONG_AMOUNT":
      return "rejected";
    case "PAYMENT_EXPIRED":
      return "expired";
    default:
      return "pending";
  }
}

export class AbroadProvider implements PaymentProvider {
  readonly name: string;
  readonly regions: readonly string[];
  readonly currencies: readonly FiatCurrencyCode[];
  readonly logoUrl?: string;
  readonly feeLabel?: string;
  /** Abroad releases the crypto itself — never run your own settlement for its orders. */
  readonly settlesCrypto = true;

  /** Underlying client — escape hatch for anything this adapter doesn't surface (KYC submission, corridors, liquidity). */
  readonly client: AbroadClient;

  #cryptoCurrency: AbroadCryptoCurrency;
  #userId: string;
  #redirectUrl?: string;
  #webhookSecret?: string;

  /**
   * Amount/currency/reference per Abroad transaction id.
   *
   * `GET /transaction/{id}` returns status but NOT the amount, while
   * `CosmosRamp.handleWebhook` reconciles a payment by comparing
   * `charge.amount` against the order's quote before settling. Returning 0
   * there would fail every reconciliation as an amount mismatch, so what we
   * knew at creation time is remembered here.
   *
   * In-process only: a restart loses it and `getCharge` falls back to
   * reporting status alone (see the `amount` note there). Persist it
   * alongside your orders if you need reconciliation to survive restarts.
   */
  #chargeFacts = new Map<string, { amount: number; currency: FiatCurrencyCode; reference: string }>();

  constructor(options: AbroadProviderOptions) {
    this.name = options.name ?? "abroad";
    this.currencies = options.currencies ?? [FiatCurrency.BRL, FiatCurrency.COP];
    this.regions =
      options.regions ?? [...new Set(this.currencies.map((c) => COUNTRY_BY_CURRENCY[c.toUpperCase()]).filter(Boolean) as string[])];
    this.logoUrl = options.logoUrl;
    this.feeLabel = options.feeLabel;
    this.#cryptoCurrency = options.cryptoCurrency ?? "USDC";
    this.#userId = options.userId ?? "cosmos-demo-user";
    this.#redirectUrl = options.redirectUrl;
    this.#webhookSecret = options.webhookSecret;
    this.client = new AbroadClient({
      apiKey: options.apiKey,
      baseUrl: options.baseUrl,
      fetch: options.fetch,
      onDebug: options.onDebug,
    });
  }

  /** Abroad's rail for a currency, or a clear error naming what it does cover. */
  #railFor(currency: FiatCurrencyCode): AbroadPaymentMethod {
    const rail = RAIL_BY_CURRENCY[currency.toUpperCase()];
    if (!rail) {
      throw new ProviderError(
        this.name,
        `Abroad does not settle ${currency.toUpperCase()}. Supported: ${Object.keys(RAIL_BY_CURRENCY).join(", ")}.`,
      );
    }
    return rail;
  }

  #userIdFor(options?: Record<string, unknown>): string {
    const override = options?.userId;
    return typeof override === "string" && override.trim() ? override.trim() : this.#userId;
  }

  #assertAsset(asset: string): void {
    if (asset.toUpperCase() !== this.#cryptoCurrency) {
      throw new ProviderError(
        this.name,
        `This Abroad instance moves ${this.#cryptoCurrency}, not ${asset}. Construct it with \`cryptoCurrency\` if you meant another asset.`,
      );
    }
  }

  // -------------------------------------------------------------------------
  // Pricing
  // -------------------------------------------------------------------------

  /**
   * Abroad's own binding price. Three endpoints back this, picked by which
   * side of the trade the caller pinned down — see {@link AbroadClient} for
   * what `value` means in each response, since it flips between crypto and
   * fiat and getting it backwards silently doubles or halves the order.
   *
   * Onramp can only be quoted from the fiat side (Abroad has no
   * crypto-first onramp endpoint), so a `cryptoAmount`-driven onramp quote
   * is refused rather than approximated — an approximation here would be a
   * price the user is then charged.
   */
  async getQuote(request: ProviderQuoteRequest): Promise<ProviderQuote> {
    this.#assertAsset(request.asset);
    const currency = request.currency.toUpperCase() as AbroadTargetCurrency;
    const rail = this.#railFor(currency);
    const common = {
      target_currency: currency,
      payment_method: rail,
      network: "STELLAR" as const,
      crypto_currency: this.#cryptoCurrency,
    };

    if (request.direction === "onramp") {
      if (request.amount === undefined) {
        throw new ProviderError(
          this.name,
          "Abroad prices onramps from the fiat side only — pass `amount` (fiat), not `cryptoAmount`.",
        );
      }
      const quote = await this.client.quoteOnramp({ ...common, fiat_amount: request.amount });
      return {
        fiatAmount: request.amount,
        cryptoAmount: quote.value, // `value` is the crypto the buyer receives
        quoteId: quote.quote_id,
        fee: { amount: Number(quote.fee.amount), currency: quote.fee.currency, type: quote.fee.type },
        expiresAt: quote.expiration_time,
        raw: quote,
      };
    }

    if (request.cryptoAmount !== undefined) {
      const quote = await this.client.quoteOfframpReverse({ ...common, source_amount: request.cryptoAmount });
      return {
        fiatAmount: quote.value, // `value` is the fiat the seller receives
        cryptoAmount: request.cryptoAmount,
        quoteId: quote.quote_id,
        fee: { amount: Number(quote.fee.amount), currency: quote.fee.currency, type: quote.fee.type },
        expiresAt: quote.expiration_time,
        raw: quote,
      };
    }
    if (request.amount === undefined) {
      throw new ProviderError(this.name, "Provide either `amount` (fiat) or `cryptoAmount` to quote an offramp.");
    }
    const quote = await this.client.quoteOfframp({ ...common, amount: request.amount });
    return {
      fiatAmount: request.amount,
      cryptoAmount: quote.value, // `value` is the crypto the seller must send
      quoteId: quote.quote_id,
      fee: { amount: Number(quote.fee.amount), currency: quote.fee.currency, type: quote.fee.type },
      expiresAt: quote.expiration_time,
      raw: quote,
    };
  }

  // -------------------------------------------------------------------------
  // Onramp
  // -------------------------------------------------------------------------

  /**
   * Build the buyer's PIX charge.
   *
   * Needs two things the base `CreateChargeRequest` only carries because
   * they were added for exactly this kind of rail: `quote` (Abroad binds the
   * transaction to the quote id it issued, so the buyer pays the price they
   * saw) and `destinationAddress` (Abroad delivers the crypto itself, so it
   * needs the wallet — this provider never sees your settlement adapter).
   *
   * Returns `method: "qr"` with the raw EMV payload in `qr`, so a UI can
   * render its own scannable PIX code rather than iframing a hosted page.
   */
  async createCharge(request: CreateChargeRequest): Promise<Charge> {
    const currency = request.currency.toUpperCase();
    const rail = this.#railFor(currency);
    if (rail !== "PIX") {
      throw new ProviderError(
        this.name,
        `Abroad only sells crypto (fiat → crypto) over PIX/BRL. ${currency} is payout-only — use it for offramp orders instead.`,
      );
    }

    const quoteId = request.quote?.providerQuoteId;
    if (!quoteId) {
      throw new ProviderError(
        this.name,
        "Abroad charges must reference one of its own quotes. Let CosmosRamp price the order (it passes `quote` through) rather than calling createCharge directly.",
      );
    }
    const destination = request.destinationAddress ?? (request.providerOptions?.destinationAddress as string | undefined);
    if (!destination) {
      throw new ProviderError(
        this.name,
        "Abroad delivers the crypto itself, so it needs a destination wallet — pass `wallet` on the onramp call.",
      );
    }

    const userId = this.#userIdFor(request.providerOptions);
    const transaction = await this.client.createTransaction({
      quote_id: quoteId,
      user_id: userId,
      destination_address: destination,
      ...(this.#redirectUrl ? { redirectUrl: this.#redirectUrl } : {}),
    });

    // Abroad answers 200 with `kycRequired: true` and no instructions rather
    // than failing — a distinct, recoverable state (verify the user, then
    // create the transaction again), so it gets its own error type instead
    // of surfacing as "the charge had no payment code".
    if (transaction.kycRequired) throw new AbroadKycRequiredError(userId);
    if (!transaction.id) throw new ProviderError(this.name, "Abroad accepted the transaction but returned no id.");

    const brCode = transaction.payment_instructions?.br_code;
    if (!brCode) {
      throw new ProviderError(this.name, `Abroad returned no PIX payment code for transaction ${transaction.id}.`);
    }

    this.#chargeFacts.set(transaction.id, { amount: request.amount, currency, reference: request.reference });

    return {
      id: transaction.id,
      method: "qr",
      qr: brCode,
      expiresAt: transaction.payment_instructions?.expires_at ?? undefined,
      raw: transaction,
    };
  }

  /**
   * Trusted state of a transaction.
   *
   * `amount`/`currency`/`reference` come from what this instance recorded at
   * creation (`#chargeFacts`) because Abroad's status response doesn't
   * repeat them. After a restart that cache is empty and `amount` reads 0 —
   * `CosmosRamp.handleWebhook` would then see an amount mismatch and refuse
   * to settle, which is the safe direction to fail, but means webhook-driven
   * settlement wants a persistent store in production.
   */
  async getCharge(chargeId: string): Promise<ChargeState> {
    const transaction = await this.client.getTransaction(chargeId);
    const known = this.#chargeFacts.get(chargeId);
    return {
      id: transaction.id,
      status: mapTransactionStatus(transaction.status),
      amount: known?.amount ?? 0,
      currency: known?.currency ?? "",
      reference: known?.reference,
      raw: transaction,
    };
  }

  // -------------------------------------------------------------------------
  // Offramp
  // -------------------------------------------------------------------------

  /**
   * Open the sell side: register the transaction with Abroad and return the
   * address the seller must send crypto to.
   *
   * `destination` must carry the payee's local bank details — Abroad pays
   * out to a PIX key (BRL) or BREB key (COP) plus a tax id, and refuses the
   * transaction without them. Accepted keys, in order of preference:
   * `accountNumber`/`account_number`/`pixKey`/`key`, and
   * `taxId`/`tax_id`/`cpf`/`document`.
   *
   * The returned `memo` is not decorative: Stellar deposits land in a pooled
   * address and Abroad credits them by memo. A transfer sent without it is
   * not recoverable through this API.
   */
  async createOfframpDeposit(request: CreateOfframpDepositRequest): Promise<OfframpDeposit> {
    this.#assertAsset(request.asset);
    const currency = request.currency.toUpperCase();
    this.#railFor(currency); // reject unsupported currencies before creating anything

    const quoteId = request.quote?.providerQuoteId;
    if (!quoteId) {
      throw new ProviderError(
        this.name,
        "Abroad offramps must reference one of its own quotes. Let CosmosRamp price the order rather than calling createOfframpDeposit directly.",
      );
    }

    const destination = request.destination ?? {};
    const accountNumber = firstString(destination, ["accountNumber", "account_number", "pixKey", "pix_key", "key"]);
    const taxId = firstString(destination, ["taxId", "tax_id", "cpf", "cnpj", "document", "nit"]);
    if (!accountNumber) {
      throw new ProviderError(
        this.name,
        `Abroad needs the payee's ${currency === FiatCurrency.COP ? "BREB" : "PIX"} key to pay out — pass it as \`destination.accountNumber\`.`,
      );
    }
    if (!taxId) {
      throw new ProviderError(
        this.name,
        `Abroad needs the payee's tax id (${currency === FiatCurrency.COP ? "NIT/CC" : "CPF"}) to pay out — pass it as \`destination.taxId\`.`,
      );
    }

    const userId = this.#userIdFor(request.providerOptions);
    const transaction = await this.client.createTransaction({
      quote_id: quoteId,
      user_id: userId,
      account_number: accountNumber,
      tax_id: taxId,
    });

    if (transaction.kycRequired) throw new AbroadKycRequiredError(userId);
    if (!transaction.id) throw new ProviderError(this.name, "Abroad accepted the offramp but returned no transaction id.");

    const context = transaction.payment_context;
    if (!context?.depositAddress) {
      throw new ProviderError(
        this.name,
        `Abroad returned no deposit address for transaction ${transaction.id} — there is nowhere to send the ${request.asset}.`,
      );
    }

    this.#chargeFacts.set(transaction.id, {
      amount: request.quote?.fiatAmount ?? 0,
      currency,
      reference: request.reference,
    });

    return {
      id: transaction.id,
      address: context.depositAddress,
      memo: context.memo ?? undefined,
      memoType: context.memoType ?? undefined,
      amount: context.amount ?? request.cryptoAmount,
      asset: context.cryptoCurrency ?? request.asset,
      network: context.blockchain,
      chainId: context.chainId,
      fiatAmount: request.quote?.fiatAmount,
      currency,
      reference: transaction.transaction_reference ?? undefined,
      notifyRequired: context.notify?.required,
      notifyEndpoint: context.notify?.endpoint ?? undefined,
      kycRequired: transaction.kycRequired,
      raw: transaction,
    };
  }

  // -------------------------------------------------------------------------
  // KYC
  // -------------------------------------------------------------------------

  /** Whether this user is already verified — call before creating a transaction to present the form as an extra step instead of hitting a hard failure. */
  async getKycStatus(userId?: string): Promise<{ approved: boolean; status: string | null }> {
    const response = await this.client.getKycStatus(this.#userIdFor(userId ? { userId } : undefined));
    return { approved: response.hasApproved, status: response.status };
  }

  // -------------------------------------------------------------------------
  // Webhooks
  // -------------------------------------------------------------------------

  /**
   * Abroad signs partner webhooks with a secret you set in its partner
   * portal. The header name isn't published in the OpenAPI schema, so both
   * the conventional spellings are accepted and checked as an HMAC-SHA256 of
   * the raw body. With no `webhookSecret` configured this trusts the payload
   * — same posture as the other providers here, and fine because
   * `CosmosRamp` re-reads the transaction from the API before settling
   * anything.
   */
  async verifyWebhook(request: WebhookRequest): Promise<boolean> {
    if (!this.#webhookSecret) return true;
    const header =
      request.headers["x-abroad-signature"] ??
      request.headers["X-Abroad-Signature"] ??
      request.headers["x-signature"];
    if (!header || Array.isArray(header)) return false;
    const body = typeof request.body === "string" ? request.body : JSON.stringify(request.body);
    const expected = await hmacSha256Hex(this.#webhookSecret, body);
    return timingSafeEqualStr(expected, header);
  }

  async parseWebhook(request: WebhookRequest): Promise<WebhookNotification | null> {
    const body = (typeof request.body === "string" ? JSON.parse(request.body || "{}") : request.body) as Record<string, unknown>;
    const data = (body.data ?? body) as Record<string, unknown>;
    const transactionId = data.transactionId ?? data.transaction_id ?? data.id;
    if (typeof transactionId !== "string") return null;
    return {
      chargeId: transactionId,
      kind: typeof body.event === "string" ? body.event : typeof body.type === "string" ? body.type : "transaction_updated",
      raw: body,
    };
  }
}

/** First non-empty string among `keys` in `source` — lets callers use whichever spelling their own form already produces. */
function firstString(source: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = source[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return undefined;
}

/** Re-exported so callers can `instanceof`-check the "verify this user first" case without reaching into the client. */
export { AbroadKycRequiredError };

/** Assets this adapter can move. Exported for callers building a picker. */
export const ABROAD_ASSETS = [Asset.USDC] as const;
