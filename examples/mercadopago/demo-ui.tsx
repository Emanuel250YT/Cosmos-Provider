/**
 * Local demo: a minimal "Buy USDC" checkout — pick a payment method, pay,
 * done. No dashboard, no action list, no raw JSON: the whole page is built
 * from `cosmos-providers/react`'s actual components (`ReceivePayment`,
 * `PaymentConfirmation`), server-rendered with `react-dom/server` and fed by
 * the `cosmos-providers/react/server` mappers (`chargeToQrProps`,
 * `rampOrderToDetailRows`) — the same pieces a real integration would use.
 *
 *   npm run demo:ui     (or: npx tsx examples/mercadopago/demo-ui.tsx)
 *   → open http://localhost:4000
 *
 * Two things are deliberately real, not simulated — see
 * examples/mercadopago/settlement-demo.ts for the full rationale:
 * - The rate: `CoinGeckoOracle`, no fixed/mocked number.
 * - The release: a REAL Stellar testnet transaction for a proper asset
 *   (code "USDC", issued by a Friendbot-funded demo issuer created on
 *   startup) — the receiving wallet's trustline is opened and the payment
 *   sent in the same transaction. Falls back to a simulated tx id
 *   automatically if Stellar testnet/Friendbot is unreachable.
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { renderToStaticMarkup } from "react-dom/server";
import { Keypair, Horizon, TransactionBuilder, Networks, Operation, Asset as StellarAsset, BASE_FEE } from "@stellar/stellar-sdk";
import { CosmosRamp, MercadoPagoProvider, CoinGeckoOracle, FiatCurrency, type RampOrderData } from "../../src/index";
import { ReceivePayment, PaymentConfirmation } from "../../src/react";
import { chargeToQrProps, rampOrderToDetailRows } from "../../src/react/server";
import { createMockMercadoPago } from "../helpers/mock-mercadopago";
import { randomArsAmount, randomBrlAmount } from "../helpers/random";

const PORT = 4000;
const WEBHOOK_SECRET = "demo-mp-secret";

const stellarServer = new Horizon.Server("https://horizon-testnet.stellar.org");
const mp = createMockMercadoPago({ webhookSecret: WEBHOOK_SECRET });

console.log("Funding a Stellar testnet demo-USDC issuer (Friendbot)...");
// Doubles as the "treasury": the account that issues an asset can send it
// directly, with no trustline of its own — issuing IS just a payment.
const issuer = Keypair.random();
// Populated by demoWallet() below — settlement needs each receiving
// wallet's own keypair to sign the trustline it opens for itself.
const walletByAddress = new Map<string, Keypair>();
let stellarReady = false;
try {
  await stellarServer.friendbot(issuer.publicKey()).call();
  stellarReady = true;
  console.log(`✔ Demo USDC issuer funded: ${issuer.publicKey()}`);
} catch (error) {
  console.warn("⚠ Could not reach Stellar testnet/Friendbot — settlement will fall back to a simulated tx id:", error);
}

const ramp = new CosmosRamp({
  providers: [
    new MercadoPagoProvider({
      accessToken: "TEST-demo",
      webhookSecret: WEBHOOK_SECRET,
      notificationUrl: "https://myapp.example/webhooks/mercadopago",
      defaultPayerEmail: "buyer@example.com",
      fetch: mp.fetchImpl, // ← simulator; remove to hit the real API
    }),
  ],
  oracle: new CoinGeckoOracle({ apiKey: process.env.COINGECKO_API_KEY }), // real market rate, not a fixed/mocked one
  settlement: async ({ wallet, amount, asset }) => {
    const receiver = wallet ? walletByAddress.get(wallet) : undefined;
    if (stellarReady && wallet && receiver) {
      try {
        // Real Stellar asset (code = whatever `asset` the order actually
        // requested — "USDC" by default), issued by the demo issuer above.
        // The receiving wallet's trustline is opened and the payment sent
        // in the SAME transaction: `changeTrust` sourced from the wallet,
        // `payment` sourced from the issuer, signed by both.
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
        console.log(`⛓ settlement: opened trustline + sent ${amount} ${asset} (testnet, real asset) → ${wallet} — https://stellar.expert/explorer/testnet/tx/${result.hash}`);
        return { txId: result.hash };
      } catch (error) {
        console.warn(`⚠ Stellar settlement failed, falling back to a simulated tx id: ${String(error)}`);
      }
    }
    console.log(`⛓ settlement (simulated): sent ${amount} ${asset} → ${wallet}`);
    return { txId: `0xdemo${Date.now()}` };
  },
});

/** A fresh, Friendbot-funded Stellar address to receive the settlement. */
async function demoWallet(): Promise<string> {
  const kp = Keypair.random();
  if (stellarReady) {
    try {
      await stellarServer.friendbot(kp.publicKey()).call();
      walletByAddress.set(kp.publicKey(), kp);
    } catch {
      // Ignore — settlement just falls back to a simulated tx id for this wallet.
    }
  }
  return kp.publicKey();
}

