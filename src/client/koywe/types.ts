/** Types for {@link KoyweClient} — the Koywe crypto fiat on/off-ramp API. */

export interface KoyweConfig {
  /** OAuth-style client id issued by Koywe. Server-side only. */
  clientId: string;
  /** Secret paired with `clientId`. Never expose to the browser. */
  secret: string;
  /** `https://api-sandbox.koywe.com` (sandbox) or the production base URL. */
  baseUrl: string;
  /** Issuer account of the USDC trustline on Stellar, injected into `supportedTokens`. */
  usdcIssuer: string;
  /** Default email used when a call doesn't pass one explicitly. */
  email?: string;
  /** Log every request/response (never credentials) to the console. Default `false`. */
  debug?: boolean;
}

/** Local payment rail id, shared across Koywe's per-country payment providers. */
export type KoyweRail = "wirear" | "qri" | "spei" | "pse";

export interface KoyweTokenInfo {
  symbol: string;
  name: string;
  issuer: string;
  /** Koywe's own symbol for this asset (e.g. `"USDC Stellar"`). */
  koyweSymbol: string;
  decimals: number;
}

export interface KoyweAccountCheck {
  canOperate: boolean;
  accountStatus: string;
  missing: Array<{ field?: string; message?: string }>;
  nextVerificationDate?: string;
}

export interface KoywePaymentMethod {
  id: string;
  name: string;
  label: string;
  rail?: KoyweRail;
  fee?: number;
}

export interface KoyweQuote {
  id: string;
  ramp: "onramp" | "offramp";
  sourceAsset: string;
  targetAsset: string;
  sourceAmount: string;
  destinationAmount: string;
  exchangeRate: string;
  fee: string;
  expiresAt: string;
  paymentMethodId?: string;
}

export interface KoyweDepositInstructions {
  cvu?: string;
  alias?: string;
  bankName?: string;
  email?: string;
  /** Untouched multi-line instruction string, in case a field wasn't recognized. */
  raw: string;
}

export interface KoyweOnRampOrder {
  id: string;
  quoteId: string;
  status: string;
  sourceAmount: string;
  destinationAmount: string;
  sourceAsset: string;
  targetAsset: string;
  stellarAddress: string;
  /** Inline deposit instructions (WIREAR). Absent for hosted-redirect rails. */
  deposit?: KoyweDepositInstructions;
  /** Hosted checkout URL to redirect the user to (QRI, Khipu). */
  interactiveUrl?: string;
}

export interface KoyweOffRampOrder {
  id: string;
  quoteId: string;
  status: string;
  sourceAmount: string;
  destinationAmount: string;
  sourceAsset: string;
  targetAsset: string;
  bankAccountId: string;
  /** Stellar address the user must send USDC to. */
  depositAddress?: string;
  interactiveUrl?: string;
}

export interface KoyweOrder {
  id: string;
  status: string;
  sourceAmount: string;
  destinationAmount: string;
  sourceAsset: string;
  targetAsset: string;
  deposit?: KoyweDepositInstructions;
  depositAddress?: string;
  interactiveUrl?: string;
  dates?: Record<string, string | undefined>;
  txHash?: string;
  statusDetails?: unknown;
  isDeliveryExpired: boolean;
}

export interface GetQuoteArgs {
  ramp: "onramp" | "offramp";
  /** Fiat leg of the conversion (ARS, CLP, MXN, COP, PEN, BRL). */
  fiatCurrency: string;
  /** Amount of the input asset (fiat for onramp, USDC for offramp). */
  amount: string | number;
  /** Required for onramp — pick from {@link KoyweClient.getPaymentProviders}. */
  paymentMethodId?: string;
}

export interface CreateOnRampOrderArgs {
  quoteId: string;
  /** Stellar "G..." address to receive USDC. Validated locally before the request. */
  stellarAddress: string;
  email?: string;
  documentNumber?: string;
  /** URL Koywe redirects to after a hosted payment (QRI, Khipu). */
  callbackUrl?: string;
  /** Idempotency key, retrievable later via {@link KoyweClient.getOrderByExternalId}. */
  externalId?: string;
}

export interface CreateOffRampOrderArgs {
  quoteId: string;
  /** Id of a bank account registered via {@link KoyweClient.createBankAccount}. */
  bankAccountId: string;
  email?: string;
  documentNumber?: string;
}

export interface CreateAccountArgs {
  email: string;
  document: {
    documentNumber: string;
    documentType: string;
    country: string;
    isCompany?: boolean;
    others?: Record<string, unknown>;
  };
  address: {
    country: string;
    zipCode: string;
    state: string;
    city: string;
    street: string;
    neighborhood?: string;
  };
  personalInfo: Record<string, unknown>;
}

export interface CreateBankAccountArgs {
  email: string;
  accountNumber: string;
  countryCode: string;
  currencySymbol: string;
  documentNumber?: string;
  bankCode?: string;
  accountType?: string;
}

export interface GetBankAccountsArgs {
  email: string;
  countryCode: string;
  currencySymbol: string;
}

export interface KoyweBankAccount {
  id: string;
  accountNumber: string;
  countryCode: string;
  currencySymbol: string;
  bankCode?: string;
  bankName?: string;
}

// ---------------------------------------------------------------------------
// Raw API response shapes (internal — mapped to the types above)
// ---------------------------------------------------------------------------

export interface KoyweTokenCurrency {
  symbol: string;
  currencies: Array<{ symbol: string; minimum?: number; maximum?: number }>;
}

export interface KoywePaymentProvider {
  _id: string;
  name: string;
  fee?: number;
}

export interface KoyweQuoteResponse {
  quoteId?: string;
  amountIn: number;
  amountOut: number;
  symbolIn: string;
  symbolOut: string;
  exchangeRate: number;
  koyweFee?: number;
  networkFee?: number;
  validUntil?: number;
  paymentMethodId?: string;
}

export interface KoyweOrderResponse {
  orderId: string;
  quoteId?: string;
  status: string;
  amountIn: number;
  amountOut: number;
  symbolIn: string;
  symbolOut: string;
  providedAddress?: string;
  providedAction?: string;
  dates?: Record<string, string | undefined>;
  txHash?: string;
  statusDetails?: unknown;
}

export interface KoyweBankAccountRequest {
  accountNumber: string;
  countryCode: string;
  currencySymbol: string;
  email: string;
  documentNumber?: string;
  bankCode?: string;
  accountType?: string;
}

export interface KoyweBankAccountResponse {
  _id: string;
  accountNumber: string;
  countryCode: string;
  currencySymbol: string;
  bankCode?: string;
  name?: string;
}

export interface KoyweAccountRequest {
  email: string;
  document: {
    documentNumber: string;
    documentType: string;
    country: string;
    isCompany: boolean;
    others?: Record<string, unknown>;
  };
  address: {
    addressCountry: string;
    addressZipCode: string;
    addressState: string;
    addressCity: string;
    addressStreet: string;
    addressNeighborhood?: string;
  };
  personalInfo: Record<string, unknown>;
}

export interface KoyweCheckAccountResponse {
  canOperate?: boolean;
  accountStatus?: string;
  errors?: Array<{ field?: string; message?: string }>;
  nextVerificationDate?: string;
}

export interface KoyweAuthResponse {
  token: string;
}

export interface KoyweErrorResponse {
  message?: string | string[];
  error?: string;
}
