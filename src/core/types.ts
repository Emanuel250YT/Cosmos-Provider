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
  /** Mid-market rate from the oracle: fiat units per 1 crypto unit. */
  rate: number;
  /** Spread applied on top of the mid rate (0.02 = 2%). */
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
}

// ---------------------------------------------------------------------------
// Provider contracts
// ---------------------------------------------------------------------------

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
