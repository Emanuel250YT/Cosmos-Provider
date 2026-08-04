# cosmos-providers

Crypto onramp/offramp toolkit for Latin America. **One client, `CosmosClient`**, wires together regional fiat rails (Mercado Pago payment links & PIX, SPEI) with automatic stablecoin release, full on/off-ramp anchors to USDC on Stellar (Etherfuse, Koywe), and composable SEP-1/10/24 helpers for any SEP-compliant anchor — priced with CoinGecko plus your own spread.

**Documentation in other languages:** [Español](./readme/README.es.md) · [Português](./readme/README.pt-BR.md)

## Contents

- [Install](#install)
- [Quickstart](#quickstart)
  - [Less code: skip `cosmos.mercadopago!`/`cosmos.koywe!`](#less-code-skip-cosmosmercadopago-cosmoskoywe)
  - [`cosmos.createPaymentLink(...)`: the same process for every provider](#cosmoscreatepaymentlink-the-same-process-for-every-provider)
- [Features](#features)
- [Configuration](#configuration)
- [Try it locally (no credentials needed)](#try-it-locally-no-credentials-needed)
- [Mercado Pago](#mercado-pago)
  - [Sandbox vs. production](#sandbox-vs-production)
  - [Multi-account: one merchant per country](#multi-account-one-merchant-per-country)
  - [Webhook verification](#webhook-verification)
- [Automatic settlement](#automatic-settlement)
  - [How the quote works](#how-the-quote-works)
  - [Offramp: buy USDC back, pay out fiat](#offramp-buy-usdc-back-pay-out-fiat)
- [Etherfuse](#etherfuse)
- [Koywe](#koywe)
- [SEP-1 / SEP-10 / SEP-24](#sep-1--sep-10--sep-24)
- [Custom providers](#custom-providers)
- [Emitting your own webhooks](#emitting-your-own-webhooks)
- [Persistence](#persistence)
- [Safety model](#safety-model)
- [Standalone PIX QR codes](#standalone-pix-qr-codes)
- [Standard identifiers: Chain, Asset, FiatCurrency, Country](#standard-identifiers-chain-asset-fiatcurrency-country)
- [Using the pieces directly](#using-the-pieces-directly)
- [Errors](#errors)
- [Examples](#examples)
- [Scripts](#scripts)
- [License](#license)

## Install

```bash
npm install cosmos-providers
```

Node ≥ 18, ESM and CJS both work, TypeScript types included. No SDK dependency for any provider — everything talks to the raw REST API with `fetch`.

## Quickstart

Everything in this library — Mercado Pago, Etherfuse, Koywe, SEP, the automatic-settlement engine — is reachable from **one `CosmosClient`**. You configure the pieces you use in a single object; the client exposes each as a property (`cosmos.mercadopago`, `cosmos.etherfuse`, `cosmos.koywe`, `cosmos.sep`, `cosmos.ramp`) instead of you importing and wiring `MercadoPagoProvider`, `EtherfuseClient`, `KoyweClient`, `CosmosRamp`, and `CoinGeckoOracle` by hand.

```ts
import { CosmosClient } from "cosmos-providers";

const cosmos = new CosmosClient({
  mercadopago: {
    accessToken: process.env.MP_ACCESS_TOKEN!, // you read process.env — the library never does
    sandbox: true, // see "Sandbox vs. production" below for why this is explicit
  },
});

const charge = await cosmos.mercadopago!.createPaymentLink({
  amount: 5000,
  currency: "ARS",
  reference: `order-${Date.now()}`,
  description: "cosmos-providers quickstart",
});

console.log("Pay here:", charge.link);
```

Run it:

```bash
MP_ACCESS_TOKEN="your-token" npx tsx quickstart.ts
```

That's `charge.link`, a real Checkout Pro URL, from one `CosmosClient`. Add Etherfuse, Koywe, and automatic settlement to the **same client** by adding to the **same config object** — nothing above changes, you're just filling in more of it:

```ts
const cosmos = new CosmosClient({
  mercadopago: { accessToken: process.env.MP_ACCESS_TOKEN!, sandbox: true },
  etherfuse: { apiKey: process.env.ETHERFUSE_API_KEY!, environment: "sandbox" },
  koywe: { clientId: process.env.KOYWE_CLIENT_ID!, secret: process.env.KOYWE_SECRET!, environment: "sandbox" },
  // Wiring `settlement` turns on `cosmos.ramp`: automatic USDC release once a
  // Mercado Pago payment is confirmed (see "Automatic settlement" below).
  settlement: async ({ wallet, amount, asset }) => ({ txId: await myWallet.transfer(asset, amount, wallet) }),
});

cosmos.mercadopago;  // MercadoPagoProvider — createPaymentLink / createPixCharge
cosmos.etherfuse;    // EtherfuseClient — full PIX/SPEI ramp to Stellar/Solana/Base/Polygon/Monad
cosmos.koywe;        // KoyweClient — ARS/CLP/MXN/COP/PEN/BRL ramp to USDC on Stellar
cosmos.sep;          // SEP-1/10/24 helpers, always available even with an empty config
cosmos.ramp;         // CosmosRamp — only built once a fiat provider + settlement exist
```

Every section below configures one more corner of this same object. Every example is copy-paste-runnable the same way: save it, set the env vars it names, `npx tsx <file>.ts`. The [`examples/`](./examples) folder has the complete, runnable version of each one, plus `npm run flow:all` to run everything in sequence.

### Less code: skip `cosmos.mercadopago!`/`cosmos.koywe!`

Every `MercadoPagoProvider`/`KoyweClient` method shown throughout this README is also callable directly on `cosmos` — no `.mercadopago!`/`.koywe!`, no null-check:

```ts
// Identical to `cosmos.mercadopago!.createPixCharge(...)` — just less to type.
const charge = await cosmos.createPixCharge({ amount: 50, reference: "order-1" });
```

If you've only configured one of `mercadopago`/`koywe`, that's the one used — automatically, there's nothing to pick. If you've configured **both**, and call a method both happen to implement, say which one with `provider` as the first argument (it's stripped before the real method sees the request):

```ts
await cosmos.getQuote({ provider: "koywe", ramp: "onramp", fiatCurrency: "ARS", amount: "10000" });
```

Omitting `provider` while it's genuinely ambiguous **throws**, with both candidates named in the message — it never silently guesses which one you meant. `cosmos.etherfuse` isn't part of this: its API is organized into namespaces (`cosmos.etherfuse.quotes`, `.bankAccounts`, `.wallets`, ...) rather than flat top-level methods like `mercadopago`/`koywe`, so it stays explicit — `cosmos.etherfuse!.quotes.create(...)`.

This is purely a shortcut: `cosmos.mercadopago`/`cosmos.koywe` keep working exactly as shown in every other example in this README, and reach for them directly whenever you want to be explicit (or need a method not in this list, like `mercadopago.regions`/`koywe.environment`).

### `cosmos.createPaymentLink(...)`: the same process for every provider

Unlike the shortcut above (a 1:1 forward), `createPaymentLink` is a real, unified method: it runs the same process — including "quote, then order", which Etherfuse/Koywe need and Mercado Pago doesn't — no matter which provider ends up handling it, and always resolves to **one normalized shape with a QR code**, even when the rail itself has no native one (a Checkout Pro link, for instance — the QR is generated from the link URL).

```ts
const result = await cosmos.createPaymentLink({ amount: 5000, currency: "ARS", reference: "order-1" });

result.provider;      // "mercadopago" | "etherfuse" | "koywe" — whichever handled it
result.link;           // hosted checkout URL, when the rail has one
result.qr;              // ALWAYS present — native QR payload, or one built from `link`/deposit instructions
result.qrImage;         // ALWAYS present — ready-to-embed `data:image/png;...`
result.synthesizedQr;   // true if `qr`/`qrImage` were generated here rather than returned by the provider
```

Auto-picks the provider the same way as everything above (sole configured one, or `{ provider: "..." }` to disambiguate). Etherfuse/Koywe need more than an amount and currency — they deliver crypto directly, so `wallet` is required, and Etherfuse additionally needs `chain` and a `bankAccountId` you've already registered (there's no safe way for a generic method to invent someone's KYC details):

```ts
// Etherfuse: quote + order run for you; the target stablebond is resolved
// live (never hardcoded — see the Etherfuse section below).
await cosmos.createPaymentLink({
  provider: "etherfuse",
  amount: 500,
  currency: "BRL",
  wallet: "USER_SOLANA_ADDRESS",
  chain: "solana",
  bankAccountId: "already-registered-account-id",
});

// Koywe: quote + createOnRampOrder run for you.
await cosmos.createPaymentLink({
  provider: "koywe",
  amount: 10000,
  currency: "ARS",
  wallet: "USER_STELLAR_ADDRESS",
});
```

Missing a field a given provider needs throws immediately, naming exactly what's missing — this never falls back to guessing or fabricating data.

## Features

- **One client, every rail** — `CosmosClient` wires Mercado Pago, Etherfuse, Koywe, and SEP helpers from a single config object; use as many or as few as you need.
- **Automatic onramp** — build a QR or payment link; when the payment is approved the engine releases USDC (or any asset) to the user's wallet.
- **Automatic offramp** — quote crypto → fiat and pay out through the provider.
- **CoinGecko pricing with spread** — the rate and your spread are locked when the payment is built.
- **Webhooks, both ways** — consumes provider webhooks automatically (signature check included) and emits your own signed webhooks.
- **TypeScript, zero heavy deps** — works on Node ≥ 18. Bring your own wallet/signer; the library never touches private keys.

## Configuration

**The library never reads `process.env` on its own.** Every credential is a plain constructor parameter — `accessToken: process.env.MP_ACCESS_TOKEN!` above is *you* reading the environment and handing the value to `CosmosClient` in code; nothing happens automatically just because a `.env` file exists or a variable is set. The same goes for `sandbox`, `environment`, base URLs, everything: you decide these explicitly, in your own code, every time you construct the client.

```ts
// Right: you read process.env and pass it in explicitly.
new CosmosClient({ mercadopago: { accessToken: process.env.MP_ACCESS_TOKEN! } });

// There is no equivalent of this — it doesn't exist and never will:
// new CosmosClient(); // "just reads .env automatically" — not how this library works
```

`.env.example` documents the variables the *scripts in [`examples/`](./examples)* read this way (they're plain Node scripts that happen to call `process.env.X` themselves, same as your app would) — it has nothing to do with how the library itself is configured:

```bash
cp .env.example .env
```

## Try it locally (no credentials needed)

The repo ships a Mercado Pago simulator so you can run every action offline:

```bash
npm run demo      # console runner: quote → link → QR → webhook → auto USDC release → offramp
npm run demo:ui   # web playground at http://localhost:4000 with one button per action
```

## Mercado Pago

`cosmos.mercadopago` is a `MercadoPagoProvider` — one merchant account (or several, one per country) with two genuinely different ways to collect money:

| | `createPaymentLink` | `createPixCharge` |
|---|---|---|
| Markets | AR, BR, MX, CL, CO, PE, UY | Brazil (BRL) only |
| Returns | `charge.link` (hosted checkout URL) | `charge.qr` (EMV "copia e cola") + `charge.qrBase64` |
| **Works in sandbox?** | **Yes** | **No — production only** |

```ts
const cosmos = new CosmosClient({ mercadopago: { accessToken: process.env.MP_ACCESS_TOKEN!, sandbox: true } });

// examples/mercadopago/payment-link.ts — run: npx tsx examples/mercadopago/payment-link.ts
const linkCharge = await cosmos.mercadopago!.createPaymentLink({
  amount: 5000,
  currency: "ARS", // or "BRL", "MXN", ...
  reference: "order-1",
  description: "Buy USDC",
});
linkCharge.link; // hosted checkout URL

// examples/mercadopago/pix.ts — run: npx tsx examples/mercadopago/pix.ts (needs a real production BRL account)
const pixCharge = await cosmos.mercadopago!.createPixCharge({ amount: 50, reference: "order-2" });
pixCharge.qr;       // EMV "copia e cola" string, scannable as-is
pixCharge.qrBase64; // ready-to-embed PNG, if you'd rather show an image
```

**PIX has no sandbox.** Mercado Pago only grants the Payments API scope PIX needs to real, production merchant accounts — a test/sandbox account gets a 401 ("Unauthorized use of live credentials") no matter what you send. `createPixCharge` checks this and throws a clear error immediately if you point it at an account resolved as sandbox, instead of letting that confusing 401 surface. Use `createPaymentLink` to exercise the BRL rail safely in sandbox; PIX itself can only be tested against your real account.

### Sandbox vs. production

`sandbox: true/false` is a plain, explicit config value — never inferred from the token. Mercado Pago issues the *same* `APP_USR-...` prefix for real merchant accounts and for every "usuario de prueba" (test user / sandbox account) you create under them, so the prefix alone can't tell the two apart. Decide it in your own code:

```ts
new CosmosClient({
  mercadopago: {
    accessToken: process.env.MP_ACCESS_TOKEN!,
    sandbox: true, // you know which kind of account this token belongs to — the library doesn't
  },
});
```

(A literal `TEST-...` token — the other credential format Mercado Pago issues — *is* unambiguous and defaults `sandbox` to `true` automatically if you don't set it. `APP_USR-...` never defaults to sandbox on its own.)

### Multi-account: one merchant per country

Mercado Pago issues a **separate merchant account** (and access token) per country — an Argentina token can't process a Brazil/PIX charge, and there's no such thing as a "default" account across countries. Pass every account into the same client, keyed by currency, and every call routes to the right one automatically:

```ts
const cosmos = new CosmosClient({
  mercadopago: {
    accounts: {
      ARS: { accessToken: process.env.MP_AR_ACCESS_TOKEN!, sandbox: true },
      BRL: { accessToken: process.env.MP_BR_ACCESS_TOKEN!, sandbox: true },
    },
  },
});

await cosmos.mercadopago!.createPaymentLink({ amount: 5000, currency: "ARS", reference: "ar-1" }); // uses the AR account
await cosmos.mercadopago!.createPaymentLink({ amount: 50, currency: "BRL", reference: "br-1" });   // uses the BR account
```

### Webhook verification

```ts
app.post("/webhooks/mercadopago", express.json(), async (req, res) => {
  const ok = await cosmos.mercadopago!.verifyWebhook({ body: req.body, headers: req.headers, url: req.url });
  if (!ok) return res.sendStatus(401);
  const notification = await cosmos.mercadopago!.parseWebhook({ body: req.body, headers: req.headers });
  // notification.chargeId -> re-fetch it with cosmos.mercadopago!.getCharge(id) and trust *that*, never the webhook body
  res.sendStatus(200);
});
```

To test webhooks without exposing a public URL, build a signed notification for a sandbox payment yourself:

```ts
const request = await cosmos.mercadopago!.buildTestWebhook(paymentId); // signed exactly like Mercado Pago would
await cosmos.mercadopago!.verifyWebhook(request); // true
```

## Automatic settlement

Mercado Pago on its own just collects fiat — you decide what happens next. Add `settlement` to your `CosmosClient` config and `cosmos.ramp` becomes the layer above that: it builds the charge, watches for the webhook, verifies the paid amount, and releases crypto for you.

**See it prove itself, no credentials needed:** a real payment link only turns "approved" once a human pays it, so `npm run demo` (source: [`examples/mercadopago/settlement-demo.ts`](./examples/mercadopago/settlement-demo.ts)) runs the whole thing against a local Mercado Pago simulator instead — it fakes a payment being approved and builds a **signed webhook request using the same HMAC scheme real Mercado Pago uses**, then feeds it into `cosmos.ramp.handleWebhook(...)`. Everything past the HTTP layer is the real pipeline: signature check, re-fetching the payment, amount matching, calling your `settlement`, and releasing crypto. It also covers duplicate-webhook idempotency, amount-mismatch rejection, and the offramp payout side.

```ts
const cosmos = new CosmosClient({
  mercadopago: { accessToken: process.env.MP_ACCESS_TOKEN!, sandbox: true },
  // oracle defaults to CoinGeckoOracle() (no key needed for light usage) — pass
  // `oracle: { apiKey: process.env.COINGECKO_API_KEY }` for higher rate limits.
  settlement: async ({ wallet, amount, asset }) => {
    const txId = await myWallet.transfer(asset, amount, wallet);
    return { txId };
  },
});

// 1. Build the payment. Rate + spread are locked right here.
const order = await cosmos.ramp!.onramp({
  provider: "mercadopago",
  amount: 5000,            // ARS the user will pay
  currency: "ARS",
  asset: "USDC",
  spread: 0.02,             // your 2% margin over the CoinGecko rate
  wallet: "USER_WALLET_ADDRESS",
  method: "link",           // or "qr" for PIX (production only, see above)
});

console.log(order.charge.link);        // send the user here to pay
console.log(order.quote.cryptoAmount); // USDC they will receive
```

```ts
// 2. Receive the Mercado Pago webhook. That's it — the engine verifies the
// signature, checks the paid amount, and calls your settlement.
app.post("/webhooks/mercadopago", express.json(), async (req, res) => {
  const result = await cosmos.ramp!.handleWebhook("mercadopago", {
    body: req.body,
    headers: req.headers,
    url: req.url,
  });
  res.sendStatus(result.status);
});
```

```ts
// 3. Optional: listen to what happens.
cosmos.ramp!.on("payment:approved", (order) => console.log("paid", order.id));
cosmos.ramp!.on("settlement:released", (order, { txId }) => console.log("USDC sent", txId));
cosmos.ramp!.on("order:completed", (order) => console.log("done", order.id));
```

### How the quote works

When you build a payment, the engine asks CoinGecko for the mid-market rate and applies your spread **at that moment**:

| | Effective rate | Example (rate 1000, spread 2%) |
|---|---|---|
| Onramp | `rate * (1 + spread)` | user pays 1020 ARS per USDC |
| Offramp | `rate * (1 - spread)` | user receives 980 ARS per USDC |

The full breakdown is stored on the order:

```ts
order.quote;
// { asset: "USDC", currency: "ARS", rate: 1000, spread: 0.02,
//   effectiveRate: 1020, fiatAmount: 5000, cryptoAmount: 4.901961, quotedAt: ... }
```

You can also quote without creating an order:

```ts
const quote = await cosmos.ramp!.quote({ direction: "onramp", currency: "ARS", amount: 5000, spread: 0.02 });
```

### Offramp: buy USDC back, pay out fiat

```ts
const order = await cosmos.ramp!.offramp({
  provider: "mercadopago",
  cryptoAmount: 100,               // USDC the user sends you
  currency: "ARS",
  spread: 0.02,
  destination: { email: "user@example.com" }, // Mercado Pago payout destination
});

// Show the user your treasury wallet; when their USDC arrives:
await cosmos.ramp!.confirmCryptoReceived(order.id, { txId: "..." });
// → the engine pays out fiat via the provider automatically.
// If the provider can't pay out, it emits "payout:required" so you can do it
// your way, then call cosmos.ramp!.confirmPayoutSent(order.id).
```

## Etherfuse

`cosmos.etherfuse` is a full ramp client for the [Etherfuse](https://docs.etherfuse.com) API (BRL·PIX and MXN·SPEI against Solana, Stellar, Base, Polygon, Monad). Unlike Mercado Pago (which only collects fiat — the crypto leg is your own `settlement`), Etherfuse moves the crypto itself, so it doesn't go through `cosmos.ramp`:

```ts
const cosmos = new CosmosClient({ etherfuse: { apiKey: process.env.ETHERFUSE_API_KEY!, environment: "sandbox" } });

const quote = await cosmos.etherfuse!.quotes.create({ /* ... */ });
const receipt = await quote.createOrder({ bankAccountId: "...", publicKey: "WALLET" });
const qr = receipt.createPixQr();
```

**Don't hardcode the target asset.** Etherfuse's onramp delivers one of its own tokenized stablebonds (CETES for MXN, TESOURO for BRL), not raw USDC, and which mint is "active" for a given chain rotates over time. Resolve it live instead:

```ts
const catalog = await cosmos.etherfuse!.lookup.stablebonds(); // public, no API key needed
```

Etherfuse webhook verification (Node-only) lives in the `cosmos-providers/webhooks` subpath. See [`examples/etherfuse/quickstart.ts`](./examples/etherfuse/quickstart.ts) for a minimal single-chain run, or [`examples/etherfuse/full-flow.ts`](./examples/etherfuse/full-flow.ts) for the complete flow across every supported chain, including automatic Stellar trustline setup.

## Koywe

`cosmos.koywe` is a dependency-free client for the [Koywe](https://docs-crypto.koywe.com) ramp API (ARS/CLP/MXN/COP/PEN/BRL ↔ USDC on Stellar). Like Etherfuse, Koywe delivers USDC directly to a Stellar address as part of the order, so it doesn't go through `cosmos.ramp` either:

```ts
const cosmos = new CosmosClient({
  koywe: {
    clientId: process.env.KOYWE_CLIENT_ID!,
    secret: process.env.KOYWE_SECRET!,
    environment: "sandbox", // or "production" — picks the matching base URL
    usdcIssuer: process.env.PUBLIC_USDC_ISSUER,
  },
});

// On-ramp: ARS -> USDC on Stellar
const providers = await cosmos.koywe!.getPaymentProviders("ARS"); // WIREAR (CVU), QRI-AR (QR)...
const quote = await cosmos.koywe!.getQuote({ ramp: "onramp", fiatCurrency: "ARS", amount: "10000", paymentMethodId: providers[0].id });
const order = await cosmos.koywe!.createOnRampOrder({ quoteId: quote.id, stellarAddress: "USER_STELLAR_ADDRESS" });

order.deposit?.cvu;      // WIREAR: CVU/alias to transfer to
order.interactiveUrl;    // QRI/Khipu: hosted checkout URL instead

// Off-ramp: USDC -> ARS to a registered bank account
const account = await cosmos.koywe!.createBankAccount({ email, accountNumber, countryCode: "AR", currencySymbol: "ARS" });
const offQuote = await cosmos.koywe!.getQuote({ ramp: "offramp", fiatCurrency: "ARS", amount: "100" });
const offOrder = await cosmos.koywe!.createOffRampOrder({ quoteId: offQuote.id, bankAccountId: account.id });
// user sends USDC to offOrder.depositAddress, then:
await cosmos.koywe!.submitTxHash(offOrder.id, stellarTxHash);
```

Stellar addresses are validated locally (a from-scratch `StrKey` check — no `@stellar/stellar-sdk` dependency) before ever reaching the API. Poll orders with `cosmos.koywe!.getOrder(id)` (or `getOrderByExternalId` after a hosted redirect); delegated KYC lives in `createAccount` + `checkAccount`.

## SEP-1 / SEP-10 / SEP-24

`cosmos.sep` is always available, even with an empty `CosmosClient` config — composable, framework-agnostic functions for the Stellar Ecosystem Proposals that cover discovery → authentication → the hosted deposit/withdraw flow. Not tied to Koywe or Etherfuse — point them at any anchor's domain (a reference [test anchor](https://testanchor.stellar.org), Vibrant, Settle, your own SEP-24 server...):

```ts
const cosmos = new CosmosClient({}); // no providers needed — cosmos.sep still works

// 1. SEP-1: discover the anchor's endpoints.
const toml = await cosmos.sep.fetchStellarToml("testanchor.stellar.org");

// 2. SEP-10: prove control of the account. The library never touches private
//    keys — bring your own signer (a server-side Keypair, Freighter...).
const jwt = await cosmos.sep.authenticateSep10({
  webAuthEndpoint: toml.WEB_AUTH_ENDPOINT,
  account: "USER_STELLAR_ADDRESS",
  sign: (challengeXdr, networkPassphrase) => myWallet.signTransaction(challengeXdr, networkPassphrase),
});

// 3. SEP-24: kick off a deposit; open `url` for the user's hosted KYC/amount entry.
const { url, id } = await cosmos.sep.startDeposit({
  transferServer: toml.TRANSFER_SERVER_SEP0024,
  jwt,
  assetCode: "USDC",
  account: "USER_STELLAR_ADDRESS",
});

// 4. Poll until it settles.
const tx = await cosmos.sep.getSep24Transaction({ transferServer: toml.TRANSFER_SERVER_SEP0024, jwt, id });
tx.status; // "completed" | "pending_user_transfer_start" | ... — see SEP24_TERMINAL_STATUSES
```

`startWithdraw` mirrors `startDeposit` for the Stellar → fiat direction. This covers SEP-1/10/24 (anchor discovery, auth, and the interactive flow that most anchors and wallets build against) — SEP-6/12/31/38 (programmatic transfers, dedicated KYC, direct fiat payments, and quotes) aren't implemented yet.

## Custom providers

Wrap any payment API into a fully working provider — payment links, QRs, status normalization and webhooks included — without implementing `PaymentProvider` by hand. Pass it to `CosmosClient` via `customProviders`, alongside (or instead of) `mercadopago`:

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

const cosmos = new CosmosClient({ customProviders: [acme], settlement: /* ... */ });
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

Whatever the adapters return is still normalized and validated (a charge without a link/QR/deposit fails fast at creation), so `cosmos.ramp!.handleWebhook` and `order.charge.link` behave identically across built-in and custom providers.

## Emitting your own webhooks

Get notified on your backend(s) whenever an order moves — pass `webhooks` to `CosmosClient`:

```ts
const cosmos = new CosmosClient({
  mercadopago: { accessToken: process.env.MP_ACCESS_TOKEN!, sandbox: true },
  settlement: /* ... */,
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

By default `cosmos.ramp` keeps orders in memory (fine for dev). In production, implement the small `OrderStore` interface (5 methods) over your database and pass it as `store`:

```ts
const cosmos = new CosmosClient({ mercadopago: { /* ... */ }, settlement: /* ... */, store: new MyPostgresStore() });
```

## Safety model

- Webhook bodies are never trusted: the engine re-fetches the payment from the provider API before settling.
- The paid amount must match the quoted amount (± `defaults.amountTolerance`).
- Duplicate webhooks are idempotent — an order settles once.
- If your settlement throws, the order stays in `"settling"`; retry with `cosmos.ramp!.retrySettlement(orderId)`.

## Standalone PIX QR codes

Generate and parse PIX BR Codes (EMV "copia e cola") without any API — no `CosmosClient` needed, this one's a plain utility:

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

## Standard identifiers: Chain, Asset, FiatCurrency, Country

Every provider/client in this library shares one set of identifiers instead of scattering raw string literals — `Chain.Stellar` instead of `"stellar"`, `Asset.USDC` instead of `"USDC"`. A typo becomes a compile error instead of a silent 404:

```ts
import { Chain, Asset, FiatCurrency, Country } from "cosmos-providers";

Chain.Stellar;       // "stellar" — also: Solana, Base, Polygon, Monad
Asset.USDC;          // "USDC" — also: USDT, DAI, BTC, ETH, SOL, XLM, and Etherfuse's
                     // own stablebonds: CETES, TESOURO, CARN, JOGO
FiatCurrency.ARS;    // "ARS" — also: BRL, MXN, CLP, COP, PEN, UYU
Country.AR;          // "AR" — also: BR, MX, CL, CO, PE, UY
```

Each is a frozen const object that also works as a type (`function f(c: Chain) {}` and `f(Chain.Stellar)` both type-check) — a `Chain` **is** the string `"stellar"` at runtime, so this is purely a typed front door: existing code that already passes plain strings keeps working unchanged. Stablebond addresses (which mint on which chain) are deliberately **not** baked into `Asset` — resolve those at runtime from `cosmos.etherfuse!.lookup.stablebonds()`, never hardcode them (see [Etherfuse](#etherfuse) above).

## Using the pieces directly

`CosmosClient` is the recommended entry point, but every piece it wires up is also a plain, independently importable class/function, for when you'd rather not go through the unified client — a library embedding just the PIX QR engine, or a service that only ever talks to one provider:

```ts
import { CosmosRamp, MercadoPagoProvider, EtherfuseClient, KoyweClient, CoinGeckoOracle, fetchStellarToml } from "cosmos-providers";
```

`CosmosClient` itself is a thin composition layer over exactly these — `new CosmosClient({ mercadopago, settlement })` and `new CosmosRamp({ providers: [new MercadoPagoProvider(mercadopago)], settlement })` end up equivalent. Everything documented above under each provider's `cosmos.X` still applies one-for-one to the class directly (`new MercadoPagoProvider(...)` has the exact same `createPaymentLink`/`createPixCharge`/etc. as `cosmos.mercadopago`).

## Errors

| Error | Meaning |
|---|---|
| `ProviderError` | A provider API call failed (`.provider`, `.status`, `.body`) |
| `OracleError` | CoinGecko couldn't price the pair |
| `SettlementError` | The crypto/fiat leg failed to move |
| `WebhookSignatureError` | Invalid webhook signature |
| `CosmosError` | Base class for all of the above |
| `KoyweError` | A Koywe API call failed (`.code`, `.statusCode`) |
| `SepError` | A SEP-1/10/24 call failed (`.sep`, `.statusCode`) |

## Examples

Every example in [`examples/`](./examples) is standalone and runnable — the snippets throughout this README are excerpts of these files. They're organized one folder per provider:

```
examples/
├── quickstart.ts                        full CosmosClient + automatic settlement, one file
├── all-flows.ts                         runs everything below, one after another (npm run flow:all)
├── mercadopago/
│   ├── payment-link.ts                  npm run flow:mercadopago:link
│   ├── pix.ts                           npm run flow:mercadopago:pix
│   ├── settlement-demo.ts               npm run demo — simulated webhook → automatic USDC release
│   ├── demo-ui.ts                       npm run demo:ui — same demo, in a local web UI
│   ├── confirm-order-on-return.ts       fallback for when the webhook is slow/unreachable
│   └── webhook-server.ts                minimal Node webhook receiver
├── etherfuse/
│   ├── quickstart.ts                    npm run flow:etherfuse:quickstart — single chain, minimal
│   ├── full-flow.ts                     npm run flow — every supported chain + trustlines
│   └── webhook-server.ts                Express webhook receiver (illustrative)
├── koywe/
│   └── full-flow.ts                     npm run flow:koywe — on-ramp + off-ramp + KYC
├── sep/
│   └── full-flow.ts                     npm run flow:sep — SEP-1/10/24 against the public test anchor
└── frontend/
    └── pix-qr.tsx                       React PIX QR + rate display (illustrative)
```

```bash
npm run demo                    # settlement demo: simulated webhook → automatic USDC release
npm run demo:ui                 # same demo, with a local web UI at http://localhost:4000
npm run flow:mercadopago:link   # Mercado Pago payment link
npm run flow:mercadopago:pix    # Mercado Pago PIX (needs a real production BRL account)
npm run flow                    # Etherfuse, every supported chain
npm run flow:etherfuse:quickstart # Etherfuse, single chain, minimal
npm run flow:koywe              # Koywe on-ramp + off-ramp + KYC
npm run flow:sep                # SEP-1/10/24 against the public test anchor
npm run flow:all                # everything above, one after another
```

These example scripts read per-country/per-provider env vars from `.env` (`MP_AR_ACCESS_TOKEN`/`MP_BR_ACCESS_TOKEN`, `ETHERFUSE_API_KEY`, `KOYWE_CLIENT_ID`/`KOYWE_SECRET`, ...) purely so they're runnable without editing code — that's the scripts calling `process.env.X` themselves and passing it to `CosmosClient`, same as the Configuration section above. See `.env.example` for the full list.

## Scripts

```bash
npm run build      # tsup → dist/ (ESM + CJS + .d.ts)
npm run typecheck  # tsc --noEmit
npm test           # vitest
```

## License

MIT
