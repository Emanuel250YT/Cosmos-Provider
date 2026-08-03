/**
 * HMAC-SHA256 helpers built on WebCrypto so they work in Node >= 18,
 * browsers, and edge runtimes alike (no `node:crypto` import).
 */

const encoder = new TextEncoder();

/** Compute an HMAC-SHA256 over `message` and return it as lowercase hex. */
export async function hmacSha256Hex(secret: string, message: string): Promise<string> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) {
    throw new Error("WebCrypto is unavailable. Use Node >= 18 or a modern runtime.");
  }
  const key = await subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await subtle.sign("HMAC", key, encoder.encode(message));
  return bytesToHex(new Uint8Array(signature));
}

/** Constant-time string comparison (both inputs hex/ascii). */
export function timingSafeEqualStr(a: string, b: string): boolean {
  const bufA = encoder.encode(a);
  const bufB = encoder.encode(b);
  if (bufA.length !== bufB.length) return false;
  let result = 0;
  for (let i = 0; i < bufA.length; i++) result |= bufA[i]! ^ bufB[i]!;
  return result === 0;
}

function bytesToHex(bytes: Uint8Array): string {
  let hex = "";
  for (const byte of bytes) hex += byte.toString(16).padStart(2, "0");
  return hex;
}
