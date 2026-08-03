# cosmos-providers

Crypto onramp/offramp toolkit for Latin America. Collect fiat with regional payment rails (Mercado Pago QR & payment links, PIX, SPEI) and release stablecoins automatically, priced with CoinGecko plus your own spread.

**Documentation in other languages:** [Español](./readme/README.es.md) · [Português](./readme/README.pt-BR.md)

## Features

- **Provider-agnostic** — one engine, pluggable regional providers (Mercado Pago included, PIX/SPEI via Etherfuse, or write your own).
- **Automatic onramp** — build a QR or payment link; when the payment is approved the engine releases USDC (or any asset) to the user's wallet.
- **Automatic offramp** — quote crypto → fiat and pay out through the provider.
- **CoinGecko pricing with spread** — the rate and your spread are locked when the payment is built.
- **Webhooks, both ways** — consumes provider webhooks automatically (signature check included) and emits your own signed webhooks.
- **TypeScript, zero heavy deps** — works on Node ≥ 18. Bring your own wallet/signer; the library never touches private keys.

## Install

```bash
npm install cosmos-providers
```

## Try it locally (no credentials needed)

The repo ships a Mercado Pago simulator so you can run every action offline:

```bash
npm run demo      # console runner: quote → link → QR → webhook → auto USDC release → offramp
npm run demo:ui   # web playground at http://localhost:4000 with one button per action
```

## Quick start: sell USDC via Mercado Pago

```ts
import { CosmosRamp, CoinGeckoOracle, MercadoPagoProvider } from "cosmos-providers";

const ramp = new CosmosRamp({
  providers: [
    new MercadoPagoProvider({
      accessToken: process.env.MP_ACCESS_TOKEN,
      webhookSecret: process.env.MP_WEBHOOK_SECRET,
      notificationUrl: "https://myapp.com/webhooks/mercadopago",
    }),
  ],
  oracle: new CoinGeckoOracle(),
  // Your code that sends the crypto. Called automatically after payment.
  settlement: async ({ wallet, amount, asset }) => {
    const txId = await myWallet.transfer(asset, amount, wallet);
    return { txId };
  },
});

// 1. Build the payment. Rate + spread are locked right here.
const order = await ramp.onramp({
  provider: "mercadopago",
  amount: 50000,          // ARS the user will pay
  currency: "ARS",
  asset: "USDC",
  spread: 0.02,           // your 2% margin over the CoinGecko rate
  wallet: "USER_WALLET_ADDRESS",
  method: "link",         // or "qr"
});

console.log(order.charge.link);        // send the user here to pay
console.log(order.quote.cryptoAmount); // USDC they will receive
```

```ts
// 2. Receive the Mercado Pago webhook. That's it — the engine verifies the
// signature, checks the paid amount, and calls your settlement.
app.post("/webhooks/mercadopago", express.json(), async (req, res) => {
  const result = await ramp.handleWebhook("mercadopago", {
    body: req.body,
    headers: req.headers,
    url: req.url,
  });
  res.sendStatus(result.status);
});
```

```ts
// 3. Optional: listen to what happens.
ramp.on("payment:approved", (order) => console.log("paid", order.id));
ramp.on("settlement:released", (order, { txId }) => console.log("USDC sent", txId));
ramp.on("order:completed", (order) => console.log("done", order.id));
```

## How the quote works

When you build a payment, the engine asks CoinGecko for the mid-market rate and applies your spread **at that moment**:

| | Effective rate | Example (rate 1000, spread 2%) |
|---|---|---|
| Onramp | `rate * (1 + spread)` | user pays 1020 ARS per USDC |
| Offramp | `rate * (1 - spread)` | user receives 980 ARS per USDC |

The full breakdown is stored on the order:

```ts
order.quote;
// { asset: "USDC", currency: "ARS", rate: 1000, spread: 0.02,
//   effectiveRate: 1020, fiatAmount: 50000, cryptoAmount: 49.019608, quotedAt: ... }
```

