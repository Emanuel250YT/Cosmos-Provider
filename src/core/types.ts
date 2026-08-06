/**
 * Core types for the provider-agnostic ramp engine.
 *
 * Everything here is regional/provider neutral: a `PaymentProvider` turns
 * fiat charges into QR codes / payment links / deposits for one or more
 * countries, a `RateOracle` prices crypto in fiat, and a `SettlementAdapter`
 * moves the crypto leg (e.g. releases USDC after an approved payment).
 */

/** Direction of a ramp order. */
export type RampDirection = "onramp" | "offramp";

/** Lifecycle of a ramp order. */
export type RampOrderStatus =
  | "created" // payment built, waiting for the user to pay / send crypto
  | "paid" // fiat payment approved (onramp) or crypto received (offramp)
  | "settling" // settlement in progress (crypto release / fiat payout)
  | "completed" // both legs done
  | "failed"
  | "expired"
  | "canceled";

/** ISO 4217 fiat currency code (upper case), e.g. "ARS", "BRL", "MXN". */
export type FiatCurrencyCode = string;

/** Crypto asset symbol, e.g. "USDC". */
export type CryptoAssetCode = string;

/** How the user pays a fiat charge. */
export type PaymentMethod =
  | "qr" // scannable QR (EMV / provider-specific)
  | "link" // hosted checkout / payment link
  | "transfer" // bank transfer or deposit to an account
  | "auto"; // let the provider pick the best method for the region

// ---------------------------------------------------------------------------
// Quotes
// ---------------------------------------------------------------------------

/** Snapshot of the crypto/fiat conversion applied to an order. */
export interface QuoteBreakdown {
  /** Crypto asset being bought (onramp) or sold (offramp). */
  asset: CryptoAssetCode;
  /** Fiat currency of the payment leg. */
  currency: FiatCurrencyCode;
  /**
   * Mid-market rate: fiat units per 1 crypto unit. From the oracle for an
   * oracle-priced quote; for a provider-priced one (see {@link source}) the
   * provider rarely publishes a separate mid, so this is the same as
   * {@link effectiveRate} — the fee is carried in {@link fee} instead.
   */
  rate: number;
  /** Spread applied on top of the mid rate (0.02 = 2%). Always 0 for a provider-priced quote — the provider's own fee replaces it. */
  spread: number;
  /**
   * Rate actually applied after spread. Onramp: `rate * (1 + spread)`
   * (the user pays more fiat per crypto). Offramp: `rate * (1 - spread)`.
   */
  effectiveRate: number;
  /** Fiat amount of the order. */
  fiatAmount: number;
  /** Crypto amount of the order. */
  cryptoAmount: number;
  /** When the quote was taken (ms since epoch). */
  quotedAt: number;
  /**
   * Who priced this. `"oracle"` — the engine's {@link RateOracle} plus your
   * spread, identical whichever provider ends up collecting. `"provider"` —
   * the provider's own binding quote (see {@link PaymentProvider.getQuote}),
   * which is the real price for that rail and can differ substantially
   * between providers in the same corridor. Absent on quotes taken before
   * this field existed; treat that as `"oracle"`.
   */
  source?: "oracle" | "provider";
  /** Provider that priced it, when `source` is `"provider"`. */
  provider?: string;
  /**
   * The provider's own id for this quote. Providers that price their own
   * orders generally require it back when the charge is created, so the
   * price the user was shown is the price they get — the engine passes it
   * through on {@link CreateChargeRequest.quote}.
   */
  providerQuoteId?: string;
  /** The provider's stated fee for this quote, when it publishes one. */
  fee?: QuoteFee;
  /** When the provider's quote stops being honoured (ms since epoch). */
  expiresAt?: number;
}

/** A provider's own stated fee on a quote. */
export interface QuoteFee {
  /** Fee amount, in {@link currency}. */
  amount: number;
  /** Currency the fee is expressed in — often the crypto asset, not the fiat. */
  currency: string;
  /** How the provider computes it, when it says. */
  type?: "combined" | "fixed" | "none" | "percentage" | string;
}

// ---------------------------------------------------------------------------
// Provider contracts
// ---------------------------------------------------------------------------

