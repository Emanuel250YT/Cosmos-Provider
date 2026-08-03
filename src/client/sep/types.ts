/** Types shared by the SEP-1 / SEP-10 / SEP-24 helpers. */

/** `[CURRENCIES]` entry of a `stellar.toml` file. */
export interface StellarTomlCurrency {
  code?: string;
  issuer?: string;
  display_decimals?: number;
  name?: string;
  desc?: string;
  is_asset_anchored?: boolean;
  anchor_asset_type?: string;
  anchor_asset?: string;
  [key: string]: unknown;
}

/** Parsed `stellar.toml` — the SEP-1 anchor discovery document. */
export interface StellarToml {
  VERSION?: string;
  NETWORK_PASSPHRASE?: string;
  FEDERATION_SERVER?: string;
  AUTH_SERVER?: string;
  WEB_AUTH_ENDPOINT?: string;
  SIGNING_KEY?: string;
  TRANSFER_SERVER?: string;
  TRANSFER_SERVER_SEP0024?: string;
  KYC_SERVER?: string;
  DIRECT_PAYMENT_SERVER?: string;
  ANCHOR_QUOTE_SERVER?: string;
  ACCOUNTS?: string[];
  CURRENCIES?: StellarTomlCurrency[];
  DOCUMENTATION?: Record<string, unknown>;
  [key: string]: unknown;
}

/** SEP-10 challenge returned by `GET {WEB_AUTH_ENDPOINT}`. */
export interface Sep10Challenge {
  /** Base64-encoded XDR of the unsigned challenge transaction. */
  transaction: string;
  networkPassphrase: string;
}

/** A function that signs a SEP-10 challenge with the account's keypair. Bring your own signer (Freighter, a server-side keypair, an HSM...) — this library never touches private keys. */
export type Sep10Signer = (challengeXdr: string, networkPassphrase: string) => Promise<string>;

/** SEP-24 `/info` response (trimmed to the fields callers actually need). */
export interface Sep24Info {
  deposit?: Record<string, Sep24AssetInfo>;
  withdraw?: Record<string, Sep24AssetInfo>;
  fee?: { enabled?: boolean };
}

export interface Sep24AssetInfo {
  enabled: boolean;
  min_amount?: number;
  max_amount?: number;
  fee_fixed?: number;
  fee_percent?: number;
}

/** `POST /transactions/{deposit,withdraw}/interactive` response. */
export interface Sep24InteractiveResponse {
  type: "interactive_customer_info_needed";
  /** URL to open (in a browser/webview) for the anchor's hosted KYC + amount flow. */
  url: string;
  id: string;
}

/** SEP-24 transaction status, per `GET /transaction`. */
export type Sep24TransactionStatus =
  | "incomplete"
  | "pending_user_transfer_start"
  | "pending_user_transfer_complete"
  | "pending_external"
  | "pending_anchor"
  | "pending_stellar"
  | "pending_trust"
  | "pending_user"
  | "completed"
  | "refunded"
  | "expired"
  | "no_market"
  | "too_small"
  | "too_large"
  | "error";

export interface Sep24Transaction {
  id: string;
  kind: "deposit" | "withdrawal";
  status: Sep24TransactionStatus;
  amount_in?: string;
  amount_out?: string;
  amount_fee?: string;
  started_at?: string;
  completed_at?: string;
  stellar_transaction_id?: string;
  external_transaction_id?: string;
  more_info_url?: string;
  message?: string;
  [key: string]: unknown;
}
