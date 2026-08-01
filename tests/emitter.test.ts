import { describe, expect, it, vi } from "vitest";
import { TypedEventEmitter } from "@/atoms/EventEmitter";

type Events = {
  ping: [value: number];
  empty: [];
};

describe("TypedEventEmitter", () => {
  it("emite a los listeners registrados con on()", () => {
    const emitter = new TypedEventEmitter<Events>();
    const fn = vi.fn();
    emitter.on("ping", fn);
    emitter.emit("ping", 42);
    emitter.emit("ping", 7);
    expect(fn).toHaveBeenNthCalledWith(1, 42);
    expect(fn).toHaveBeenNthCalledWith(2, 7);
  });

  it("once() se dispara una sola vez", () => {
    const emitter = new TypedEventEmitter<Events>();
    const fn = vi.fn();
    emitter.once("ping", fn);
    emitter.emit("ping", 1);
    emitter.emit("ping", 2);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("off() elimina el listener", () => {
    const emitter = new TypedEventEmitter<Events>();
    const fn = vi.fn();
    emitter.on("ping", fn);
    emitter.off("ping", fn);
    emitter.emit("ping", 1);
    expect(fn).not.toHaveBeenCalled();
  });

  it("emit devuelve false sin listeners y true con ellos", () => {
    const emitter = new TypedEventEmitter<Events>();
    expect(emitter.emit("empty")).toBe(false);
    emitter.on("empty", () => {});
    expect(emitter.emit("empty")).toBe(true);
  });

  it("removeAllListeners limpia todo", () => {
    const emitter = new TypedEventEmitter<Events>();
    emitter.on("ping", () => {});
    emitter.on("empty", () => {});
    emitter.removeAllListeners();
    expect(emitter.listenerCount("ping")).toBe(0);
    expect(emitter.listenerCount("empty")).toBe(0);
  });
});
