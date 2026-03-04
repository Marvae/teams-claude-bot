/**
 * A simple async iterable queue. push() enqueues items,
 * for-await-of consumes them. end() signals no more items.
 */
export class AsyncQueue<T> implements AsyncIterable<T> {
  private queue: T[] = [];
  private waiters: Array<(value: IteratorResult<T>) => void> = [];
  private done = false;

  push(item: T): void {
    if (this.done) return;
    const waiter = this.waiters.shift();
    if (waiter) {
      waiter({ value: item, done: false });
    } else {
      this.queue.push(item);
    }
  }

  end(): void {
    this.done = true;
    for (const w of this.waiters) {
      w({ value: undefined as never, done: true });
    }
    this.waiters.length = 0;
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: () =>
        new Promise<IteratorResult<T>>((resolve) => {
          const item = this.queue.shift();
          if (item !== undefined) {
            resolve({ value: item, done: false });
          } else if (this.done) {
            resolve({ value: undefined as never, done: true });
          } else {
            this.waiters.push(resolve);
          }
        }),
    };
  }
}
