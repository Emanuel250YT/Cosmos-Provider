/**
 * Atom: typed EventEmitter with no Node dependencies,
 * so the client works the same in the browser and backend.
 */

/** Event map: each key is an event name and the value is the argument tuple its listener receives. */
export type EventMap = Record<string, unknown[]>;
/** Function that listens to an event `K`, typed with the argument tuple declared in `EventMap`. */
export type Listener<Args extends unknown[]> = (...args: Args) => void;

// Internal type-erased signature: the Map stores listeners from different
// events (and thus different signatures) in the same Set, so they're stored
// with a generic signature and cast back to the real type at each public use.
type AnyListener = (...args: never[]) => void;

export class TypedEventEmitter<Events extends EventMap> {
  // One listener Set per event — Set instead of array so `off` is O(1)
  // and doesn't need to look up the index of the listener to remove.
  #listeners = new Map<keyof Events, Set<AnyListener>>();

  /** Subscribes `listener` to `event`. Can be called multiple times with the same listener without duplicating it (it's a Set). */
  on<K extends keyof Events>(event: K, listener: Listener<Events[K]>): this {
    let set = this.#listeners.get(event);
    if (!set) {
      set = new Set();
      this.#listeners.set(event, set);
    }
    set.add(listener as unknown as AnyListener);
    return this;
  }

  /** Same as `on`, but automatically unsubscribes after firing the first time. */
  once<K extends keyof Events>(event: K, listener: Listener<Events[K]>): this {
    const wrapper: Listener<Events[K]> = (...args) => {
      this.off(event, wrapper);
      listener(...args);
    };
    return this.on(event, wrapper);
  }

  /** Removes `listener` from `event`. No-op if it wasn't subscribed. */
  off<K extends keyof Events>(event: K, listener: Listener<Events[K]>): this {
    this.#listeners.get(event)?.delete(listener as unknown as AnyListener);
    return this;
  }

  /** Removes all listeners for `event`, or for every event if omitted. */
  removeAllListeners<K extends keyof Events>(event?: K): this {
    if (event === undefined) this.#listeners.clear();
    else this.#listeners.delete(event);
    return this;
  }

  /** Fires `event` with `args` for each subscribed listener. Returns `true` if there was at least one. */
  emit<K extends keyof Events>(event: K, ...args: Events[K]): boolean {
    const set = this.#listeners.get(event);
    if (!set || set.size === 0) return false;
    // Defensive copy: if a listener unsubscribes (e.g. `once`) or adds
    // another one while iterating, it shouldn't affect this emit pass.
    for (const listener of [...set]) (listener as unknown as Listener<Events[K]>)(...args);
    return true;
  }

  /** Number of listeners currently subscribed to `event`. */
  listenerCount<K extends keyof Events>(event: K): number {
    return this.#listeners.get(event)?.size ?? 0;
  }
}
