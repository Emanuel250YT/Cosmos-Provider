/**
 * Runnable demo: executes EVERY engine action end to end, offline.
 *
 *   npm run demo        (or: npx tsx examples/run-all.ts)
 *
 * Uses the local Mercado Pago simulator (examples/helpers/mock-mercadopago.ts)
 * and a fixed oracle rate, so no credentials or network are needed. Swap in a
 * real `MP_ACCESS_TOKEN` + `new CoinGeckoOracle()` for the real thing.
 *
 * Actions covered:
 *   1. Quote (rate + spread breakdown)
 *   2. Onramp with a payment link (ARS)
 *   3. Approved payment webhook → automatic USDC release
 *   4. Duplicate webhook → idempotency
 *   5. Onramp with a PIX QR (BRL)
 *   6. Amount-mismatch protection
 *   7. Offramp + crypto received → automatic fiat payout
 *   8. Outgoing signed webhooks (received + verified by a local server)
 */

import { createServer } from "node:http";
import { CosmosRamp, MercadoPagoProvider, verifyCosmosSignature } from "../src/index";
import { createMockMercadoPago } from "./helpers/mock-mercadopago";

const WEBHOOK_SECRET = "demo-mp-secret";
const HOOK_SECRET = "demo-cosmos-secret";
const HOOK_PORT = 4100;

const step = (title: string) => console.log(`\n─── ${title} ${"─".repeat(Math.max(0, 60 - title.length))}`);

async function main() {
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

  // 1 ──────────────────────────────────────────────────────────────────────
  step("1. Quote: 50 000 ARS → USDC with a 2% spread");
  const quote = await ramp.quote({ direction: "onramp", currency: "ARS", amount: 50_000, spread: 0.02 });
  console.log(`   rate ${quote.rate} → effective ${quote.effectiveRate} | user gets ${quote.cryptoAmount} USDC`);

  // 2 ──────────────────────────────────────────────────────────────────────
  step("2. Onramp via payment LINK (ARS)");
  const linkOrder = await ramp.onramp({
    provider: "mercadopago",
    amount: 50_000,
    currency: "ARS",
    spread: 0.02,
    wallet: "USER_WALLET_1",
    method: "link",
    description: "Buy USDC",
  });
  console.log(`   order ${linkOrder.id.slice(0, 8)}… | pay at: ${linkOrder.charge?.link}`);

  // 3 ──────────────────────────────────────────────────────────────────────
  step("3. User pays → Mercado Pago webhook → automatic USDC release");
  const webhook1 = mp.pay(linkOrder.charge!.id);
  const result1 = await ramp.handleWebhook("mercadopago", webhook1);
  console.log(`   handleWebhook → ${result1.outcome} (HTTP ${result1.status})`);

  // 4 ──────────────────────────────────────────────────────────────────────
  step("4. Same webhook again → idempotent");
  const result2 = await ramp.handleWebhook("mercadopago", webhook1);
  console.log(`   handleWebhook → ${result2.outcome} (settled exactly once)`);

  // 5 ──────────────────────────────────────────────────────────────────────
  step("5. Onramp via PIX QR (BRL)");
  const qrOrder = await ramp.onramp({
    provider: "mercadopago",
    amount: 500,
    currency: "BRL",
    spread: 0.015,
    wallet: "USER_WALLET_2",
    method: "qr",
  });
  console.log(`   copia e cola: ${qrOrder.charge?.qr}`);
  const webhook2 = mp.pay(qrOrder.charge!.id);
  const result3 = await ramp.handleWebhook("mercadopago", webhook2);
  console.log(`   handleWebhook → ${result3.outcome}`);

  // 6 ──────────────────────────────────────────────────────────────────────
  step("6. Amount-mismatch protection (user pays half)");
  const badOrder = await ramp.onramp({
    provider: "mercadopago",
    amount: 10_000,
    currency: "ARS",
    spread: 0.02,
    wallet: "USER_WALLET_3",
    method: "link",
  });
  const badWebhook = mp.pay(badOrder.charge!.id, { amount: 5_000 });
  const result4 = await ramp.handleWebhook("mercadopago", badWebhook);
  console.log(`   handleWebhook → ${result4.outcome} (HTTP ${result4.status})`);

  // 7 ──────────────────────────────────────────────────────────────────────
  step("7. Offramp: user sends 100 USDC, gets ARS paid out");
  const offramp = await ramp.offramp({
    provider: "mercadopago",
    cryptoAmount: 100,
    currency: "ARS",
    spread: 0.02,
    destination: { email: "user@example.com" },
  });
  console.log(`   quote: 100 USDC → ${offramp.quote.fiatAmount} ARS (effective ${offramp.quote.effectiveRate})`);
  await ramp.confirmCryptoReceived(offramp.id, { txId: "0xincoming" });

  // 8 ──────────────────────────────────────────────────────────────────────
  step("8. Outgoing signed webhooks received by our local server");
  await new Promise((resolve) => setTimeout(resolve, 100)); // let deliveries flush
  for (const line of received) console.log(`   ← ${line}`);

  step("Final order states");
  for (const order of await ramp.store.list()) {
    console.log(
      `   ${order.id.slice(0, 8)}… ${order.direction.padEnd(7)} ${order.status.padEnd(9)} ` +
        `${order.quote.fiatAmount} ${order.quote.currency} ↔ ${order.quote.cryptoAmount} ${order.quote.asset}`,
    );
  }

  hookServer.close();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
