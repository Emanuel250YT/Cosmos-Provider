/**
 * Local demo UI: a small web page with one button per engine action.
 *
 *   npm run demo:ui     (or: npx tsx examples/demo-ui.ts)
 *   → open http://localhost:4000
 *
 * Runs fully offline against the Mercado Pago simulator: create quotes,
 * onramp links and PIX QRs, simulate the user paying (signed webhook →
 * automatic USDC release), trigger the mismatch protection, and run an
 * offramp with automatic payout. The page shows live orders and the event log.
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import QRCode from "qrcode";
import { CosmosRamp, MercadoPagoProvider } from "../src/index";
import { createMockMercadoPago } from "./helpers/mock-mercadopago";

const PORT = 4000;
const WEBHOOK_SECRET = "demo-mp-secret";

const mp = createMockMercadoPago({ webhookSecret: WEBHOOK_SECRET });
const log: string[] = [];
const note = (message: string) => {
  log.unshift(`${new Date().toLocaleTimeString()}  ${message}`);
  if (log.length > 200) log.pop();
};

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
  oracle: { getRate: async () => 1000 }, // ← fixed demo rate; use new CoinGeckoOracle() for real prices
  settlement: async ({ wallet, amount, asset }) => {
    note(`⛓ settlement: sent ${amount} ${asset} → ${wallet}`);
    return { txId: `0xdemo${Date.now()}` };
  },
});

ramp.on("order:created", (o) => note(`order created ${o.id.slice(0, 8)}… (${o.direction})`));
ramp.on("payment:approved", (o) => note(`✔ payment approved ${o.id.slice(0, 8)}…`));
ramp.on("payment:mismatch", (o) => note(`✘ amount mismatch on ${o.id.slice(0, 8)}… — not settling`));
ramp.on("settlement:released", (o, r) => note(`✔ crypto released ${o.id.slice(0, 8)}… tx ${r.txId}`));
ramp.on("payout:sent", (o, p) => note(`✔ fiat payout sent for ${o.id.slice(0, 8)}… id ${p.id}`));
ramp.on("order:completed", (o) => note(`★ order completed ${o.id.slice(0, 8)}…`));

// ---------------------------------------------------------------------------
// API actions
// ---------------------------------------------------------------------------

type Action = (body: any) => Promise<unknown>;

const actions: Record<string, Action> = {
  async quote(body) {
    return ramp.quote({
      direction: body.direction ?? "onramp",
      currency: body.currency ?? "ARS",
      amount: Number(body.amount ?? 50_000),
      spread: Number(body.spread ?? 0.02),
    });
  },

  async onramp(body) {
    const currency = body.currency ?? (body.method === "qr" ? "BRL" : "ARS");
    const order = await ramp.onramp({
      provider: "mercadopago",
      amount: Number(body.amount ?? (currency === "BRL" ? 500 : 50_000)),
      currency,
      spread: Number(body.spread ?? 0.02),
      wallet: body.wallet ?? "USER_WALLET",
      method: body.method ?? "link",
      description: "Buy USDC (demo)",
    });
    // Render the QR as an image for the page, when there is one.
    const qrImage = order.charge?.qr ? await QRCode.toDataURL(order.charge.qr, { width: 240 }) : undefined;
    return { order, qrImage };
  },

  /** Simulate the user paying → signed webhook → engine settles. */
  async pay(body) {
    const order = await ramp.getOrder(body.orderId);
    if (!order?.charge) throw new Error("Order not found or has no charge.");
    const webhook = mp.pay(order.charge.id, body.amount ? { amount: Number(body.amount) } : undefined);
    const result = await ramp.handleWebhook("mercadopago", webhook);
    note(`webhook processed → ${result.outcome} (HTTP ${result.status})`);
    return result;
  },

  async offramp(body) {
    return ramp.offramp({
      provider: "mercadopago",
      cryptoAmount: Number(body.cryptoAmount ?? 100),
      currency: body.currency ?? "ARS",
      spread: Number(body.spread ?? 0.02),
      destination: { email: "user@example.com" },
    });
  },

  async confirmCrypto(body) {
    return ramp.confirmCryptoReceived(body.orderId, { txId: "0xincoming-demo" });
  },

  async retrySettlement(body) {
    return ramp.retrySettlement(body.orderId);
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
  if (req.method === "GET" && url.pathname === "/api/state") {
    const orders = await ramp.store.list();
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ orders, log }));
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
        res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(result, null, 2));
      } catch (error) {
        res
          .writeHead(400, { "content-type": "application/json" })
          .end(JSON.stringify({ error: String((error as Error).message ?? error) }, null, 2));
      }
    });
    return;
  }
  res.writeHead(404).end();
});

server.listen(PORT, () => {
  console.log(`Demo UI running → http://localhost:${PORT}`);
  console.log("Every action runs offline against the Mercado Pago simulator.");
});

// ---------------------------------------------------------------------------
// Page (vanilla HTML/JS, no build step)
// ---------------------------------------------------------------------------