/** What the engine asks a provider to price. */
export interface ProviderQuoteRequest {
  direction: RampDirection;
  /** Fiat currency of the payment leg. */
  currency: FiatCurrencyCode;
  /** Crypto asset being bought (onramp) or sold (offramp). */
  asset: CryptoAssetCode;
  /** Fiat amount to price from — set this or `cryptoAmount`. */
  amount?: number;
  /** Crypto amount to price from — set this or `amount`. */
  cryptoAmount?: number;
  /** Preferred payment method, when the provider prices per rail. */
  method?: PaymentMethod;
  /** Free-form provider-specific options passed through untouched. */
  providerOptions?: Record<string, unknown>;
}

/** A provider's own binding price for one conversion. */
export interface ProviderQuote {
  /** Fiat the user pays (onramp) or receives (offramp). */
  fiatAmount: number;
  /** Crypto the user receives (onramp) or sends (offramp). */
  cryptoAmount: number;
  /** The provider's id for this quote, to be echoed back when the order is created. */
  quoteId?: string;
  /** The provider's stated fee, when it publishes one. */
  fee?: QuoteFee;
  /** When the quote stops being honoured (ms since epoch). */
  expiresAt?: number;
  /** Raw provider response, untouched. */
  raw?: unknown;
}

/** Request the engine sends to a provider to build a fiat charge. */
export interface CreateChargeRequest {
  /** Fiat amount to collect. */
  amount: number;
  /** Fiat currency, upper case. */
  currency: FiatCurrencyCode;
  /** Preferred payment method. Providers may fall back when unsupported. */
  method: PaymentMethod;
  /** Opaque reference the provider must echo back in webhooks (the order id). */
  reference: string;
  /** Human description shown at checkout. */
  description?: string;
  /** Payer hints (some providers require an email for QR payments). */
  payer?: { email?: string; name?: string; document?: string };
  /** Charge expiration in minutes, when the provider supports it. */
  expiresInMinutes?: number;
  /**
   * The quote the engine froze for this order. Providers that price their
   * own orders need it back — `quote.providerQuoteId` is the id they handed
   * out from {@link PaymentProvider.getQuote}, and re-quoting instead would
   * charge a price the user never saw. Oracle-priced providers can ignore it.
   */
  quote?: QuoteBreakdown;
  /**
   * Where the crypto should be delivered, for providers that release it
   * themselves rather than leaving it to your `SettlementAdapter`. Most
   * rails ignore this — they only collect fiat.
   */
  destinationAddress?: string;
  /** Free-form provider-specific options passed through untouched. */
  providerOptions?: Record<string, unknown>;
}

/** What a provider returns after building a charge. */
export interface Charge {
  /** Provider-side id of the charge/payment/preference. */
  id: string;
  /** Which method was actually built. */
  method: Exclude<PaymentMethod, "auto">;
  /** Scannable QR payload (EMV "copia e cola" for PIX, EMVCo for MP QR...). */
  qr?: string;
  /** Ready-to-embed base64 PNG of the QR, when the provider gives one. */
  qrBase64?: string;
  /** Hosted checkout / payment link. */
  link?: string;
  /** Deposit instructions for transfer-style charges. */
  deposit?: { bankName?: string; accountNumber?: string; alias?: string; reference?: string };
  /** Charge expiration (ms since epoch), when known. */
  expiresAt?: number;
  /** Raw provider response, untouched. */
  raw?: unknown;
}

/** Normalized status of a provider payment. */
export type ChargeStatus = "pending" | "approved" | "rejected" | "refunded" | "canceled" | "expired";

/** Normalized view of a provider payment (used to reconcile webhooks). */
export interface ChargeState {
  id: string;
  status: ChargeStatus;
  amount: number;
  currency: FiatCurrencyCode;
  /** The `reference` we sent at creation, echoed back by the provider. */
  reference?: string;
  raw?: unknown;
}

/**
 * What the engine asks a provider for when an offramp order is created:
 * where the user must send their crypto.
 */
export interface CreateOfframpDepositRequest {
  /** Crypto amount the user will send. */
  cryptoAmount: number;
  asset: CryptoAssetCode;
  /** Fiat currency to pay out. */
  currency: FiatCurrencyCode;
  /** Opaque reference the provider should echo back (the order id). */
  reference: string;
  /**
   * Where the fiat goes: the user's bank/PIX/BREB details. Shape is
   * provider-specific (`accountNumber`, `taxId`, `pixKey`, `email`...) —
   * the engine passes it through untouched.
   */
  destination: Record<string, unknown>;
  /** The quote this deposit settles against, so the provider can bind its own quote id. */
  quote?: QuoteBreakdown;
  providerOptions?: Record<string, unknown>;
}

