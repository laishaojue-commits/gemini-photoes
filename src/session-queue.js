/**
 * Small shared helpers for operations against the single Gemini page.
 */
export function createMutex() {
  let tail = Promise.resolve();

  return {
    run(task) {
      const result = tail.then(task, task);
      tail = result.then(() => undefined, () => undefined);
      return result;
    },
  };
}

export function createSingleFlight(task) {
  let pending = null;

  return (...args) => {
    if (!pending) {
      pending = Promise.resolve().then(() => task(...args)).finally(() => {
        pending = null;
      });
    }
    return pending;
  };
}

export function createSessionTaskRunner({ mutex, disconnect }) {
  return (task) => mutex.run(async () => {
    try {
      return await task();
    } finally {
      await disconnect();
    }
  });
}
