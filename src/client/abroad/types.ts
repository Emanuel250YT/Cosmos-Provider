/**
 * Wire types for the Abroad Finance partner API
 * (https://api.abroad.finance, schema at /swagger.json).
 *
 * Only the partner-facing surface is modelled here — the `/ops/*` and
 * `/partner-portal/*` trees are internal to Abroad and need a different
 * credential entirely.
 *
 * Naming is Abroad's, not this library's: the request bodies are
 * `snake_case` and the responses mix `snake_case` with `camelCase`. That's
 * deliberate — these are the bytes on the wire, and `AbroadProvider` is
 * where they get normalized into the engine's own vocabulary.
 */

/** Fiat currencies Abroad settles in. */
export type AbroadTargetCurrency = "COP" | "BRL";

/** Local payment rails Abroad collects/pays out on: PIX (Brazil), BREB (Colombia). */
export type AbroadPaymentMethod = "PIX" | "BREB";

/** Chains Abroad moves crypto on. All corridors are mainnet — there is no testnet. */
export type AbroadBlockchainNetwork = "STELLAR" | "SOLANA" | "CELO";

export type AbroadChainFamily = "evm" | "solana" | "stellar";

export type AbroadCryptoCurrency = "USDC" | "USDT";

/** Which way money moves. Abroad defaults to payouts when the parameter is omitted. */
export type AbroadCorridorDirection = "CRYPTO_TO_FIAT" | "FIAT_TO_CRYPTO";

// ---------------------------------------------------------------------------
// Quotes
// ---------------------------------------------------------------------------

/** `POST /quote/onramp` — given the fiat the user pays, how much crypto they get. */
export interface AbroadOnrampQuoteRequest {
  target_currency: AbroadTargetCurrency;
  payment_method: AbroadPaymentMethod;
  network: AbroadBlockchainNetwork;
  crypto_currency: AbroadCryptoCurrency;
  fiat_amount: number;
}

/** `POST /quote` — given the fiat the user wants paid out, how much crypto they must send. */
export interface AbroadQuoteRequest {
  target_currency: AbroadTargetCurrency;
  payment_method: AbroadPaymentMethod;
  network: AbroadBlockchainNetwork;
  crypto_currency: AbroadCryptoCurrency;
  /** The FIAT amount to be paid out — despite the bare name. */
  amount: number;
}

/** `POST /quote/reverse` — given the crypto the user sends, how much fiat they get. */
export interface AbroadReverseQuoteRequest {
  target_currency: AbroadTargetCurrency;
  payment_method: AbroadPaymentMethod;
  network: AbroadBlockchainNetwork;
  crypto_currency: AbroadCryptoCurrency;
  /** The CRYPTO amount the user sends. */
  source_amount: number;
}

export interface AbroadQuoteFee {
  /** Decimal string, e.g. `"0.189754"`. */
  amount: string;
  currency: AbroadCryptoCurrency;
  type: "combined" | "fixed" | "none" | "percentage";
}

/**
 * Every quote endpoint answers with this shape. What `value` MEANS depends
 * on which one you called, which is the single easiest thing to get wrong
 * here:
 * - `/quote/onramp` → `value` is CRYPTO (what the buyer receives).
 * - `/quote`        → `value` is CRYPTO (what the seller must send).
 * - `/quote/reverse`→ `value` is FIAT   (what the seller receives).
 */
export interface AbroadQuoteResponse {
  quote_id: string;
  value: number;
  fee: AbroadQuoteFee;
  /** Epoch milliseconds. */
  expiration_time: number;
}

export type AbroadQuoteErrorCode =
  | "corridor_unavailable"
  | "maximum"
  | "minimum"
  | "quote_unavailable"
  | "authentication_failed"
  | "invalid_request"
  | "server_error";

export interface AbroadQuoteErrorResponse {
  code: AbroadQuoteErrorCode;
  reason: string;
  retryable: boolean;
}

// ---------------------------------------------------------------------------
// Transactions
// ---------------------------------------------------------------------------

export interface AbroadAcceptTransactionRequest {
  quote_id: string;
  user_id: string;
  /** Offramp: the payee's local account (PIX key / BREB key). */
  account_number?: string;
  /** Offramp: the payee's tax id (CPF in Brazil, NIT/CC in Colombia). */
  tax_id?: string;
  /** Onramp: where Abroad delivers the crypto. */
  destination_address?: string;
  qr_code?: string | null;
  redirectUrl?: string;
}

