export class ActiveRequestLimiter {
  #active = 0;
  #queue: Array<{
    resolve: (release: () => void) => void;
    reject: (error: Error) => void;
    timeout?: NodeJS.Timeout;
  }> = [];

  constructor(readonly max: number) {}

  get active(): number {
    return this.#active;
  }

  get queued(): number {
    return this.#queue.length;
  }

  tryAcquire(): (() => void) | null {
    if (this.#active >= this.max) {
      return null;
    }

    this.#active += 1;
    return this.#makeRelease();
  }

  acquire({ timeoutMs }: { timeoutMs?: number } = {}): Promise<() => void> {
    const release = this.tryAcquire();
    if (release) {
      return Promise.resolve(release);
    }

    return new Promise((resolve, reject) => {
      const queued = {
        resolve,
        reject,
        timeout: undefined as NodeJS.Timeout | undefined
      };

      if (timeoutMs && timeoutMs > 0) {
        queued.timeout = setTimeout(() => {
          this.#queue = this.#queue.filter((item) => item !== queued);
          reject(new Error('Limiter acquire timed out'));
        }, timeoutMs);
      }

      this.#queue.push(queued);
    });
  }

  #makeRelease(): () => void {
    let released = false;

    return () => {
      if (released) {
        return;
      }
      released = true;

      const next = this.#queue.shift();
      if (next) {
        if (next.timeout) {
          clearTimeout(next.timeout);
        }
        next.resolve(this.#makeRelease());
        return;
      }

      this.#active = Math.max(0, this.#active - 1);
    };
  }
}
