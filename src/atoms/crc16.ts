/**
 * Atom: CRC16-CCITT (polinomio 0x1021, init 0xFFFF), requerido por el
 * estándar EMV® QRCPS que usa PIX para el campo 63 del BR Code.
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
