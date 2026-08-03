# Graph Report - Cosmos-Provider  (2026-08-03)

## Corpus Check
- 84 files · ~44,990 words
- Verdict: corpus is large enough that graph structure adds value.

## Summary
- 763 nodes · 1813 edges · 42 communities (37 shown, 5 thin omitted)
- Extraction: 100% EXTRACTED · 0% INFERRED · 0% AMBIGUOUS · INFERRED: 2 edges (avg confidence: 0.5)
- Token cost: 0 input · 0 output

## Graph Freshness
- Built from commit: `d060603a`
- Run `git rev-parse HEAD` and compare to check if the graph is stale.
- Run `graphify update .` after code changes (no API cost).

## Community Hubs (Navigation)
- CosmosRamp.ts
- KoyweClient.ts
- sep/index.ts
- REST
- Routes
- types/index.ts
- Order.ts
- demo-ui.ts
- compilerOptions
- CustomProvider.ts
- cosmos-providers
- WebhookEmitter.ts
- src/index.ts
- keywords
- cosmos-providers
- cosmos-providers
- Wallet
- EtherfuseClient.ts
- BankAccount
- devDependencies
- Quote
- package.json
- atoms/errors.ts
- CustomProvider
- MercadoPagoProvider.ts
- WebhookManager.ts
- TypedEventEmitter
- MercadoPagoProvider
- webhooks/index.ts
- scripts
- Pix.ts
- order.test.ts
- PixQr
- WebSocketManager
- Pix
- main
- ./webhooks
- files
- webhook-server.ts

## God Nodes (most connected - your core abstractions)
1. `Routes` - 51 edges
2. `EtherfuseClient` - 33 edges
3. `CosmosRamp` - 30 edges
4. `KoyweClient` - 25 edges
5. `BaseManager` - 25 edges
6. `REST` - 22 edges
7. `BankAccount` - 22 edges
8. `MercadoPagoProvider` - 22 edges
9. `Order` - 21 edges
10. `cosmos-providers` - 21 edges

## Surprising Connections (you probably didn't know these)
- `main()` --calls--> `verifyCosmosSignature()`  [EXTRACTED]
  examples/run-all.ts → src/webhooks/WebhookEmitter.ts
- `FakeProviderState` --references--> `CreateChargeRequest`  [EXTRACTED]
  tests/ramp.test.ts → src/core/types.ts
- `FakeProviderState` --references--> `ChargeState`  [EXTRACTED]
  tests/ramp.test.ts → src/core/types.ts
- `main()` --references--> `CosmosRamp`  [EXTRACTED]
  examples/run-all.ts → src/core/CosmosRamp.ts
- `sign()` --calls--> `canonicalize()`  [EXTRACTED]
  tests/webhooks.test.ts → src/webhooks/index.ts

