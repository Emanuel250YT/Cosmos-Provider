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

Qualquer outro trilho pode ser plugado implementando a interface `PaymentProvider` (criar cobrança, consultar cobrança, verificar/interpretar webhook, payout opcional).

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

## Licença

MIT
