/**
 * Full flow against the real Koywe sandbox: payment-rail discovery →
 * on-ramp quote (ARS → USDC on Stellar) → order with a real Stellar address
 * (generated and funded right here) → deposit instructions → non-blocking
 * status check → a quick look at the off-ramp side (bank account + quote)
 * and delegated KYC.
 *
 * Setup: `KOYWE_CLIENT_ID` / `KOYWE_SECRET` in `.env` (sandbox:
 * https://api-sandbox.koywe.com, request them at https://docs-crypto.koywe.com).
 * Run `npm run flow:koywe`. Without credentials, the script warns and exits
 * — there's nothing else to show without them.
 *
 * DESIGN (same as examples/full-flow.ts):
 * - Each section (on-ramp, off-ramp, KYC) runs in its own try/catch: if one
 *   fails (e.g. the sandbox doesn't have the test bank account number we
 *   tried), the error is logged and the next section still runs — the
 *   whole script never stops.
 * - There's no way to simulate the money actually arriving (unlike the
 *   Etherfuse sandbox) — that's why the status check is a SINGLE attempt
 *   (`getOrder`), no polling; anything short of terminal is logged as
 *   "pending".
 * - A summary of everything created is ALWAYS printed at the end.
 */

import "dotenv/config";
import { Keypair, Horizon } from "@stellar/stellar-sdk";
import { CosmosClient, KoyweError, type KoyweClient } from "../src/index";
import { isMainModule } from "./helpers/isMain";

const DEMO_EMAIL = "sandbox-demo@example.com";
const stellarServer = new Horizon.Server("https://horizon-testnet.stellar.org");

export interface KoyweFlowSummary {
  paymentProviders?: string[];
  onRampQuoteId?: string;
  onRampDestination?: string;
  onRampError?: string;
  stellarAddress?: string;
  orderId?: string;
  orderError?: string;
  depositCvu?: string;
  depositAlias?: string;
  interactiveUrl?: string;
  orderStatus?: string;
  bankAccountId?: string;
  bankAccountError?: string;
  offRampQuoteId?: string;
  offRampError?: string;
  kycStatus?: string;
  kycError?: string;
}

async function runOnRamp(koywe: KoyweClient, summary: KoyweFlowSummary) {
  console.log("\n── On-ramp: ARS → USDC (Stellar) ───────────────────────────");
  let paymentMethodId: string | undefined;
  try {
    const providers = await koywe.getPaymentProviders("ARS");
    summary.paymentProviders = providers.map((p) => `${p.label} (${p.id})`);
    console.log(`✔ Available rails for ARS: ${providers.map((p) => p.label).join(", ") || "none"}`);
    paymentMethodId = providers[0]?.id;
  } catch (error) {
    console.error("✘ Could not list payment providers — continuing without a specific one:", error);
  }

  let quoteId: string;
  try {
    const quote = await koywe.getQuote({ ramp: "onramp", fiatCurrency: "ARS", amount: "10000", paymentMethodId });
    quoteId = quote.id;
    summary.onRampQuoteId = quote.id;
    summary.onRampDestination = `${quote.destinationAmount} ${quote.targetAsset}`;
    console.log(`✔ Quote ${quote.id}: ${quote.sourceAmount} ARS → ${quote.destinationAmount} ${quote.targetAsset}`);
  } catch (error) {
    summary.onRampError = String(error instanceof Error ? error.message : error);
    console.error("✘ Could not get an on-ramp quote — continuing with the rest of the flow:", error);
    return;
  }

  // Real, funded Stellar address, generated here — Koywe delivers USDC
  // straight to this account (unlike Etherfuse, no trustline is needed
  // here: most wallets open USDC on Stellar by default, and this order
  // never settles without a real payment anyway).
  let stellarAddress: string;
  try {
    const keypair = Keypair.random();
    await stellarServer.friendbot(keypair.publicKey()).call();
    stellarAddress = keypair.publicKey();
    summary.stellarAddress = stellarAddress;
    console.log(`✔ Destination Stellar address: ${stellarAddress}`);
  } catch (error) {
    console.error("✘ Could not generate/fund a Stellar address — continuing with the rest of the flow:", error);
    return;
  }

  try {
    const order = await koywe.createOnRampOrder({ quoteId, stellarAddress, email: DEMO_EMAIL });
    summary.orderId = order.id;
    summary.depositCvu = order.deposit?.cvu;
    summary.depositAlias = order.deposit?.alias;
    summary.interactiveUrl = order.interactiveUrl;
    console.log(`✔ Order created: ${order.id} (status ${order.status})`);
    if (order.deposit) console.log(`  Deposit: CVU ${order.deposit.cvu ?? "n/a"} / alias ${order.deposit.alias ?? "n/a"}`);
    if (order.interactiveUrl) console.log(`  Hosted checkout: ${order.interactiveUrl}`);

    // Status check — a SINGLE attempt, no polling: without a real transfer
    // it can't get past "WAITING", which is expected here.
    try {
      const current = await koywe.getOrder(order.id, DEMO_EMAIL);
      summary.orderStatus = current?.status ?? "pending";
      console.log(`  Status: ${summary.orderStatus}`);
    } catch (error) {
      summary.orderStatus = "pending";
      console.warn("  Could not check the status — left as \"pending\".", error);
    }
  } catch (error) {
    summary.orderError = String(error instanceof Error ? error.message : error);
    console.error("✘ Could not create the on-ramp order:", error);
  }
}

