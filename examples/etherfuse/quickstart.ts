/**
 * Etherfuse quickstart: BRL → USDC on Solana via a PIX QR, single chain,
 * minimal setup. For every chain Etherfuse supports (plus automatic
 * Stellar trustline setup) see examples/etherfuse/full-flow.ts — this one
 * is the short version to copy-paste and adapt. In your own integration,
 * swap the throwaway wallet below for your actual user's Solana address.
 *
 * Run:  npx tsx examples/etherfuse/quickstart.ts
 * Env:  ETHERFUSE_API_KEY (sandbox) in .env
 */

import "dotenv/config";
import { generateKeyPairSync } from "node:crypto";
import { EtherfuseClient, Chain, FiatCurrency } from "../../src/index";
import { isMainModule } from "../helpers/isMain";

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

/** Throwaway ed25519 public key, encoded as a Solana address — just to have a real one to point the order at. */
function generateSolanaAddress(): string {
  const { publicKey } = generateKeyPairSync("ed25519");
  const der = publicKey.export({ type: "spki", format: "der" }) as Buffer;
  return base58Encode(der.subarray(der.length - 32));
}

export async function runEtherfuseQuickstart() {
  const apiKey = process.env.ETHERFUSE_API_KEY;
  if (!apiKey) {
    console.log("Skipped: set ETHERFUSE_API_KEY in .env to run this example.");
    return null;
  }

  const client = new EtherfuseClient({ apiKey, environment: "sandbox" });
  client.on("orderUpdated", ({ orderId, order }) => console.log(`Order ${orderId} → ${order?.status}`));

  try {
    // 1. Your organization (default customerId for quotes)
    const me = await client.customers.me();
    console.log("Organization:", me.id);

    // 2. The end user's PIX bank account (BRL) — the sandbox allows only ONE
    // BRL account per organization, so reuse an existing compliant one
    // before trying to create a new one (a second attempt 400s otherwise).
    const existingAccounts = await client.bankAccounts.listForCustomer(me.id);
    const existing = existingAccounts.find((a) => a.currency?.toUpperCase() === FiatCurrency.BRL && a.compliant && !a.raw.deletedAt);
    const account = existing ?? (await client.bankAccounts.createPixPersonal(me.id, {
      firstName: "João",
      lastName: "Silva",
      cpf: "12345678909",
      pixKey: "joao@exemplo.com.br",
      pixKeyType: "email",
    }));
    console.log(existing ? "Reusing PIX account:" : "PIX account created:", account.id, account.currency);

    // 3. Your user's wallet. This example generates a throwaway one so the
    // script runs end to end — in your integration, use the real address
    // and register it before ordering ("Wallet not found or not authorized"
    // otherwise).
    const publicKey = generateSolanaAddress();
    await client.wallets.register({ publicKey, blockchain: Chain.Solana });
    console.log("Wallet:", publicKey);

    // 4. Don't hardcode the target asset: Etherfuse's onramp delivers one of
    // ITS tokenized stablebonds (TESOURO for BRL), not raw USDC, and the
    // active mint for a given chain rotates over time. Resolve it live —
    // `client.lookup.stablebonds()` is public, no API key needed.
    const catalog = (await client.lookup.stablebonds()) as {
      stablebonds?: { symbol: string; bondCurrency: string; blockchains: { blockchain: string; tokenIdentifier: string; totalSupply?: string }[] }[];
    };
    const targetAsset = (catalog.stablebonds ?? [])
      .filter((bond) => bond.bondCurrency === FiatCurrency.BRL)
      .flatMap((bond) => bond.blockchains.filter((b) => b.blockchain === Chain.Solana).map((b) => b.tokenIdentifier))[0];
    if (!targetAsset) throw new Error("No active BRL stablebond for Solana right now.");

    // 5. Quote: 500 BRL → the resolved stablebond on Solana (expires in 2 minutes)
    const quote = await client.quotes.create({
      customerId: me.id,
      blockchain: Chain.Solana,
      sourceAmount: "500",
      quoteAssets: { type: "onramp", sourceAsset: FiatCurrency.BRL, targetAsset },
    });
    console.log(`Quote: ${quote.raw.sourceAmount} BRL → ${quote.destinationAmount} (asset ${targetAsset})`);

    // 6. Create the order, locking the quote
    const receipt = await quote.createOrder({ bankAccountId: account.id, publicKey });

    // 7. PIX QR for the user to pay
    const qr = receipt.createPixQr();
    if (qr) {
      console.log("Copia e cola:", qr.toString());
    } else if (receipt.deposit) {
      console.log("Deposit instructions:", receipt.deposit);
    }

    // 8. Sandbox only: simulate the fiat arriving (a real PIX payment does this in production)
    await client.sandbox.fiatReceived(receipt.orderId);
    console.log("Fiat deposit simulated");

    // 9. ONE status check, no blocking poll — see examples/etherfuse/full-flow.ts
    // for why: the sandbox can take minutes to settle, and polling stalls a
    // demo script. Anything short of terminal is expected here as "pending".
    const current = await receipt.fetch();
    console.log(`Status: ${current.isTerminal ? current.status : "pending"} — check ${current.statusPage} later`);

    return receipt;
  } finally {
    client.destroy();
  }
}

if (isMainModule(import.meta.url)) {
  runEtherfuseQuickstart().catch(console.error);
}