/**
 * Where an offramp user must send their crypto, and what they get back.
 *
 * Rails that take custody of the crypto themselves (rather than letting you
 * collect it into your own treasury) can only tell you this once the order
 * exists on their side — the address and memo are per-order, and sending to
 * the wrong one, or with no memo, generally loses the funds. Surface every
 * field of this verbatim to the user.
 */
export interface OfframpDeposit {
  /** Provider-side id of the offramp transaction. */
  id: string;
  /** Address the user sends crypto to. */
  address: string;
  /** Memo/tag that identifies the deposit, when the rail needs one. Sending without it usually means the funds can't be credited. */
  memo?: string;
  /** Memo kind, e.g. "text" for Stellar. */
  memoType?: string;
  /** Exact crypto amount expected — an amount mismatch is a common failure state. */
  amount: number;
  asset: CryptoAssetCode;
  /** Chain the deposit must be made on, e.g. "STELLAR". Mismatched chains lose funds. */
  network?: string;
  /** Chain id in CAIP form when the provider gives one, e.g. "stellar:pubnet". */
  chainId?: string;
  /** Fiat the user receives once the deposit lands. */
  fiatAmount?: number;
  currency?: FiatCurrencyCode;
  /** The provider's human-facing reference for this transaction. */
  reference?: string;
  /** Whether the provider must be told about the transfer explicitly (rather than watching the chain itself). */
  notifyRequired?: boolean;
  /** Endpoint to notify on, when `notifyRequired`. */
  notifyEndpoint?: string;
  /** True when the provider won't proceed until the user passes KYC. */
  kycRequired?: boolean;
  expiresAt?: number;
  raw?: unknown;
}

/** Fiat payout instruction for offramp orders. */
export interface CreatePayoutRequest {
  amount: number;
  currency: FiatCurrencyCode;
  reference: string;
  /** Provider-specific destination (CVU/CBU, PIX key, MP account email...). */
  destination: Record<string, unknown>;
}

export interface PayoutResult {
  id: string;
  status: "pending" | "sent" | "failed";
  raw?: unknown;
}

/**
 * Transport-agnostic view of an incoming HTTP request, so webhook handling
 * works with Express, Fastify, Next.js, Workers or anything else.
 */
export interface WebhookRequest {
  /** Raw body as received (string preferred for signature checks). */
  body: string | Record<string, unknown>;
  /** Header lookup, case-insensitive keys recommended. */
  headers: Record<string, string | string[] | undefined>;
  /** Query string parameters, if any. */
  query?: Record<string, string | undefined>;
  /** Full request URL, if available (used to extract query params). */
  url?: string;
}

/** Result of parsing a provider webhook. */
export interface WebhookNotification {
  /** Provider payment id the notification refers to. */
  chargeId: string;
  /** Event kind as reported by the provider ("payment", "test", ...). */
  kind: string;
  raw?: unknown;
}

/**
 * A regional payment rail: Mercado Pago, PIX, SPEI, Stripe... Implement this
 * interface to plug any provider into the engine.
 */
export interface PaymentProvider {
  /** Unique name used to select the provider ("mercadopago", ...). */
  readonly name: string;
  /** ISO 3166-1 alpha-2 country codes this provider can collect in. */
  readonly regions: readonly string[];
  /** Fiat currencies this provider can collect/pay out. */
  readonly currencies: readonly FiatCurrencyCode[];
  /** Optional logo URL, for UIs that list providers (e.g. a payment-method picker). */
  readonly logoUrl?: string;
  /**
   * Short, human-readable summary of what this rail costs, e.g. `"1.0%"` or
   * `"2.0% spread"` — for a picker to show next to each provider so the user
   * can tell which is cheapest in their region at a glance. A static
   * fallback: when the provider implements {@link getQuote}, the fee on a
   * live quote is the authoritative number and this is only what's shown
   * before an amount is known.
   */
  readonly feeLabel?: string;
  /**
   * True when this rail delivers the crypto itself (an integrated ramp like
   * Abroad or Etherfuse) rather than only collecting fiat and leaving the
   * release to your `SettlementAdapter`. Skip your own settlement for these
   * orders — running both would pay the user twice.
   */
  readonly settlesCrypto?: boolean;

  /**
   * The provider's own binding price, when it publishes one. Implement this
   * and the engine prices orders on this rail with it instead of the
   * oracle+spread — which is the real price the user pays, and the only way
   * a picker can honestly compare two rails. Leave it off for a
   * fiat-collection-only rail (Mercado Pago, Stripe), where the oracle is
   * the right answer.
   */
  getQuote?(request: ProviderQuoteRequest): Promise<ProviderQuote>;