async function runOffRamp(koywe: KoyweClient, summary: KoyweFlowSummary) {
  console.log("\n── Off-ramp: register bank account + quote ─────────────────");
  try {
    const account = await koywe.createBankAccount({
      email: DEMO_EMAIL,
      accountNumber: "0000053600000017871248", // sample account — the sandbox requires one of its validated numbers
      countryCode: "AR",
      currencySymbol: "ARS",
    });
    summary.bankAccountId = account.id;
    console.log(`✔ Bank account registered: ${account.id}`);
  } catch (error) {
    summary.bankAccountError = String(error instanceof Error ? error.message : error);
    console.error(
      "✘ Could not register the bank account (the sandbox requires a validated test account number for the country) — continuing anyway:",
      error,
    );
  }

  try {
    const quote = await koywe.getQuote({ ramp: "offramp", fiatCurrency: "ARS", amount: "100" });
    summary.offRampQuoteId = quote.id;
    console.log(`✔ Off-ramp quote ${quote.id}: ${quote.sourceAmount} USDC → ${quote.destinationAmount} ARS`);
  } catch (error) {
    summary.offRampError = String(error instanceof Error ? error.message : error);
    console.error("✘ Could not get an off-ramp quote:", error);
  }
}

async function runKyc(koywe: KoyweClient, summary: KoyweFlowSummary) {
  console.log("\n── Delegated KYC ─────────────────────────────────────────────");
  try {
    const check = await koywe.checkAccount(DEMO_EMAIL);
    summary.kycStatus = check.accountStatus;
    console.log(`✔ Account status for ${DEMO_EMAIL}: ${check.accountStatus} (can operate: ${check.canOperate})`);
  } catch (error) {
    summary.kycError = String(error instanceof Error ? error.message : error);
    console.error("✘ Could not check KYC status:", error);
  }
}

/**
 * Runs the full Koywe flow (on-ramp, off-ramp, KYC) and returns the
 * summary. `null` if `KOYWE_CLIENT_ID`/`KOYWE_SECRET` are missing — doesn't
 * throw, so `all-flows.ts` can skip this section cleanly and continue with
 * the rest.
 */
export async function runKoyweFlow(): Promise<KoyweFlowSummary | null> {
  const CLIENT_ID = process.env.KOYWE_CLIENT_ID;
  const SECRET = process.env.KOYWE_SECRET;
  if (!CLIENT_ID || !SECRET) {
    console.error(
      "⚠ Missing KOYWE_CLIENT_ID / KOYWE_SECRET (set them in .env, get them from https://docs-crypto.koywe.com) — skipping the Koywe flow.",
    );
    return null;
  }

  const cosmos = new CosmosClient({
    koywe: {
      clientId: CLIENT_ID,
      secret: SECRET,
      // "sandbox" (default) or "production" — picks the matching base URL.
      // KOYWE_BASE_URL still overrides it outright, e.g. for a proxy.
      environment: (process.env.KOYWE_ENVIRONMENT as "sandbox" | "production" | undefined) ?? "sandbox",
      baseUrl: process.env.KOYWE_BASE_URL,
      usdcIssuer: process.env.PUBLIC_USDC_ISSUER || "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5",
      debug: Boolean(process.env.DEBUG),
    },
  });
  console.log(`ℹ Koywe: environment=${cosmos.koywe!.environment}, baseUrl=${cosmos.koywe!.baseUrl}`);
  const koywe = cosmos.koywe!;

  const summary: KoyweFlowSummary = {};
  try {
    await runOnRamp(koywe, summary);
    await runOffRamp(koywe, summary);
    await runKyc(koywe, summary);
  } catch (error) {
    if (error instanceof KoyweError) {
      console.error(`\n✘ Koywe error [${error.code}]:`, error.message);
    } else {
      console.error("\n✘ Unexpected error:", error);
    }
  }
  return summary;
}

export function printKoyweSummary(summary: KoyweFlowSummary) {
  console.log("\n══ Final summary — Koywe ═══════════════════════════════════");
  console.log("ARS rails:             ", summary.paymentProviders?.join(", ") ?? "n/a");
  console.log(
    "On-ramp quote:         ",
    summary.onRampQuoteId ?? `n/a${summary.onRampError ? ` — error: ${summary.onRampError}` : ""}`,
    summary.onRampDestination ?? "",
  );
  console.log("Stellar address:       ", summary.stellarAddress ?? "n/a");
  console.log("On-ramp order:         ", summary.orderId ?? `n/a${summary.orderError ? ` — error: ${summary.orderError}` : ""}`);
  if (summary.depositCvu) console.log("  CVU / alias:         ", summary.depositCvu, summary.depositAlias ?? "");
  if (summary.interactiveUrl) console.log("  Hosted checkout:     ", summary.interactiveUrl);
  console.log("Order status:          ", summary.orderStatus ?? "n/a");
  console.log(
    "Bank account:          ",
    summary.bankAccountId ?? `n/a${summary.bankAccountError ? ` — error: ${summary.bankAccountError}` : ""}`,
  );
  console.log(
    "Off-ramp quote:        ",
    summary.offRampQuoteId ?? `n/a${summary.offRampError ? ` — error: ${summary.offRampError}` : ""}`,
  );
  console.log("KYC:                   ", summary.kycStatus ?? `n/a${summary.kycError ? ` — error: ${summary.kycError}` : ""}`);
  console.log("═════════════════════════════════════════════════════════");
}

if (isMainModule(import.meta.url)) {
  runKoyweFlow()
    .then((summary) => {
      if (summary) printKoyweSummary(summary);
    })
    .catch((error) => {
      console.error("\n✘ Unexpected error:", error);
    });
}
