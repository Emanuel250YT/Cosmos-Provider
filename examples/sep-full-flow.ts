/**
 * Flujo completo SEP-1 → SEP-10 → SEP-24 contra un anchor de referencia
 * público (testanchor.stellar.org) — no hace falta ninguna credencial ni
 * cuenta propia: se genera y fondea una wallet de Stellar testnet acá mismo.
 * Sirve como plantilla para conectar contra CUALQUIER anchor compatible con
 * SEP con solo cambiar `ANCHOR_DOMAIN`.
 *
 * Ejecutá: `npm run flow:sep` (o `ANCHOR_DOMAIN=otro-anchor.com npm run flow:sep`).
 *
 * DISEÑO (igual que examples/full-flow.ts):
 * - SEP-1 (descubrimiento), SEP-10 (auth) y SEP-24 (depósito interactivo)
 *   corren cada uno en su propio try/catch — si alguno falla, se anota el
 *   error y se sigue (sin JWT no se puede intentar SEP-24, así que ese paso
 *   se salta prolijamente en vez de fallar feo).
 * - SEP-24 es interactivo A PROPÓSITO: la API devuelve una URL para que un
 *   humano complete el KYC/monto en un navegador — no hay forma de
 *   automatizar esa parte (ni tendría sentido). Por eso el chequeo de
 *   estado es UN solo intento (`getSep24Transaction`), sin poll; mientras
 *   nadie abra la URL va a quedar "pending", y está bien así.
 * - Al final SIEMPRE se imprime un resumen con todo lo obtenido.
 */

import "dotenv/config";
import { Keypair, Horizon, TransactionBuilder } from "@stellar/stellar-sdk";
import { CosmosClient, SEP24_TERMINAL_STATUSES } from "../src/index";
import { isMainModule } from "./helpers/isMain";

// `CosmosClient` sin proveedores solo te da `.sep` — los helpers SEP-1/10/24
// bindeados en un solo lugar, sin tener que importar cada función suelta.
const { fetchStellarToml, authenticateSep10, getSep24Info, startDeposit, getSep24Transaction } = new CosmosClient({}).sep;
const stellarServer = new Horizon.Server("https://horizon-testnet.stellar.org");

export interface SepFlowSummary {
  account?: string;
  webAuthEndpoint?: string;
  transferServer?: string;
  jwt?: string;
  authError?: string;
  availableDeposits?: string[];
  assetCode?: string;
  interactiveUrl?: string;
  transactionId?: string;
  depositError?: string;
  status?: string;
  statusError?: string;
}

/**
 * Corre el flujo SEP-1 → SEP-10 → SEP-24 completo contra `anchorDomain`
 * (default: `ANCHOR_DOMAIN` en `.env`, o el anchor de referencia público) y
 * devuelve el resumen. Nunca lanza — no hace falta ninguna credencial para
 * este flujo, así que no hay nada que "saltear".
 */
