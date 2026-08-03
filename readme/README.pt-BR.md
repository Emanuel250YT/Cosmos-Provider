# cosmos-providers

Toolkit de onramp/offramp cripto para a América Latina. Receba em moeda local com trilhos de pagamento regionais (QR e links de pagamento do Mercado Pago, PIX, SPEI) e libere stablecoins automaticamente, com preço do CoinGecko mais o seu próprio spread.

**Documentação em outros idiomas:** [English](../README.md) · [Español](./README.es.md)

## Recursos

- **Agnóstico de provedor** — um único motor, provedores regionais plugáveis (Mercado Pago incluído, PIX/SPEI via Etherfuse, ou escreva o seu).
- **Onramp automático** — gere um QR ou link de pagamento; quando o pagamento é aprovado, o motor libera USDC (ou qualquer ativo) para a carteira do usuário.
- **Offramp automático** — cote cripto → fiat e pague através do provedor.
- **Preço do CoinGecko com spread** — a cotação e o seu spread são travados na criação do pagamento.
- **Webhooks nos dois sentidos** — consome webhooks do provedor automaticamente (com verificação de assinatura) e emite seus próprios webhooks assinados.
- **TypeScript, sem dependências pesadas** — Node ≥ 18. A biblioteca nunca toca em chaves privadas; o envio de cripto é seu.

## Instalação

```bash
npm install cosmos-providers
```

## Teste localmente (sem credenciais)

O repositório inclui um simulador do Mercado Pago para executar cada ação offline:

```bash
npm run demo      # runner de console: quote → link → QR → webhook → liberação automática de USDC → offramp
npm run demo:ui   # playground web em http://localhost:4000 com um botão por ação
```

## Início rápido: vender USDC via Mercado Pago

```ts
import { CosmosRamp, CoinGeckoOracle, MercadoPagoProvider } from "cosmos-providers";

const ramp = new CosmosRamp({
  providers: [
    new MercadoPagoProvider({
      accessToken: process.env.MP_ACCESS_TOKEN,
      webhookSecret: process.env.MP_WEBHOOK_SECRET,
      notificationUrl: "https://meuapp.com/webhooks/mercadopago",
    }),
  ],
  oracle: new CoinGeckoOracle(),
  // Seu código que envia a cripto. Chamado automaticamente após o pagamento.
  settlement: async ({ wallet, amount, asset }) => {
    const txId = await minhaCarteira.transfer(asset, amount, wallet);
    return { txId };
  },
});

// 1. Crie o pagamento. Cotação + spread são travados aqui.
const order = await ramp.onramp({
  provider: "mercadopago",
  amount: 500,            // BRL que o usuário vai pagar
  currency: "BRL",
  asset: "USDC",
  spread: 0.02,           // sua margem de 2% sobre o CoinGecko
  wallet: "CARTEIRA_DO_USUARIO",
  method: "qr",           // PIX QR para BRL
  payer: { email: "usuario@exemplo.com.br" },
});

console.log(order.charge.qr);          // "copia e cola" PIX
console.log(order.charge.qrBase64);    // PNG base64 pronto para <img>
console.log(order.quote.cryptoAmount); // USDC que o usuário vai receber
```

```ts
// 2. Receba o webhook do Mercado Pago. Pronto — o motor verifica a
// assinatura, confere o valor pago e chama o seu settlement.
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
// 3. Opcional: escute os eventos.
ramp.on("payment:approved", (order) => console.log("pago", order.id));
ramp.on("settlement:released", (order, { txId }) => console.log("USDC enviado", txId));
ramp.on("order:completed", (order) => console.log("concluído", order.id));
```

## Como a cotação funciona

Ao criar um pagamento, o motor consulta o CoinGecko e aplica o seu spread **naquele momento**:

| | Taxa efetiva | Exemplo (taxa 5.00, spread 2%) |
|---|---|---|
| Onramp | `rate * (1 + spread)` | o usuário paga R$ 5,10 por USDC |
| Offramp | `rate * (1 - spread)` | o usuário recebe R$ 4,90 por USDC |

