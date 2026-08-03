/**
 * Atom: EventEmitter tipado y sin dependencias de Node,
 * para que el cliente funcione igual en navegador y backend.
 */

/** Mapa de eventos: cada key es un nombre de evento y el valor la tupla de argumentos que recibe su listener. */
export type EventMap = Record<string, unknown[]>;
/** Función que escucha un evento `K`, tipada con la tupla de argumentos declarada en `EventMap`. */
export type Listener<Args extends unknown[]> = (...args: Args) => void;

// Tipo interno de borrado: el Map guarda listeners de distintos eventos (y
// por lo tanto distintas firmas) en el mismo Set, así que se almacenan con
// una firma genérica y se castean de vuelta al tipo real en cada uso público.
type AnyListener = (...args: never[]) => void;

export class TypedEventEmitter<Events extends EventMap> {
  // Un Set de listeners por evento — Set en vez de array para que `off`
  // sea O(1) y no haga falta buscar el índice del listener a remover.
  #listeners = new Map<keyof Events, Set<AnyListener>>();

  /** Suscribe `listener` a `event`. Se puede llamar varias veces con el mismo listener sin duplicar (es un Set). */
  on<K extends keyof Events>(event: K, listener: Listener<Events[K]>): this {
    let set = this.#listeners.get(event);
    if (!set) {
      set = new Set();
      this.#listeners.set(event, set);
    }
    set.add(listener as unknown as AnyListener);
    return this;
  }

  /** Igual que `on`, pero se desuscribe automáticamente después de la primera vez que dispara. */
  once<K extends keyof Events>(event: K, listener: Listener<Events[K]>): this {
    const wrapper: Listener<Events[K]> = (...args) => {
      this.off(event, wrapper);
      listener(...args);
    };
    return this.on(event, wrapper);
  }

  /** Quita `listener` de `event`. No hace nada si no estaba suscripto. */
  off<K extends keyof Events>(event: K, listener: Listener<Events[K]>): this {
    this.#listeners.get(event)?.delete(listener as unknown as AnyListener);
    return this;
  }

  /** Quita todos los listeners de `event`, o de absolutamente todos los eventos si se omite. */
  removeAllListeners<K extends keyof Events>(event?: K): this {
    if (event === undefined) this.#listeners.clear();
    else this.#listeners.delete(event);
    return this;
  }

  /** Dispara `event` con `args` para cada listener suscripto. Devuelve `true` si había al menos uno. */
  emit<K extends keyof Events>(event: K, ...args: Events[K]): boolean {
    const set = this.#listeners.get(event);
    if (!set || set.size === 0) return false;
    // Copia defensiva: si un listener se desuscribe (p. ej. `once`) o agrega
    // otro mientras se está iterando, no debe alterar esta pasada de emit.
    for (const listener of [...set]) (listener as unknown as Listener<Events[K]>)(...args);
    return true;
  }

  /** Cantidad de listeners actualmente suscriptos a `event`. */
  listenerCount<K extends keyof Events>(event: K): number {
    return this.#listeners.get(event)?.size ?? 0;
  }
}
