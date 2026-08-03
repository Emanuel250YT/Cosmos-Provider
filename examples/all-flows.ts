/**
 * Corre TODOS los flujos reales del paquete, uno detrás del otro, en una
 * sola ejecución: Etherfuse (las 5 chains), Mercado Pago, Koywe y el módulo
 * SEP-1/10/24 genérico. Es la versión "todo junto" de:
 *
 *   npm run flow             (solo Etherfuse)
 *   npm run flow:mercadopago
 *   npm run flow:koywe
 *   npm run flow:sep
 *
 * Ejecutá: `npm run flow:all`.
 *
 * DISEÑO: ningún proveedor bloquea a los demás.
 * - Cada flujo corre en su propio try/catch — si Etherfuse falla entero, se
 *   anota y se sigue igual con Mercado Pago, Koywe y SEP (y viceversa).
 * - Los que necesitan credenciales que no están en `.env` (Mercado Pago,
 *   Koywe) devuelven `null` y se saltean prolijamente — no hace falta tener
 *   las cuatro cuentas configuradas para que esto sirva de algo. Etherfuse y
 *   SEP no necesitan credenciales propias (Etherfuse solo su API key de
 *   sandbox; SEP corre contra un anchor de referencia público, generando su
 *   propia wallet de prueba).
 * - Cada flujo interno ya tiene su propio diseño "nunca bloquea" (ver el
 *   comentario de cabecera de cada archivo) — acá simplemente se encadenan.
 * - Al final se imprime el resumen de CADA flujo que sí corrió, uno atrás
 *   del otro, más un resumen de una línea de qué se corrió y qué se salteó.
 */

import "dotenv/config";
import { runEtherfuseFlow, printEtherfuseSummary } from "./full-flow";
import { runMercadoPagoFlow, printMercadoPagoSummary } from "./mercadopago-full-flow";
import { runKoyweFlow, printKoyweSummary } from "./koywe-full-flow";
import { runSepFlow, printSepSummary } from "./sep-full-flow";

interface Ran {
  etherfuse: boolean;
  mercadopago: boolean;
  koywe: boolean;
  sep: boolean;
}

async function main(): Promise<Ran> {
  const ran: Ran = { etherfuse: false, mercadopago: false, koywe: false, sep: false };

  console.log("\n\n█████ 1/4 — Etherfuse (todas las chains) █████████████████");
  try {
    const results = await runEtherfuseFlow();
    if (results) {
      printEtherfuseSummary(results);
      ran.etherfuse = true;
    }
  } catch (error) {
    console.error("✘ El flujo de Etherfuse falló por completo — sigo con el resto:", error);
  }

  console.log("\n\n█████ 2/4 — Mercado Pago ██████████████████████████████████");
  try {
    const results = await runMercadoPagoFlow();
    if (results) {
      printMercadoPagoSummary(results);
      ran.mercadopago = true;
    }
  } catch (error) {
    console.error("✘ El flujo de Mercado Pago falló por completo — sigo con el resto:", error);
  }

  console.log("\n\n█████ 3/4 — Koywe █████████████████████████████████████████");
  try {
    const summary = await runKoyweFlow();
    if (summary) {
      printKoyweSummary(summary);
      ran.koywe = true;
    }
  } catch (error) {
    console.error("✘ El flujo de Koywe falló por completo — sigo con el resto:", error);
  }

  console.log("\n\n█████ 4/4 — SEP-1/10/24 ███████████████████████████████████");
  try {
    const summary = await runSepFlow();
    printSepSummary(summary);
    ran.sep = true;
  } catch (error) {
    console.error("✘ El flujo SEP falló por completo:", error);
  }

  return ran;
}

function printOverallSummary(ran: Ran) {
  const line = (label: string, ok: boolean) => `  ${ok ? "✔" : "✘ (salteado o falló)"}  ${label}`;
  console.log("\n\n══════════════════════════════════════════════════════════");
  console.log("  RESUMEN GENERAL — all-flows.ts");
  console.log("══════════════════════════════════════════════════════════");
  console.log(line("Etherfuse (todas las chains)", ran.etherfuse));
  console.log(line("Mercado Pago", ran.mercadopago));
  console.log(line("Koywe", ran.koywe));
  console.log(line("SEP-1/10/24", ran.sep));
  console.log("══════════════════════════════════════════════════════════");
  if (!ran.mercadopago) console.log("  ℹ Mercado Pago se salteó: falta MP_ACCESS_TOKEN en .env.");
  if (!ran.koywe) console.log("  ℹ Koywe se salteó: faltan KOYWE_CLIENT_ID/KOYWE_SECRET en .env.");
}

main()
  .then(printOverallSummary)
  .catch((error) => {
    // Red de seguridad: cada flujo ya atrapa lo suyo, esto no debería disparar.
    console.error("\n✘ Error inesperado en all-flows.ts:", error);
  });
