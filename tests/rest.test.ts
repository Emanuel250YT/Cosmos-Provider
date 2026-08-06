import { describe, expect, it } from "vitest";
import { REST } from "@/atoms/REST";
import { EtherfuseAPIError } from "@/atoms/errors";
import { createMockFetch } from "./helpers/mockFetch";

describe("REST", () => {
  it("points to the sandbox by default and to production when requested", () => {
    expect(new REST().baseUrl).toBe("https://api.sand.etherfuse.com");
    expect(new REST({ environment: "production" }).baseUrl).toBe("https://api.etherfuse.com");
  });

  it("sends the API key in Authorization WITHOUT a Bearer prefix", async () => {
    const { fetchImpl, requests } = createMockFetch([{ route: "GET /ramp/me", response: {} }]);
    const rest = new REST({ apiKey: "sk_test_123", fetch: fetchImpl });
    await rest.get("/ramp/me");
    expect(requests[0]!.headers["authorization"]).toBe("sk_test_123");
  });

  it("does not send Authorization with auth:false (public endpoints)", async () => {
    const { fetchImpl, requests } = createMockFetch([
      { route: "GET /lookup/exchange_rate", response: {} },
    ]);
    const rest = new REST({ apiKey: "sk_test_123", fetch: fetchImpl });
    await rest.get("/lookup/exchange_rate", { auth: false });
    expect(requests[0]!.headers["authorization"]).toBeUndefined();
  });

  it("serializes the query, omitting undefined/null", async () => {
    const { fetchImpl, requests } = createMockFetch([{ route: "GET /x", response: {} }]);
    const rest = new REST({ fetch: fetchImpl });
    await rest.get("/x", { query: { a: 1, b: "dos", c: undefined, d: null } });
    const url = new URL(requests[0]!.url);
    expect(url.searchParams.get("a")).toBe("1");
    expect(url.searchParams.get("b")).toBe("dos");
    expect(url.searchParams.has("c")).toBe(false);
    expect(url.searchParams.has("d")).toBe(false);
  });

  it("sends the body as JSON with Content-Type", async () => {
    const { fetchImpl, requests } = createMockFetch([{ route: "POST /ramp/quote", response: {} }]);
    const rest = new REST({ fetch: fetchImpl });
    await rest.post("/ramp/quote", { sourceAmount: "500" });
    expect(requests[0]!.headers["content-type"]).toBe("application/json");
    expect(requests[0]!.body).toEqual({ sourceAmount: "500" });
  });

  it("throws EtherfuseAPIError with status and body on HTTP errors", async () => {
    const { fetchImpl } = createMockFetch([
      { route: "GET /ramp/order/x", status: 404, response: { message: "Order not found" } },
    ]);
    const rest = new REST({ fetch: fetchImpl, retries: 0 });
    const error = await rest.get("/ramp/order/x").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(EtherfuseAPIError);
    expect((error as EtherfuseAPIError).status).toBe(404);
    expect((error as EtherfuseAPIError).message).toContain("Order not found");
  });

  it("retries on 424 (quote transiently unavailable) and eventually succeeds", async () => {
    const { fetchImpl, requests } = createMockFetch([
      {
        route: "POST /ramp/quote",
        sequence: [
          { status: 424, response: { message: "try later" } },
          { status: 200, response: { quoteId: "q1" } },
        ],
      },
    ]);
    const rest = new REST({ fetch: fetchImpl, retries: 2 });
    const result = await rest.post<{ quoteId: string }>("/ramp/quote", {});
    expect(result.quoteId).toBe("q1");
    expect(requests.length).toBe(2);
  });

  it("does NOT retry on 400 (structural error)", async () => {
    const { fetchImpl, requests } = createMockFetch([
      { route: "POST /ramp/order", status: 400, response: { message: "invalid quote" } },
    ]);
    const rest = new REST({ fetch: fetchImpl, retries: 3 });
    await expect(rest.post("/ramp/order", {})).rejects.toThrow(EtherfuseAPIError);
    expect(requests.length).toBe(1);
  });

  it("marks isRetryable correctly", () => {
    expect(new EtherfuseAPIError(424, "GET", "/x", null).isRetryable).toBe(true);
    expect(new EtherfuseAPIError(429, "GET", "/x", null).isRetryable).toBe(true);
    expect(new EtherfuseAPIError(500, "GET", "/x", null).isRetryable).toBe(true);
    expect(new EtherfuseAPIError(400, "GET", "/x", null).isRetryable).toBe(false);
    expect(new EtherfuseAPIError(404, "GET", "/x", null).isRetryable).toBe(false);
  });
});