## Import Cycles
- 3-file cycle: `src/client/EtherfuseClient.ts -> src/organisms/SandboxManager.ts -> src/organisms/BaseManager.ts -> src/client/EtherfuseClient.ts`
- 3-file cycle: `src/client/EtherfuseClient.ts -> src/organisms/LookupManager.ts -> src/organisms/BaseManager.ts -> src/client/EtherfuseClient.ts`
- 3-file cycle: `src/client/EtherfuseClient.ts -> src/organisms/QuoteManager.ts -> src/organisms/BaseManager.ts -> src/client/EtherfuseClient.ts`
- 3-file cycle: `src/client/EtherfuseClient.ts -> src/client/WebSocketManager.ts -> src/molecules/Order.ts -> src/client/EtherfuseClient.ts`
- 3-file cycle: `src/client/EtherfuseClient.ts -> src/organisms/OrderManager.ts -> src/molecules/Order.ts -> src/client/EtherfuseClient.ts`
- 3-file cycle: `src/client/EtherfuseClient.ts -> src/organisms/CustomerManager.ts -> src/organisms/BaseManager.ts -> src/client/EtherfuseClient.ts`
- 3-file cycle: `src/client/EtherfuseClient.ts -> src/organisms/AssetManager.ts -> src/organisms/BaseManager.ts -> src/client/EtherfuseClient.ts`
- 3-file cycle: `src/client/EtherfuseClient.ts -> src/organisms/BankAccountManager.ts -> src/organisms/BaseManager.ts -> src/client/EtherfuseClient.ts`
- 3-file cycle: `src/client/EtherfuseClient.ts -> src/organisms/OrderManager.ts -> src/organisms/BaseManager.ts -> src/client/EtherfuseClient.ts`
- 3-file cycle: `src/client/EtherfuseClient.ts -> src/organisms/SwapManager.ts -> src/organisms/BaseManager.ts -> src/client/EtherfuseClient.ts`
- 3-file cycle: `src/client/EtherfuseClient.ts -> src/organisms/WalletManager.ts -> src/organisms/BaseManager.ts -> src/client/EtherfuseClient.ts`
- 3-file cycle: `src/client/EtherfuseClient.ts -> src/organisms/WebhookManager.ts -> src/organisms/BaseManager.ts -> src/client/EtherfuseClient.ts`
- 4-file cycle: `src/client/EtherfuseClient.ts -> src/organisms/WebhookManager.ts -> src/molecules/Webhook.ts -> src/molecules/Base.ts -> src/client/EtherfuseClient.ts`
- 4-file cycle: `src/client/EtherfuseClient.ts -> src/organisms/QuoteManager.ts -> src/molecules/Quote.ts -> src/molecules/Base.ts -> src/client/EtherfuseClient.ts`
- 4-file cycle: `src/client/EtherfuseClient.ts -> src/organisms/QuoteManager.ts -> src/molecules/Quote.ts -> src/molecules/Order.ts -> src/client/EtherfuseClient.ts`
- 4-file cycle: `src/client/EtherfuseClient.ts -> src/client/WebSocketManager.ts -> src/molecules/Order.ts -> src/molecules/Base.ts -> src/client/EtherfuseClient.ts`
- 4-file cycle: `src/client/EtherfuseClient.ts -> src/organisms/OrderManager.ts -> src/molecules/Order.ts -> src/molecules/Base.ts -> src/client/EtherfuseClient.ts`
- 4-file cycle: `src/client/EtherfuseClient.ts -> src/organisms/CustomerManager.ts -> src/molecules/Customer.ts -> src/molecules/Base.ts -> src/client/EtherfuseClient.ts`
- 4-file cycle: `src/client/EtherfuseClient.ts -> src/organisms/BankAccountManager.ts -> src/molecules/BankAccount.ts -> src/molecules/Base.ts -> src/client/EtherfuseClient.ts`
- 4-file cycle: `src/client/EtherfuseClient.ts -> src/organisms/WalletManager.ts -> src/molecules/Wallet.ts -> src/molecules/Base.ts -> src/client/EtherfuseClient.ts`

## Communities (42 total, 5 thin omitted)

### Community 0 - "CosmosRamp.ts"
Cohesion: 0.05
Nodes (38): ramp, server, main(), ramp, main(), CosmosRamp, CosmosRampOptions, OfframpParams (+30 more)

### Community 1 - "KoyweClient.ts"
Cohesion: 0.07
Nodes (38): KoyweError, displayAsset(), KoyweClient, labelForProvider(), mapBankAccount(), parseDepositInstructions(), railForProvider(), resolveFiatLimits() (+30 more)

### Community 2 - "sep/index.ts"
Cohesion: 0.13
Nodes (31): SepError, authenticate(), getSep10Challenge(), Sep10AuthenticateOptions, submitSep10Challenge(), fetchStellarToml(), FetchStellarTomlOptions, getSep24Info() (+23 more)

### Community 3 - "REST"
Cohesion: 0.09
Nodes (7): PixCheckout(), Environment, REST, LookupClient, LookupClientOptions, ExchangeRatePair, ExchangeRates

### Community 4 - "Routes"
Cohesion: 0.13
Nodes (7): Routes, Customer, CustomerManager, LookupManager, OrderManager, Page, PageQuery

