/**
 * Full SEP-1 → SEP-10 → SEP-24 flow against a public reference anchor
 * (testanchor.stellar.org) — no credentials or account of your own needed:
 * a Stellar testnet wallet is generated and funded right here. Use it as a
 * template for connecting to ANY SEP-compatible anchor by just changing
 * `ANCHOR_DOMAIN`.
 *
 * Run: `npm run flow:sep` (or `ANCHOR_DOMAIN=some-other-anchor.com npm run flow:sep`).
 *
 * DESIGN (same as examples/etherfuse/full-flow.ts):
 * - SEP-1 (discovery), SEP-10 (auth), and SEP-24 (interactive deposit) each
 *   run in their own try/catch — if one fails, the error is logged and the
 *   flow continues (without a JWT, SEP-24 can't be attempted, so that step
 *   is skipped cleanly instead of failing ugly).
 * - SEP-24 is interactive ON PURPOSE: the API returns a URL for a human to
 *   complete KYC/amount entry in a browser — there's no way to automate
 *   that part (and it wouldn't make sense to). That's why the status check
 *   is a SINGLE attempt (`getSep24Transaction`), no polling; it stays
 *   "pending" until someone opens the URL, and that's expected.
 * - A summary of everything obtained is ALWAYS printed at the end.
 */

import "dotenv/config";
import { Keypair, Horizon, TransactionBuilder } from "@stellar/stellar-sdk";
import { CosmosClient, SEP24_TERMINAL_STATUSES } from "../../src/index";
import { isMainModule } from "../helpers/isMain";

// `CosmosClient` with no providers still gives you `.sep` — the SEP-1/10/24
// helpers bound in one place, without importing each loose function.
const { fetchStellarToml, authenticateSep10, getSep24Info, startDeposit, getSep24Transaction } = new CosmosClient({}).sep;
const stellarServer = new Horizon.Server("https://horizon-testnet.stellar.org");

export interface SepFlowSummary {
  account?: string;
  webAuthEndpoint?: string;
  transferServer?: string;
  jwt?: string;
  authError?: string;
  availableDeposits?: string[];
  assetCode?: string;
  interactiveUrl?: string;
  transactionId?: string;
  depositError?: string;
  status?: string;
  statusError?: string;
}

/**
 * Runs the full SEP-1 → SEP-10 → SEP-24 flow against `anchorDomain`
 * (default: `ANCHOR_DOMAIN` in `.env`, or the public reference anchor) and
 * returns the summary. Never throws — this flow needs no credentials at
 * all, so there's nothing to "skip".
 */