const PAGE = /* html */ `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<title>cosmos-providers · demo</title>
<style>
  body { font: 14px/1.5 system-ui, sans-serif; margin: 0; background: #0f1220; color: #e8e9f0; }
  header { padding: 16px 24px; background: #171b31; }
  header h1 { margin: 0; font-size: 18px; } header p { margin: 4px 0 0; color: #9aa0b8; }
  main { display: grid; grid-template-columns: 320px 1fr 1fr; gap: 16px; padding: 16px 24px; }
  section { background: #171b31; border-radius: 10px; padding: 16px; min-height: 200px; }
  h2 { font-size: 13px; text-transform: uppercase; letter-spacing: .08em; color: #9aa0b8; margin: 0 0 12px; }
  button { display: block; width: 100%; margin: 6px 0; padding: 9px 12px; border: 0; border-radius: 8px;
           background: #2d3560; color: #fff; cursor: pointer; text-align: left; font: inherit; }
  button:hover { background: #3a4380; }
  button.warn { background: #5c3560; }
  input { width: 100%; box-sizing: border-box; margin: 4px 0 10px; padding: 7px 10px; border-radius: 6px;
          border: 1px solid #2d3560; background: #0f1220; color: #e8e9f0; font: inherit; }
  pre { white-space: pre-wrap; word-break: break-all; font-size: 12px; background: #0f1220;
        border-radius: 8px; padding: 12px; max-height: 420px; overflow: auto; }
  table { width: 100%; border-collapse: collapse; font-size: 12px; }
  td, th { padding: 6px 8px; border-bottom: 1px solid #262b4a; text-align: left; }
  .status-completed { color: #7ce38b; } .status-settling { color: #f0b429; }
  .status-created { color: #9aa0b8; } .status-failed { color: #ff7b72; }
  #qr { text-align: center; } #qr img { border-radius: 8px; background: #fff; padding: 8px; }
  .log { font-size: 12px; color: #b8bdd4; max-height: 240px; overflow: auto; }
  label { color: #9aa0b8; font-size: 12px; }
</style>
</head>
<body>
<header>
  <h1>cosmos-providers — action playground</h1>
  <p>Offline demo: Mercado Pago simulator + fixed oracle rate (1 USDC = 1000). Click an action, watch it settle.</p>
</header>
<main>
  <section>
    <h2>Actions</h2>
    <label>Order id (for pay / confirm / retry)</label>
    <input id="orderId" placeholder="click an order row to fill" />
    <button onclick="run('quote', {direction:'onramp', currency:'ARS', amount:50000, spread:0.02})">1 · Quote 50 000 ARS → USDC (2% spread)</button>
    <button onclick="run('onramp', {method:'link', currency:'ARS', amount:50000})">2 · Onramp — payment LINK (ARS)</button>
    <button onclick="run('onramp', {method:'qr', currency:'BRL', amount:500})">3 · Onramp — PIX QR (BRL)</button>
    <button onclick="run('pay', {orderId: val()})">4 · Pay selected order (webhook → release USDC)</button>
    <button class="warn" onclick="run('pay', {orderId: val(), amount: 1})">5 · Pay WRONG amount (mismatch protection)</button>
    <button onclick="run('offramp', {cryptoAmount:100, currency:'ARS'})">6 · Offramp — 100 USDC → ARS</button>
    <button onclick="run('confirmCrypto', {orderId: val()})">7 · Confirm crypto received (triggers payout)</button>
    <button onclick="run('retrySettlement', {orderId: val()})">8 · Retry settlement</button>
  </section>
  <section>
    <h2>Result</h2>
    <div id="qr"></div>
    <pre id="result">—</pre>
  </section>
  <section>
    <h2>Orders</h2>
    <table id="orders"><thead><tr><th>id</th><th>dir</th><th>status</th><th>fiat</th><th>crypto</th></tr></thead><tbody></tbody></table>
    <h2 style="margin-top:16px">Event log</h2>
    <div class="log" id="log"></div>
  </section>
</main>
<script>
  const val = () => document.getElementById('orderId').value.trim();

  async function run(action, body) {
    const res = await fetch('/api/' + action, { method: 'POST', body: JSON.stringify(body) });
    const text = await res.text();
    document.getElementById('result').textContent = text;
    let qrHtml = '';
    try {
      const data = JSON.parse(text);
      if (data.qrImage) qrHtml = '<img src="' + data.qrImage + '" alt="QR" />';
      if (data.order?.id) document.getElementById('orderId').value = data.order.id;
    } catch {}
    document.getElementById('qr').innerHTML = qrHtml;
    refresh();
  }

  async function refresh() {
    const { orders, log } = await (await fetch('/api/state')).json();
    document.querySelector('#orders tbody').innerHTML = orders.map(o =>
      '<tr style="cursor:pointer" onclick="document.getElementById(\\'orderId\\').value=\\'' + o.id + '\\'">' +
      '<td>' + o.id.slice(0, 8) + '…</td><td>' + o.direction + '</td>' +
      '<td class="status-' + o.status + '">' + o.status + '</td>' +
      '<td>' + o.quote.fiatAmount + ' ' + o.quote.currency + '</td>' +
      '<td>' + o.quote.cryptoAmount + ' ' + o.quote.asset + '</td></tr>'
    ).join('');
    document.getElementById('log').innerHTML = log.map(l => '<div>' + l + '</div>').join('');
  }

  refresh();
  setInterval(refresh, 2000);
</script>
</body>
</html>`;
