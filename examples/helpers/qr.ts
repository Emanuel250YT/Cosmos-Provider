/** Prints a QR code image directly in the terminal, so it's scannable during a live test. */

import QRCode from "qrcode";

export async function printQr(payload: string | undefined, label: string): Promise<void> {
  if (!payload) return;
  console.log(`\n${label} (scan to pay):`);
  console.log(await QRCode.toString(payload, { type: "terminal", small: true }));
}