export async function runSepFlow(anchorDomain = process.env.ANCHOR_DOMAIN || "testanchor.stellar.org"): Promise<SepFlowSummary> {
  const summary: SepFlowSummary = {};
  try {
    // ── Throwaway wallet: generated and funded here, nothing to configure ──
    const keypair = Keypair.random();
    await stellarServer.friendbot(keypair.publicKey()).call();
    summary.account = keypair.publicKey();
    console.log(`✔ Stellar testnet account: ${keypair.publicKey()}`);

    // ── SEP-1: discover the anchor's endpoints ────────────────────────────
    const toml = await fetchStellarToml(anchorDomain);
    if (!toml.WEB_AUTH_ENDPOINT || !toml.TRANSFER_SERVER_SEP0024) {
      console.error(
        `✘ ${anchorDomain} doesn't publish WEB_AUTH_ENDPOINT/TRANSFER_SERVER_SEP0024 in its stellar.toml — can't continue.`,
      );
      return summary;
    }
    summary.webAuthEndpoint = toml.WEB_AUTH_ENDPOINT;
    summary.transferServer = toml.TRANSFER_SERVER_SEP0024;
    console.log(`✔ ${anchorDomain}'s stellar.toml: SEP-10 at ${toml.WEB_AUTH_ENDPOINT}, SEP-24 at ${toml.TRANSFER_SERVER_SEP0024}`);

    // ── SEP-10: prove we control the account, in exchange for a JWT ──────
    // The library never touches private keys: the "signer" here is ours,
    // signing with the keypair we generated above (not a real user's).
    let jwt: string;
    try {
      jwt = await authenticateSep10({
        webAuthEndpoint: toml.WEB_AUTH_ENDPOINT,
        account: keypair.publicKey(),
        sign: async (challengeXdr, networkPassphrase) => {
          const tx = TransactionBuilder.fromXDR(challengeXdr, networkPassphrase);
          tx.sign(keypair);
          return tx.toXDR();
        },
      });
      summary.jwt = `${jwt.slice(0, 16)}...`;
      console.log(`✔ SEP-10 OK, JWT: ${summary.jwt}`);
    } catch (error) {
      summary.authError = String(error instanceof Error ? error.message : error);
      console.error("✘ SEP-10 authentication failed — can't attempt SEP-24 without a JWT:", error);
      return summary;
    }

    // ── SEP-24: which assets this anchor accepts, and start a deposit ────
    try {
      const info = await getSep24Info({ transferServer: toml.TRANSFER_SERVER_SEP0024 });
      const enabled = Object.entries(info.deposit ?? {}).filter(([, a]) => a.enabled);
      summary.availableDeposits = enabled.map(([code]) => code);
      console.log(`✔ Enabled deposit assets: ${summary.availableDeposits.join(", ") || "none"}`);

      const assetCode = enabled[0]?.[0];
      if (!assetCode) {
        console.log("ℹ This anchor doesn't enable any deposit asset right now — skipping SEP-24.");
        return summary;
      }
      summary.assetCode = assetCode;

      const deposit = await startDeposit({
        transferServer: toml.TRANSFER_SERVER_SEP0024,
        jwt,
        assetCode,
        account: keypair.publicKey(),
      });
      summary.interactiveUrl = deposit.url;
      summary.transactionId = deposit.id;
      console.log(`✔ Interactive deposit started (${assetCode}): ${deposit.url}`);
      console.log("  Open that URL in a browser to complete KYC/amount entry — it's a human step, can't be automated.");

      // Status check — a SINGLE attempt, no polling: it'll stay "pending"
      // until someone opens the URL above, and that's expected.
      try {
        const tx = await getSep24Transaction({ transferServer: toml.TRANSFER_SERVER_SEP0024, jwt, id: deposit.id });
        const isTerminal = (SEP24_TERMINAL_STATUSES as readonly string[]).includes(tx.status);
        summary.status = isTerminal ? tx.status : "pending";
        console.log(`  Status: ${summary.status}${isTerminal ? "" : ` (actual: "${tx.status}")`}`);
      } catch (error) {
        summary.statusError = String(error instanceof Error ? error.message : error);
        summary.status = "pending";
        console.warn("  Could not check the status — left as \"pending\".", error);
      }
    } catch (error) {
      summary.depositError = String(error instanceof Error ? error.message : error);
      console.error("✘ Could not start the SEP-24 deposit:", error);
    }
  } catch (error) {
    console.error("\n✘ Unexpected error in the SEP flow:", error);
  }
  return summary;
}

export function printSepSummary(summary: SepFlowSummary, anchorDomain = process.env.ANCHOR_DOMAIN || "testanchor.stellar.org") {
  console.log("\n══ Final summary — SEP-1/10/24 (" + anchorDomain + ") ══════");
  console.log("Account:             ", summary.account ?? "n/a");
  console.log("WEB_AUTH_ENDPOINT:   ", summary.webAuthEndpoint ?? "n/a");
  console.log("TRANSFER_SERVER:     ", summary.transferServer ?? "n/a");
  console.log("JWT:                 ", summary.jwt ?? `n/a${summary.authError ? ` — error: ${summary.authError}` : ""}`);
  console.log("Enabled assets:      ", summary.availableDeposits?.join(", ") ?? "n/a");
  console.log(
    "Deposit started:     ",
    summary.transactionId ?? `n/a${summary.depositError ? ` — error: ${summary.depositError}` : ""}`,
    summary.assetCode ? `(${summary.assetCode})` : "",
  );
  if (summary.interactiveUrl) console.log("Interactive URL:     ", summary.interactiveUrl);
  console.log("Status:              ", summary.status ?? "n/a");
  console.log("═════════════════════════════════════════════════════════");
}

if (isMainModule(import.meta.url)) {
  runSepFlow()
    .then((summary) => printSepSummary(summary))
    .catch((error) => {
      console.error("\n✘ Unexpected error:", error);
    });
}
