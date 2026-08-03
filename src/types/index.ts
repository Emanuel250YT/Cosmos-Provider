/**
 * Tipos de payloads de la API de Etherfuse.
 *
 * Todos los objetos crudos aceptan campos extra (`[key: string]: unknown`)
 * para que la librería no se rompa cuando la API añada campos nuevos.
 */

import type {
  Blockchain,
  FiatCurrency,
  OrderDirection,
  OrderStatus,
  PixKeyType,
} from "@/atoms/constants";

// ---------------------------------------------------------------------------
// Paginación
// ---------------------------------------------------------------------------

export interface Page<T> {
  items: T[];
  pageNumber: number;
  pageSize: number;
  totalItems: number;
  totalPages: number;
  next?: string | null;
  [key: string]: unknown;
}

export interface PageQuery {
  pageNumber?: number;
  pageSize?: number;
}

// ---------------------------------------------------------------------------
// Quotes
// ---------------------------------------------------------------------------

export type QuoteAssets =
  | { type: "onramp"; sourceAsset: FiatCurrency | string; targetAsset: string }
  | { type: "offramp"; sourceAsset: string; targetAsset: FiatCurrency | string }
  | { type: "swap"; sourceAsset: string; targetAsset: string };

export interface CreateQuoteOptions {
  /** Se genera automáticamente si se omite. */
  quoteId?: string;
  /** UUID de la organización o de un customer hijo. Si se omite, se usa el customer por defecto del cliente. */
  customerId?: string;
  blockchain: Blockchain;
  /** Monto a convertir, como string decimal (p. ej. "1000"). */
  sourceAmount: string;
  quoteAssets: QuoteAssets;
  /** Override de fee de partner en basis points (0–500). */
  partnerFeeBps?: number;
  /** Dirección Stellar: habilita chequeo de trustline en onramps. */
  walletAddress?: string;
}