export async function runSepFlow(anchorDomain = process.env.ANCHOR_DOMAIN || "testanchor.stellar.org"): Promise<SepFlowSummary> {
  const summary: SepFlowSummary = {};
  try {
    // ── Wallet de prueba: generada y fondeada acá, nada que configurar ────
    const keypair = Keypair.random();
    await stellarServer.friendbot(keypair.publicKey()).call();
    summary.account = keypair.publicKey();
    console.log(`✔ Cuenta Stellar testnet: ${keypair.publicKey()}`);

    // ── SEP-1: descubrir los endpoints del anchor ─────────────────────────
    const toml = await fetchStellarToml(anchorDomain);
    if (!toml.WEB_AUTH_ENDPOINT || !toml.TRANSFER_SERVER_SEP0024) {
      console.error(
        `✘ ${anchorDomain} no publica WEB_AUTH_ENDPOINT/TRANSFER_SERVER_SEP0024 en su stellar.toml — no puedo seguir.`,
      );
      return summary;
    }
    summary.webAuthEndpoint = toml.WEB_AUTH_ENDPOINT;
    summary.transferServer = toml.TRANSFER_SERVER_SEP0024;
    console.log(`✔ stellar.toml de ${anchorDomain}: SEP-10 en ${toml.WEB_AUTH_ENDPOINT}, SEP-24 en ${toml.TRANSFER_SERVER_SEP0024}`);

    // ── SEP-10: probar que controlamos la cuenta, a cambio de un JWT ─────
    // La librería nunca toca claves privadas: acá el "signer" es nuestro,
    // firmando con el keypair que generamos arriba (no el de un usuario real).
    let jwt: string;
    try {
      jwt = await authenticateSep10({
        webAuthEndpoint: toml.WEB_AUTH_ENDPOINT,
        account: keypair.publicKey(),
        sign: async (challengeXdr, networkPassphrase) => {
          const tx = TransactionBuilder.fromXDR(challengeXdr, networkPassphrase);
          tx.sign(keypair);
          return tx.toXDR();
        },
      });
      summary.jwt = `${jwt.slice(0, 16)}...`;
      console.log(`✔ SEP-10 OK, JWT: ${summary.jwt}`);
    } catch (error) {
      summary.authError = String(error instanceof Error ? error.message : error);
      console.error("✘ Falló la autenticación SEP-10 — no puedo intentar SEP-24 sin JWT:", error);
      return summary;
    }

    // ── SEP-24: qué assets acepta este anchor, y arrancar un depósito ────
    try {
      const info = await getSep24Info({ transferServer: toml.TRANSFER_SERVER_SEP0024 });
      const enabled = Object.entries(info.deposit ?? {}).filter(([, a]) => a.enabled);
      summary.availableDeposits = enabled.map(([code]) => code);
      console.log(`✔ Assets de depósito habilitados: ${summary.availableDeposits.join(", ") || "ninguno"}`);

      const assetCode = enabled[0]?.[0];
      if (!assetCode) {
        console.log("ℹ Este anchor no habilita ningún asset de depósito ahora mismo — salteo SEP-24.");
        return summary;
      }
      summary.assetCode = assetCode;

      const deposit = await startDeposit({
        transferServer: toml.TRANSFER_SERVER_SEP0024,
        jwt,
        assetCode,
        account: keypair.publicKey(),
      });
      summary.interactiveUrl = deposit.url;
      summary.transactionId = deposit.id;
      console.log(`✔ Depósito interactivo iniciado (${assetCode}): ${deposit.url}`);
      console.log("  Abrí esa URL en un navegador para completar el KYC/monto — es un paso humano, no se puede automatizar.");

      // Chequeo de estado — UN solo intento, sin poll: hasta que alguien
      // abra la URL de arriba va a quedar "pending", y es lo esperable.
      try {
        const tx = await getSep24Transaction({ transferServer: toml.TRANSFER_SERVER_SEP0024, jwt, id: deposit.id });
        const isTerminal = (SEP24_TERMINAL_STATUSES as readonly string[]).includes(tx.status);
        summary.status = isTerminal ? tx.status : "pending";
        console.log(`  Estado: ${summary.status}${isTerminal ? "" : ` (real: "${tx.status}")`}`);
      } catch (error) {
        summary.statusError = String(error instanceof Error ? error.message : error);
        summary.status = "pending";
        console.warn("  No se pudo chequear el estado — queda como \"pending\".", error);
      }
    } catch (error) {
      summary.depositError = String(error instanceof Error ? error.message : error);
      console.error("✘ No se pudo iniciar el depósito SEP-24:", error);
    }
  } catch (error) {
    console.error("\n✘ Error inesperado en el flujo SEP:", error);
  }
  return summary;
}

export function printSepSummary(summary: SepFlowSummary, anchorDomain = process.env.ANCHOR_DOMAIN || "testanchor.stellar.org") {
  console.log("\n══ Resumen final — SEP-1/10/24 (" + anchorDomain + ") ══════");
  console.log("Cuenta:              ", summary.account ?? "n/a");
  console.log("WEB_AUTH_ENDPOINT:   ", summary.webAuthEndpoint ?? "n/a");
  console.log("TRANSFER_SERVER:     ", summary.transferServer ?? "n/a");
  console.log("JWT:                 ", summary.jwt ?? `n/a${summary.authError ? ` — error: ${summary.authError}` : ""}`);
  console.log("Assets habilitados:  ", summary.availableDeposits?.join(", ") ?? "n/a");
  console.log(
    "Depósito iniciado:   ",
    summary.transactionId ?? `n/a${summary.depositError ? ` — error: ${summary.depositError}` : ""}`,
    summary.assetCode ? `(${summary.assetCode})` : "",
  );
  if (summary.interactiveUrl) console.log("URL interactiva:     ", summary.interactiveUrl);
  console.log("Estado:              ", summary.status ?? "n/a");
  console.log("═════════════════════════════════════════════════════════");
}

if (isMainModule(import.meta.url)) {
  runSepFlow()
    .then((summary) => printSepSummary(summary))
    .catch((error) => {
      console.error("\n✘ Error inesperado:", error);
    });
}
