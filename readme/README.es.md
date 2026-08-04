# cosmos-providers

Toolkit de onramp/offramp cripto para Latinoamérica. Cobrá fiat con rieles de pago regionales (QR y links de pago de Mercado Pago, PIX, SPEI) y liberá stablecoins automáticamente, con precio de CoinGecko más tu propio spread.

**Documentación en otros idiomas:** [English](../README.md) · [Português](./README.pt-BR.md)

## Características

- **Agnóstico de proveedor** — un solo motor, proveedores regionales enchufables (Mercado Pago incluido, PIX/SPEI vía Etherfuse, o escribí el tuyo).
- **Onramp automático** — generás un QR o link de pago; cuando el pago se aprueba, el motor libera USDC (o cualquier activo) a la wallet del usuario.
- **Offramp automático** — cotizás cripto → fiat y pagás a través del proveedor.
- **Precio de CoinGecko con spread** — la cotización y tu spread quedan fijados al construir el pago.
- **Webhooks en ambas direcciones** — consume webhooks del proveedor automáticamente (con verificación de firma) y emite tus propios webhooks firmados.
- **TypeScript, sin dependencias pesadas** — Node ≥ 18. La librería nunca toca claves privadas; el envío de cripto es tuyo.

## Instalación

```bash
npm install cosmos-providers
```

## Probalo localmente (sin credenciales)

El repo incluye un simulador de Mercado Pago para ejecutar cada acción offline:

```bash
npm run demo      # runner de consola: quote → link → QR → webhook → liberación automática de USDC → offramp
npm run demo:ui   # playground web en http://localhost:4000 con un botón por acción
```

## Inicio rápido: vender USDC vía Mercado Pago

```ts
import { CosmosRamp, CoinGeckoOracle, MercadoPagoProvider } from "cosmos-providers";

const ramp = new CosmosRamp({
  providers: [
    new MercadoPagoProvider({
      accessToken: process.env.MP_ACCESS_TOKEN,
      webhookSecret: process.env.MP_WEBHOOK_SECRET,
      notificationUrl: "https://miapp.com/webhooks/mercadopago",
    }),
  ],
  oracle: new CoinGeckoOracle(),
  // Tu código que envía la cripto. Se llama automáticamente tras el pago.
  settlement: async ({ wallet, amount, asset }) => {
    const txId = await miWallet.transfer(asset, amount, wallet);
    return { txId };
  },
});

// 1. Construí el pago. La cotización + spread quedan fijados acá.
const order = await ramp.onramp({
  provider: "mercadopago",
  amount: 50000,          // ARS que paga el usuario
  currency: "ARS",
  asset: "USDC",
  spread: 0.02,           // tu margen del 2% sobre CoinGecko
  wallet: "WALLET_DEL_USUARIO",
  method: "link",         // o "qr"
});

console.log(order.charge.link);        // mandá al usuario a pagar acá
console.log(order.quote.cryptoAmount); // USDC que va a recibir
```

```ts
// 2. Recibí el webhook de Mercado Pago. Listo — el motor verifica la firma,
// chequea el monto pagado y llama a tu settlement.
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
// 3. Opcional: escuchá lo que pasa.
ramp.on("payment:approved", (order) => console.log("pagado", order.id));
ramp.on("settlement:released", (order, { txId }) => console.log("USDC enviado", txId));
ramp.on("order:completed", (order) => console.log("completado", order.id));
```

## Cómo funciona la cotización

Al construir un pago, el motor pide a CoinGecko la cotización de mercado y aplica tu spread **en ese momento**:

| | Cotización efectiva | Ejemplo (cotización 1000, spread 2%) |
|---|---|---|
| Onramp | `rate * (1 + spread)` | el usuario paga 1020 ARS por USDC |
| Offramp | `rate * (1 - spread)` | el usuario recibe 980 ARS por USDC |

El desglose completo queda guardado en la orden:

```ts
order.quote;
// { asset: "USDC", currency: "ARS", rate: 1000, spread: 0.02,
//   effectiveRate: 1020, fiatAmount: 50000, cryptoAmount: 49.019608, quotedAt: ... }
```

También podés cotizar sin crear una orden:

```ts
const quote = await ramp.quote({ direction: "onramp", currency: "ARS", amount: 50000, spread: 0.02 });
```

## Offramp: recomprar USDC y pagar fiat

```ts
const order = await ramp.offramp({
  provider: "mercadopago",
  cryptoAmount: 100,               // USDC que te envía el usuario
  currency: "ARS",
  spread: 0.02,
  destination: { email: "usuario@ejemplo.com" }, // destino del pago en Mercado Pago
});

// Mostrale al usuario tu wallet de tesorería; cuando llegue su USDC:
await ramp.confirmCryptoReceived(order.id, { txId: "..." });
// → el motor paga el fiat vía el proveedor automáticamente.
// Si el proveedor no soporta payouts, emite "payout:required" para que lo
// hagas a tu manera y luego llames ramp.confirmPayoutSent(order.id).
```

## Métodos de pago por región

`MercadoPagoProvider` cubre AR, BR, MX, CL, CO, PE, UY (ARS, BRL, MXN, CLP, COP, PEN, UYU):

| `method` | Qué obtenés |
|---|---|
| `"link"` | Link de pago de Checkout Pro (`order.charge.link`) |
| `"qr"` (BRL) | QR PIX: string EMV (`order.charge.qr`) + PNG base64 (`order.charge.qrBase64`) |
| `"qr"` (con `qrPos`) | QR dinámico in-store de Mercado Pago |
| `"auto"` | El mejor método para la moneda (default) |

Cualquier otro riel se puede enchufar con `createCustomProvider` (ver abajo) o implementando la interfaz `PaymentProvider` directamente.

## Sandbox de Mercado Pago