O detalhamento completo fica salvo na ordem:

```ts
order.quote;
// { asset: "USDC", currency: "BRL", rate: 5.0, spread: 0.02,
//   effectiveRate: 5.1, fiatAmount: 500, cryptoAmount: 98.039216, quotedAt: ... }
```

Também dá para cotar sem criar uma ordem:

```ts
const quote = await ramp.quote({ direction: "onramp", currency: "BRL", amount: 500, spread: 0.02 });
```

## Offramp: recomprar USDC e pagar em fiat

```ts
const order = await ramp.offramp({
  provider: "mercadopago",
  cryptoAmount: 100,               // USDC que o usuário envia para você
  currency: "BRL",
  spread: 0.02,
  destination: { email: "usuario@exemplo.com.br" },
});

// Mostre ao usuário a sua carteira de tesouraria; quando o USDC chegar:
await ramp.confirmCryptoReceived(order.id, { txId: "..." });
// → o motor paga o fiat via provedor automaticamente.
// Se o provedor não suportar payouts, o evento "payout:required" é emitido
// para você resolver do seu jeito e depois chamar ramp.confirmPayoutSent(order.id).
```

## Métodos de pagamento por região

O `MercadoPagoProvider` cobre AR, BR, MX, CL, CO, PE, UY (ARS, BRL, MXN, CLP, COP, PEN, UYU):

| `method` | O que você recebe |
|---|---|
| `"link"` | Link de pagamento do Checkout Pro (`order.charge.link`) |
| `"qr"` (BRL) | QR PIX: string EMV (`order.charge.qr`) + PNG base64 (`order.charge.qrBase64`) |
| `"qr"` (com `qrPos`) | QR dinâmico in-store do Mercado Pago |
| `"auto"` | Melhor método para a moeda (padrão) |

Qualquer outro trilho pode ser plugado com `createCustomProvider` (veja abaixo) ou implementando a interface `PaymentProvider` diretamente.

## Sandbox do Mercado Pago