/** The pending-payment view a buyer sees: real QR or payment link, built with cosmos-providers/react. */
async function renderPending(order: RampOrderData): Promise<string> {
  const qr = await chargeToQrProps(order.charge, { width: 240 });
  return renderToStaticMarkup(
    <ReceivePayment
      amount={`${order.quote.fiatAmount.toFixed(2)} ${order.quote.currency}`}
      statusLabel="Waiting for payment"
      statusColor="#9CA3AF"
      qr={qr ?? undefined}
      paymentLink={!qr ? order.charge?.link : undefined}
      rows={rampOrderToDetailRows(order)}
    />,
  );
}

/** The receipt shown once the order is paid and settled. */
function renderReceipt(order: RampOrderData): string {
  return renderToStaticMarkup(
    <PaymentConfirmation
      itemTitle={`Buy USDC · ${order.provider}`}
      itemSubtitle={new Date(order.updatedAt).toLocaleString()}
      rows={rampOrderToDetailRows(order)}
    />,
  );
}

// ---------------------------------------------------------------------------
// API: two actions — start a checkout, confirm the payment.
// ---------------------------------------------------------------------------

type Action = (body: any) => Promise<unknown>;

const actions: Record<string, Action> = {
  /** Creates the onramp charge for the chosen method and returns the pending-payment view. */
  async checkout(body) {
    const method: "qr" | "link" = body.method === "qr" ? "qr" : "link";
    const currency = method === "qr" ? FiatCurrency.BRL : FiatCurrency.ARS;
    const order = await ramp.onramp({
      provider: "mercadopago",
      amount: currency === FiatCurrency.BRL ? randomBrlAmount() : randomArsAmount(),
      currency,
      spread: 0.02,
      wallet: await demoWallet(),
      method,
      description: "Buy USDC (demo)",
    });
    return { orderId: order.id, resultHtml: await renderPending(order) };
  },

  /** Simulates the buyer paying (signed webhook) → engine settles → returns the receipt view. */
  async confirm(body) {
    const order = await ramp.getOrder(body.orderId);
    if (!order?.charge) throw new Error("Order not found or has no charge.");
    await ramp.handleWebhook("mercadopago", mp.pay(order.charge.id));
    const updated = await ramp.getOrder(body.orderId);
    if (!updated) throw new Error("Order disappeared after payment.");
    return { resultHtml: renderReceipt(updated) };
  },
};

// ---------------------------------------------------------------------------
// HTTP server
// ---------------------------------------------------------------------------

const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
  const url = new URL(req.url ?? "/", `http://localhost:${PORT}`);

  if (req.method === "GET" && url.pathname === "/") {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(PAGE);
    return;
  }
  if (req.method === "POST" && url.pathname.startsWith("/api/")) {
    const name = url.pathname.slice("/api/".length);
    const action = actions[name];
    if (!action) {
      res.writeHead(404).end(JSON.stringify({ error: `Unknown action ${name}` }));
      return;
    }
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", async () => {
      try {
        const result = await action(raw ? JSON.parse(raw) : {});
        res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(result));
      } catch (error) {
        res.writeHead(400, { "content-type": "application/json" }).end(JSON.stringify({ error: String((error as Error).message ?? error) }));
      }
    });
    return;
  }
  res.writeHead(404).end();
});

