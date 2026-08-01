/**
 * Ejemplo backend: onramp BRL completo con QR PIX y eventos en vivo.
 *
 * Ejecutar con: npx tsx examples/backend-pix-onramp.ts
 * Requiere: ETHERFUSE_API_KEY (sandbox) en el entorno.
 */

import { EtherfuseClient } from "cosmos-providers";

const client = new EtherfuseClient({
  apiKey: process.env.ETHERFUSE_API_KEY!,
  environment: "sandbox",
});

client.on("debug", (msg) => console.log(msg));
client.on("orderUpdated", ({ orderId, order }) => {
  console.log(`Orden ${orderId} → ${order?.status}`);
});

async function main() {
  // 0. Tu organización (customerId por defecto para quotes)
  const me = await client.customers.me();
  console.log("Organización:", me.id);

  // 1. Cuenta bancaria PIX del cliente final (BRL)
  const account = await client.bankAccounts.createPixPersonal(me.id, {
    firstName: "João",
    lastName: "Silva",
    cpf: "12345678909",
    pixKey: "joao@exemplo.com.br",
    pixKeyType: "email",
  });
  console.log("Cuenta PIX:", account.id, account.currency);

  // 2. Quote: 500 BRL → USDC en Solana (expira en 2 minutos)
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

  // 3. Orden fijando la quote
  const receipt = await quote.createOrder({
    bankAccountId: account.id,
    publicKey: "TU_WALLET_SOLANA",
  });

  // 4. QR PIX para que el usuario pague
  const qr = receipt.createPixQr();
  if (qr) {
    console.log("Copia e cola:", qr.toString());
    console.log(await qr.toTerminal()); // QR en la terminal
  } else if (receipt.deposit) {
    console.log("Instrucciones de depósito:", receipt.deposit);
  }

  // 5. Eventos en vivo por WebSocket
  await client.connect();

  // 6. Sandbox: simular que el fiat llegó
  await client.sandbox.fiatReceived(receipt.orderId);

  // 7. Esperar a que complete
  const order = await receipt.fetch();
  const completed = await order.waitForStatus("completed");
  console.log("Completada:", completed.raw.confirmedTxSignature);

  client.destroy();
}

main().catch(console.error);
