/**
 * SEP-10 — Stellar Web Authentication.
 *
 * Proves control of a Stellar account to an anchor, in exchange for a JWT
 * used to authorize SEP-24/SEP-6/SEP-12 calls. The library never touches
 * private keys: you provide a {@link Sep10Signer} function that signs the
 * challenge transaction with whatever keypair/wallet you already use
 * (a server-side `Keypair` from `@stellar/stellar-sdk`, Freighter, an HSM...).
 *
 * ```ts
 * const jwt = await authenticate({
 *   webAuthEndpoint: toml.WEB_AUTH_ENDPOINT!,
 *   account: "GABC...",
 *   sign: (xdr, passphrase) => myKeypair.signChallenge(xdr, passphrase),
 * });
 * ```
 */
import { SepError } from "./errors";
import type { Sep10Challenge, Sep10Signer } from "./types";

export interface Sep10AuthenticateOptions {
  /** `WEB_AUTH_ENDPOINT` from the anchor's `stellar.toml` (see {@link fetchStellarToml}). */
  webAuthEndpoint: string;
  /** The Stellar account ("G...") authenticating. */
  account: string;
  /** Signs the challenge transaction. The library never touches private keys. */
  sign: Sep10Signer;
  /** Optional memo (only for accounts that require one, e.g. an exchange's shared account). */
  memo?: string;
  /** Domain of the client app, for anchors that require SEP-10 client attribution. */
  clientDomain?: string;
  /** Custom fetch implementation. Default: global `fetch`. */
  fetch?: typeof fetch;
}

/** `GET {webAuthEndpoint}?account=...` — request the challenge transaction. */
export async function getSep10Challenge(
  options: Omit<Sep10AuthenticateOptions, "sign">,
): Promise<Sep10Challenge> {
  const fetchImpl = options.fetch ?? globalThis.fetch?.bind(globalThis);
  if (typeof fetchImpl !== "function") throw new SepError("SEP-10", "No fetch implementation available.");

  const params = new URLSearchParams({ account: options.account });
  if (options.memo) params.set("memo", options.memo);
  if (options.clientDomain) params.set("client_domain", options.clientDomain);

  const url = `${options.webAuthEndpoint}?${params}`;
  const response = await fetchImpl(url);
  if (!response.ok) {
    throw new SepError("SEP-10", `GET ${url} returned ${response.status}`, response.status);
  }

  const body = (await response.json()) as { transaction?: string; network_passphrase?: string };
  if (!body.transaction || !body.network_passphrase) {
    throw new SepError("SEP-10", "Challenge response missing `transaction` or `network_passphrase`.");
  }
  return { transaction: body.transaction, networkPassphrase: body.network_passphrase };
}

/** `POST {webAuthEndpoint}` with the signed challenge — exchange it for a JWT. */
export async function submitSep10Challenge(
  webAuthEndpoint: string,
  signedTransaction: string,
  fetchImpl?: typeof fetch,
): Promise<string> {
  const doFetch = fetchImpl ?? globalThis.fetch?.bind(globalThis);
  if (typeof doFetch !== "function") throw new SepError("SEP-10", "No fetch implementation available.");

  const response = await doFetch(webAuthEndpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ transaction: signedTransaction }),
  });

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new SepError("SEP-10", `POST ${webAuthEndpoint} returned ${response.status}: ${text}`, response.status);
  }

  const body = (await response.json()) as { token?: string };
  if (!body.token) throw new SepError("SEP-10", "Authentication response missing `token`.");
  return body.token;
}

/** Full round trip: fetch the challenge, sign it, and exchange it for a JWT. */
export async function authenticate(options: Sep10AuthenticateOptions): Promise<string> {
  const challenge = await getSep10Challenge(options);
  const signed = await options.sign(challenge.transaction, challenge.networkPassphrase);
  return submitSep10Challenge(options.webAuthEndpoint, signed, options.fetch);
}
