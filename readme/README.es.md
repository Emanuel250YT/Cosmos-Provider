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

Cualquier otro riel se puede enchufar implementando la interfaz `PaymentProvider` (crear cobro, consultar cobro, verificar/parsear webhook, payout opcional).

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

## Licencia

MIT
