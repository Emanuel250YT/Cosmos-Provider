/**
 * Atom: EventEmitter tipado y sin dependencias de Node,
 * para que el cliente funcione igual en navegador y backend.
 */

export type EventMap = Record<string, unknown[]>;
export type Listener<Args extends unknown[]> = (...args: Args) => void;

type AnyListener = (...args: never[]) => void;

export class TypedEventEmitter<Events extends EventMap> {
  #listeners = new Map<keyof Events, Set<AnyListener>>();

  on<K extends keyof Events>(event: K, listener: Listener<Events[K]>): this {
    let set = this.#listeners.get(event);
    if (!set) {
      set = new Set();
      this.#listeners.set(event, set);
    }
    set.add(listener as unknown as AnyListener);
    return this;
  }

  once<K extends keyof Events>(event: K, listener: Listener<Events[K]>): this {
    const wrapper: Listener<Events[K]> = (...args) => {
      this.off(event, wrapper);
      listener(...args);
    };
    return this.on(event, wrapper);
  }

  off<K extends keyof Events>(event: K, listener: Listener<Events[K]>): this {
    this.#listeners.get(event)?.delete(listener as unknown as AnyListener);
    return this;
  }

  removeAllListeners<K extends keyof Events>(event?: K): this {
    if (event === undefined) this.#listeners.clear();
    else this.#listeners.delete(event);
    return this;
  }

  emit<K extends keyof Events>(event: K, ...args: Events[K]): boolean {
    const set = this.#listeners.get(event);
    if (!set || set.size === 0) return false;
    for (const listener of [...set]) (listener as unknown as Listener<Events[K]>)(...args);
    return true;
  }

  listenerCount<K extends keyof Events>(event: K): number {
    return this.#listeners.get(event)?.size ?? 0;
  }
}
