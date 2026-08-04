import { describe, expect, it } from "vitest";
import { crc16ccitt } from "@/atoms/crc16";

describe("crc16ccitt", () => {
  it('computes the standard CCITT-FALSE vector: "123456789" → 29B1', () => {
    expect(crc16ccitt("123456789")).toBe("29B1");
  });

  it("returns 4 uppercase hex digits", () => {
    expect(crc16ccitt("")).toMatch(/^[0-9A-F]{4}$/);
    expect(crc16ccitt("a")).toMatch(/^[0-9A-F]{4}$/);
  });

  it("is deterministic", () => {
    expect(crc16ccitt("cosmos")).toBe(crc16ccitt("cosmos"));
  });

  it("changes with content", () => {
    expect(crc16ccitt("cosmos")).not.toBe(crc16ccitt("cosmoS"));
  });
});
