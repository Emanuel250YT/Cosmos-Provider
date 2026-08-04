/**
 * Runnable demo: executes EVERY engine action end to end, offline —
 * including the piece that's hardest to demonstrate with real credentials:
 * automatic crypto release once a payment is confirmed.
 *
 *   npm run demo   (or: npx tsx examples/mercadopago/settlement-demo.ts)
 *
 * A real Mercado Pago payment link/PIX charge only turns "approved" once a
 * human actually pays it — nothing in this repo can automate that safely.
 * This demo uses the local Mercado Pago simulator
 * (examples/helpers/mock-mercadopago.ts) instead: it fakes a payment being
 * approved and returns a **signed webhook request, built exactly the way
 * real Mercado Pago signs one** (same x-signature/HMAC scheme). Feeding
 * that into `ramp.handleWebhook(...)` exercises the real, production
 * pipeline end to end — signature verification, re-fetching the payment,
 * amount matching, and calling your `settlement` — with nothing mocked
 * past the HTTP layer. That's what proves the release-of-funds system
 * actually works, not just that a link/QR can be created.
 *
 * No credentials or network needed. Swap in a real `MP_ACCESS_TOKEN` +
 * `new CoinGeckoOracle()` for the real thing (see examples/quickstart.ts).
 *
 * Actions covered:
 *   1. Quote (rate + spread breakdown)
 *   2. Onramp with a payment link (ARS)
 *   3. Simulated approved-payment webhook → automatic USDC release
 *   4. Duplicate webhook → idempotency (settles exactly once)
 *   5. Onramp with a PIX QR (BRL) → simulated webhook → USDC release
 *   6. Amount-mismatch protection (simulated underpayment)
 *   7. Offramp + crypto received → automatic fiat payout
 *   8. Outgoing signed webhooks (received + verified by a local server)
 */

import { createServer } from "node:http";
import { CosmosRamp, MercadoPagoProvider, verifyCosmosSignature, FiatCurrency, type RampOrderData } from "../../src/index";
import { createMockMercadoPago } from "../helpers/mock-mercadopago";
import { isMainModule } from "../helpers/isMain";
import { randomArsAmount, randomBrlAmount } from "../helpers/random";
import { printQr } from "../helpers/qr";

const WEBHOOK_SECRET = "demo-mp-secret";
const HOOK_SECRET = "demo-cosmos-secret";
const HOOK_PORT = 4100;

const step = (title: string) => console.log(`\n─── ${title} ${"─".repeat(Math.max(0, 60 - title.length))}`);

export interface SettlementDemoSummary {
  released: string[];
  finalOrders: RampOrderData[];
  receivedWebhooks: string[];
}

/**
 * Runs the full simulated settlement demo and returns a summary. Never
 * throws for demo-internal outcomes (mismatch protection rejecting a
 * webhook is an expected, successful result, not a failure) — genuine
 * setup errors (e.g. the local hook server failing to bind) still throw.
 */