Passe um access token `TEST-...` e o provedor entra em modo sandbox automaticamente (ou force com `sandbox: true`): os links de pagamento usam `sandbox_init_point`, então todo o fluxo pode ser testado com [usuários e cartões de teste](https://www.mercadopago.com.br/developers/pt/docs/checkout-pro/additional-content/your-integrations/test/accounts) antes de ir para produção.

```ts
const mp = new MercadoPagoProvider({
  accessToken: process.env.MP_TEST_ACCESS_TOKEN, // "TEST-..." → mp.sandbox === true
  webhookSecret: process.env.MP_WEBHOOK_SECRET,
});
```

Para testar webhooks sem expor uma URL pública, gere uma notificação assinada de um pagamento sandbox e passe direto ao motor — exercita o pipeline real (verificação de assinatura → parse → re-consulta à API → settlement):

```ts
const request = await mp.buildTestWebhook(paymentId); // assinado exatamente como o Mercado Pago faria
const result = await ramp.handleWebhook("mercadopago", request);
// → { ok: true, outcome: "settled", orderId: "..." }
```

## Provedores custom

Transforme qualquer API de pagamentos em um provedor completo — links de pagamento, QRs, normalização de status e webhooks incluídos — sem implementar `PaymentProvider` na mão. Você fornece as chamadas cruas à sua API; as respostas são adaptadas ao formato Cosmos automaticamente:

```ts
import { createCustomProvider } from "cosmos-providers";

const acme = createCustomProvider({
  name: "acme",
  currencies: ["BRL"],

  // Chamadas cruas à sua API — retorne a resposta como está.
  createCharge: (req) => acmeApi.post("/charges", { amount: req.amount, ref: req.reference }),
  getCharge: (id) => acmeApi.get(`/charges/${id}`),
  createPayout: (req) => acmeApi.post("/payouts", req), // opcional

  // Mapeie status do provedor para: pending | approved | rejected | refunded | canceled | expired.
  // Há uma tabela de aliases embutida ("paid"/"succeeded" → approved, ...); status
  // desconhecidos resolvem para "pending" — nunca para uma aprovação falsa.
  statusMap: { beleza: "approved" },

  // Webhooks: HMAC-SHA256 de fábrica, ou traga seu próprio verify/parse.
  webhook: {
    hmac: { secret: process.env.ACME_WEBHOOK_SECRET, header: "x-acme-signature" },
    chargeIdPaths: ["data.id"], // onde mora o id do pagamento (este é o padrão)
  },
});

const ramp = new CosmosRamp({ providers: [acme], /* ... */ });
```

Os campos comuns de resposta (`checkout_url`, `init_point`, `payment_url`, `qr_code`, `qr_code_base64`, `transaction_amount`, `external_reference`, objetos aninhados `data`/`payment`...) são auto-mapeados. Para formatos incomuns, assuma controle total com `adapt`:

```ts
createCustomProvider({
  // ...
  adapt: {
    charge: (raw) => ({ id: raw.tx.id, link: raw.tx.hosted_page }),
    chargeState: (raw) => ({ status: raw.tx.phase, amount: raw.tx.cents / 100 }),
  },
});
```

O que os adaptadores retornam ainda é normalizado e validado (uma cobrança sem link/QR/depósito falha rápido na criação), então `ramp.handleWebhook` e `order.charge.link` se comportam de forma idêntica entre provedores embutidos e custom.

## Emitindo seus próprios webhooks

Receba notificações no(s) seu(s) backend(s) sempre que uma ordem avançar:

```ts
const ramp = new CosmosRamp({
  // ...
  webhooks: {
    endpoints: [{ url: "https://meuapp.com/hooks/cosmos", secret: process.env.HOOK_SECRET }],
  },
});
```

Cada entrega é assinada (`x-cosmos-signature: t=...,v1=...`). Verifique no destino:

```ts
import { verifyCosmosSignature } from "cosmos-providers";

const ok = await verifyCosmosSignature(rawBody, req.get("x-cosmos-signature"), secret);
```

Eventos: `order.created`, `payment.approved`, `payment.rejected`, `payment.mismatch`, `settlement.released`, `settlement.failed`, `payout.required`, `order.completed`.

## Persistência

Por padrão as ordens vivem em memória (bom para desenvolvimento). Em produção, implemente a interface `OrderStore` (5 métodos) sobre o seu banco de dados e passe como `store`.

## Modelo de segurança

- O corpo do webhook nunca é confiável: o motor reconsulta o pagamento na API do provedor antes de liquidar.
- O valor pago deve bater com o cotado (± `defaults.amountTolerance`).
- Webhooks duplicados são idempotentes — uma ordem é liquidada uma única vez.
- Se o seu settlement falhar, a ordem fica em `"settling"`; tente de novo com `ramp.retrySettlement(orderId)`.

## QR PIX standalone

Gere e interprete BR Codes PIX (EMV "copia e cola") sem nenhuma API:

```ts
import { Pix } from "cosmos-providers";

const qr = Pix.create({
  pixKey: "cobranca@minhaempresa.com.br",
  merchantName: "Minha Empresa",
  merchantCity: "Sao Paulo",
  amount: 99.9,
});

await qr.toDataURL(); // PNG data URL para <img src>
qr.toString();        // payload "copia e cola"
Pix.parse("00020126..."); // decodificar + validar qualquer BR Code
```

## Cliente Etherfuse (API de ramp PIX/SPEI)

O pacote também inclui um cliente completo para a API de ramp da [Etherfuse](https://docs.etherfuse.com) (BRL·PIX e MXN·SPEI contra Solana, Stellar, Base, Polygon):

```ts
import { EtherfuseClient } from "cosmos-providers";

const client = new EtherfuseClient({ apiKey: process.env.ETHERFUSE_API_KEY, environment: "sandbox" });
```

A verificação de webhooks da Etherfuse (somente Node) vive no subpath `cosmos-providers/webhooks`. Veja a pasta [examples](../examples) para fluxos completos.

## Cliente Koywe (ARS/CLP/MXN/COP/PEN/BRL ↔ USDC em Stellar)

Cliente sem dependências para a API de ramp da [Koywe](https://docs-crypto.koywe.com). Diferente dos `PaymentProvider` acima (que só cobram fiat — a perna cripto é seu próprio `settlement`), a Koywe entrega USDC diretamente para um endereço Stellar como parte da ordem, então é exposta como um cliente standalone, assim como o `EtherfuseClient`:

```ts
import { KoyweClient } from "cosmos-providers";

const koywe = new KoyweClient({
  clientId: process.env.KOYWE_CLIENT_ID,
  secret: process.env.KOYWE_SECRET,
  baseUrl: process.env.KOYWE_BASE_URL, // https://api-sandbox.koywe.com em sandbox
  usdcIssuer: process.env.PUBLIC_USDC_ISSUER,
});

// Onramp: ARS -> USDC em Stellar
const providers = await koywe.getPaymentProviders("ARS"); // WIREAR (CVU), QRI-AR (QR)...
const quote = await koywe.getQuote({ ramp: "onramp", fiatCurrency: "ARS", amount: "10000", paymentMethodId: providers[0].id });
const order = await koywe.createOnRampOrder({ quoteId: quote.id, stellarAddress: "ENDERECO_STELLAR_DO_USUARIO" });

order.deposit?.cvu;      // WIREAR: CVU/alias para transferir
order.interactiveUrl;    // QRI/Khipu: link de checkout hospedado no lugar
```

Endereços Stellar são validados localmente (`StrKey` implementado do zero — sem depender de `@stellar/stellar-sdk`) antes de chegar à API. Consulte ordens com `koywe.getOrder(id)` (ou `getOrderByExternalId` após um redirect hospedado); o KYC delegado vive em `createAccount` + `checkAccount`.

## SEP-1 / SEP-10 / SEP-24 — qualquer anchor compatível com SEP

Funções componíveis e agnósticas de framework para as Stellar Ecosystem Proposals que cobrem descoberta → autenticação → o fluxo hospedado de depósito/saque. Não estão presas à Koywe nem à Etherfuse — aponte para o domínio de qualquer anchor (um [test anchor](https://testanchor.stellar.org) de referência, ou outro):

```ts
import { fetchStellarToml, authenticateSep10, startDeposit, getSep24Transaction } from "cosmos-providers";

const toml = await fetchStellarToml("testanchor.stellar.org"); // SEP-1: descoberta

// SEP-10: a biblioteca nunca toca chaves privadas — traga seu próprio signer.
const jwt = await authenticateSep10({
  webAuthEndpoint: toml.WEB_AUTH_ENDPOINT,
  account: "ENDERECO_STELLAR_DO_USUARIO",
  sign: (challengeXdr, networkPassphrase) => minhaWallet.signTransaction(challengeXdr, networkPassphrase),
});

// SEP-24: inicia o depósito, abre `url` para o KYC/valor hospedado, e consulta o status.
const { url, id } = await startDeposit({ transferServer: toml.TRANSFER_SERVER_SEP0024, jwt, assetCode: "USDC", account: "ENDERECO_STELLAR_DO_USUARIO" });
const tx = await getSep24Transaction({ transferServer: toml.TRANSFER_SERVER_SEP0024, jwt, id });
```

`startWithdraw` espelha `startDeposit` para a direção Stellar → fiat. Isso cobre SEP-1/10/24 (descoberta, autenticação e o fluxo interativo que a maioria dos anchors e wallets usa) — SEP-6/12/31/38 (transferências programáticas, KYC dedicado, pagamentos fiat diretos e cotações) ainda não estão implementados.

## Licença

MIT
