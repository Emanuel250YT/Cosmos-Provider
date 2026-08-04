/**
 * Atom: CRC16-CCITT (polynomial 0x1021, init 0xFFFF), required by the
 * EMV® QRCPS standard that PIX uses for field 63 of the BR Code.
 */
export function crc16ccitt(payload: string): string {
  let crc = 0xffff;
  const bytes = new TextEncoder().encode(payload);
  for (const byte of bytes) {
    crc ^= byte << 8;
    for (let i = 0; i < 8; i++) {
      crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
    }
  }
  return crc.toString(16).toUpperCase().padStart(4, "0");
}
