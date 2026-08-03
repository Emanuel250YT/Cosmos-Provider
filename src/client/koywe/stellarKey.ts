/**
 * Minimal Stellar `StrKey` ed25519-public-key validator.
 *
 * Koywe on-ramp orders deliver USDC to a Stellar account, so the destination
 * address is validated locally before it ever reaches the API. Implemented
 * from scratch (base32 + CRC16/XModem) instead of depending on
 * `@stellar/stellar-sdk`, to keep this client dependency-free and portable —
 * copy the `koywe/` folder into any TypeScript project.
 */

const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
/** Version byte for an ed25519 public key ("G..." addresses), per SEP-0023. */
const ED25519_PUBLIC_KEY_VERSION_BYTE = 6 << 3; // 0x30

function base32Decode(input: string): Uint8Array | null {
  const clean = input.toUpperCase().replace(/=+$/, "");
  let bits = 0;
  let value = 0;
  const bytes: number[] = [];

  for (const char of clean) {
    const index = BASE32_ALPHABET.indexOf(char);
    if (index === -1) return null;
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((value >> bits) & 0xff);
    }
  }
  return new Uint8Array(bytes);
}

/** CRC16/XModem (poly 0x1021, init 0x0000) — the checksum algorithm StrKey uses. */
function crc16xmodem(bytes: Uint8Array): number {
  let crc = 0x0000;
  for (const byte of bytes) {
    crc ^= byte << 8;
    for (let i = 0; i < 8; i++) {
      crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
    }
  }
  return crc;
}

/** Validate a Stellar ed25519 public key ("G..." address), StrKey-encoded. */
export function isValidStellarPublicKey(address: string): boolean {
  if (typeof address !== "string" || address.length !== 56 || address[0] !== "G") return false;

  const decoded = base32Decode(address);
  // version byte + 32 raw key bytes + 2 checksum bytes
  if (!decoded || decoded.length !== 35) return false;

  const versionByte = decoded[0];
  if (versionByte !== ED25519_PUBLIC_KEY_VERSION_BYTE) return false;

  const payload = decoded.subarray(0, 33);
  const checksum = decoded.subarray(33, 35);
  const expected = crc16xmodem(payload);
  // StrKey stores the checksum little-endian.
  const actual = checksum[0]! | (checksum[1]! << 8);
  return expected === actual;
}
