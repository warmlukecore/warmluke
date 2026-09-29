// Work that answers in time if it can, and finishes anyway if it cannot.
//
// A design through a connected assistant took the whole request: past a
// client's patience the connection closed, the turn was told to stop,
// and the design was thrown away. The design now runs as work of its
// own; the request waits a while for it, and when it is not done the
// caller answers "still designing" and hands the rest to whatever keeps
// a function alive after its answer (next/server's after).

/**
 * The work's value when it settles within `ms`; otherwise null, and
 * `later` is handed the rest of it to keep alive. A failure within the
 * wait is the caller's to handle, as if it had awaited the work itself.
 */
export async function inTime<T>(work: Promise<T>, ms: number, later: (rest: Promise<T>) => void): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = Symbol("late");
  const first = await Promise.race([
    work,
    new Promise<typeof late>((resolve) => {
      timer = setTimeout(() => resolve(late), ms);
    }),
  ]).finally(() => clearTimeout(timer));
  if (first !== late) return first as T;
  later(work);
  return null;
}
