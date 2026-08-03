/**
 * Flujo completo contra el sandbox de Etherfuse, para TODAS las chains que
 * soporta (Stellar, Solana, Base, Polygon, Monad):
 *
 *   organización → cuenta bancaria PIX (BRL, una sola vez)
 *   → por cada chain: wallet nueva (+ trustline automática en Stellar)
 *     → quote → orden → QR PIX → simular depósito fiat → chequeo de estado
 *
 * Preparación: crea un .env en la raíz con ETHERFUSE_API_KEY=tu_key_de_sandbox
 * y ejecutá `npm run flow`. Nada más es obligatorio — cada chain arma su
 * propia wallet de prueba sola, no hace falta configurar nada por chain.
 *
 * IMPORTANTE sobre el activo destino: el onramp de Etherfuse entrega uno de
 * SUS stablebonds tokenizados (CETES para MXN, TESOURO para BRL) — no USDC
 * directo. El mint/identifier de cada stablebond NO está hardcodeado: se
 * resuelve en cada corrida contra `client.lookup.stablebonds()` (público,
 * sin API key), eligiendo el activo con mayor `totalSupply` para esa
 * moneda+chain. Un mint fijo se rompe con el tiempo — ya lo vimos romperse
 * en la práctica (el catálogo del sandbox rota qué bond está activo).
 *
 * TRUSTLINES: en Stellar, recibir un asset ajeno (no XLM) exige que la
 * cuenta receptora abra una "trustline" para ese asset — y eso solo lo puede
 * firmar el dueño de la cuenta (nadie puede abrirla en tu nombre). Por eso
 * este script genera su PROPIO par de claves de Stellar por corrida, lo
 * fondea en testnet vía Friendbot, y abre la trustline él mismo antes de
 * pedir la orden. Es la única chain que necesita esto: en Solana, Etherfuse
 * despliega la cuenta de token asociada por su cuenta (no hace falta que
 * nosotros hagamos nada); en las EVM (Base/Polygon/Monad) cualquier
 * dirección puede recibir un ERC-20 sin configuración previa.
 *
 * DISEÑO: nada bloquea el flujo.
 * - Cada chain corre en su propio try/catch — si una falla, se anota el
 *   error y se sigue con la siguiente chain (no se corta todo el script).
 * - Después de simular el depósito fiat NO se espera en un poll largo a que
 *   la orden llegue a "completed" (eso puede tardar minutos en el sandbox y
 *   trababa el flujo). Se hace UN solo chequeo rápido y lo que no sea un
 *   estado terminal queda anotado como "pending" — se puede consultar más
 *   tarde con la `statusPage` que se imprime.
 * - Al final SIEMPRE se imprime una tabla con todo lo que se creó por cada
 *   chain — ids, wallets, tx de trustline, quotes, órdenes, códigos PIX,
 *   estados — aunque alguna haya fallado.
 */

import "dotenv/config";
import { randomBytes, generateKeyPairSync } from "node:crypto";
import { keccak256 } from "js-sha3";
import { Keypair, Horizon, TransactionBuilder, Networks, Operation, Asset as StellarAsset, BASE_FEE } from "@stellar/stellar-sdk";
import { EtherfuseClient, EtherfuseAPIError, Pix, Chain, FiatCurrency, Asset, type Quote, type OrderReceipt } from "../src/index";

const API_KEY = process.env.ETHERFUSE_API_KEY;
if (!API_KEY) {
  console.error("Falta ETHERFUSE_API_KEY (ponla en .env o en el entorno). Aborto.");
  process.exit(1);
}

/** Moneda que este flujo soporta (Etherfuse liquida solo BRL/MXN hoy). */
type EtherfuseFiat = typeof FiatCurrency.BRL | typeof FiatCurrency.MXN;

/** Todas las chains que Etherfuse soporta — el flujo corre una por una para cada una. */
const CHAINS: readonly Chain[] = [Chain.Stellar, Chain.Solana, Chain.Base, Chain.Polygon, Chain.Monad];

