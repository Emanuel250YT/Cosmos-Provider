/**
 * Runnable demo: executes EVERY engine action end to end — including the
 * piece that's hardest to demonstrate with real credentials: automatic
 * crypto release once a payment is confirmed.
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
 * past the HTTP layer.
 *
 * Two things are deliberately real, not simulated:
 * - The rate: `CoinGeckoOracle` with no fixed/mocked number, same as
 *   production — the quote reflects the actual market price at the moment
 *   you run this.
 * - The release: a REAL Stellar testnet transaction, for a proper Stellar
 *   asset — code "USDC", issued by a Friendbot-funded demo issuer generated
 *   at the top of the run (there's no way to get real Circle-issued testnet
 *   USDC into an arbitrary account without a human faucet step, so this
 *   demo issues its own so the *mechanism* — open a trustline, then receive
 *   a proper asset, not native XLM standing in for one — is real and
 *   verifiable end to end). Each release opens the receiving wallet's
 *   trustline and sends the asset in the SAME transaction, then prints the
 *   tx hash, a stellar.expert link, and a scannable QR for that link. If
 *   Stellar testnet/Friendbot is unreachable, settlement falls back to a
 *   simulated tx id automatically — this demo never hard-fails on a
 *   network hiccup.
 *
 * No credentials needed — an optional `COINGECKO_API_KEY` in `.env` only
 * raises the rate-limit ceiling, the public endpoint works without one.
 *
 * Actions covered:
 *   0. Fund a Stellar testnet demo-USDC issuer + wallets (Friendbot)
 *   1. Quote at the real market rate (rate + spread breakdown)
 *   2. Onramp with a payment link (ARS)
 *   3. Simulated approved-payment webhook → automatic release (real Stellar tx, real asset + trustline)
 *   4. Duplicate webhook → idempotency (settles exactly once)
 *   5. Onramp with a PIX QR (BRL) → simulated webhook → release (real Stellar tx, real asset + trustline)
 *   6. Amount-mismatch protection (simulated underpayment)
 *   7. Offramp + crypto received → automatic fiat payout
 *   8. Outgoing signed webhooks (received + verified by a local server)
 */

import { createServer } from "node:http";
import { Keypair, Horizon, TransactionBuilder, Networks, Operation, Asset as StellarAsset, BASE_FEE } from "@stellar/stellar-sdk";
import { CosmosRamp, MercadoPagoProvider, CoinGeckoOracle, verifyCosmosSignature, FiatCurrency, type RampOrderData } from "../../src/index";
import { createMockMercadoPago } from "../helpers/mock-mercadopago";
import { isMainModule } from "../helpers/isMain";
import { randomArsAmount, randomBrlAmount } from "../helpers/random";
import { printQr } from "../helpers/qr";

const WEBHOOK_SECRET = "demo-mp-secret";
const HOOK_SECRET = "demo-cosmos-secret";
const HOOK_PORT = 4100;

const stellarServer = new Horizon.Server("https://horizon-testnet.stellar.org");
const stellarExplorerTx = (hash: string) => `https://stellar.expert/explorer/testnet/tx/${hash}`;

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

  // 0 ──────────────────────────────────────────────────────────────────────
  step("0. Funding a Stellar testnet demo-USDC issuer + wallets (Friendbot)");
  // The issuer doubles as the "treasury": on Stellar, the account that
  // issues an asset can send it directly, with no trustline of its own —
  // issuing IS just a payment from this account.
  const issuer = Keypair.random();
  const wallet1 = Keypair.random();
  const wallet2 = Keypair.random();
  const wallet3 = Keypair.random();
  const walletByAddress = new Map([wallet1, wallet2, wallet3].map((kp) => [kp.publicKey(), kp]));
  let stellarReady = false;
  try {
    await Promise.all([issuer, wallet1, wallet2, wallet3].map((kp) => stellarServer.friendbot(kp.publicKey()).call()));
    stellarReady = true;
    console.log(`   ✔ Demo USDC issuer funded: ${issuer.publicKey()}`);
  } catch (error) {
    console.warn("   ⚠ Could not reach Stellar testnet/Friendbot — settlement will fall back to a simulated tx id:", error);
  }

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
    oracle: new CoinGeckoOracle({ apiKey: process.env.COINGECKO_API_KEY }), // real market rate, not a fixed/mocked one
    settlement: async ({ wallet, amount, asset }) => {
      const receiver = wallet ? walletByAddress.get(wallet) : undefined;
      if (stellarReady && wallet && receiver) {
        try {
          // Real Stellar asset (code = whatever `asset` the order actually
          // requested — "USDC" by default), issued by the demo issuer
          // above. The receiving wallet's trustline is opened and the
          // payment sent in the SAME transaction: `changeTrust` sourced
          // from the wallet, `payment` sourced from the issuer, signed by
          // both — one round trip, both steps real and verifiable.
          const stellarAsset = new StellarAsset(asset, issuer.publicKey());
          const account = await stellarServer.loadAccount(issuer.publicKey());
          const tx = new TransactionBuilder(account, { fee: String(Number(BASE_FEE) * 2), networkPassphrase: Networks.TESTNET })
            .addOperation(Operation.changeTrust({ asset: stellarAsset, source: wallet }))
            .addOperation(
              Operation.payment({
                destination: wallet,
                asset: stellarAsset,
                amount: String(Math.round(amount * 1e7) / 1e7),
              }),
            )
            .setTimeout(30)
            .build();
          tx.sign(issuer);
          tx.sign(receiver);
          const result = await stellarServer.submitTransaction(tx);
          const explorerUrl = stellarExplorerTx(result.hash);

          console.log(`   ⛓  settlement: opened trustline + sent ${amount} ${asset} (testnet, real asset) → ${wallet}`);
          console.log(`      tx:       ${result.hash}`);
          console.log(`      explorer: ${explorerUrl}`);
          await printQr(explorerUrl, "Stellar Explorer");

          released.push(`${amount} ${asset} → ${wallet} — tx ${result.hash} (${explorerUrl})`);
          return { txId: result.hash };
        } catch (error) {
          console.warn("   ⚠ Stellar settlement failed — falling back to a simulated tx id:", error);
        }
      }
      console.log(`   ⛓  settlement (simulated): sending ${amount} ${asset} → ${wallet}`);
      released.push(`${amount} ${asset} → ${wallet} (simulated)`);
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
    step(`1. Quote: ${quoteAmount} ARS → USDC at the real market rate, 2% spread`);
    const quote = await ramp.quote({ direction: "onramp", currency: FiatCurrency.ARS, amount: quoteAmount, spread: 0.02 });
    console.log(`   rate ${quote.rate} → effective ${quote.effectiveRate} | user gets ${quote.cryptoAmount} USDC`);

    // 2 ────────────────────────────────────────────────────────────────────
    step("2. Onramp via payment LINK (ARS)");
    const linkOrder = await ramp.onramp({
      provider: "mercadopago",
      amount: randomArsAmount(),
      currency: FiatCurrency.ARS,
      spread: 0.02,
      wallet: wallet1.publicKey(),
      method: "link",
      description: "Buy USDC",
    });
    console.log(`   order ${linkOrder.id.slice(0, 8)}… | pay at: ${linkOrder.charge?.link}`);
    await printQr(linkOrder.charge?.qr ?? linkOrder.charge?.link, "Payment link QR");

    // 3 ────────────────────────────────────────────────────────────────────
    step("3. Simulated payment → signed webhook → automatic release");
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
      wallet: wallet2.publicKey(),
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
      wallet: wallet3.publicKey(),
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
