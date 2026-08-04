/**
 * Full flow against the Etherfuse sandbox, for EVERY chain it supports
 * (Stellar, Solana, Base, Polygon, Monad):
 *
 *   organization → PIX bank account (BRL, once)
 *   → per chain: fresh wallet (+ automatic trustline on Stellar)
 *     → quote → order → PIX QR → simulate fiat deposit → status check
 *
 * Setup: create a `.env` at the repo root with ETHERFUSE_API_KEY=your_sandbox_key
 * and run `npm run flow`. Nothing else is required — each chain builds its
 * own throwaway wallet on its own, no per-chain configuration needed.
 *
 * IMPORTANT about the target asset: Etherfuse's onramp delivers one of ITS
 * tokenized stablebonds (CETES for MXN, TESOURO for BRL) — not raw USDC.
 * Each stablebond's mint/identifier is NOT hardcoded: it's resolved on every
 * run against `client.lookup.stablebonds()` (public, no API key needed),
 * picking the asset with the highest `totalSupply` for that currency+chain.
 * A fixed mint breaks over time — we've seen it break in practice (the
 * sandbox catalog rotates which bond is active).
 *
 * TRUSTLINES: on Stellar, receiving a non-native asset (anything but XLM)
 * requires the receiving account to open a "trustline" for that asset — and
 * only the account owner can sign that (nobody can open it on your behalf).
 * That's why this script generates its OWN Stellar keypair per run, funds it
 * on testnet via Friendbot, and opens the trustline itself before requesting
 * the order. It's the only chain that needs this: on Solana, Etherfuse
 * deploys the associated token account on its own (nothing for us to do);
 * on the EVM chains (Base/Polygon/Monad) any address can receive an ERC-20
 * with no prior setup.
 *
 * DESIGN: nothing blocks the flow.
 * - Each chain runs in its own try/catch — if one fails, the error is
 *   logged and the script moves on to the next chain (the whole script
 *   never stops).
 * - After simulating the fiat deposit, it does NOT wait in a long poll for
 *   the order to reach "completed" (that can take minutes in the sandbox
 *   and would stall the flow). It does ONE quick check, and anything short
 *   of a terminal state is logged as "pending" — it can be checked later
 *   via the `statusPage` that gets printed.
 * - At the end, a table with everything created per chain is ALWAYS
 *   printed — ids, wallets, trustline tx, quotes, orders, PIX codes,
 *   statuses — even if some chain failed.
 */

import "dotenv/config";
import { randomBytes, generateKeyPairSync } from "node:crypto";
import { keccak256 } from "js-sha3";
import { Keypair, Horizon, TransactionBuilder, Networks, Operation, Asset as StellarAsset, BASE_FEE } from "@stellar/stellar-sdk";
import { CosmosClient, EtherfuseAPIError, Pix, Chain, FiatCurrency, Asset, type EtherfuseClient, type Quote, type OrderReceipt } from "../src/index";
import { isMainModule } from "./helpers/isMain";

/** Currency this flow supports (Etherfuse only settles BRL/MXN today). */
type EtherfuseFiat = typeof FiatCurrency.BRL | typeof FiatCurrency.MXN;

/** Every chain Etherfuse supports — the flow runs one after another for each. */
const CHAINS: readonly Chain[] = [Chain.Stellar, Chain.Solana, Chain.Base, Chain.Polygon, Chain.Monad];

