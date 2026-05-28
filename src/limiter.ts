export class ActiveRequestLimiter {
  #active = 0;

  constructor(readonly max: number) {}

  get active(): number {
    return this.#active;
  }

  tryAcquire(): (() => void) | null {
    if (this.#active >= this.max) {
      return null;
    }

    this.#active += 1;
    let released = false;

    return () => {
      if (released) {
        return;
      }
      released = true;
      this.#active = Math.max(0, this.#active - 1);
    };
  }
}