/** Símbolo del stablebond de Etherfuse que recibe cada moneda (solo para loguear). */
const STABLEBOND_FOR: Record<EtherfuseFiat, Asset> = {
  [FiatCurrency.BRL]: Asset.TESOURO,
  [FiatCurrency.MXN]: Asset.CETES,
};
// Último recurso si `client.lookup.stablebonds()` falla (red caída, etc.) o
// no devuelve nada usable para esta moneda+chain. Puede quedar desactualizado
// — por eso es fallback, no la fuente principal.
const FALLBACK_TARGET_ASSET: Record<EtherfuseFiat, Partial<Record<Chain, string>>> = {
  [FiatCurrency.BRL]: {
    [Chain.Solana]: "EyvBnTz9QDVc2oaBVeu77kndynmD5njrWjZghYh5xpUk", // TESOURO, puede haber rotado
    [Chain.Stellar]: "TESOURO-GC3CW7EDYRTWQ635VDIGY6S4ZUF5L6TQ7AA4MWS7LEQDBLUSZXV7UPS4",
  },
  [FiatCurrency.MXN]: {
    [Chain.Solana]: "AvvetPGuuB5FD5m86fpw3LtDKyQoUFT1mG9WarNQLW4q", // CETES, puede haber rotado
    [Chain.Stellar]: "CETES-GC3CW7EDYRTWQ635VDIGY6S4ZUF5L6TQ7AA4MWS7LEQDBLUSZXV7UPS4",
  },
};

const client = new EtherfuseClient({ apiKey: API_KEY, environment: "sandbox" });
client.on("debug", (m) => process.env.DEBUG && console.log(m));

const stellarServer = new Horizon.Server("https://horizon-testnet.stellar.org");

// ---------------------------------------------------------------------------
// Generación de direcciones de prueba, una por chain
// ---------------------------------------------------------------------------

const BASE58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
function base58Encode(bytes: Uint8Array): string {
  let digits = [0];
  for (const byte of bytes) {
    let carry = byte;
    for (let i = 0; i < digits.length; i++) {
      carry += digits[i]! << 8;
      digits[i] = carry % 58;
      carry = (carry / 58) | 0;
    }
    while (carry > 0) {
      digits.push(carry % 58);
      carry = (carry / 58) | 0;
    }
  }
  let leadingZeros = 0;
  for (const byte of bytes) {
    if (byte === 0) leadingZeros++;
    else break;
  }
  return BASE58_ALPHABET[0]!.repeat(leadingZeros) + digits.reverse().map((d) => BASE58_ALPHABET[d]).join("");
}

/** Clave pública ed25519 al azar, codificada como address de Solana (base58). Nunca firmamos nada en Solana acá — Etherfuse despliega la cuenta de token por su cuenta. */
function generateSolanaAddress(): string {
  const { publicKey } = generateKeyPairSync("ed25519");
  const der = publicKey.export({ type: "spki", format: "der" }) as Buffer;
  return base58Encode(der.subarray(der.length - 32));
}

/** EIP-55: casing mixto derivado del hash Keccak-256 del address en minúsculas — Etherfuse lo exige, no es opcional. */
function toChecksumAddress(address: string): string {
  const lower = address.toLowerCase().replace(/^0x/, "");
  const hash = keccak256(lower);
  let result = "0x";
  for (let i = 0; i < lower.length; i++) {
    result += parseInt(hash[i]!, 16) >= 8 ? lower[i]!.toUpperCase() : lower[i];
  }
  return result;
}

/** Dirección EVM al azar (0x + 40 hex, EIP-55 checksummed). Nunca firmamos nada acá — cualquier dirección EVM puede recibir un ERC-20 sin configuración previa. */
function generateEvmAddress(): string {
  return toChecksumAddress(randomBytes(20).toString("hex"));
}

// ---------------------------------------------------------------------------
// Stablebonds: resolver el activo destino en vivo (nunca hardcodeado)
// ---------------------------------------------------------------------------

interface StablebondChainEntry {
  blockchain: string;
  tokenIdentifier: string;
  totalSupply?: string;
}
interface StablebondEntry {
  symbol: string;
  bondCurrency: string;
  blockchains: StablebondChainEntry[];
}
interface TargetAssetCandidate {
  asset: string;
  symbol?: string;
}

