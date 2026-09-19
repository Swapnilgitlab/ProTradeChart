/** Runs `run` unless a call with the same `key` is already in flight, in which
 *  case that call's promise is returned instead. The entry is dropped as soon as
 *  the call settles, so this only merges *simultaneous* identical requests — it
 *  is not a cache. A grid of charts that all boot on the same symbol asks for
 *  the same history at the same moment; this turns that into one request. */
export function coalesce<T>(inflight: Map<string, Promise<T>>, key: string, run: () => Promise<T>): Promise<T> {
  const existing = inflight.get(key);
  if (existing) return existing;
  const pending = run().finally(() => inflight.delete(key));
  inflight.set(key, pending);
  return pending;
}
