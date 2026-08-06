/**
 * Runs every real flow this package ships, one after another, in a single
 * execution: the simulated-webhook settlement demo, Etherfuse (all 5
 * chains), Mercado Pago (payment link + PIX), Koywe, and the generic
 * SEP-1/10/24 module. It's the "everything at once" version of:
 *
 *   npm run demo                      (settlement demo only)
 *   npm run flow                      (Etherfuse only)
 *   npm run flow:mercadopago:link
 *   npm run flow:mercadopago:pix
 *   npm run flow:koywe
 *   npm run flow:sep
 *
 * Run: `npm run flow:all`.
 *
 * DESIGN: no provider blocks the others.
 * - Each flow runs in its own try/catch — if Etherfuse fails entirely, it's
 *   logged and the script still moves on to Mercado Pago, Koywe, and SEP
 *   (and vice versa).
 * - The ones that need credentials not present in `.env` (Mercado Pago,
 *   Koywe) return `null` and are skipped cleanly — you don't need every
 *   account configured for this to be useful. The settlement demo,
 *   Etherfuse, and SEP need no credentials of their own (the settlement
 *   demo runs fully offline against a local simulator; Etherfuse only
 *   needs a sandbox API key; SEP runs against a public reference anchor,
 *   generating its own throwaway wallet).
 * - Each flow already has its own "never blocks" design (see that file's
 *   header comment) — this just chains them.
 * - At the end, every flow that actually ran prints its own summary, one
 *   after another, plus a one-line overview of what ran and what was
 *   skipped.
 */

import "dotenv/config";
import { runSettlementDemo, printSettlementDemoSummary } from "./mercadopago/settlement-demo";
import { createPaymentLinkExample } from "./mercadopago/payment-link";
import { createPixChargeExample } from "./mercadopago/pix";
import { runEtherfuseFlow, printEtherfuseSummary } from "./etherfuse/full-flow";
import { runKoyweFlow, printKoyweSummary } from "./koywe/full-flow";
import { runSepFlow, printSepSummary } from "./sep/full-flow";

interface Ran {
  settlementDemo: boolean;
  etherfuse: boolean;
  mercadopagoLink: boolean;
  mercadopagoPix: boolean;
  koywe: boolean;
  sep: boolean;
}

async function main(): Promise<Ran> {
  const ran: Ran = {
    settlementDemo: false,
    etherfuse: false,
    mercadopagoLink: false,
    mercadopagoPix: false,
    koywe: false,
    sep: false,
  };

  console.log("\n\n█████ 1/6 — Settlement demo: simulated webhook → automatic USDC release █████");
  try {
    const summary = await runSettlementDemo();
    printSettlementDemoSummary(summary);
    ran.settlementDemo = true;
  } catch (error) {
    console.error("✘ The settlement demo failed entirely — continuing with the rest:", error);
  }

  console.log("\n\n█████ 2/6 — Etherfuse (all chains) ████████████████████████");
  try {
    const results = await runEtherfuseFlow();
    if (results) {
      printEtherfuseSummary(results);
      ran.etherfuse = true;
    }
  } catch (error) {
    console.error("✘ The Etherfuse flow failed entirely — continuing with the rest:", error);
  }

  console.log("\n\n█████ 3/6 — Mercado Pago: payment link ████████████████████");
  try {
    const charge = await createPaymentLinkExample();
    ran.mercadopagoLink = charge !== null;
  } catch (error) {
    console.error("✘ The Mercado Pago payment-link flow failed entirely — continuing with the rest:", error);
  }

  console.log("\n\n█████ 4/6 — Mercado Pago: PIX ██████████████████████████████");
  try {
    const charge = await createPixChargeExample();
    ran.mercadopagoPix = charge !== null;
  } catch (error) {
    console.error("✘ The Mercado Pago PIX flow failed entirely — continuing with the rest:", error);
  }

  console.log("\n\n█████ 5/6 — Koywe █████████████████████████████████████████");
  try {
    const summary = await runKoyweFlow();
    if (summary) {
      printKoyweSummary(summary);
      ran.koywe = true;
    }
  } catch (error) {
    console.error("✘ The Koywe flow failed entirely — continuing with the rest:", error);
  }

  console.log("\n\n█████ 6/6 — SEP-1/10/24 ███████████████████████████████████");
  try {
    const summary = await runSepFlow();
    printSepSummary(summary);
    ran.sep = true;
  } catch (error) {
    console.error("✘ The SEP flow failed entirely:", error);
  }

  return ran;
}

function printOverallSummary(ran: Ran) {
  const line = (label: string, ok: boolean) => `  ${ok ? "✔" : "✘ (skipped or failed)"}  ${label}`;
  console.log("\n\n══════════════════════════════════════════════════════════");
  console.log("  OVERALL SUMMARY — all-flows.ts");
  console.log("══════════════════════════════════════════════════════════");
  console.log(line("Settlement demo (simulated webhook → USDC release)", ran.settlementDemo));
  console.log(line("Etherfuse (all chains)", ran.etherfuse));
  console.log(line("Mercado Pago — payment link", ran.mercadopagoLink));
  console.log(line("Mercado Pago — PIX", ran.mercadopagoPix));
  console.log(line("Koywe", ran.koywe));
  console.log(line("SEP-1/10/24", ran.sep));
  console.log("══════════════════════════════════════════════════════════");
  if (!ran.mercadopagoLink) {
    console.log("  ℹ Mercado Pago payment link skipped: set MP_AR_ACCESS_TOKEN or MP_BR_ACCESS_TOKEN in .env.");
  }
  if (!ran.mercadopagoPix) {
    console.log(
      "  ℹ Mercado Pago PIX skipped: set MP_BR_ACCESS_TOKEN in .env to a REAL production account " +
        "(PIX has no sandbox mode).",
    );
  }
  if (!ran.koywe) console.log("  ℹ Koywe skipped: set KOYWE_CLIENT_ID/KOYWE_SECRET in .env.");
}

main()
  .then(printOverallSummary)
  .catch((error) => {
    // Safety net: each flow already catches its own errors, this shouldn't fire.
    console.error("\n✘ Unexpected error in all-flows.ts:", error);
  });