/**
 * Candidatos de stablebond activo para `cur` en `chain`, de mayor a menor
 * `totalSupply` — consultando el catálogo público en vivo. Varios bonds
 * pueden compartir moneda (p. ej. CETES + "Cetes2"); si el mejor candidato
 * falla en la API (rotado/agotado), {@link createQuoteForCurrency} prueba el
 * siguiente. `.env` puede forzar un valor con `ETHERFUSE_TARGET_ASSET`.
 */
async function resolveTargetAssetCandidates(cur: EtherfuseFiat, chain: Chain): Promise<TargetAssetCandidate[]> {
  const override = process.env.ETHERFUSE_TARGET_ASSET;
  if (override) return [{ asset: override }];

  try {
    const catalog = (await client.lookup.stablebonds()) as { stablebonds?: StablebondEntry[] };
    const candidates = (catalog.stablebonds ?? [])
      .filter((bond) => bond.bondCurrency === cur)
      .flatMap((bond) =>
        bond.blockchains
          .filter((entry) => entry.blockchain === chain)
          .map((entry) => ({ symbol: bond.symbol, asset: entry.tokenIdentifier, supply: Number(entry.totalSupply ?? 0) })),
      )
      .filter((candidate) => candidate.supply > 0)
      .sort((a, b) => b.supply - a.supply)
      .map(({ symbol, asset }) => ({ symbol, asset }));

    if (candidates.length) return candidates;
    console.warn(`⚠ Sin stablebond activo para ${cur} en ${chain} — uso el fallback fijo.`);
  } catch (error) {
    console.warn(`⚠ No se pudo consultar client.lookup.stablebonds() — uso el fallback fijo:`, error);
  }
  const fallback = FALLBACK_TARGET_ASSET[cur][chain];
  return fallback ? [{ asset: fallback, symbol: STABLEBOND_FOR[cur] }] : [];
}

/** `NonStableAsset` es el error puntual de un mint rotado/agotado — vale la pena probar el siguiente candidato. */
function isNonStableAssetError(error: unknown): boolean {
  if (!(error instanceof EtherfuseAPIError) || error.status !== 400) return false;
  const body = error.body as { type?: string } | undefined;
  return body?.type === "NonStableAsset";
}

/** Pide la quote probando cada candidato de {@link resolveTargetAssetCandidates} hasta que uno funcione. */
async function createQuoteForCurrency(
  orgId: string,
  cur: EtherfuseFiat,
  chain: Chain,
): Promise<{ quote: Quote; targetAsset: string; targetSymbol?: string }> {
  const candidates = await resolveTargetAssetCandidates(cur, chain);
  if (!candidates.length) throw new Error(`Sin candidatos de activo destino para ${cur} en ${chain}.`);

  let lastError: unknown;
  for (const candidate of candidates) {
    try {
      const quote = await client.quotes.create({
        customerId: orgId,
        blockchain: chain,
        sourceAmount: "500",
        quoteAssets: { type: "onramp", sourceAsset: cur, targetAsset: candidate.asset },
      });
      return { quote, targetAsset: candidate.asset, targetSymbol: candidate.symbol };
    } catch (error) {
      lastError = error;
      if (!isNonStableAssetError(error)) throw error;
      console.warn(`⚠ ${candidate.asset} rechazado (Non-stable) — probando el siguiente candidato...`);
    }
  }
  throw lastError;
}

// ---------------------------------------------------------------------------
// Trustline automática (solo Stellar)
// ---------------------------------------------------------------------------

/** `"CODE-ISSUER"` (formato Etherfuse/Stellar) → `{ code, issuer }` para el SDK. */
function parseStellarAsset(identifier: string): { code: string; issuer: string } {
  const sep = identifier.indexOf("-");
  if (sep === -1) throw new Error(`No pude parsear code/issuer de "${identifier}" (esperaba "CODE-ISSUER").`);
  return { code: identifier.slice(0, sep), issuer: identifier.slice(sep + 1) };
}