You can also quote without creating an order:

```ts
const quote = await ramp.quote({ direction: "onramp", currency: "ARS", amount: 50000, spread: 0.02 });
```

## Offramp: buy USDC back, pay out fiat

```ts
const order = await ramp.offramp({
  provider: "mercadopago",
  cryptoAmount: 100,               // USDC the user sends you
  currency: "ARS",
  spread: 0.02,
  destination: { email: "user@example.com" }, // Mercado Pago payout destination
});

// Show the user your treasury wallet; when their USDC arrives:
await ramp.confirmCryptoReceived(order.id, { txId: "..." });
// → the engine pays out fiat via the provider automatically.
// If the provider can't pay out, it emits "payout:required" so you can do it
// your way, then call ramp.confirmPayoutSent(order.id).
```

## Payment methods per region

`MercadoPagoProvider` covers AR, BR, MX, CL, CO, PE, UY (ARS, BRL, MXN, CLP, COP, PEN, UYU):

| `method` | What you get |
|---|---|
| `"link"` | Checkout Pro payment link (`order.charge.link`) |
| `"qr"` (BRL) | PIX QR: EMV string (`order.charge.qr`) + base64 PNG (`order.charge.qrBase64`) |
| `"qr"` (with `qrPos`) | Mercado Pago in-store dynamic QR |
| `"auto"` | Best method for the currency (default) |

Any other rail can be plugged in with `createCustomProvider` (see below) or by implementing the `PaymentProvider` interface directly.

## Mercado Pago sandbox

