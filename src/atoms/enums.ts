/**
 * Atom: the library's single standard for chain/asset/currency/country
 * identifiers. Every provider and client imports these instead of typing
 * raw string literals, so `Chain.Stellar` and `"Stellar"` (or `"stellar "`,
 * or `"stellar"` typo'd as `"steller"`) can never silently diverge — a typo
 * becomes a compile error instead of a 404 from a provider API.
 *
 * Each export is a frozen const object AND, under the same name, a union
 * type of its values (`typeof Chain[keyof typeof Chain]`) — a well-known
 * TypeScript pattern that lets `Chain` work both as a namespace of values
 * (`Chain.Stellar`) and as a type annotation (`chain: Chain`).
 *
 * These are plain string enums, not opaque/branded types: a `Chain` IS the
 * string `"stellar"` at runtime, so existing API calls that expect that
 * exact string keep working unchanged — this only adds a typed front door,
 * it doesn't change what goes over the wire.
 */

// ---------------------------------------------------------------------------
// Chain — blockchains every provider/client in this library can target.
// ---------------------------------------------------------------------------

export const Chain = {
  Stellar: "stellar",
  Solana: "solana",
  Base: "base",
  Polygon: "polygon",
  Monad: "monad",
} as const;

export type Chain = (typeof Chain)[keyof typeof Chain];

// ---------------------------------------------------------------------------
// Asset — crypto asset symbols. Stablebonds (CETES, TESOURO, CARN, JOGO) are
// Etherfuse's own tokenized products; their per-chain mint/issuer addresses
// are NEVER hardcoded here — resolve them at runtime from
// `client.lookup.stablebonds()` or `client.assets.list()`, per Etherfuse's
// own guidance. This enum only standardizes the symbol, not the address.
// ---------------------------------------------------------------------------

export const Asset = {
  USDC: "USDC",
  USDT: "USDT",
  DAI: "DAI",
  BTC: "BTC",
  ETH: "ETH",
  SOL: "SOL",
  XLM: "XLM",
  /** Etherfuse stablebond, MXN-denominated. */
  CETES: "CETES",
  /** Etherfuse stablebond, BRL-denominated. */
  TESOURO: "TESOURO",
  /** Etherfuse stablebond, BRL-denominated. */
  CARN: "CARN",
  /** Etherfuse stablebond, MXN-denominated. Catalog spells it "JoGo". */
  JOGO: "JoGo",
  EURO: "EURO",
} as const;

export type Asset = (typeof Asset)[keyof typeof Asset];

// ---------------------------------------------------------------------------
// FiatCurrency — ISO 4217 codes for every fiat rail this library speaks
// (Mercado Pago's 7 markets; Etherfuse currently only settles BRL/MXN).
// ---------------------------------------------------------------------------

export const FiatCurrency = {
  ARS: "ARS",
  BRL: "BRL",
  MXN: "MXN",
  CLP: "CLP",
  COP: "COP",
  PEN: "PEN",
  UYU: "UYU",
} as const;

export type FiatCurrency = (typeof FiatCurrency)[keyof typeof FiatCurrency];

// ---------------------------------------------------------------------------
// Country — ISO 3166-1 alpha-2 codes for the regions a payment provider can
// collect in (parallels FiatCurrency 1:1 for the markets above).
// ---------------------------------------------------------------------------

export const Country = {
  AR: "AR",
  BR: "BR",
  MX: "MX",
  CL: "CL",
  CO: "CO",
  PE: "PE",
  UY: "UY",
} as const;

export type Country = (typeof Country)[keyof typeof Country];