/** Abre (o confirma) la trustline para `targetAsset` en la cuenta de `keypair`, fondeada por Friendbot. Devuelve el hash de la tx. */
async function ensureStellarTrustline(keypair: Keypair, targetAsset: string): Promise<string> {
  const { code, issuer } = parseStellarAsset(targetAsset);
  const account = await stellarServer.loadAccount(keypair.publicKey());
  const tx = new TransactionBuilder(account, { fee: BASE_FEE, networkPassphrase: Networks.TESTNET })
    .addOperation(Operation.changeTrust({ asset: new StellarAsset(code, issuer) }))
    .setTimeout(30)
    .build();
  tx.sign(keypair);
  const result = await stellarServer.submitTransaction(tx);
  return result.hash;
}

// ---------------------------------------------------------------------------
// Resultado por chain, para el resumen final
// ---------------------------------------------------------------------------

interface ChainResult {
  chain: Chain;
  walletAddress?: string;
  walletError?: string;
  trustlineTx?: string;
  trustlineError?: string;
  quoteId?: string;
  quoteDestinationAmount?: string;
  quoteTargetAsset?: string;
  quoteTargetSymbol?: string;
  quoteError?: string;
  orderId?: string;
  orderError?: string;
  depositMethod?: string;
  depositPixCode?: string;
  fiatReceivedSimulated?: boolean;
  fiatReceivedError?: string;
  /** "pending" cuando no llegó a un estado terminal en el chequeo único (no bloqueante). */
  status?: string;
  statusPage?: string;
}

const chainResults: ChainResult[] = [];

