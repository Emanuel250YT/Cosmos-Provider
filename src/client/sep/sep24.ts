/**
 * SEP-24 — Hosted Deposit and Withdrawal.
 *
 * The interactive flow any SEP-compliant anchor supports: kick off a deposit
 * or withdrawal, get back a hosted URL for the user's KYC/amount entry, then
 * poll the transaction until it settles. Works against any anchor once you
 * have its `TRANSFER_SERVER_SEP0024` (from {@link fetchStellarToml}) and a
 * SEP-10 JWT (from {@link authenticate}).
 *
 * ```ts
 * const info = await getSep24Info({ transferServer });
 * const { url, id } = await startDeposit({ transferServer, jwt, assetCode: "USDC", account });
 * // open `url` for the user, then poll:
 * const tx = await getSep24Transaction({ transferServer, jwt, id });
 * ```
 */
import { SepError } from "./errors";
import type { Sep24Info, Sep24InteractiveResponse, Sep24Transaction } from "./types";

export interface Sep24RequestOptions {
  /** `TRANSFER_SERVER_SEP0024` from the anchor's `stellar.toml`. */
  transferServer: string;
  /** Custom fetch implementation. Default: global `fetch`. */
  fetch?: typeof fetch;
}

/** `GET {transferServer}/info` — which assets/rails the anchor supports. */
export async function getSep24Info(options: Sep24RequestOptions): Promise<Sep24Info> {
  const fetchImpl = resolveFetch(options.fetch);
  const url = `${options.transferServer}/info`;
  const response = await fetchImpl(url);
  if (!response.ok) throw new SepError("SEP-24", `GET ${url} returned ${response.status}`, response.status);
  return (await response.json()) as Sep24Info;
}

export interface StartInteractiveFlowOptions extends Sep24RequestOptions {
  /** SEP-10 JWT for the authenticated account. */
  jwt: string;
  /** Asset code to deposit/withdraw, e.g. `"USDC"`. */
  assetCode: string;
  /** The Stellar account ("G...") the flow is for. */
  account: string;
  /** Extra anchor-specific fields (amount, KYC hints...), passed through as-is. */
  extraFields?: Record<string, string>;
}

/**
 * `POST {transferServer}/transactions/deposit/interactive` — start a fiat →
 * Stellar deposit. Open the returned `url` for the user; the anchor handles
 * KYC and payment instructions from there.
 */
export async function startDeposit(options: StartInteractiveFlowOptions): Promise<Sep24InteractiveResponse> {
  return startInteractive(options, "deposit");
}

/**
 * `POST {transferServer}/transactions/withdraw/interactive` — start a
 * Stellar → fiat withdrawal. The user sends the asset on-chain once the
 * anchor confirms deposit instructions.
 */
export async function startWithdraw(options: StartInteractiveFlowOptions): Promise<Sep24InteractiveResponse> {
  return startInteractive(options, "withdraw");
}

async function startInteractive(
  options: StartInteractiveFlowOptions,
  kind: "deposit" | "withdraw",
): Promise<Sep24InteractiveResponse> {
  const fetchImpl = resolveFetch(options.fetch);
  const url = `${options.transferServer}/transactions/${kind}/interactive`;

  // Per SEP-24, the interactive endpoints take multipart/form-data (they may
  // carry KYC file uploads down the line).
  const form = new FormData();
  form.set("asset_code", options.assetCode);
  form.set("account", options.account);
  for (const [key, value] of Object.entries(options.extraFields ?? {})) form.set(key, value);

  const response = await fetchImpl(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${options.jwt}` },
    body: form,
  });

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new SepError("SEP-24", `POST ${url} returned ${response.status}: ${text}`, response.status);
  }

  const body = (await response.json()) as Sep24InteractiveResponse;
  if (!body.url || !body.id) {
    throw new SepError("SEP-24", "Interactive response missing `url` or `id`.");
  }
  return body;
}

export interface GetSep24TransactionOptions extends Sep24RequestOptions {
  jwt: string;
  /** The anchor's transaction id (from {@link startDeposit}/{@link startWithdraw}). */
  id: string;
}

/** `GET {transferServer}/transaction?id=...` — poll a transaction's status. */
export async function getSep24Transaction(options: GetSep24TransactionOptions): Promise<Sep24Transaction> {
  const fetchImpl = resolveFetch(options.fetch);
  const url = `${options.transferServer}/transaction?id=${encodeURIComponent(options.id)}`;
  const response = await fetchImpl(url, { headers: { Authorization: `Bearer ${options.jwt}` } });
  if (!response.ok) throw new SepError("SEP-24", `GET ${url} returned ${response.status}`, response.status);
  const body = (await response.json()) as { transaction: Sep24Transaction };
  return body.transaction;
}

export interface ListSep24TransactionsOptions extends Sep24RequestOptions {
  jwt: string;
  assetCode: string;
  /** Filter to transactions after this one, for pagination. */
  pagingId?: string;
}

/** `GET {transferServer}/transactions?asset_code=...` — list this account's transactions. */
export async function listSep24Transactions(options: ListSep24TransactionsOptions): Promise<Sep24Transaction[]> {
  const fetchImpl = resolveFetch(options.fetch);
  const params = new URLSearchParams({ asset_code: options.assetCode });
  if (options.pagingId) params.set("paging_id", options.pagingId);
  const url = `${options.transferServer}/transactions?${params}`;
  const response = await fetchImpl(url, { headers: { Authorization: `Bearer ${options.jwt}` } });
  if (!response.ok) throw new SepError("SEP-24", `GET ${url} returned ${response.status}`, response.status);
  const body = (await response.json()) as { transactions: Sep24Transaction[] };
  return body.transactions;
}

/** Terminal SEP-24 transaction statuses — polling can stop once one of these is reached. */
export const SEP24_TERMINAL_STATUSES = [
  "completed",
  "refunded",
  "expired",
  "no_market",
  "too_small",
  "too_large",
  "error",
] as const;

function resolveFetch(custom?: typeof fetch): typeof fetch {
  const fetchImpl = custom ?? globalThis.fetch?.bind(globalThis);
  if (typeof fetchImpl !== "function") throw new SepError("SEP-24", "No fetch implementation available.");
  return fetchImpl;
}
