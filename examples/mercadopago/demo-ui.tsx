/**
 * Local demo: a minimal "Buy USDC" checkout — pick a provider, a payment
 * method and a test amount, pay, done. No dashboard, no action list, no raw
 * JSON: the whole page is built from `cosmos-providers/react`'s actual
 * components (`PaymentMethodCard`, `PaymentOptionRow`, `ReceivePayment`,
 * `PaymentConfirmation`), server-rendered with `react-dom/server` and fed by
 * the `cosmos-providers/react/server` mappers (`chargeToQrProps`,
 * `rampOrderToDetailRows`) — the same pieces a real integration would use.
 * Transitions between steps fade/slide instead of hard-swapping.
 *
 *   npm run demo:ui     (or: npx tsx examples/mercadopago/demo-ui.tsx)
 *   → open http://localhost:4000
 *
 * The provider list comes from `ramp.providers` (whatever's actually
 * registered below) — add another `PaymentProvider` to the `CosmosRamp`
 * constructor and it shows up in the picker with no other change.
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
import { ReceivePayment, PaymentConfirmation, PaymentMethodCard, PaymentOptionRow } from "../../src/react";
import { chargeToQrProps, rampOrderToDetailRows } from "../../src/react/server";
import { createMockMercadoPago } from "../helpers/mock-mercadopago";
import { randomAmount } from "../helpers/random";

const PORT = 4000;
const WEBHOOK_SECRET = "demo-mp-secret";

/** Test-amount bounds for this demo, per method's currency (BRL for PIX QR, ARS for the link). */
const BRL_TEST_RANGE = [5, 30] as const;
const ARS_TEST_RANGE = [1500, 5000] as const;

const clamp = (n: number, min: number, max: number): number => Math.min(max, Math.max(min, n));
const providerLabel = (name: string): string => name.charAt(0).toUpperCase() + name.slice(1).replace(/[-_]/g, " ");
const initials = (name: string): string => name.slice(0, 2).toUpperCase();

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

// ---------------------------------------------------------------------------
// Views — all built from cosmos-providers/react's actual components.
// ---------------------------------------------------------------------------

type Method = "qr" | "link";

/**
 * Step 1: provider + method + test-amount picker. Lists every provider
 * registered on `ramp` (via `PaymentMethodCard`) and the two payment methods
 * (via `PaymentOptionRow`) — real components, wrapped in a plain clickable
 * `<div>` since a statically-rendered page can't wire up React's `onClick`.
 */
function renderPicker(providerName: string, method: Method, amount?: number): string {
  const providers = ramp.providers;
  const selected = providers.find((p) => p.name === providerName) ?? providers[0]!;
  const currency = method === "qr" ? FiatCurrency.BRL : FiatCurrency.ARS;
  const range = method === "qr" ? BRL_TEST_RANGE : ARS_TEST_RANGE;
  const value = clamp(amount ?? randomAmount(range[0], range[1]), range[0], range[1]);

  const providerRows = providers
    .map((p) => {
      const card = renderToStaticMarkup(
        <PaymentMethodCard
          iconLabel={initials(p.name)}
          iconBg="#111827"
          title={providerLabel(p.name)}
          subtitle={p.currencies.length ? p.currencies.join(" · ") : p.regions.join(" · ")}
          selected={p.name === selected.name}
          radioColor={p.name === selected.name ? "#111827" : "#D1D5DB"}
        />,
      );
      return `<div class="pickable" onclick="selectPicker('${p.name}','${method}')">${card}</div>`;
    })
    .join("");

  const methodRows = (["qr", "link"] as const)
    .map((m) => {
      const row = renderToStaticMarkup(
        <PaymentOptionRow label={m === "qr" ? "PIX QR" : "Payment link"} selected={m === method} radioColor={m === method ? "#4F46E5" : "#D1D5DB"} />,
      );
      return `<div class="pickable" onclick="selectPicker('${selected.name}','${m}')">${row}</div>`;
    })
    .join("");

  return `<div style="width:100%;max-width:420px;box-sizing:border-box;margin:0 auto;background:#fff;border-radius:24px;padding:24px;font-family:Helvetica, Arial, sans-serif;color:#111827">
    <h1 style="font-size:20px;margin:0 0 4px;text-align:center">Buy USDC</h1>
    <p style="color:#6B7280;margin:0 0 20px;font-size:13px;text-align:center">Choose a provider and how you'd like to pay.</p>
    <div style="font-size:12px;font-weight:700;color:#6B7280;text-transform:uppercase;letter-spacing:.04em;margin-bottom:8px">Provider (${providers.length} loaded)</div>
    <div style="display:flex;flex-direction:column;gap:8px;margin-bottom:20px">${providerRows}</div>
    <div style="font-size:12px;font-weight:700;color:#6B7280;text-transform:uppercase;letter-spacing:.04em;margin-bottom:8px">Method</div>
    <div style="display:flex;flex-direction:column;gap:8px;margin-bottom:20px">${methodRows}</div>
    <label style="display:block;font-size:12px;color:#6B7280;font-weight:600;margin-bottom:6px">Test amount (${currency}, ${range[0]}–${range[1]})</label>
    <input id="amount" type="number" min="${range[0]}" max="${range[1]}" step="0.01" value="${value}"
      style="width:100%;box-sizing:border-box;border:1px solid #E5E7EB;border-radius:10px;padding:12px 14px;font-size:14px;margin-bottom:20px" />
    <button onclick="pay()" style="width:100%;background:#111827;color:#fff;border:none;border-radius:16px;padding:16px;font-size:16px;font-weight:700;cursor:pointer">Continue</button>
  </div>`;
}

