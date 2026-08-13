export const runPQ = async <T, R>(items: T[], executor: (item: T) => R, simultaneous = 5): Promise<R[]> => {
  if (simultaneous <= 0) {
    throw new Error('Simultaneous value must be greater than 0');
  }
  // Nothing to run means nothing ever reaches the completion check below, which would otherwise
  // leave the caller waiting on a promise that can never settle
  if (items.length === 0) return [];
  const returns: R[] = [];
  let currentIndex = 0;
  let currentlyRunning = 0;

  let done: (err?: any) => void;
  let isDone = false;
  const promise = new Promise<void>((resolve, reject) => {
    done = (err?: any) => {
      isDone = true;
      if (err) return reject(err);
      resolve();
    };
  });

  const run = async () => {
    if (isDone) return;
    currentlyRunning += 1;
    if (currentIndex >= items.length) {
      currentlyRunning -= 1;
      if (currentlyRunning === 0) {
        done();
      }
      return;
    }

    const i = currentIndex;
    currentIndex += 1;
    try {
      returns[i] = await executor(items[i]);
    } catch (err) {
      return done(err);
    }
    currentlyRunning -= 1;

    process.nextTick(run);
  };

  for (let t = 0; t < Math.min(items.length, simultaneous); t += 1) {
    run();
  }

  await promise;
  return returns;
};
