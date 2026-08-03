/**
 * Backend example: full BRL onramp with a PIX QR and live events (Etherfuse).
 *
 * Run with: npx tsx examples/backend-pix-onramp.ts
 * Requires: ETHERFUSE_API_KEY (sandbox) in the environment.
 */

import { EtherfuseClient } from "cosmos-providers";

const client = new EtherfuseClient({
  apiKey: process.env.ETHERFUSE_API_KEY!,
  environment: "sandbox",
});

client.on("debug", (msg) => console.log(msg));
client.on("orderUpdated", ({ orderId, order }) => {
  console.log(`Order ${orderId} → ${order?.status}`);
});

async function main() {
  // 0. Your organization (default customerId for quotes)
  const me = await client.customers.me();
  console.log("Organization:", me.id);

  // 1. The end user's PIX bank account (BRL)
  const account = await client.bankAccounts.createPixPersonal(me.id, {
    firstName: "João",
    lastName: "Silva",
    cpf: "12345678909",
    pixKey: "joao@exemplo.com.br",
    pixKeyType: "email",
  });
  console.log("PIX account:", account.id, account.currency);

  // 2. Quote: 500 BRL → USDC on Solana (expires in 2 minutes)
  const quote = await client.quotes.create({
    customerId: me.id,
    blockchain: "solana",
    sourceAmount: "500",
    quoteAssets: {
      type: "onramp",
      sourceAsset: "BRL",
      targetAsset: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", // USDC mint
    },
  });
  console.log(`Quote: ${quote.raw.sourceAmount} BRL → ${quote.destinationAmount} USDC`);

  // 3. Create the order, locking the quote
  const receipt = await quote.createOrder({
    bankAccountId: account.id,
    publicKey: "YOUR_SOLANA_WALLET",
  });

  // 4. PIX QR for the user to pay
  const qr = receipt.createPixQr();
  if (qr) {
    console.log("Copia e cola:", qr.toString());
    console.log(await qr.toTerminal()); // QR in the terminal
  } else if (receipt.deposit) {
    console.log("Deposit instructions:", receipt.deposit);
  }

  // 5. Live events over WebSocket
  await client.connect();

  // 6. Sandbox: simulate the fiat arriving
  await client.sandbox.fiatReceived(receipt.orderId);

  // 7. Wait until it completes
  const order = await receipt.fetch();
  const completed = await order.waitForStatus("completed");
  console.log("Completed:", completed.raw.confirmedTxSignature);

  client.destroy();
}

main().catch(console.error);