  /** Build a fiat charge (QR, link or deposit instructions). */
  createCharge(request: CreateChargeRequest): Promise<Charge>;

  /** Fetch the current, trusted state of a charge from the provider API. */
  getCharge(chargeId: string): Promise<ChargeState>;

  /**
   * Verify an incoming webhook's authenticity. Return `false` (or throw)
   * for invalid signatures. Providers without signatures may return `true`.
   */
  verifyWebhook(request: WebhookRequest): Promise<boolean>;

  /**
   * Extract the charge reference from a webhook. Return `null` for
   * notifications that are not about payments (tests, chargebacks...).
   */
  parseWebhook(request: WebhookRequest): Promise<WebhookNotification | null>;

  /**
   * Open an offramp order and return where the user must send their crypto.
   * Implement this for a rail that custodies the crypto leg itself, so the
   * engine can put a real deposit address (and memo) on the order the moment
   * it's created — the user has nowhere to send funds otherwise.
   *
   * Rails where YOU collect the crypto into your own treasury don't need
   * this: implement {@link createPayout} instead and pay the fiat out once
   * you've seen the transfer.
   */
  createOfframpDeposit?(request: CreateOfframpDepositRequest): Promise<OfframpDeposit>;

  /** Send fiat to a user (offramp). Optional: not all rails support payouts. */
  createPayout?(request: CreatePayoutRequest): Promise<PayoutResult>;
}

// ---------------------------------------------------------------------------
// Oracle contract
// ---------------------------------------------------------------------------

/** Prices crypto assets in fiat. */
export interface RateOracle {
  /** Fiat units per 1 unit of `asset` (e.g. USDC → ARS = 1350.42). */
  getRate(asset: CryptoAssetCode, currency: FiatCurrencyCode): Promise<number>;
}

// ---------------------------------------------------------------------------
// Settlement contract
// ---------------------------------------------------------------------------

/** Context the engine passes when the crypto leg must move. */
export interface SettlementContext {
  order: RampOrderData;
  /** Crypto asset to move. */
  asset: CryptoAssetCode;
  /** Crypto amount to move. */
  amount: number;
  /** Destination wallet (onramp) — absent for offramp collections. */
  wallet?: string;
}

/**
 * Moves the crypto leg. Implement `release` to send crypto to the user's
 * wallet after an approved onramp payment — with your own signer, a custodial
 * API, an exchange withdrawal, etc. The engine never touches keys.
 */
export interface SettlementAdapter {
  release(context: SettlementContext): Promise<{ txId?: string } | void>;
}

/** Shorthand: a bare function is accepted anywhere a SettlementAdapter is. */
export type SettlementFn = (context: SettlementContext) => Promise<{ txId?: string } | void>;

// ---------------------------------------------------------------------------
// Orders & storage
// ---------------------------------------------------------------------------

/** Persisted representation of a ramp order. */
export interface RampOrderData {
  /** Engine-generated id; also sent to providers as the charge reference. */
  id: string;
  direction: RampDirection;
  status: RampOrderStatus;
  provider: string;
  quote: QuoteBreakdown;
  /** Destination wallet for onramp releases. */
  wallet?: string;
  /** Fiat payout destination for offramp orders. */
  payoutDestination?: Record<string, unknown>;
  /**
   * Where the user must send crypto to fulfil an offramp order, for
   * providers that custody the crypto leg (see
   * {@link PaymentProvider.createOfframpDeposit}). Absent when you collect
   * the crypto into your own treasury instead.
   */
  deposit?: OfframpDeposit;
  /** The fiat charge built for onramp orders. */
  charge?: Charge;
  /** Provider payment id once known (charge id or webhook payment id). */
  chargeId?: string;
  /** Settlement transaction id (crypto release / payout id). */
  settlementTxId?: string;
  /** Arbitrary user metadata. */
  metadata?: Record<string, unknown>;
  createdAt: number;
  updatedAt: number;
}

/** Pluggable persistence. The default is an in-memory Map (dev only). */
export interface OrderStore {
  save(order: RampOrderData): Promise<void>;
  get(id: string): Promise<RampOrderData | null>;
  /** Find by provider charge id (webhooks may only carry the payment id). */
  findByChargeId(provider: string, chargeId: string): Promise<RampOrderData | null>;
  update(id: string, patch: Partial<RampOrderData>): Promise<RampOrderData | null>;
  list(): Promise<RampOrderData[]>;
}