/** Step 2: the real QR/payment-link view a buyer would see. */
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

/** Step 3: the receipt shown once the order is paid and settled. */
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
// API
// ---------------------------------------------------------------------------

type Action = (body: any) => Promise<unknown>;

const actions: Record<string, Action> = {
  /** Creates the onramp charge for the chosen provider/method/amount and returns the pending-payment view. */
  async checkout(body) {
    const providerName = ramp.providers.some((p) => p.name === body.provider) ? body.provider : ramp.providers[0]!.name;
    const method: Method = body.method === "link" ? "link" : "qr";
    const currency = method === "qr" ? FiatCurrency.BRL : FiatCurrency.ARS;
    const range = method === "qr" ? BRL_TEST_RANGE : ARS_TEST_RANGE;
    const requested = Number(body.amount);
    const amount = Number.isFinite(requested) ? clamp(requested, range[0], range[1]) : randomAmount(range[0], range[1]);

    const order = await ramp.onramp({
      provider: providerName,
      amount,
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
  if (req.method === "GET" && url.pathname === "/api/picker") {
    const provider = url.searchParams.get("provider") || ramp.providers[0]!.name;
    const method: Method = url.searchParams.get("method") === "link" ? "link" : "qr";
    const amountParam = url.searchParams.get("amount");
    const amount = amountParam ? Number(amountParam) : undefined;
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ html: renderPicker(provider, method, amount) }));
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
  console.log(`Providers loaded: ${ramp.providers.map((p) => p.name).join(", ")}`);
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
  .pickable { cursor: pointer; }
  .pickable:hover { filter: brightness(0.98); }
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

  /* Animated transitions between steps (picker → pending payment → receipt). */
  @keyframes viewEnter { from { opacity: 0; transform: translateY(10px) scale(.98); } to { opacity: 1; transform: none; } }
  @keyframes viewLeave { from { opacity: 1; transform: none; } to { opacity: 0; transform: translateY(-8px) scale(.98); } }
  #view > *, #actions > * { animation: viewEnter .3s cubic-bezier(.16,1,.3,1) both; }
  #view > *.leaving, #actions > *.leaving { animation: viewLeave .15s ease both !important; }
</style>
</head>
<body>
<main>
  <div id="view">${renderPicker(ramp.providers[0]!.name, "qr")}</div>
  <div id="actions"></div>
  <p id="hint">Mercado Pago is simulated; the release is a real Stellar testnet transaction.</p>
</main>
<script>
  let selectedProvider = ${JSON.stringify(ramp.providers[0]!.name)};
  let selectedMethod = 'qr';
  let orderId = null;

  /** Fades the current child of #containerId out, swaps its HTML, then fades the new one in (CSS handles the "in" animation automatically). */
  function swapView(containerId, html) {
    const el = document.getElementById(containerId);
    const current = el.firstElementChild;
    if (current) {
      current.classList.add('leaving');
      setTimeout(function () { el.innerHTML = html; }, 150);
    } else {
      el.innerHTML = html;
    }
  }

  async function selectPicker(provider, method) {
    const amountInput = document.getElementById('amount');
    const keepAmount = amountInput && selectedMethod === method ? amountInput.value : '';
    selectedProvider = provider;
    selectedMethod = method;
    const qs = new URLSearchParams({ provider: provider, method: method });
    if (keepAmount) qs.set('amount', keepAmount);
    const res = await fetch('/api/picker?' + qs.toString());
    const data = await res.json();
    swapView('view', data.html);
  }

  async function pay() {
    const amountInput = document.getElementById('amount');
    const amount = amountInput ? Number(amountInput.value) : undefined;
    const btn = document.querySelector('#view button');
    if (btn) { btn.disabled = true; btn.textContent = 'Creating…'; }
    const res = await fetch('/api/checkout', { method: 'POST', body: JSON.stringify({ provider: selectedProvider, method: selectedMethod, amount: amount }) });
    const data = await res.json();
    if (data.error) {
      if (btn) { btn.disabled = false; btn.textContent = 'Continue'; }
      alert(data.error);
      return;
    }
    orderId = data.orderId;
    swapView('view', data.resultHtml);
    swapView('actions', '<div id="confirmBar"><button onclick="confirmPayment()">I\\'ve paid</button></div><button id="restart" onclick="location.reload()">Start over</button>');
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
    swapView('view', data.resultHtml);
    swapView('actions', '<button id="restart" onclick="location.reload()">Start over</button>');
  }
</script>
</body>
</html>`;