/** Onramp only: what the buyer pays to fund the transaction. */
export interface AbroadPaymentInstructions {
  /** EMV copy-paste PIX payload ("copia e cola") — render your own QR from this. */
  br_code: string;
  /** Epoch milliseconds, or null when the code doesn't expire. */
  expires_at: number | null;
}

export interface AbroadPaymentNotifyContext {
  required: boolean;
  endpoint: string | null;
}

/** Offramp only: where the seller sends crypto so Abroad can pay their fiat out. */
export interface AbroadPaymentContext {
  blockchain: AbroadBlockchainNetwork;
  chainFamily: AbroadChainFamily;
  chainId: string;
  cryptoCurrency: AbroadCryptoCurrency;
  depositAddress: string;
  /** Stellar deposits are pooled — WITHOUT this memo the transfer can't be credited. */
  memo: string | null;
  memoType: "text" | null;
  amount: number;
  decimals: number | null;
  mintAddress: string | null;
  rpcUrl: string | null;
  notify: AbroadPaymentNotifyContext;
}

export interface AbroadAcceptTransactionResponse {
  id: string | null;
  /**
   * `true` when Abroad won't move this transaction until the user is
   * verified. The transaction is NOT usable in that state — submit
   * `POST /kyc` for `user_id` and create it again.
   */
  kycRequired: boolean;
  transaction_reference: string | null;
  payment_instructions?: AbroadPaymentInstructions | null;
  payment_context?: AbroadPaymentContext | null;
}

export type AbroadTransactionStatus =
  | "AWAITING_PAYMENT"
  | "PROCESSING_PAYMENT"
  | "PAYMENT_FAILED"
  | "PAYMENT_EXPIRED"
  | "PAYMENT_COMPLETED"
  | "WRONG_AMOUNT";

export interface AbroadTransactionStatusResponse {
  id: string;
  user_id: string;
  status: AbroadTransactionStatus;
  kycRequired: boolean;
  transaction_reference: string;
  on_chain_tx_hash: string | null;
}

// ---------------------------------------------------------------------------
// KYC
// ---------------------------------------------------------------------------

export type AbroadKycStatus = "PENDING" | "APPROVED" | "PENDING_APPROVAL" | "REJECTED";

export interface AbroadKycStatusResponse {
  hasApproved: boolean;
  status: AbroadKycStatus | null;
}

export interface AbroadKycSubmitResponse {
  status: AbroadKycStatus;
}

/** The identity fields `POST /kyc` requires alongside the document image. All are mandatory — a partial submission is rejected. */
export interface AbroadKycSubmission {
  userId: string;
  fullName: string;
  documentType: string;
  documentNumber: string;
  /** Abroad accepts an ISO date here, e.g. "1990-01-31". */
  dateOfBirth: string;
  nationality: string;
  city: string;
  address: string;
  email: string;
  phone: string;
}

// ---------------------------------------------------------------------------
// Corridors, liquidity, partner
// ---------------------------------------------------------------------------

export interface AbroadWalletConnectMetadata {
  namespace: string;
  chainId: string;
  methods: string[];
  events: string[];
}

/** One supported route, e.g. "STELLAR USDC → BRL over PIX, between 10 and 500". */
export interface AbroadCorridor {
  blockchain: AbroadBlockchainNetwork;
  chainFamily: AbroadChainFamily;
  /** CAIP-2-ish chain id. Every corridor Abroad publishes today is mainnet, e.g. `"stellar:pubnet"`. */
  chainId: string;
  cryptoCurrency: AbroadCryptoCurrency;
  paymentMethod: AbroadPaymentMethod | "NEQUI" | "MOVII";
  targetCurrency: AbroadTargetCurrency;
  /** Bounds are in the FIAT currency (`targetCurrency`). `null` means unbounded. */
  minAmount: number | null;
  maxAmount: number | null;
  notify: AbroadPaymentNotifyContext;
  walletConnect: AbroadWalletConnectMetadata;
}

export interface AbroadCorridorResponse {
  corridors: AbroadCorridor[];
}

export interface AbroadLiquidityResponse {
  success: boolean;
  liquidity: number;
  message?: string;
}

export interface AbroadPartnerInfo {
  id: string;
  name: string;
  createdAt: string;
  country?: string;
  email?: string;
  firstName?: string;
  lastName?: string;
  phone?: string;
  needsKyc?: boolean;
  isKybApproved?: boolean;
}

export interface AbroadPartnerUser {
  id: string;
  userId: string;
  kycToken: string | null;
  createdAt: string;
  updatedAt: string;
}
