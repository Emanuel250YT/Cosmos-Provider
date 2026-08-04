/**
 * SEP-1 — Stellar Info File.
 *
 * Fetches and parses `https://{homeDomain}/.well-known/stellar.toml`, the
 * anchor discovery document that points at every other SEP endpoint
 * (`WEB_AUTH_ENDPOINT` for SEP-10, `TRANSFER_SERVER_SEP0024` for SEP-24...).
 * This is always the first call against a new, unfamiliar anchor.
 */
import { SepError } from "./errors";
import { parseToml } from "./toml";
import type { StellarToml } from "./types";

export interface FetchStellarTomlOptions {
  /** Custom fetch implementation. Default: global `fetch`. */
  fetch?: typeof fetch;
}

/**
 * Fetch and parse the `stellar.toml` for `homeDomain` (a bare domain, no
 * protocol/path — e.g. `"testanchor.stellar.org"`).
 */
export async function fetchStellarToml(
  homeDomain: string,
  options?: FetchStellarTomlOptions,
): Promise<StellarToml> {
  const fetchImpl = options?.fetch ?? globalThis.fetch?.bind(globalThis);
  if (typeof fetchImpl !== "function") {
    throw new SepError("SEP-1", "No fetch implementation available.");
  }

  const url = `https://${homeDomain}/.well-known/stellar.toml`;
  let response: Response;
  try {
    response = await fetchImpl(url);
  } catch (cause) {
    throw new SepError("SEP-1", `Network error fetching ${url}`, undefined, { cause });
  }

  if (!response.ok) {
    throw new SepError("SEP-1", `GET ${url} returned ${response.status}`, response.status);
  }

  const text = await response.text();
  return parseToml(text) as StellarToml;
}
