import { describe, expect, it } from "vitest";
import { EtherfuseClient } from "@/client/EtherfuseClient";
import { Order, OrderReceipt, extractDeposit } from "@/molecules/Order";
import { EtherfuseError } from "@/atoms/errors";
import { Pix } from "@/molecules/Pix";
import { createMockFetch } from "./helpers/mockFetch";

const PIX_CODE = Pix.payload({
  pixKey: "etherfuse@exemplo.com.br",
  merchantName: "Etherfuse BR",
  merchantCity: "Sao Paulo",
  amount: 500,
});

function makeClient(rules: Parameters<typeof createMockFetch>[0]) {
  const { fetchImpl, requests } = createMockFetch(rules);
  const client = new EtherfuseClient({ apiKey: "sk_test", fetch: fetchImpl });
  return { client, requests };
}

describe("extractDeposit", () => {
  it("detecta PIX con cualquiera de los nombres de campo conocidos", () => {
    for (const field of [
      "depositPixQrCode",
      "depositPixCode",
      "pixCopiaECola",
      "pixQrCode",
      "brCode",
    ]) {
      const deposit = extractDeposit({ [field]: PIX_CODE, depositAmount: "500.00" });
      expect(deposit).toMatchObject({ method: "pix", pixCode: PIX_CODE, amount: "500.00" });
    }
  });

  it("detecta SPEI por depositClabe", () => {
    const deposit = extractDeposit({
      depositClabe: "646180157000000004",
      depositAmount: "1000.00",
      depositBankName: "Example Bank",
      depositAccountHolder: "Etherfuse MX",
    });
    expect(deposit).toMatchObject({
      method: "spei",
      clabe: "646180157000000004",
      bankName: "Example Bank",
      accountHolder: "Etherfuse MX",
    });
  });

  it("prefiere PIX si hay ambos", () => {
    expect(extractDeposit({ depositClabe: "6461...", brCode: PIX_CODE })?.method).toBe("pix");
  });

  it("devuelve null sin instrucciones", () => {
    expect(extractDeposit({ orderId: "x" })).toBeNull();
  });
});

describe("OrderReceipt", () => {
  const { client } = makeClient([]);

  it("parsea la forma anidada onramp (como documenta la API)", () => {
    const receipt = new OrderReceipt(client, {
      onramp: {
        orderId: "o-1",
        depositClabe: "646180157000000004",
        depositAmount: "1000.00",
        depositBankName: "Example Bank",
      },
    });
    expect(receipt.orderId).toBe("o-1");
    expect(receipt.direction).toBe("onramp");
    expect(receipt.deposit?.method).toBe("spei");
    expect(receipt.createPixQr()).toBeNull();
  });

  it("expone el QR PIX en onramps BRL", () => {
    const receipt = new OrderReceipt(client, {
      onramp: { orderId: "o-2", depositPixQrCode: PIX_CODE, depositAmount: "500.00" },
    });
    expect(receipt.deposit?.method).toBe("pix");
    const qr = receipt.createPixQr();
    expect(qr?.parse().pixKey).toBe("etherfuse@exemplo.com.br");
  });

  it("parsea la forma offramp con datos de retiro", () => {
    const receipt = new OrderReceipt(client, {
      offramp: { orderId: "o-3", withdrawAnchorAccount: "GABC", withdrawMemo: "123" },
    });
    expect(receipt.direction).toBe("offramp");
    expect(receipt.withdraw).toMatchObject({ anchorAccount: "GABC", memo: "123" });
  });

  it("tolera una respuesta plana (sin envoltorio onramp/offramp)", () => {
    const receipt = new OrderReceipt(client, { orderId: "o-4", depositClabe: "646..." });
    expect(receipt.orderId).toBe("o-4");
    expect(receipt.deposit?.method).toBe("spei");
  });

  it("lanza si no hay orderId", () => {
    expect(() => new OrderReceipt(client, {} as never)).toThrow(EtherfuseError);
  });
});

describe("Order", () => {
  it("expone getters de estado y deposit", () => {
    const { client } = makeClient([]);
    const order = new Order(client, {
      orderId: "o-1",
      orderType: "onramp",
      status: "created",
      depositPixQrCode: PIX_CODE,
    });
    expect(order.id).toBe("o-1");
    expect(order.isOnramp).toBe(true);
    expect(order.isTerminal).toBe(false);
    expect(order.deposit?.method).toBe("pix");
    expect(order.createPixQr()?.payload).toBe(PIX_CODE);
  });

  it("waitForStatus hace polling hasta completar", async () => {
    const { client } = makeClient([
      {
        route: "GET /ramp/order/o-1",
        sequence: [
          { response: { orderId: "o-1", status: "funded" } },
          { response: { orderId: "o-1", status: "completed" } },
        ],
      },
    ]);
    const order = new Order(client, { orderId: "o-1", status: "created" });
    const done = await order.waitForStatus("completed", { intervalMs: 1, timeoutMs: 5_000 });
    expect(done.status).toBe("completed");
  });

  it("waitForStatus lanza si la orden termina en estado terminal distinto", async () => {
    const { client } = makeClient([
      { route: "GET /ramp/order/o-2", response: { orderId: "o-2", status: "failed" } },
    ]);
    const order = new Order(client, { orderId: "o-2", status: "created" });
    await expect(
      order.waitForStatus("completed", { intervalMs: 1, timeoutMs: 5_000 }),
    ).rejects.toThrow(/failed/);
  });
});