/** Etherfuse stablebond symbol each currency settles into (logging only). */
const STABLEBOND_FOR: Record<EtherfuseFiat, Asset> = {
  [FiatCurrency.BRL]: Asset.TESOURO,
  [FiatCurrency.MXN]: Asset.CETES,
};
// Last resort if `client.lookup.stablebonds()` fails (network down, etc.) or
// returns nothing usable for this currency+chain. Can go stale over time —
// that's why it's a fallback, not the primary source.
const FALLBACK_TARGET_ASSET: Record<EtherfuseFiat, Partial<Record<Chain, string>>> = {
  [FiatCurrency.BRL]: {
    [Chain.Solana]: "EyvBnTz9QDVc2oaBVeu77kndynmD5njrWjZghYh5xpUk", // TESOURO, may have rotated
    [Chain.Stellar]: "TESOURO-GC3CW7EDYRTWQ635VDIGY6S4ZUF5L6TQ7AA4MWS7LEQDBLUSZXV7UPS4",
  },
  [FiatCurrency.MXN]: {
    [Chain.Solana]: "AvvetPGuuB5FD5m86fpw3LtDKyQoUFT1mG9WarNQLW4q", // CETES, may have rotated
    [Chain.Stellar]: "CETES-GC3CW7EDYRTWQ635VDIGY6S4ZUF5L6TQ7AA4MWS7LEQDBLUSZXV7UPS4",
  },
};

// Built only inside `runEtherfuseFlow()`, and only if an API key is present —
// that way this module can be imported (e.g. from all-flows.ts) without
// needing ETHERFUSE_API_KEY set. Everything comes from ONE `CosmosClient`
// (`cosmos.etherfuse`), not a standalone `EtherfuseClient`.
let cosmos: CosmosClient;
let client: EtherfuseClient;
const stellarServer = new Horizon.Server("https://horizon-testnet.stellar.org");

// ---------------------------------------------------------------------------
// Throwaway address generation, one per chain
// ---------------------------------------------------------------------------

const BASE58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
function base58Encode(bytes: Uint8Array): string {
  let digits = [0];
  for (const byte of bytes) {
    let carry = byte;
    for (let i = 0; i < digits.length; i++) {
      carry += digits[i]! << 8;
      digits[i] = carry % 58;
      carry = (carry / 58) | 0;
    }
    while (carry > 0) {
      digits.push(carry % 58);
      carry = (carry / 58) | 0;
    }
  }
  let leadingZeros = 0;
  for (const byte of bytes) {
    if (byte === 0) leadingZeros++;
    else break;
  }
  return BASE58_ALPHABET[0]!.repeat(leadingZeros) + digits.reverse().map((d) => BASE58_ALPHABET[d]).join("");
}

/** Random ed25519 public key, encoded as a Solana address (base58). We never sign anything on Solana here — Etherfuse deploys the token account on its own. */
function generateSolanaAddress(): string {
  const { publicKey } = generateKeyPairSync("ed25519");
  const der = publicKey.export({ type: "spki", format: "der" }) as Buffer;
  return base58Encode(der.subarray(der.length - 32));
}

/** EIP-55: mixed casing derived from the Keccak-256 hash of the lowercase address — Etherfuse requires this, it's not optional. */
function toChecksumAddress(address: string): string {
  const lower = address.toLowerCase().replace(/^0x/, "");
  const hash = keccak256(lower);
  let result = "0x";
  for (let i = 0; i < lower.length; i++) {
    result += parseInt(hash[i]!, 16) >= 8 ? lower[i]!.toUpperCase() : lower[i];
  }
  return result;
}

/** Random EVM address (0x + 40 hex, EIP-55 checksummed). We never sign anything here — any EVM address can receive an ERC-20 with no prior setup. */
function generateEvmAddress(): string {
  return toChecksumAddress(randomBytes(20).toString("hex"));
}

// ---------------------------------------------------------------------------
// Stablebonds: resolve the target asset live (never hardcoded)
// ---------------------------------------------------------------------------

interface StablebondChainEntry {
  blockchain: string;
  tokenIdentifier: string;
  totalSupply?: string;
}
interface StablebondEntry {
  symbol: string;
  bondCurrency: string;
  blockchains: StablebondChainEntry[];
}
interface TargetAssetCandidate {
  asset: string;
  symbol?: string;
}

/**
 * Active stablebond candidates for `cur` on `chain`, from highest to lowest
 * `totalSupply` — queried live against the public catalog. Several bonds can
 * share a currency (e.g. CETES + "Cetes2"); if the best candidate fails at
 * the API (rotated/depleted), {@link createQuoteForCurrency} tries the next
 * one. `.env` can force a value via `ETHERFUSE_TARGET_ASSET`.
 */