export async function runSettlementDemo(): Promise<SettlementDemoSummary> {
  const released: string[] = [];

  // A tiny local server that receives OUR outgoing webhooks and verifies them.
  const received: string[] = [];
  const hookServer = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", async () => {
      const ok = await verifyCosmosSignature(body, req.headers["x-cosmos-signature"] as string, HOOK_SECRET);
      const event = JSON.parse(body);
      received.push(`${event.type} (signature ${ok ? "valid" : "INVALID"})`);
      res.writeHead(200).end();
    });
  });
  await new Promise<void>((resolve) => hookServer.listen(HOOK_PORT, resolve));

  const mp = createMockMercadoPago({ webhookSecret: WEBHOOK_SECRET });

  const ramp = new CosmosRamp({
    providers: [
      new MercadoPagoProvider({
        accessToken: "TEST-demo",
        webhookSecret: WEBHOOK_SECRET,
        notificationUrl: "https://myapp.example/webhooks/mercadopago",
        defaultPayerEmail: "buyer@example.com",
        fetch: mp.fetchImpl, // ← simulator; remove for the real API
      }),
    ],
    oracle: { getRate: async () => 1000 }, // ← fixed rate; use new CoinGeckoOracle() for real prices
    settlement: async ({ wallet, amount, asset }) => {
      console.log(`   ⛓  settlement: sending ${amount} ${asset} → ${wallet}`);
      released.push(`${amount} ${asset} → ${wallet}`);
      return { txId: `0xdemo${Date.now()}` };
    },
    webhooks: {
      endpoints: [{ url: `http://localhost:${HOOK_PORT}/hooks/cosmos`, secret: HOOK_SECRET }],
    },
  });

  ramp.on("payment:approved", (order) => console.log(`   ✔ payment approved for order ${order.id.slice(0, 8)}…`));
  ramp.on("settlement:released", (_, { txId }) => console.log(`   ✔ crypto released, tx ${txId}`));
  ramp.on("order:completed", (order) => console.log(`   ✔ order completed (${order.direction})`));
  ramp.on("payment:mismatch", () => console.log("   ✘ paid amount does not match the quote — NOT settling"));
  ramp.on("payout:sent", (_, payout) => console.log(`   ✔ fiat payout sent, id ${payout.id}`));

  try {
    // 1 ────────────────────────────────────────────────────────────────────
    const quoteAmount = randomArsAmount();
    step(`1. Quote: ${quoteAmount} ARS → USDC with a 2% spread`);
    const quote = await ramp.quote({ direction: "onramp", currency: FiatCurrency.ARS, amount: quoteAmount, spread: 0.02 });
    console.log(`   rate ${quote.rate} → effective ${quote.effectiveRate} | user gets ${quote.cryptoAmount} USDC`);

    // 2 ────────────────────────────────────────────────────────────────────
    step("2. Onramp via payment LINK (ARS)");
    const linkOrder = await ramp.onramp({
      provider: "mercadopago",
      amount: randomArsAmount(),
      currency: FiatCurrency.ARS,
      spread: 0.02,
      wallet: "USER_WALLET_1",
      method: "link",
      description: "Buy USDC",
    });
    console.log(`   order ${linkOrder.id.slice(0, 8)}… | pay at: ${linkOrder.charge?.link}`);
    await printQr(linkOrder.charge?.qr ?? linkOrder.charge?.link, "Payment link QR");

    // 3 ────────────────────────────────────────────────────────────────────
    step("3. Simulated payment → signed webhook → automatic USDC release");
    const webhook1 = mp.pay(linkOrder.charge!.id);
    const result1 = await ramp.handleWebhook("mercadopago", webhook1);
    console.log(`   handleWebhook → ${result1.outcome} (HTTP ${result1.status})`);

    // 4 ────────────────────────────────────────────────────────────────────
    step("4. Same webhook again → idempotent");
    const result2 = await ramp.handleWebhook("mercadopago", webhook1);
    console.log(`   handleWebhook → ${result2.outcome} (settled exactly once)`);

    // 5 ────────────────────────────────────────────────────────────────────
    step("5. Onramp via PIX QR (BRL)");
    const qrOrder = await ramp.onramp({
      provider: "mercadopago",
      amount: randomBrlAmount(),
      currency: FiatCurrency.BRL,
      spread: 0.015,
      wallet: "USER_WALLET_2",
      method: "qr",
    });
    console.log(`   copia e cola: ${qrOrder.charge?.qr}`);
    await printQr(qrOrder.charge?.qr, "PIX QR");
    const webhook2 = mp.pay(qrOrder.charge!.id);
    const result3 = await ramp.handleWebhook("mercadopago", webhook2);
    console.log(`   handleWebhook → ${result3.outcome}`);

    // 6 ────────────────────────────────────────────────────────────────────
    step("6. Amount-mismatch protection (user pays half)");
    const mismatchAmount = randomArsAmount();
    const badOrder = await ramp.onramp({
      provider: "mercadopago",
      amount: mismatchAmount,
      currency: FiatCurrency.ARS,
      spread: 0.02,
      wallet: "USER_WALLET_3",
      method: "link",
    });
    const badWebhook = mp.pay(badOrder.charge!.id, { amount: Math.round((mismatchAmount / 2) * 100) / 100 });
    const result4 = await ramp.handleWebhook("mercadopago", badWebhook);
    console.log(`   handleWebhook → ${result4.outcome} (HTTP ${result4.status})`);

    // 7 ────────────────────────────────────────────────────────────────────
    step("7. Offramp: user sends 100 USDC, gets ARS paid out");
    const offramp = await ramp.offramp({
      provider: "mercadopago",
      cryptoAmount: 100,
      currency: FiatCurrency.ARS,
      spread: 0.02,
      destination: { email: "user@example.com" },
    });
    console.log(`   quote: 100 USDC → ${offramp.quote.fiatAmount} ARS (effective ${offramp.quote.effectiveRate})`);
    await ramp.confirmCryptoReceived(offramp.id, { txId: "0xincoming" });

    // 8 ────────────────────────────────────────────────────────────────────
    step("8. Outgoing signed webhooks received by our local server");
    await new Promise((resolve) => setTimeout(resolve, 100)); // let deliveries flush
    for (const line of received) console.log(`   ← ${line}`);

    const finalOrders = await ramp.store.list();
    return { released, finalOrders, receivedWebhooks: received };
  } finally {
    hookServer.close();
  }
}

export function printSettlementDemoSummary(summary: SettlementDemoSummary) {
  console.log("\n══ Final summary — settlement demo ═════════════════════════");
  console.log("Crypto released:");
  for (const line of summary.released) console.log(`  ⛓  ${line}`);
  console.log("Final order states:");
  for (const order of summary.finalOrders) {
    console.log(
      `  ${order.id.slice(0, 8)}… ${order.direction.padEnd(7)} ${order.status.padEnd(9)} ` +
        `${order.quote.fiatAmount} ${order.quote.currency} ↔ ${order.quote.cryptoAmount} ${order.quote.asset}`,
    );
  }
  console.log("═════════════════════════════════════════════════════════");
}

if (isMainModule(import.meta.url)) {
  runSettlementDemo()
    .then(printSettlementDemoSummary)
    .catch((error) => {
      console.error(error);
      process.exit(1);
    });
}
