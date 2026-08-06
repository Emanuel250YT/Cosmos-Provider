/**
 * Abroad Finance quickstart — read-only. Prints the partner account, the
 * live corridors, and real quotes on both legs, plus the KYC status of one
 * user. Nothing here moves money.
 *
 * ⚠ ABROAD HAS NO SANDBOX. Every corridor it publishes is mainnet — you'll
 * see `stellar:pubnet` in the output below — and the partner key is a live
 * credential. That's why this script stops at quoting: the next call,
 * `POST /transaction`, mints a real PIX charge (onramp) or a real deposit
 * address expecting real Circle USDC (offramp). See
 * examples/mercadopago/demo-ui.tsx for the full flow behind a UI that warns
 * about exactly that before it takes anyone's money.
 *
 * Run:  npx tsx examples/abroad/quickstart.ts
 * Env:  ABROAD_API_KEY in .env (or .env.test — same key, there is only one)
 */

import "dotenv/config";
import { AbroadProvider, CosmosRamp, CoinGeckoOracle, FiatCurrency, AbroadQuoteError } from "../../src/index";
import { isMainModule } from "../helpers/isMain";

export async function runAbroadQuickstart() {
  const apiKey = process.env.ABROAD_API_KEY?.trim();
  if (!apiKey) {
    console.error("✘ ABROAD_API_KEY is not set. Add it to .env (see .env.example).");
    return;
  }

  const abroad = new AbroadProvider({ apiKey, userId: "cosmos-quickstart-user" });

  // 1. Who the key belongs to. `needsKyc`/`isKybApproved` are the account's
  //    own onboarding state — a transaction can be refused on those grounds
  //    even when every corridor below looks open.
  const partner = await abroad.client.getPartner();
  console.log(`Partner: ${partner.name} (${partner.country ?? "?"}) — KYB approved: ${partner.isKybApproved}, needs KYC: ${partner.needsKyc}`);

  // 2. Coverage, straight from the API rather than hardcoded — limits and
  //    corridors change, and `chainId` is where "there is no testnet"
  //    becomes visible rather than a claim in a comment.
  for (const direction of ["FIAT_TO_CRYPTO", "CRYPTO_TO_FIAT"] as const) {
    const corridors = await abroad.client.getCorridors(direction);
    console.log(`\n${direction} corridors:`);
    for (const c of corridors) {
      console.log(
        `  ${c.cryptoCurrency} on ${c.blockchain} (${c.chainId}) ↔ ${c.targetCurrency} via ${c.paymentMethod}` +
          `  [${c.minAmount ?? "—"} – ${c.maxAmount ?? "—"} ${c.targetCurrency}]`,
      );
    }
  }

  // 3. Pricing through the engine. `provider: "abroad"` is what makes
  //    CosmosRamp use Abroad's own quote instead of the CoinGecko oracle —
  //    note `source: "provider"` and the real `fee` in the output.
  const ramp = new CosmosRamp({ providers: [abroad], oracle: new CoinGeckoOracle({ apiKey: process.env.COINGECKO_API_KEY }) });

  const buy = await ramp.quote({ direction: "onramp", provider: abroad.name, currency: FiatCurrency.BRL, amount: 100 });
  console.log(`\nBuy  100 BRL → ${buy.cryptoAmount} USDC  (fee ${buy.fee?.amount} ${buy.fee?.currency}, ${buy.source}, quote ${buy.providerQuoteId})`);

  const sell = await ramp.quote({ direction: "offramp", provider: abroad.name, currency: FiatCurrency.BRL, cryptoAmount: 20 });
  console.log(`Sell 20 USDC → ${sell.fiatAmount} BRL  (fee ${sell.fee?.amount} ${sell.fee?.currency})`);

  const sellCop = await ramp.quote({ direction: "offramp", provider: abroad.name, currency: FiatCurrency.COP, cryptoAmount: 20 });
  console.log(`Sell 20 USDC → ${sellCop.fiatAmount} COP  (fee ${sellCop.fee?.amount} ${sellCop.fee?.currency})`);

  // 4. Refusals are ordinary answers, not crashes: an amount outside the
  //    corridor comes back as a typed error carrying Abroad's own code, so a
  //    UI can say "below the minimum" instead of "something went wrong".
  try {
    await ramp.quote({ direction: "onramp", provider: abroad.name, currency: FiatCurrency.BRL, amount: 1 });
  } catch (error) {
    if (error instanceof AbroadQuoteError) console.log(`\nBelow-minimum quote → ${error.code}: ${error.message}`);
    else throw error;
  }

  // 5. KYC gate. Abroad also reports this on the transaction response, but
  //    reading it up front is what lets you present verification as an extra
  //    step instead of failing a checkout the user already committed to.
  const kyc = await abroad.getKycStatus();
  console.log(`\nKYC for cosmos-quickstart-user: ${kyc.status ?? "not started"} (approved: ${kyc.approved})`);
  console.log("\nStopping before POST /transaction — that call charges real money on mainnet.");
}

if (isMainModule(import.meta.url)) {
  runAbroadQuickstart().catch(console.error);
}
