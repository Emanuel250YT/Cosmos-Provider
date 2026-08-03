# cosmos-providers

Cliente TypeScript para la [API de Etherfuse](https://docs.etherfuse.com/api-reference/introduction) — onramp/offramp de stablecoins con **PIX (BRL)** y SPEI (MXN) — con soporte de primera clase para **QR de pagos PIX**.

- 🏗️ **Estructura estilo Discord.js**: un `Client` central con managers por recurso (`client.orders`, `client.quotes`, ...) que devuelven estructuras con métodos (`order.createPixQr()`, `quote.createOrder()`).
- ⚛️ **Atomic design**: `atoms` (REST, errores, CRC16) → `molecules` (estructuras: `Order`, `Quote`, `Pix`) → `organisms` (managers) → `client`.
- 🌐 **Backend y frontend**: entry principal isomórfico (solo necesita `fetch`); la verificación de webhooks (Node-only) vive en el subpath `cosmos-providers/webhooks`.
- 🇧🇷 **PIX nativo**: genera y parsea BR Codes EMV (copia-e-cola) con CRC16, y los renderiza como QR (PNG data URL, SVG o terminal).
- 📡 **Eventos en vivo**: WebSocket con reconexión automática — `client.on("orderUpdated", ...)`.

```bash
npm install cosmos-providers
```

Requiere Node ≥ 18 (o cualquier navegador moderno). Para eventos WebSocket en Node < 22, pasa la clase del paquete [`ws`](https://www.npmjs.com/package/ws) en las opciones.

## Inicio rápido (backend)

```ts
import { EtherfuseClient } from "cosmos-providers";

const client = new EtherfuseClient({
  apiKey: process.env.ETHERFUSE_API_KEY!,
  environment: "sandbox", // o "production"
});

// 1. Quote: 500 BRL → USDC en Solana (expira en 2 min)
const quote = await client.quotes.create({
  customerId: (await client.customers.me()).id,
  blockchain: "solana",
  sourceAmount: "500",
  quoteAssets: {
    type: "onramp",
    sourceAsset: "BRL",
    targetAsset: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
  },
});

// 2. Orden fijando la quote
const receipt = await quote.createOrder({
  bankAccountId: "...",       // cuenta PIX del cliente
  publicKey: "WALLET_SOLANA", // o cryptoWalletId para wallets embebidas
});

// 3. QR PIX para que el usuario pague
const qr = receipt.createPixQr();
if (qr) {
  const png = await qr.toDataURL(); // "data:image/png;base64,..." → <img src>
  const copiaECola = qr.toString(); // para el botón "copiar código PIX"
}

// 4. Seguir la orden
const order = await receipt.fetch();
await order.waitForStatus("completed");
```

## QR PIX sin API (frontend o backend)

`Pix` funciona standalone — no necesita API key ni red:

```ts
import { Pix } from "cosmos-providers";

// Generar un cobro PIX estático propio
const qr = Pix.create({
  pixKey: "cobros@miempresa.com.br", // CPF/CNPJ, email, teléfono o llave aleatoria
  merchantName: "Mi Empresa",
  merchantCity: "Sao Paulo",
  amount: 99.9,          // opcional: sin monto, lo escribe el pagador
  txid: "PEDIDO42",      // opcional
});

await qr.toDataURL({ width: 320 }); // PNG data URL
await qr.toSVG();                   // SVG escalable
await qr.toTerminal();              // QR ASCII para CLIs
qr.toString();                      // payload "copia e cola"

// Envolver un copia-e-cola existente (p. ej. el que devolvió Etherfuse)
const wrapped = Pix.fromCode("00020126...", { validate: false });

// Decodificar y validar cualquier BR Code
const parsed = Pix.parse("00020126...");
// → { pixKey, merchantName, amount, txid, valid, ... }
```

## Lookup público (seguro para el navegador)

La Lookup API no requiere API key, así que puede llamarse directo desde frontend:

```ts
import { LookupClient } from "cosmos-providers";

const lookup = new LookupClient();
const brl = await lookup.usdToBrl();
console.log(brl?.rate); // "5.07600"
```

> ⚠️ Nunca uses `EtherfuseClient` (con API key) en el navegador. El flujo correcto: tu backend crea la orden y le pasa al frontend solo el código PIX; el frontend lo renderiza con `Pix.fromCode(...)`.

## Cuentas bancarias PIX y CLABE

```ts
const me = await client.customers.me();

// BRL / PIX
await client.bankAccounts.createPixPersonal(me.id, {
  firstName: "João",
  lastName: "Silva",
  cpf: "12345678909",
  pixKey: "joao@exemplo.com.br",
  pixKeyType: "email", // cpf | cnpj | email | phone | random
});

// MXN / SPEI
await client.bankAccounts.createClabePersonal(me.id, {
  firstName: "Ana",
  paternalLastName: "García",
  maternalLastName: "López",
  birthDate: "19900515",
  birthCountryIsoCode: "MX",
  curp: "GALA900515MDFRPN08",
  rfc: "GALA900515AB1",
  clabe: "646180157000000004",
});
```

## Eventos en vivo (estilo Discord.js)

```ts
client.on("ready", () => console.log("conectado"));
client.on("orderUpdated", ({ orderId, order }) => {
  console.log(orderId, "→", order?.status);
});
client.on("disconnect", () => {}); // se reconecta solo (backoff exponencial)

await client.connect();
```

En Node < 22: `new EtherfuseClient({ apiKey, webSocket: (await import("ws")).WebSocket })`.

## Webhooks firmados (backend)

Etherfuse firma cada webhook con HMAC-SHA256 sobre el JSON canonicalizado (RFC 8785) en la cabecera `X-Signature`:

```ts
import { constructEvent } from "cosmos-providers/webhooks";

app.post("/webhooks/etherfuse", express.raw({ type: "application/json" }), (req, res) => {
  const event = constructEvent(
    req.body.toString("utf8"),
    req.header("X-Signature"),
    process.env.ETHERFUSE_WEBHOOK_SECRET!, // base64, devuelto UNA vez al crear el webhook
  );
  if (event.type === "order_updated") { /* ... */ }
  res.sendStatus(200);
});
```

## Sandbox

```ts
// Simula el depósito fiat de una orden onramp (solo sandbox)
await client.sandbox.fiatReceived(receipt.orderId);
```

## Arquitectura (atomic design)

| Capa | Carpeta | Contenido |
|---|---|---|
| Atoms | `src/atoms` | `REST` (transporte HTTP con reintentos), errores, constantes/`Routes`, CRC16, EventEmitter tipado |
| Molecules | `src/molecules` | Estructuras: `Order`, `OrderReceipt`, `Quote`, `BankAccount`, `Customer`, `Wallet`, `Webhook`, `Pix`/`PixQr` |
| Organisms | `src/organisms` | Managers: `OrderManager`, `QuoteManager`, `BankAccountManager`, `LookupManager`, ... |
| Client | `src/client` | `EtherfuseClient` (API key + eventos), `LookupClient` (público), `WebSocketManager` |

### Escape hatch

Cualquier endpoint aún no tipado se puede llamar con la capa REST:

```ts
await client.rest.get("/ramp/organization/...");
await client.rest.post("/ramp/...", { body: "..." });
```

Todos los paths viven en `Routes` (`src/atoms/constants.ts`). Los marcados `@inferred` siguen la convención de la API pero no aparecen literalmente en la documentación pública — si alguno devuelve 404, corrígelo ahí y toda la librería lo hereda.

## Errores

- `EtherfuseAPIError` — respuesta HTTP de error (`.status`, `.body`, `.isRetryable`; 424/429/5xx se reintentan solos con backoff).
- `EtherfuseNetworkError` — fallo de red/timeout.
- `PixError` — BR Code inválido o parámetros de cobro incorrectos.
- `WebhookVerificationError` — firma de webhook inválida.

Los imports internos usan el alias `@/` (→ `src/`), configurado en `tsconfig.json`, resuelto por tsup en el build y por `vitest.config.ts` en los tests.

## Tests

```bash
npm test           # suite unitaria (Vitest): PIX/EMV, CRC16, REST, webhooks, managers, órdenes
npm run test:e2e   # E2E contra el sandbox real (necesita ETHERFUSE_API_KEY; sin key se salta)
npm run flow       # flujo completo ejecutable: cuenta PIX → quote → orden → QR → depósito simulado → completed
```

Para los tests E2E y el flujo completo, crea un `.env` en la raíz:

```
ETHERFUSE_API_KEY=tu_key_de_sandbox
# opcionales:
# ETHERFUSE_BLOCKCHAIN=solana
# ETHERFUSE_TARGET_ASSET=EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v
# ETHERFUSE_WALLET=TU_WALLET
```

### Notas del sandbox (verificadas contra la API real)

- `GET /ramp/me` devuelve el UUID como `id` (no `customerId`); `customer.id` lo resuelve.
- `GET /ramp/assets` exige `blockchain`, `currency` **y** `wallet` como query params.
- Solo se permite **una cuenta BRL por organización**; el flujo reutiliza la existente.
- El sandbox rechaza CLABEs de STP (prefijo 646) al registrar cuentas MXN propias.
- Las órdenes exigen `publicKey` (wallet **registrada** vía `client.wallets.register`) o `cryptoWalletId`. Una wallet reclamada por otra organización no puede registrarse.
- En Stellar (testnet): la cuenta debe estar **fondeada** (friendbot) y tener **trustline** del asset antes de crear la orden.
- Identificador de asset Stellar: formato `CODE-ISSUER` (con guion), p. ej. `CETES-GC3CW7...`.
- El sandbox **no devuelve el copia-e-cola PIX** en la orden (deja `depositClabe` vacío y `depositBankName: "PIX"`); usa `Pix.create(...)` para generar QRs propios y `Pix.fromCode(...)` cuando producción entregue el código real.
- `currency` de las cuentas llega en minúsculas (`"brl"`); `account.isPix` ya lo normaliza.

## Grafo de conocimiento (Graphify)

El proyecto incluye un grafo de conocimiento generado con [Graphify](https://graphify.com/) en `.graphify/`:

- `.graphify/graph.json` — 316 nodos / 640 aristas / 25 comunidades etiquetadas, con descripción por símbolo.
- `.graphify/GRAPH_REPORT.md` — informe de comunidades y hubs.
- `.graphify/studio/studio.html` — **visualización interactiva autocontenida** (doble clic para abrir).

Para regenerarlo tras cambios: `npx @sentropic/graphify update .`

## Scripts

```bash
npm run build      # tsup → dist/ (ESM + CJS + .d.ts)
npm run typecheck  # tsc --noEmit
npm test           # vitest
```

## Licencia

MIT