async function resolveTargetAssetCandidates(cur: EtherfuseFiat, chain: Chain): Promise<TargetAssetCandidate[]> {
  const override = process.env.ETHERFUSE_TARGET_ASSET;
  if (override) return [{ asset: override }];

  try {
    const catalog = (await client.lookup.stablebonds()) as { stablebonds?: StablebondEntry[] };
    const candidates = (catalog.stablebonds ?? [])
      .filter((bond) => bond.bondCurrency === cur)
      .flatMap((bond) =>
        bond.blockchains
          .filter((entry) => entry.blockchain === chain)
          .map((entry) => ({ symbol: bond.symbol, asset: entry.tokenIdentifier, supply: Number(entry.totalSupply ?? 0) })),
      )
      .filter((candidate) => candidate.supply > 0)
      .sort((a, b) => b.supply - a.supply)
      .map(({ symbol, asset }) => ({ symbol, asset }));

    if (candidates.length) return candidates;
    console.warn(`⚠ No active stablebond for ${cur} on ${chain} — using the fixed fallback.`);
  } catch (error) {
    console.warn(`⚠ Could not query client.lookup.stablebonds() — using the fixed fallback:`, error);
  }
  const fallback = FALLBACK_TARGET_ASSET[cur][chain];
  return fallback ? [{ asset: fallback, symbol: STABLEBOND_FOR[cur] }] : [];
}

/** `NonStableAsset` is the specific error for a rotated/depleted mint — worth trying the next candidate. */
function isNonStableAssetError(error: unknown): boolean {
  if (!(error instanceof EtherfuseAPIError) || error.status !== 400) return false;
  const body = error.body as { type?: string } | undefined;
  return body?.type === "NonStableAsset";
}

/** Requests the quote, trying each candidate from {@link resolveTargetAssetCandidates} until one works. */
async function createQuoteForCurrency(
  orgId: string,
  cur: EtherfuseFiat,
  chain: Chain,
): Promise<{ quote: Quote; targetAsset: string; targetSymbol?: string }> {
  const candidates = await resolveTargetAssetCandidates(cur, chain);
  if (!candidates.length) throw new Error(`No target-asset candidates for ${cur} on ${chain}.`);

  let lastError: unknown;
  for (const candidate of candidates) {
    try {
      const quote = await client.quotes.create({
        customerId: orgId,
        blockchain: chain,
        sourceAmount: "500",
        quoteAssets: { type: "onramp", sourceAsset: cur, targetAsset: candidate.asset },
      });
      return { quote, targetAsset: candidate.asset, targetSymbol: candidate.symbol };
    } catch (error) {
      lastError = error;
      if (!isNonStableAssetError(error)) throw error;
      console.warn(`⚠ ${candidate.asset} rejected (Non-stable) — trying the next candidate...`);
    }
  }
  throw lastError;
}

// ---------------------------------------------------------------------------
// Automatic trustline (Stellar only)
// ---------------------------------------------------------------------------

/** `"CODE-ISSUER"` (Etherfuse/Stellar format) → `{ code, issuer }` for the SDK. */
function parseStellarAsset(identifier: string): { code: string; issuer: string } {
  const sep = identifier.indexOf("-");
  if (sep === -1) throw new Error(`Could not parse code/issuer from "${identifier}" (expected "CODE-ISSUER").`);
  return { code: identifier.slice(0, sep), issuer: identifier.slice(sep + 1) };
}

/** Opens (or confirms) the trustline for `targetAsset` on `keypair`'s account, funded via Friendbot. Returns the tx hash. */
async function ensureStellarTrustline(keypair: Keypair, targetAsset: string): Promise<string> {
  const { code, issuer } = parseStellarAsset(targetAsset);
  const account = await stellarServer.loadAccount(keypair.publicKey());
  const tx = new TransactionBuilder(account, { fee: BASE_FEE, networkPassphrase: Networks.TESTNET })
    .addOperation(Operation.changeTrust({ asset: new StellarAsset(code, issuer) }))
    .setTimeout(30)
    .build();
  tx.sign(keypair);
  const result = await stellarServer.submitTransaction(tx);
  return result.hash;
}

