# Graph Report - .  (2026-08-01)

## Corpus Check
- Corpus is ~14.136 words - fits in a single context window. You may not need a graph.

## Summary
- 316 nodes · 640 edges · 23 communities detected
- Extraction: 100% EXTRACTED · 0% INFERRED · 0% AMBIGUOUS
- Token cost: 0 input · 0 output
- Edge kinds: imports: 140 · imports_from: 137 · method: 133 · contains: 121 · re_exports: 59 · calls: 28 · inherits: 22


## Input Scope
- Requested: auto
- Resolved: all (source: default-auto)
- Included files: 46 · Candidates: recursive
- Excluded: 0 untracked · 0 ignored · 0 sensitive · 0 missing committed
## God Nodes (most connected - your core abstractions)
1. `REST` - 18 edges
2. `Order` - 17 edges
3. `Routes` - 14 edges
4. `EtherfuseClient` - 14 edges
5. `EtherfuseError` - 13 edges
6. `PixQr` - 13 edges
7. `BankAccount` - 12 edges
8. `Quote` - 12 edges
9. `BankAccountManager` - 12 edges
10. `LookupClient` - 11 edges

## Surprising Connections (you probably didn't know these)
- None detected - all connections are within the same source files.

## Communities

### Community 21 - "Backend Onramp Example"
Cohesion: 0.67
Nodes (1): client

### Community 19 - "Frontend PIX Example"
Cohesion: 0.50
Nodes (1): lookup

### Community 20 - "Full Flow Example"
Cohesion: 0.50
Nodes (2): BLOCKCHAIN, client

### Community 22 - "Webhook Server Example"
Cohesion: 1.00
Nodes (1): app

### Community 6 - "Typed Event Emitter"
Cohesion: 0.18
Nodes (5): EventMap, Listener, AnyListener, TypedEventEmitter, Events

### Community 0 - "API Routes and Constants"
Cohesion: 0.07
Nodes (32): QueryValue, RequestOptions, RESTOptions, REST, Environments, Environment, BASE_URLS, Blockchains (+24 more)

### Community 3 - "PIX BR Code Engine"
Cohesion: 0.12
Nodes (9): crc16ccitt(), PixStaticOptions, ParsedPix, PixQrImageOptions, emv(), normalizeText(), formatAmount(), Pix (+1 more)

### Community 2 - "Client and Error Hierarchy"
Cohesion: 0.10
Nodes (15): EtherfuseError, EtherfuseAPIError, EtherfuseNetworkError, PixError, WebhookVerificationError, EtherfuseClient, TypedEventEmitter, WebSocketLike (+7 more)

### Community 11 - "Public Lookup Client"
Cohesion: 0.32
Nodes (1): LookupClient

### Community 14 - "WebSocket Live Gateway"
Cohesion: 0.29
Nodes (1): WebSocketManager

### Community 1 - "Base Structure Classes"
Cohesion: 0.11
Nodes (20): Wallet, Base, Page, PageQuery, QuoteAssets, APICustomer, CreatePixPersonalAccount, CreatePixBusinessAccount (+12 more)

### Community 8 - "Bank Account Structure"
Cohesion: 0.22
Nodes (2): BankAccount, Base

### Community 12 - "Customer Structure"
Cohesion: 0.25
Nodes (2): Customer, Base

### Community 4 - "Order Structure"
Cohesion: 0.11
Nodes (8): extractDeposit(), Order, Base, OrderReceipt, DepositInstructions, WithdrawInstructions, APIOrder, APICreateOrderResult

### Community 5 - "Quote Structure and Manager"
Cohesion: 0.13
Nodes (7): Quote, Base, QuoteManager, BaseManager, CreateQuoteOptions, APIQuote, CreateOrderOptions

### Community 16 - "Webhook Structure"
Cohesion: 0.33
Nodes (2): Webhook, Base

### Community 7 - "Bank Account Manager"
Cohesion: 0.29
Nodes (2): BankAccountManager, BaseManager

### Community 17 - "Customer Manager"
Cohesion: 0.33
Nodes (2): CustomerManager, BaseManager

### Community 9 - "Lookup Rates Manager"
Cohesion: 0.28
Nodes (2): LookupManager, BaseManager

### Community 15 - "Order Manager"
Cohesion: 0.29
Nodes (2): OrderManager, BaseManager

### Community 13 - "Wallet Manager"
Cohesion: 0.25
Nodes (2): WalletManager, BaseManager

### Community 18 - "Webhook Endpoint Manager"
Cohesion: 0.33
Nodes (2): WebhookManager, BaseManager

### Community 10 - "Webhook Signature Verification"
Cohesion: 0.36
Nodes (6): WebhookEvent, canonicalize(), VerifySignatureOptions, verifySignature(), constructEvent(), SECRET

## Knowledge Gaps
- **18 isolated node(s):** `client`, `lookup`, `BLOCKCHAIN`, `client`, `app` (+13 more)
  These have ≤1 connection - possible missing edges or undocumented components.
- **Thin community `Backend Onramp Example`** (1 nodes): `client`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Frontend PIX Example`** (1 nodes): `lookup`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Full Flow Example`** (2 nodes): `BLOCKCHAIN`, `client`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Webhook Server Example`** (1 nodes): `app`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Public Lookup Client`** (1 nodes): `LookupClient`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `WebSocket Live Gateway`** (1 nodes): `WebSocketManager`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Bank Account Structure`** (2 nodes): `BankAccount`, `Base`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Customer Structure`** (2 nodes): `Customer`, `Base`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Webhook Structure`** (2 nodes): `Webhook`, `Base`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Bank Account Manager`** (2 nodes): `BankAccountManager`, `BaseManager`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Customer Manager`** (2 nodes): `CustomerManager`, `BaseManager`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Lookup Rates Manager`** (2 nodes): `LookupManager`, `BaseManager`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Order Manager`** (2 nodes): `OrderManager`, `BaseManager`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Wallet Manager`** (2 nodes): `WalletManager`, `BaseManager`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Webhook Endpoint Manager`** (2 nodes): `WebhookManager`, `BaseManager`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `REST` connect `API Routes and Constants` to `Client and Error Hierarchy`?**
  _High betweenness centrality (0.073) - this node is a cross-community bridge._
- **Why does `Order` connect `Order Structure` to `Client and Error Hierarchy`, `API Routes and Constants`?**
  _High betweenness centrality (0.067) - this node is a cross-community bridge._
- **Why does `BankAccountManager` connect `Bank Account Manager` to `API Routes and Constants`, `Base Structure Classes`?**
  _High betweenness centrality (0.054) - this node is a cross-community bridge._
- **What connects `client`, `lookup`, `BLOCKCHAIN` to the rest of the system?**
  _18 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `API Routes and Constants` be split into smaller, more focused modules?**
  _Cohesion score 0.07175141242937853 - nodes in this community are weakly interconnected._
- **Should `PIX BR Code Engine` be split into smaller, more focused modules?**
  _Cohesion score 0.12 - nodes in this community are weakly interconnected._
- **Should `Client and Error Hierarchy` be split into smaller, more focused modules?**
  _Cohesion score 0.0967741935483871 - nodes in this community are weakly interconnected._