### Community 5 - "types/index.ts"
Cohesion: 0.15
Nodes (14): PixKeyType, Base, APIBankAccount, APICustomer, APIQuote, CreateBankAccountPayload, CreateClabeBusinessAccount, CreateClabePersonalAccount (+6 more)

### Community 6 - "Order.ts"
Cohesion: 0.14
Nodes (9): OrderStatus, extractDeposit(), Order, OrderReceipt, APICreateOrderResult, APIOrder, CreateOrderOptions, DepositInstructions (+1 more)

### Community 7 - "demo-ui.ts"
Cohesion: 0.11
Nodes (15): confirmOrderOnReturn(), main(), mp, provider, ramp, Action, actions, log (+7 more)

### Community 8 - "compilerOptions"
Cohesion: 0.08
Nodes (23): DOM, ES2022, node, src, tests, vitest.config.ts, compilerOptions, baseUrl (+15 more)

### Community 9 - "CustomProvider.ts"
Cohesion: 0.12
Nodes (21): AMOUNT_KEYS, autoMapCharge(), autoMapChargeState(), candidates(), createCustomProvider(), CURRENCY_KEYS, DEFAULT_STATUS_ALIASES, dotGet() (+13 more)

### Community 10 - "cosmos-providers"
Cohesion: 0.10
Nodes (21): Configuration, cosmos-providers, Custom providers, Emitting your own webhooks, Errors, Etherfuse client (PIX/SPEI ramp API), Features, How the quote works (+13 more)

### Community 11 - "WebhookEmitter.ts"
Cohesion: 0.15
Nodes (11): bytesToHex(), encoder, hmacSha256Hex(), timingSafeEqualStr(), headerValue(), COSMOS_SIGNATURE_HEADER, CosmosWebhookEvent, verifyCosmosSignature() (+3 more)

### Community 12 - "src/index.ts"
Cohesion: 0.20
Nodes (15): BASE_URLS, Blockchains, ClientEventNames, Environments, FiatCurrencies, FiatCurrency, OrderDirection, OrderDirections (+7 more)

### Community 13 - "keywords"
Cohesion: 0.11
Nodes (18): keywords, coingecko, etherfuse, koywe, latam, mercadopago, offramp, onramp (+10 more)

### Community 14 - "cosmos-providers"
Cohesion: 0.11
Nodes (18): Características, Cliente Etherfuse (API de ramp PIX/SPEI), Cliente Koywe (ARS/CLP/MXN/COP/PEN/BRL ↔ USDC en Stellar), cosmos-providers, Cómo funciona la cotización, Emitir tus propios webhooks, Inicio rápido: vender USDC vía Mercado Pago, Instalación (+10 more)

### Community 15 - "cosmos-providers"
Cohesion: 0.11
Nodes (18): Cliente Etherfuse (API de ramp PIX/SPEI), Cliente Koywe (ARS/CLP/MXN/COP/PEN/BRL ↔ USDC em Stellar), Como a cotação funciona, cosmos-providers, Emitindo seus próprios webhooks, Instalação, Início rápido: vender USDC via Mercado Pago, Licença (+10 more)

### Community 16 - "Wallet"
Cohesion: 0.19
Nodes (5): Blockchain, Wallet, WalletManager, APIWallet, RegisterWalletOptions

### Community 17 - "EtherfuseClient.ts"
Cohesion: 0.25
Nodes (10): ClientEvents, EtherfuseClient, EtherfuseClientOptions, OrderUpdatedPayload, WebSocketConstructorLike, BaseManager, QuoteManager, SandboxManager (+2 more)

### Community 19 - "devDependencies"
Cohesion: 0.13
Nodes (15): dotenv, devDependencies, dotenv, tsup, tsx, @types/node, @types/qrcode, typescript (+7 more)

### Community 20 - "Quote"
Cohesion: 0.13
Nodes (6): lookup, StaticPixQr(), BLOCKCHAIN, client, main(), Quote