// ---------------------------------------------------------------------------
// Per-chain result, for the final summary
// ---------------------------------------------------------------------------

interface ChainResult {
  chain: Chain;
  walletAddress?: string;
  walletError?: string;
  trustlineTx?: string;
  trustlineError?: string;
  quoteId?: string;
  quoteDestinationAmount?: string;
  quoteTargetAsset?: string;
  quoteTargetSymbol?: string;
  quoteError?: string;
  orderId?: string;
  orderError?: string;
  depositMethod?: string;
  depositPixCode?: string;
  fiatReceivedSimulated?: boolean;
  fiatReceivedError?: string;
  /** "pending" when the single, non-blocking check didn't reach a terminal state. */
  status?: string;
  statusPage?: string;
}

let chainResults: ChainResult[] = [];

async function runChain(orgId: string, currency: EtherfuseFiat, bankAccountId: string | undefined, chain: Chain) {
  const result: ChainResult = { chain };
  chainResults.push(result);
  console.log(`\n── Chain: ${chain} ─────────────────────────────────────────`);

  // ── Throwaway wallet for this chain ─────────────────────────────────────
  let publicKey: string;
  let stellarKeypair: Keypair | undefined;
  try {
    if (chain === Chain.Stellar) {
      stellarKeypair = Keypair.random();
      await stellarServer.friendbot(stellarKeypair.publicKey()).call();
      publicKey = stellarKeypair.publicKey();
    } else if (chain === Chain.Solana) {
      publicKey = generateSolanaAddress();
    } else {
      publicKey = generateEvmAddress();
    }
    result.walletAddress = publicKey;
    console.log(`✔ Wallet: ${publicKey}`);
  } catch (error) {
    result.walletError = String(error instanceof Error ? error.message : error);
    console.error(`✘ Could not prepare a wallet for ${chain} — moving on to the next chain:`, error);
    return;
  }

  // Etherfuse requires the wallet to be registered before it's used in an
  // order ("Wallet not found or not authorized" if this step is skipped).
  try {
    const wallet = await client.wallets.register({ publicKey, blockchain: chain });
    console.log(`✔ Wallet registered: ${wallet.id} (kyc: ${wallet.raw.kycStatus ?? "n/a"})`);
  } catch (error) {
    result.walletError = String(error instanceof Error ? error.message : error);
    console.error(`✘ Could not register the wallet for ${chain} — the order will likely fail:`, error);
  }

  // ── Quote (resolves the active stablebond, expires in 2 minutes) ────────
  let quoteResult: Awaited<ReturnType<typeof createQuoteForCurrency>>;
  try {
    quoteResult = await createQuoteForCurrency(orgId, currency, chain);
    result.quoteId = quoteResult.quote.id;
    result.quoteDestinationAmount = quoteResult.quote.destinationAmount;
    result.quoteTargetAsset = quoteResult.targetAsset;
    result.quoteTargetSymbol = quoteResult.targetSymbol;
    console.log(
      `✔ Quote ${quoteResult.quote.id}: 500 ${currency} → ${quoteResult.quote.destinationAmount} ` +
        `${quoteResult.targetSymbol ?? ""} (rate ${quoteResult.quote.exchangeRate}, asset ${quoteResult.targetAsset})`,
    );
  } catch (error) {
    result.quoteError = String(error instanceof Error ? error.message : error);
    console.error(`✘ Could not get a quote for ${chain} — moving on to the next chain:`, error);
    return;
  }

  // ── Automatic trustline (Stellar only) ───────────────────────────────────
  if (chain === Chain.Stellar && stellarKeypair) {
    try {
      result.trustlineTx = await ensureStellarTrustline(stellarKeypair, quoteResult.targetAsset);
      console.log(`✔ Trustline opened: tx ${result.trustlineTx}`);
    } catch (error) {
      result.trustlineError = String(error instanceof Error ? error.message : error);
      console.error(`✘ Could not open the trustline for ${chain} — the order might still fail:`, error);
    }
  }

  // ── Order ─────────────────────────────────────────────────────────────────
  if (!bankAccountId) {
    console.log(`ℹ Skipping the order for ${chain}: no bank account.`);
    return;
  }
  let receipt: OrderReceipt;
  try {
    receipt = await quoteResult.quote.createOrder({ bankAccountId, publicKey, blockchain: chain });
    result.orderId = receipt.orderId;
    console.log(`✔ Order created: ${receipt.orderId}`);
  } catch (error) {
    result.orderError = String(error instanceof Error ? error.message : error);
    console.error(`✘ Could not create the order for ${chain} — moving on to the next chain:`, error);
    return;
  }

  // ── Payment instructions / PIX QR ───────────────────────────────────────
  if (receipt.deposit?.method === "pix") {
    result.depositMethod = "pix";
    result.depositPixCode = receipt.deposit.pixCode;
    console.log(`✔ PIX code (copia e cola): ${receipt.deposit.pixCode}`);
  } else if (receipt.deposit?.method === "spei") {
    result.depositMethod = "spei";
    result.depositPixCode = receipt.deposit.clabe;
    console.log(`✔ SPEI deposit:`, receipt.deposit);
  } else if (currency === FiatCurrency.BRL) {
    // The sandbox doesn't return a BR Code for this particular order; we
    // generate one locally with the library's PIX engine, same amount:
    const demo = Pix.create({
      pixKey: "sandbox@etherfuse.com.br",
      merchantName: "Etherfuse Sandbox",
      merchantCity: "Sao Paulo",
      amount: "500",
      txid: receipt.orderId.replace(/-/g, "").slice(0, 25),
    });
    result.depositMethod = "pix (local demo)";
    result.depositPixCode = demo.toString();
    console.log(`ℹ Copia e cola (local demo): ${demo.toString()}`);
  }

  // ── Simulate the fiat arriving — non-blocking on failure ────────────────
  try {
    await client.sandbox.fiatReceived(receipt.orderId);
    result.fiatReceivedSimulated = true;
    console.log("✔ Fiat deposit simulated");
  } catch (error) {
    result.fiatReceivedError = String(error instanceof Error ? error.message : error);
    console.error(`✘ Could not simulate the fiat deposit for ${chain} — continuing anyway:`, error);
  }

  // ── ONE status check, no long poll: anything non-terminal stays "pending" ─
  try {
    const current = await receipt.fetch();
    result.status = current.isTerminal ? current.status : "pending";
    result.statusPage = current.statusPage;
    console.log(`  Status: ${result.status}${current.isTerminal ? "" : ` (actual: "${current.status}")`}`);
    console.log(`  Status page: ${current.statusPage ?? "n/a"}`);
  } catch (error) {
    result.status = "pending";
    console.warn(`  Could not check the status for ${chain} — left as "pending".`, error);
  }
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

/**
 * Runs the full Etherfuse flow (all 5 chains) and returns the per-chain
 * detail. `null` if `ETHERFUSE_API_KEY` is missing — doesn't throw, so
 * `all-flows.ts` can skip this section cleanly and continue with the rest.
 */
export async function runEtherfuseFlow(): Promise<ChainResult[] | null> {
  const API_KEY = process.env.ETHERFUSE_API_KEY;
  if (!API_KEY) {
    console.error("⚠ Missing ETHERFUSE_API_KEY (set it in .env) — skipping the Etherfuse flow.");
    return null;
  }
  cosmos = new CosmosClient({ etherfuse: { apiKey: API_KEY, environment: "sandbox" } });
  client = cosmos.etherfuse!;
  client.on("debug", (m) => process.env.DEBUG && console.log(m));
  chainResults = [];

  // ── 1. Organization ─────────────────────────────────────────────────────
  const me = await client.customers.me();
  console.log(`✔ Organization: ${me.id} (${me.displayName ?? "unnamed"})`);

  // ── 2. Bank account: reuse a compliant one or create a PIX one ─────────
  // The sandbox only allows ONE BRL account per organization. It's shared
  // across every chain — fiat only comes in once per currency.
  let currency: EtherfuseFiat = FiatCurrency.BRL;
  let bankAccountId: string | undefined;
  try {
    const accounts = await client.bankAccounts.listForCustomer(me.id);
    const usable = (cur: string) =>
      accounts.find((a) => a.currency?.toUpperCase() === cur && a.compliant && !a.raw.deletedAt);

    const existing = usable(FiatCurrency.BRL) ?? usable(FiatCurrency.MXN);
    if (existing) {
      currency = existing.isPix ? FiatCurrency.BRL : FiatCurrency.MXN;
      bankAccountId = existing.id;
      console.log(`✔ Reusing existing ${currency} account: ${existing.id}`);
    } else {
      try {
        const pix = await client.bankAccounts.createPixPersonal(me.id, {
          firstName: "João",
          lastName: "Silva",
          cpf: "12345678909",
          pixKey: "joao.sandbox@exemplo.com.br",
          pixKeyType: "email",
        });
        bankAccountId = pix.id;
        console.log(`✔ PIX account created: ${pix.id} (compliant: ${pix.compliant})`);
      } catch (error) {
        if (!(error instanceof EtherfuseAPIError)) throw error;
        console.warn(`⚠ PIX not available (${error.message}) — trying CLABE/MXN instead...`);
        currency = FiatCurrency.MXN;
        const clabe = await client.bankAccounts.createClabePersonal(me.id, {
          firstName: "Ana",
          paternalLastName: "García",
          maternalLastName: "López",
          birthDate: "19900515",
          birthCountryIsoCode: "MX",
          curp: "GALA900515MDFRPN08",
          rfc: "XEXX010101000", // sandbox's magic RFC: auto-approves
          clabe: "012180015700000000", // sample non-STP CLABE (the sandbox rejects 646)
        });
        bankAccountId = clabe.id;
        console.log(`✔ CLABE account created: ${clabe.id}`);
      }
    }
  } catch (error) {
    console.error("✘ Could not fetch/create a bank account — continuing without one:", error);
  }

  // ── 3. One full run per chain ───────────────────────────────────────────
  for (const chain of CHAINS) {
    await runChain(me.id, currency, bankAccountId, chain);
  }

  cosmos.destroy();
  return chainResults;
}

export function printEtherfuseSummary(results: ChainResult[]) {
  console.log("\n══ Final summary — Etherfuse (all chains) ══════════════════");
  for (const r of results) {
    console.log(`\n${r.chain}:`);
    console.log("  Wallet:            ", r.walletAddress ?? `n/a${r.walletError ? ` — error: ${r.walletError}` : ""}`);
    if (r.trustlineTx || r.trustlineError) {
      console.log("  Trustline:         ", r.trustlineTx ?? `error: ${r.trustlineError}`);
    }
    console.log(
      "  Quote:             ",
      r.quoteId ?? `n/a${r.quoteError ? ` — error: ${r.quoteError}` : ""}`,
      r.quoteDestinationAmount ? `(→ ${r.quoteDestinationAmount} ${r.quoteTargetSymbol ?? ""}, asset ${r.quoteTargetAsset})` : "",
    );
    console.log("  Order:             ", r.orderId ?? `n/a${r.orderError ? ` — error: ${r.orderError}` : ""}`);
    if (r.depositMethod) console.log("  Deposit:           ", r.depositMethod, r.depositPixCode ?? "");
    console.log(
      "  Deposit simulated: ",
      r.fiatReceivedSimulated ? "yes" : `no${r.fiatReceivedError ? ` — error: ${r.fiatReceivedError}` : ""}`,
    );
    console.log("  Status:            ", r.status ?? "n/a");
    console.log("  Status page:       ", r.statusPage ?? "n/a");
  }
  console.log("\n═════════════════════════════════════════════════════════");
}

if (isMainModule(import.meta.url)) {
  runEtherfuseFlow()
    .then((results) => {
      if (results) printEtherfuseSummary(results);
    })
    .catch((error) => {
      // Safety net: each chain already catches its own errors, this shouldn't fire.
      console.error("\n✘ Unexpected error:", error);
    });
}