export interface APIQuote {
  quoteId: string;
  blockchain: Blockchain;
  quoteAssets: QuoteAssets;
  sourceAmount: string;
  destinationAmount: string;
  exchangeRate: string;
  nominalRate: string;
  feeBps: string;
  feeAmount: string;
  etherfuseMidMarketRate?: string;
  requiresSwap?: boolean;
  createdAt: string;
  updatedAt: string;
  /** Las quotes expiran a los 2 minutos. */
  expiresAt: string;
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// Orders
// ---------------------------------------------------------------------------

export interface CreateOrderOptions {
  /** Se genera automáticamente si se omite. */
  orderId?: string;
  bankAccountId: string;
  /** Recomendado: fija el precio de una quote previa. */
  quoteId?: string;
  /** Wallet embebida de Etherfuse. */
  cryptoWalletId?: string;
  /** Dirección on-chain propia (BYOW). */
  publicKey?: string;
  blockchain?: Blockchain;
  direction?: OrderDirection;
  fiatAmount?: string;
  tokenAmount?: string;
  feePayer?: string;
  memo?: string;
  useAnchor?: boolean;
  [key: string]: unknown;
}

/** Instrucciones de depósito normalizadas para onramps (PIX o SPEI). */
export interface DepositInstructions {
  method: "pix" | "spei";
  /** Monto fiat exacto a depositar. */
  amount?: string;
  /** BRL: código PIX "copia e cola" (BR Code EMV) — de aquí sale el QR. */
  pixCode?: string;
  /** MXN: CLABE interbancaria a la que transferir. */
  clabe?: string;
  bankName?: string;
  accountHolder?: string;
}

export interface WithdrawInstructions {
  anchorAccount?: string | null;
  memo?: string | null;
  memoType?: string | null;
}

export interface APIOrder {
  orderId: string;
  customerId?: string;
  walletId?: string;
  bankAccountId?: string;
  orderType?: OrderDirection | "swap";
  status?: OrderStatus;
  sourceAsset?: string;
  targetAsset?: string;
  amountInFiat?: string;
  amountInTokens?: string;
  exchangeRate?: string;
  etherfuseMidMarketRate?: string;
  feeBps?: number | string;
  feeAmountInFiat?: string;
  depositClabe?: string;
  depositAmount?: string;
  depositBankName?: string;
  depositAccountHolder?: string;
  trackingCode?: string | null;
  confirmedTxSignature?: string | null;
  blockchain?: Blockchain;
  statusPage?: string;
  memo?: string | null;
  partnerFeeBps?: number;
  partnerFeeAmountFiat?: string;
  partnerFeeStatus?: "none" | "pending" | "disbursed";
  isAnchorOrder?: boolean;
  createdAt?: string;
  updatedAt?: string;
  completedAt?: string | null;
  deletedAt?: string | null;
  [key: string]: unknown;
}

export interface APICreateOrderResult {
  onramp?: APIOrder & Record<string, unknown>;
  offramp?: {
    orderId: string;
    withdrawAnchorAccount?: string | null;
    withdrawMemo?: string | null;
    withdrawMemoType?: string | null;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// Customers
// ---------------------------------------------------------------------------

export interface APICustomer {
  customerId?: string;
  /** `GET /ramp/me` devuelve el UUID como `id` en lugar de `customerId`. */
  id?: string;
  displayName?: string;
  createdAt?: string;
  updatedAt?: string;
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// Bank accounts
// ---------------------------------------------------------------------------

export interface CreatePixPersonalAccount {
  /** UUID de idempotencia; se genera si se omite. */
  transactionId?: string;
  firstName: string;
  lastName: string;
  cpf: string;
  pixKey: string;
  pixKeyType: PixKeyType | string;
  [key: string]: unknown;
}

export interface CreatePixBusinessAccount {
  transactionId?: string;
  name: string;
  cnpj: string;
  pixKey: string;
  pixKeyType: PixKeyType | string;
  [key: string]: unknown;
}

export interface CreateClabePersonalAccount {
  transactionId?: string;
  firstName: string;
  paternalLastName: string;
  maternalLastName?: string;
  /** YYYYMMDD */
  birthDate: string;
  birthCountryIsoCode: string;
  curp: string;
  rfc: string;
  clabe: string;
  [key: string]: unknown;
}

export interface CreateClabeBusinessAccount {
  transactionId?: string;
  name: string;
  /** YYYYMMDD */
  incorporatedDate: string;
  rfc: string;
  clabe: string;
  countryIsoCode: string;
  [key: string]: unknown;
}

export interface CreateBankAccountPayload {
  account: Record<string, unknown>;
  bankAccountId?: string;
  label?: string;
}

export interface APIBankAccount {
  bankAccountId: string;
  customerId: string;
  currency: FiatCurrency | string;
  compliant?: boolean;
  needsWork?: boolean;
  status?: string;
  etherfuseDepositClabe?: string;
  label?: string;
  createdAt?: string;
  updatedAt?: string;
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// Wallets
// ---------------------------------------------------------------------------

export interface RegisterWalletOptions {
  publicKey: string;
  blockchain: Blockchain;
  claimOwnership?: boolean;
  [key: string]: unknown;
}

export interface APIWallet {
  walletId: string;
  customerId?: string;
  publicKey?: string;
  blockchain?: Blockchain;
  claimedOwnership?: boolean | null;
  kycStatus?: string | null;
  displayName?: string | null;
  kycOnChain?: boolean | null;
  signerPublicKey?: string | null;
  createdAt?: string;
  updatedAt?: string;
  deletedAt?: string | null;
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// Assets / Lookup
// ---------------------------------------------------------------------------

export interface APIAsset {
  [key: string]: unknown;
}

export interface ExchangeRateSource {
  rate: string;
  updated_at: number;
  [key: string]: unknown;
}

export interface ExchangeRatePair {
  rate: string;
  sources?: Record<string, ExchangeRateSource>;
  updated_at?: number;
  [key: string]: unknown;
}

/** Respuesta de GET /lookup/exchange_rate: claves tipo "usd_to_brl". */
export type ExchangeRates = Record<string, ExchangeRatePair>;

// ---------------------------------------------------------------------------
// Webhooks
// ---------------------------------------------------------------------------

export interface CreateWebhookOptions {
  url: string;
  [key: string]: unknown;
}

export interface APIWebhook {
  webhookId?: string;
  url?: string;
  /** Secreto HMAC en base64 — solo se devuelve una vez, al crear el webhook. */
  secret?: string;
  createdAt?: string;
  [key: string]: unknown;
}

export type WebhookEventType =
  | "order_updated"
  | "swap_updated"
  | "customer_updated"
  | "bank_account_updated"
  | "kyc_updated"
  | "kyb_updated"
  | (string & {});

export interface WebhookEvent {
  type?: WebhookEventType;
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// Swaps
// ---------------------------------------------------------------------------

export interface SwapOptions {
  quoteId?: string;
  [key: string]: unknown;
}