Pasá un access token `TEST-...` y el proveedor entra en modo sandbox automáticamente (o forzalo con `sandbox: true`): los links de pago usan `sandbox_init_point`, así que todo el flujo se puede probar con [usuarios y tarjetas de prueba](https://www.mercadopago.com.ar/developers/es/docs/checkout-pro/additional-content/your-integrations/test/accounts) antes de salir a producción.

```ts
const mp = new MercadoPagoProvider({
  accessToken: process.env.MP_TEST_ACCESS_TOKEN, // "TEST-..." → mp.sandbox === true
  webhookSecret: process.env.MP_WEBHOOK_SECRET,
});
```

Para probar webhooks sin exponer una URL pública, generá una notificación firmada de un pago sandbox y pasásela directo al motor — ejercita el pipeline real (verificación de firma → parseo → re-consulta a la API → settlement):

```ts
const request = await mp.buildTestWebhook(paymentId); // firmado exactamente como lo haría Mercado Pago
const result = await ramp.handleWebhook("mercadopago", request);
// → { ok: true, outcome: "settled", orderId: "..." }
```

## Proveedores custom

Convertí cualquier API de pagos en un proveedor completo — links de pago, QRs, normalización de estados y webhooks incluidos — sin implementar `PaymentProvider` a mano. Vos ponés las llamadas crudas a tu API; las respuestas se adaptan al formato Cosmos automáticamente:

```ts
import { createCustomProvider } from "cosmos-providers";

const acme = createCustomProvider({
  name: "acme",
  currencies: ["ARS"],

  // Llamadas crudas a tu API — devolvé la respuesta tal cual.
  createCharge: (req) => acmeApi.post("/charges", { amount: req.amount, ref: req.reference }),
  getCharge: (id) => acmeApi.get(`/charges/${id}`),
  createPayout: (req) => acmeApi.post("/payouts", req), // opcional

  // Mapeá estados del proveedor a: pending | approved | rejected | refunded | canceled | expired.
  // Hay una tabla de alias incorporada ("paid"/"succeeded" → approved, ...); los estados
  // desconocidos resuelven a "pending" — nunca a una aprobación falsa.
  statusMap: { ok_dale: "approved" },

  // Webhooks: HMAC-SHA256 de fábrica, o traé tu propio verify/parse.
  webhook: {
    hmac: { secret: process.env.ACME_WEBHOOK_SECRET, header: "x-acme-signature" },
    chargeIdPaths: ["data.id"], // dónde vive el id del pago (este es el default)
  },
});

const ramp = new CosmosRamp({ providers: [acme], /* ... */ });
```

Los campos comunes de respuesta (`checkout_url`, `init_point`, `payment_url`, `qr_code`, `qr_code_base64`, `transaction_amount`, `external_reference`, objetos anidados `data`/`payment`...) se auto-mapean. Para formatos raros, tomá control total con `adapt`:

```ts
createCustomProvider({
  // ...
  adapt: {
    charge: (raw) => ({ id: raw.tx.id, link: raw.tx.hosted_page }),
    chargeState: (raw) => ({ status: raw.tx.phase, amount: raw.tx.cents / 100 }),
  },
});
```

Lo que devuelvan los adaptadores igual se normaliza y valida (un cobro sin link/QR/depósito falla rápido al crearse), así que `ramp.handleWebhook` y `order.charge.link` se comportan idéntico entre proveedores incorporados y custom.

## Emitir tus propios webhooks

Recibí notificaciones en tu(s) backend(s) cada vez que una orden avanza:

```ts
const ramp = new CosmosRamp({
  // ...
  webhooks: {
    endpoints: [{ url: "https://miapp.com/hooks/cosmos", secret: process.env.HOOK_SECRET }],
  },
});
```

Cada entrega va firmada (`x-cosmos-signature: t=...,v1=...`). Verificala al recibir:

```ts
import { verifyCosmosSignature } from "cosmos-providers";

const ok = await verifyCosmosSignature(rawBody, req.get("x-cosmos-signature"), secret);
```

Eventos: `order.created`, `payment.approved`, `payment.rejected`, `payment.mismatch`, `settlement.released`, `settlement.failed`, `payout.required`, `order.completed`.

## Persistencia

Por defecto las órdenes viven en memoria (bien para desarrollo). En producción, implementá la interfaz `OrderStore` (5 métodos) sobre tu base de datos y pasala como `store`.

## Modelo de seguridad

- Nunca se confía en el cuerpo del webhook: el motor re-consulta el pago en la API del proveedor antes de liquidar.
- El monto pagado debe coincidir con el cotizado (± `defaults.amountTolerance`).
- Los webhooks duplicados son idempotentes — una orden se liquida una sola vez.
- Si tu settlement falla, la orden queda en `"settling"`; reintentá con `ramp.retrySettlement(orderId)`.

## QR PIX standalone

Generá y parseá BR Codes PIX (EMV "copia e cola") sin ninguna API:

```ts
import { Pix } from "cosmos-providers";

const qr = Pix.create({
  pixKey: "cobros@miempresa.com.br",
  merchantName: "Mi Empresa",
  merchantCity: "Sao Paulo",
  amount: 99.9,
});

await qr.toDataURL(); // PNG data URL para <img src>
qr.toString();        // payload "copia e cola"
Pix.parse("00020126..."); // decodificar + validar cualquier BR Code
```

## Cliente Etherfuse (API de ramp PIX/SPEI)

El paquete también incluye un cliente completo para la API de ramp de [Etherfuse](https://docs.etherfuse.com) (BRL·PIX y MXN·SPEI contra Solana, Stellar, Base, Polygon):

```ts
import { EtherfuseClient } from "cosmos-providers";

const client = new EtherfuseClient({ apiKey: process.env.ETHERFUSE_API_KEY, environment: "sandbox" });
```

La verificación de webhooks de Etherfuse (solo Node) vive en el subpath `cosmos-providers/webhooks`. Mirá la carpeta [examples](../examples) para flujos completos.

## Cliente Koywe (ARS/CLP/MXN/COP/PEN/BRL ↔ USDC en Stellar)

Cliente sin dependencias para la API de ramp de [Koywe](https://docs-crypto.koywe.com). A diferencia de los `PaymentProvider` de arriba (que solo cobran fiat — la pata cripto es tu propio `settlement`), Koywe entrega USDC directamente a una dirección de Stellar como parte de la orden, así que se expone como cliente standalone, igual que `EtherfuseClient`:

```ts
import { KoyweClient } from "cosmos-providers";

const koywe = new KoyweClient({
  clientId: process.env.KOYWE_CLIENT_ID,
  secret: process.env.KOYWE_SECRET,
  baseUrl: process.env.KOYWE_BASE_URL, // https://api-sandbox.koywe.com en sandbox
  usdcIssuer: process.env.PUBLIC_USDC_ISSUER,
});

// Onramp: ARS -> USDC en Stellar
const providers = await koywe.getPaymentProviders("ARS"); // WIREAR (CVU), QRI-AR (QR)...
providers[0].deposit?.cvu; // WIREAR: CVU/alias — estático por método de pago, se lee antes de crear la orden
const quote = await koywe.getQuote({ ramp: "onramp", fiatCurrency: "ARS", amount: "10000", paymentMethodId: providers[0].id });
const order = await koywe.createOnRampOrder({ quoteId: quote.id, stellarAddress: "DIRECCION_STELLAR_DEL_USUARIO" });

order.interactiveUrl;    // URL de checkout/estado, devuelta para cualquier rail (WIREAR, QRI, Khipu...)

// Offramp: el usuario envía USDC a la dirección de depósito de la cuenta:
const depositAddress = await koywe.getClientAddress();
```

Las direcciones de Stellar se validan localmente (`StrKey` implementado desde cero — sin depender de `@stellar/stellar-sdk`) antes de llegar a la API. Consultá órdenes con `koywe.getOrder(id)` (o `getOrderByExternalId` tras un redirect hosteado); el KYC delegado vive en `createAccount` + `checkAccount`.

## SEP-1 / SEP-10 / SEP-24 — cualquier anchor compatible con SEP

Funciones componibles, agnósticas de framework, para las Stellar Ecosystem Proposals que cubren descubrimiento → autenticación → el flujo hosteado de depósito/retiro. No están atadas a Koywe ni a Etherfuse — apuntalas al dominio de cualquier anchor (un [test anchor](https://testanchor.stellar.org) de referencia, u otro):

```ts
import { fetchStellarToml, authenticateSep10, startDeposit, getSep24Transaction } from "cosmos-providers";

const toml = await fetchStellarToml("testanchor.stellar.org"); // SEP-1: descubrimiento

// SEP-10: la librería nunca toca claves privadas — traés tu propio signer.
const jwt = await authenticateSep10({
  webAuthEndpoint: toml.WEB_AUTH_ENDPOINT,
  account: "DIRECCION_STELLAR_DEL_USUARIO",
  sign: (challengeXdr, networkPassphrase) => miWallet.signTransaction(challengeXdr, networkPassphrase),
});

// SEP-24: iniciás el depósito, abrís `url` para el KYC/monto hosteado, y consultás el estado.
const { url, id } = await startDeposit({ transferServer: toml.TRANSFER_SERVER_SEP0024, jwt, assetCode: "USDC", account: "DIRECCION_STELLAR_DEL_USUARIO" });
const tx = await getSep24Transaction({ transferServer: toml.TRANSFER_SERVER_SEP0024, jwt, id });
```

`startWithdraw` es el espejo de `startDeposit` para la dirección Stellar → fiat. Esto cubre SEP-1/10/24 (descubrimiento, auth y el flujo interactivo que usan la mayoría de anchors y wallets) — SEP-6/12/31/38 (transferencias programáticas, KYC dedicado, pagos fiat directos y cotizaciones) todavía no están implementados.

## Licencia

MIT