### Community 21 - "package.json"
Cohesion: 0.13
Nodes (14): author, description, engines, node, license, main, module, name (+6 more)

### Community 22 - "atoms/errors.ts"
Cohesion: 0.20
Nodes (8): EtherfuseAPIError, EtherfuseError, EtherfuseNetworkError, PixError, QueryValue, RequestOptions, RESTOptions, BASE

### Community 23 - "CustomProvider"
Cohesion: 0.21
Nodes (7): ChargeState, ChargeStatus, CHARGE_STATUSES, CustomProvider, CustomProviderConfig, firstString(), toNumber()

### Community 24 - "MercadoPagoProvider.ts"
Cohesion: 0.23
Nodes (10): WebhookNotification, WebhookRequest, CustomWebhookConfig, headerValue(), MercadoPagoProviderOptions, MP_CURRENCIES, MP_REGIONS, parseBody() (+2 more)

### Community 25 - "WebhookManager.ts"
Cohesion: 0.21
Nodes (4): Webhook, WebhookManager, APIWebhook, CreateWebhookOptions

### Community 26 - "TypedEventEmitter"
Cohesion: 0.19
Nodes (5): AnyListener, EventMap, Listener, TypedEventEmitter, Events

### Community 27 - "MercadoPagoProvider"
Cohesion: 0.32
Nodes (5): Charge, CreateChargeRequest, CreatePayoutRequest, CustomAdapters, MercadoPagoProvider

### Community 28 - "webhooks/index.ts"
Cohesion: 0.27
Nodes (10): RFC-8785, WebhookVerificationError, WebhookEvent, canonicalize(), constructEvent(), SIGNATURE_HEADER, verifySignature(), VerifySignatureOptions (+2 more)

### Community 29 - "scripts"
Cohesion: 0.18
Nodes (11): scripts, build, demo, demo:ui, dev, flow, prepublishOnly, test (+3 more)

### Community 30 - "Pix.ts"
Cohesion: 0.27
Nodes (7): crc16ccitt(), emv(), formatAmount(), normalizeText(), ParsedPix, PixQrImageOptions, PixStaticOptions

### Community 31 - "order.test.ts"
Cohesion: 0.31
Nodes (7): createMockFetch(), MockRule, parseBody(), RecordedRequest, makeClient(), makeClient(), PIX_CODE

### Community 32 - "PixQr"
Cohesion: 0.24
Nodes (4): dependencies, qrcode, qrcode, PixQr

### Community 36 - "./webhooks"
Cohesion: 0.40
Nodes (5): exports, ./webhooks, import, require, types

### Community 37 - "files"
Cohesion: 0.40
Nodes (5): files, dist, LICENSE, readme, README.md

## Knowledge Gaps
- **180 isolated node(s):** `client`, `provider`, `mp`, `log`, `ramp` (+175 more)
  These have ≤1 connection - possible missing edges or undocumented components.
- **5 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `PixQr` connect `PixQr` to `Pix`, `Order.ts`, `src/index.ts`, `atoms/errors.ts`, `Pix.ts`?**
  _High betweenness centrality (0.166) - this node is a cross-community bridge._
- **Why does `dependencies` connect `PixQr` to `package.json`?**
  _High betweenness centrality (0.144) - this node is a cross-community bridge._
- **What connects `client`, `provider`, `mp` to the rest of the system?**
  _180 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `CosmosRamp.ts` be split into smaller, more focused modules?**
  _Cohesion score 0.05444596443228454 - nodes in this community are weakly interconnected._
- **Should `KoyweClient.ts` be split into smaller, more focused modules?**
  _Cohesion score 0.07291666666666667 - nodes in this community are weakly interconnected._
- **Should `sep/index.ts` be split into smaller, more focused modules?**
  _Cohesion score 0.1294871794871795 - nodes in this community are weakly interconnected._
- **Should `REST` be split into smaller, more focused modules?**
  _Cohesion score 0.0946969696969697 - nodes in this community are weakly interconnected._