/**
 * Tests for the standard Chain/Asset/FiatCurrency/Country enums and their
 * backward-compatible aliases (`Blockchains`/`FiatCurrencies` from
 * `@/atoms/constants`, kept so existing imports don't break).
 */

import { describe, expect, it } from "vitest";
import { Chain, Asset, FiatCurrency, Country } from "@/atoms/enums";
import { Blockchains, FiatCurrencies } from "@/atoms/constants";

describe("Chain", () => {
  it("exposes every blockchain the library talks to", () => {
    expect(Chain).toEqual({
      Stellar: "stellar",
      Solana: "solana",
      Base: "base",
      Polygon: "polygon",
      Monad: "monad",
    });
  });
});

describe("Asset", () => {
  it("standardizes crypto symbols, including Etherfuse's stablebonds", () => {
    expect(Asset.USDC).toBe("USDC");
    expect(Asset.XLM).toBe("XLM");
    expect(Asset.CETES).toBe("CETES");
    expect(Asset.TESOURO).toBe("TESOURO");
    expect(Asset.CARN).toBe("CARN");
    expect(Asset.JOGO).toBe("JoGo");
  });
});

describe("FiatCurrency", () => {
  it("covers every Mercado Pago / Koywe market", () => {
    expect(Object.values(FiatCurrency).sort()).toEqual(
      ["ARS", "BRL", "CLP", "COP", "MXN", "PEN", "UYU"].sort(),
    );
  });
});

describe("Country", () => {
  it("mirrors FiatCurrency 1:1 for the same markets (AR, BR, MX, CL, CO, PE, UY)", () => {
    expect(Object.keys(Country).sort()).toEqual(["AR", "BR", "CL", "CO", "MX", "PE", "UY"].sort());
    expect(Country.AR).toBe("AR");
    expect(Country.BR).toBe("BR");
  });
});

describe("backward-compatible aliases", () => {
  it("Blockchains from @/atoms/constants is the same object as Chain", () => {
    expect(Blockchains).toBe(Chain);
  });

  it("FiatCurrencies from @/atoms/constants is the same object as FiatCurrency", () => {
    expect(FiatCurrencies).toBe(FiatCurrency);
  });
});