async function runChain(orgId: string, currency: EtherfuseFiat, bankAccountId: string | undefined, chain: Chain) {
  const result: ChainResult = { chain };
  chainResults.push(result);
  console.log(`\n── Chain: ${chain} ─────────────────────────────────────────`);

  // ── Wallet de prueba para esta chain ────────────────────────────────────
  let publicKey: string;
  let stellarKeypair: Keypair | undefined;
  try {
    if (chain === Chain.Stellar) {
      stellarKeypair = Keypair.random();
      await stellarServer.friendbot(stellarKeypair.publicKey()).call();
      publicKey = stellarKeypair.publicKey();
    } else if (chain === Chain.Solana) {
      publicKey = generateSolanaAddress();
    } else {
      publicKey = generateEvmAddress();
    }
    result.walletAddress = publicKey;
    console.log(`✔ Wallet: ${publicKey}`);
  } catch (error) {
    result.walletError = String(error instanceof Error ? error.message : error);
    console.error(`✘ No se pudo preparar una wallet para ${chain} — sigo con la siguiente chain:`, error);
    return;
  }

  // Etherfuse exige que la wallet esté registrada antes de usarla en una
  // orden ("Wallet not found or not authorized" si se salta este paso).
  try {
    const wallet = await client.wallets.register({ publicKey, blockchain: chain });
    console.log(`✔ Wallet registrada: ${wallet.id} (kyc: ${wallet.raw.kycStatus ?? "n/a"})`);
  } catch (error) {
    result.walletError = String(error instanceof Error ? error.message : error);
    console.error(`✘ No se pudo registrar la wallet para ${chain} — la orden probablemente falle:`, error);
  }

  // ── Quote (resuelve el stablebond activo, expira en 2 minutos) ──────────
  let quoteResult: Awaited<ReturnType<typeof createQuoteForCurrency>>;
  try {
    quoteResult = await createQuoteForCurrency(orgId, currency, chain);
    result.quoteId = quoteResult.quote.id;
    result.quoteDestinationAmount = quoteResult.quote.destinationAmount;
    result.quoteTargetAsset = quoteResult.targetAsset;
    result.quoteTargetSymbol = quoteResult.targetSymbol;
    console.log(
      `✔ Quote ${quoteResult.quote.id}: 500 ${currency} → ${quoteResult.quote.destinationAmount} ` +
        `${quoteResult.targetSymbol ?? ""} (rate ${quoteResult.quote.exchangeRate}, activo ${quoteResult.targetAsset})`,
    );
  } catch (error) {
    result.quoteError = String(error instanceof Error ? error.message : error);
    console.error(`✘ No se pudo obtener una quote para ${chain} — sigo con la siguiente chain:`, error);
    return;
  }

  // ── Trustline automática (solo Stellar) ──────────────────────────────────
  if (chain === Chain.Stellar && stellarKeypair) {
    try {
      result.trustlineTx = await ensureStellarTrustline(stellarKeypair, quoteResult.targetAsset);
      console.log(`✔ Trustline abierta: tx ${result.trustlineTx}`);
    } catch (error) {
      result.trustlineError = String(error instanceof Error ? error.message : error);
      console.error(`✘ No se pudo abrir la trustline para ${chain} — la orden puede fallar igual:`, error);
    }
  }

  // ── Orden ────────────────────────────────────────────────────────────────
  if (!bankAccountId) {
    console.log(`ℹ Salteo la orden para ${chain}: no hay cuenta bancaria.`);
    return;
  }
  let receipt: OrderReceipt;
  try {
    receipt = await quoteResult.quote.createOrder({ bankAccountId, publicKey, blockchain: chain });
    result.orderId = receipt.orderId;
    console.log(`✔ Orden creada: ${receipt.orderId}`);
  } catch (error) {
    result.orderError = String(error instanceof Error ? error.message : error);
    console.error(`✘ No se pudo crear la orden para ${chain} — sigo con la siguiente chain:`, error);
    return;
  }

  // ── Instrucciones de pago / QR PIX ──────────────────────────────────────
  if (receipt.deposit?.method === "pix") {
    result.depositMethod = "pix";
    result.depositPixCode = receipt.deposit.pixCode;
    console.log(`✔ Código PIX (copia e cola): ${receipt.deposit.pixCode}`);
  } else if (receipt.deposit?.method === "spei") {
    result.depositMethod = "spei";
    result.depositPixCode = receipt.deposit.clabe;
    console.log(`✔ Depósito SPEI:`, receipt.deposit);
  } else if (currency === FiatCurrency.BRL) {
    // El sandbox no devuelve el BR Code para esta orden puntual; lo generamos
    // localmente con el motor PIX de la librería, mismo monto:
    const demo = Pix.create({
      pixKey: "sandbox@etherfuse.com.br",
      merchantName: "Etherfuse Sandbox",
      merchantCity: "Sao Paulo",
      amount: "500",
      txid: receipt.orderId.replace(/-/g, "").slice(0, 25),
    });
    result.depositMethod = "pix (demo local)";
    result.depositPixCode = demo.toString();
    console.log(`ℹ Copia e cola (demo local): ${demo.toString()}`);
  }

  // ── Simular que el fiat llegó — no bloquea si falla ─────────────────────
  try {
    await client.sandbox.fiatReceived(receipt.orderId);
    result.fiatReceivedSimulated = true;
    console.log("✔ Depósito fiat simulado");
  } catch (error) {
    result.fiatReceivedError = String(error instanceof Error ? error.message : error);
    console.error(`✘ No se pudo simular el depósito fiat para ${chain} — sigo igual:`, error);
  }

  // ── UN chequeo de estado, sin poll largo: lo no-terminal queda "pending" ─
  try {
    const current = await receipt.fetch();
    result.status = current.isTerminal ? current.status : "pending";
    result.statusPage = current.statusPage;
    console.log(`  Estado: ${result.status}${current.isTerminal ? "" : ` (real: "${current.status}")`}`);
    console.log(`  Página de estado: ${current.statusPage ?? "n/a"}`);
  } catch (error) {
    result.status = "pending";
    console.warn(`  No se pudo chequear el estado de ${chain} — queda como "pending".`, error);
  }
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

async function main() {
  // ── 1. Organización ────────────────────────────────────────────────────
  const me = await client.customers.me();
  console.log(`✔ Organización: ${me.id} (${me.displayName ?? "sin nombre"})`);

  // ── 2. Cuenta bancaria: reutiliza una compliant o crea una PIX ─────────
  // El sandbox solo permite UNA cuenta BRL por organización. Es compartida
  // por todas las chains — el fiat entra una sola vez por moneda.
  let currency: EtherfuseFiat = FiatCurrency.BRL;
  let bankAccountId: string | undefined;
  try {
    const accounts = await client.bankAccounts.listForCustomer(me.id);
    const usable = (cur: string) =>
      accounts.find((a) => a.currency?.toUpperCase() === cur && a.compliant && !a.raw.deletedAt);

    const existing = usable(FiatCurrency.BRL) ?? usable(FiatCurrency.MXN);
    if (existing) {
      currency = existing.isPix ? FiatCurrency.BRL : FiatCurrency.MXN;
      bankAccountId = existing.id;
      console.log(`✔ Reutilizando cuenta ${currency} existente: ${existing.id}`);
    } else {
      try {
        const pix = await client.bankAccounts.createPixPersonal(me.id, {
          firstName: "João",
          lastName: "Silva",
          cpf: "12345678909",
          pixKey: "joao.sandbox@exemplo.com.br",
          pixKeyType: "email",
        });
        bankAccountId = pix.id;
        console.log(`✔ Cuenta PIX creada: ${pix.id} (compliant: ${pix.compliant})`);
      } catch (error) {
        if (!(error instanceof EtherfuseAPIError)) throw error;
        console.warn(`⚠ PIX no disponible (${error.message}) — probando CLABE/MXN...`);
        currency = FiatCurrency.MXN;
        const clabe = await client.bankAccounts.createClabePersonal(me.id, {
          firstName: "Ana",
          paternalLastName: "García",
          maternalLastName: "López",
          birthDate: "19900515",
          birthCountryIsoCode: "MX",
          curp: "GALA900515MDFRPN08",
          rfc: "XEXX010101000", // RFC mágico del sandbox: auto-aprueba
          clabe: "012180015700000000", // CLABE de ejemplo no-STP (el sandbox rechaza 646)
        });
        bankAccountId = clabe.id;
        console.log(`✔ Cuenta CLABE creada: ${clabe.id}`);
      }
    }
  } catch (error) {
    console.error("✘ No se pudo obtener/crear una cuenta bancaria — sigo sin ella:", error);
  }

  // ── 3. Una corrida completa por cada chain ─────────────────────────────
  for (const chain of CHAINS) {
    await runChain(me.id, currency, bankAccountId, chain);
  }
}

function printSummary() {
  console.log("\n══ Resumen final (todas las chains) ═══════════════════════");
  for (const r of chainResults) {
    console.log(`\n${r.chain}:`);
    console.log("  Wallet:            ", r.walletAddress ?? `n/a${r.walletError ? ` — error: ${r.walletError}` : ""}`);
    if (r.trustlineTx || r.trustlineError) {
      console.log("  Trustline:         ", r.trustlineTx ?? `error: ${r.trustlineError}`);
    }
    console.log(
      "  Quote:             ",
      r.quoteId ?? `n/a${r.quoteError ? ` — error: ${r.quoteError}` : ""}`,
      r.quoteDestinationAmount ? `(→ ${r.quoteDestinationAmount} ${r.quoteTargetSymbol ?? ""}, activo ${r.quoteTargetAsset})` : "",
    );
    console.log("  Orden:             ", r.orderId ?? `n/a${r.orderError ? ` — error: ${r.orderError}` : ""}`);
    if (r.depositMethod) console.log("  Depósito:          ", r.depositMethod, r.depositPixCode ?? "");
    console.log(
      "  Depósito simulado: ",
      r.fiatReceivedSimulated ? "sí" : `no${r.fiatReceivedError ? ` — error: ${r.fiatReceivedError}` : ""}`,
    );
    console.log("  Estado:            ", r.status ?? "n/a");
    console.log("  Página de estado:  ", r.statusPage ?? "n/a");
  }
  console.log("\n═════════════════════════════════════════════════════════");
}

main()
  .catch((error) => {
    // Red de seguridad: cada chain atrapa lo suyo, esto no debería disparar.
    console.error("\n✘ Error inesperado:", error);
  })
  .finally(() => {
    printSummary();
    client.destroy();
  });