Pass a `TEST-...` access token and the provider switches to sandbox automatically (or force it with `sandbox: true`): payment links use `sandbox_init_point`, so the whole flow is testable with [test users and test cards](https://www.mercadopago.com.ar/developers/en/docs/checkout-pro/additional-content/your-integrations/test/accounts) before going live.

```ts
const mp = new MercadoPagoProvider({
  accessToken: process.env.MP_TEST_ACCESS_TOKEN, // "TEST-..." → mp.sandbox === true
  webhookSecret: process.env.MP_WEBHOOK_SECRET,
});
```

To test webhooks without exposing a public URL, build a signed notification for a sandbox payment and feed it straight to the engine — it exercises the real pipeline (signature check → parse → API re-fetch → settlement):

```ts
const request = await mp.buildTestWebhook(paymentId); // signed exactly like Mercado Pago would
const result = await ramp.handleWebhook("mercadopago", request);
// → { ok: true, outcome: "settled", orderId: "..." }
```

## Custom providers

Wrap any payment API into a fully working provider — payment links, QRs, status normalization and webhooks included — without implementing `PaymentProvider` by hand. You supply the raw API calls; the responses are adapted to the Cosmos format automatically:

```ts
import { createCustomProvider } from "cosmos-providers";

const acme = createCustomProvider({
  name: "acme",
  currencies: ["ARS"],

  // Raw API calls — return the provider response as-is.
  createCharge: (req) => acmeApi.post("/charges", { amount: req.amount, ref: req.reference }),
  getCharge: (id) => acmeApi.get(`/charges/${id}`),
  createPayout: (req) => acmeApi.post("/payouts", req), // optional

  // Map provider statuses onto: pending | approved | rejected | refunded | canceled | expired.
  // A big alias table is built in ("paid"/"succeeded" → approved, ...); unknown statuses
  // resolve to "pending" — never to a false approval.
  statusMap: { ok_dale: "approved" },

  // Webhooks: HMAC-SHA256 out of the box, or bring your own verify/parse.
  webhook: {
    hmac: { secret: process.env.ACME_WEBHOOK_SECRET, header: "x-acme-signature" },
    chargeIdPaths: ["data.id"], // where the payment id lives (this is the default)
  },
});

const ramp = new CosmosRamp({ providers: [acme], /* ... */ });
```

Common response fields (`checkout_url`, `init_point`, `payment_url`, `qr_code`, `qr_code_base64`, `transaction_amount`, `external_reference`, nested `data`/`payment` objects...) are auto-mapped. For unusual shapes, take full control with `adapt`:

```ts
createCustomProvider({
  // ...
  adapt: {
    charge: (raw) => ({ id: raw.tx.id, link: raw.tx.hosted_page }),
    chargeState: (raw) => ({ status: raw.tx.phase, amount: raw.tx.cents / 100 }),
  },
});
```

Whatever the adapters return is still normalized and validated (a charge without a link/QR/deposit fails fast at creation), so `ramp.handleWebhook` and `order.charge.link` behave identically across built-in and custom providers.

## Emitting your own webhooks

Get notified on your backend(s) whenever an order moves:

```ts
const ramp = new CosmosRamp({
  // ...
  webhooks: {
    endpoints: [{ url: "https://myapp.com/hooks/cosmos", secret: process.env.HOOK_SECRET }],
  },
});
```

Every delivery is signed (`x-cosmos-signature: t=...,v1=...`). Verify it on the receiving end:

```ts
import { verifyCosmosSignature } from "cosmos-providers";

const ok = await verifyCosmosSignature(rawBody, req.get("x-cosmos-signature"), secret);
```

Events: `order.created`, `payment.approved`, `payment.rejected`, `payment.mismatch`, `settlement.released`, `settlement.failed`, `payout.required`, `order.completed`.

## Persistence

By default orders live in memory (fine for dev). In production, implement the small `OrderStore` interface (5 methods) over your database and pass it as `store`.

```ts
const ramp = new CosmosRamp({ store: new MyPostgresStore(), /* ... */ });
```

## Safety model

- Webhook bodies are never trusted: the engine re-fetches the payment from the provider API before settling.
- The paid amount must match the quoted amount (± `defaults.amountTolerance`).
- Duplicate webhooks are idempotent — an order settles once.
- If your settlement throws, the order stays in `"settling"`; retry with `ramp.retrySettlement(orderId)`.

## Standalone PIX QR codes

Generate and parse PIX BR Codes (EMV "copia e cola") without any API:

```ts
import { Pix } from "cosmos-providers";

const qr = Pix.create({
  pixKey: "payments@mycompany.com.br",
  merchantName: "My Company",
  merchantCity: "Sao Paulo",
  amount: 99.9,
});

await qr.toDataURL(); // PNG data URL for <img src>
qr.toString();        // "copia e cola" payload
Pix.parse("00020126..."); // decode + validate any BR Code
```

## Etherfuse client (PIX/SPEI ramp API)

The package also ships a full client for the [Etherfuse](https://docs.etherfuse.com) ramp API (BRL·PIX and MXN·SPEI against Solana, Stellar, Base, Polygon):

```ts
import { EtherfuseClient } from "cosmos-providers";

const client = new EtherfuseClient({ apiKey: process.env.ETHERFUSE_API_KEY, environment: "sandbox" });

const quote = await client.quotes.create({ /* ... */ });
const receipt = await quote.createOrder({ bankAccountId: "...", publicKey: "WALLET" });
const qr = receipt.createPixQr();
```

Etherfuse webhook verification (Node-only) lives in the `cosmos-providers/webhooks` subpath. See the [examples](./examples) folder for complete flows.

## Errors

| Error | Meaning |
|---|---|
| `ProviderError` | A provider API call failed (`.provider`, `.status`, `.body`) |
| `OracleError` | CoinGecko couldn't price the pair |
| `SettlementError` | The crypto/fiat leg failed to move |
| `WebhookSignatureError` | Invalid webhook signature |
| `CosmosError` | Base class for all of the above |

## Scripts

```bash
npm run build      # tsup → dist/ (ESM + CJS + .d.ts)
npm run typecheck  # tsc --noEmit
npm test           # vitest
```

## License

MIT