server.listen(PORT, () => {
  console.log(`Demo UI running → http://localhost:${PORT}`);
  console.log("Mercado Pago is simulated; rate is real (CoinGecko) and settlement is a real Stellar testnet transaction.");
});

// ---------------------------------------------------------------------------
// Page (vanilla HTML/JS shell — the payment views inside #view are the real
// cosmos-providers/react components, server-rendered per request above)
// ---------------------------------------------------------------------------

const PAGE = /* html */ `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Buy USDC</title>
<style>
  * { box-sizing: border-box; }
  body {
    font: 14px/1.5 system-ui, sans-serif; margin: 0; background: #F3F4F6; color: #111827;
    min-height: 100vh; display: flex; align-items: center; justify-content: center; padding: 24px;
  }
  main { width: 100%; max-width: 420px; }
  .picker { background: #fff; border-radius: 24px; padding: 24px; text-align: center; }
  .picker h1 { font-size: 20px; margin: 0 0 4px; }
  .picker p { color: #6B7280; margin: 0 0 20px; font-size: 13px; }
  .methods { display: flex; flex-direction: column; gap: 10px; }
  .methods button {
    display: block; width: 100%; padding: 16px; border-radius: 16px; border: none;
    font-size: 15px; font-weight: 700; cursor: pointer; font: inherit;
  }
  .methods button.primary { background: #111827; color: #fff; }
  .methods button.secondary { background: #F3F4F6; color: #111827; }
  .methods button:disabled { opacity: .6; cursor: default; }
  #confirmBar { margin-top: 12px; }
  #confirmBar button {
    display: block; width: 100%; padding: 14px; border-radius: 16px; border: none;
    background: #16A34A; color: #fff; font-size: 14px; font-weight: 700; cursor: pointer; font: inherit;
  }
  #confirmBar button:disabled { opacity: .6; cursor: default; }
  #restart {
    display: block; margin: 16px auto 0; background: none; border: none;
    color: #6B7280; font-size: 13px; text-decoration: underline; cursor: pointer; font: inherit;
  }
  #hint { text-align: center; color: #9CA3AF; font-size: 12px; margin-top: 16px; }
</style>
</head>
<body>
<main>
  <div id="view">
    <div class="picker">
      <h1>Buy USDC</h1>
      <p>Pick how you'd like to pay.</p>
      <div class="methods">
        <button class="primary" id="qrBtn" onclick="checkout('qr')">Pay with PIX QR</button>
        <button class="secondary" id="linkBtn" onclick="checkout('link')">Pay with a link</button>
      </div>
    </div>
  </div>
  <div id="actions"></div>
  <p id="hint">Mercado Pago is simulated; the release is a real Stellar testnet transaction.</p>
</main>
<script>
  let orderId = null;

  function setLoading(loading) {
    var qrBtn = document.getElementById('qrBtn');
    var linkBtn = document.getElementById('linkBtn');
    if (qrBtn) qrBtn.disabled = loading;
    if (linkBtn) linkBtn.disabled = loading;
  }

  async function checkout(method) {
    setLoading(true);
    try {
      const res = await fetch('/api/checkout', { method: 'POST', body: JSON.stringify({ method: method }) });
      const data = await res.json();
      if (data.error) { alert(data.error); return; }
      orderId = data.orderId;
      document.getElementById('view').innerHTML = data.resultHtml;
      document.getElementById('actions').innerHTML =
        '<div id="confirmBar"><button onclick="confirmPayment()">I\\'ve paid</button></div>' +
        '<button id="restart" onclick="location.reload()">Start over</button>';
    } finally {
      setLoading(false);
    }
  }

  async function confirmPayment() {
    if (!orderId) return;
    const btn = document.querySelector('#confirmBar button');
    btn.disabled = true;
    btn.textContent = 'Confirming…';
    const res = await fetch('/api/confirm', { method: 'POST', body: JSON.stringify({ orderId: orderId }) });
    const data = await res.json();
    if (data.error) {
      btn.disabled = false;
      btn.textContent = "I've paid";
      alert(data.error);
      return;
    }
    document.getElementById('view').innerHTML = data.resultHtml;
    document.getElementById('actions').innerHTML = '<button id="restart" onclick="location.reload()">Start over</button>';
  }
</script>
</body>
</html>`;
