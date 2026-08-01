import { describe, expect, it } from "vitest";
import { crc16ccitt } from "@/atoms/crc16";

describe("crc16ccitt", () => {
  it('calcula el vector estándar CCITT-FALSE: "123456789" → 29B1', () => {
    expect(crc16ccitt("123456789")).toBe("29B1");
  });

  it("devuelve 4 dígitos hex en mayúsculas", () => {
    expect(crc16ccitt("")).toMatch(/^[0-9A-F]{4}$/);
    expect(crc16ccitt("a")).toMatch(/^[0-9A-F]{4}$/);
  });

  it("es determinista", () => {
    expect(crc16ccitt("cosmos")).toBe(crc16ccitt("cosmos"));
  });

  it("cambia con el contenido", () => {
    expect(crc16ccitt("cosmos")).not.toBe(crc16ccitt("cosmoS"));
  });
});
