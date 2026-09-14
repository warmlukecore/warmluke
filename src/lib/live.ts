// ─────────────────────────────────────────────────────────────
// Changes the browser did not make.
//
// A merchant can approve a build inside Claude, or work in a second
// tab, or have a colleague on the same project. The page had no way to
// hear about any of it — it showed whatever it loaded on open, and
// only a refresh told the truth.
//
// One helper rather than a subscription written out at each call site:
// the coalescing and the teardown are the parts that go wrong, and
// they should go wrong in one place or not at all.
// ─────────────────────────────────────────────────────────────

import { supabase } from "./supabase-client";

export type Watch = {
  table: string;
  /** PostgREST filter, e.g. `project_id=eq.<uuid>`. */
  filter?: string;
  onChange: () => void;
};

/**
 * Subscribes to row changes and calls back when they land. Returns the
 * unsubscribe — call it on unmount, or the channel outlives the screen
 * and fires into a component that is gone.
 *
 * Row-level security applies to the stream as it does to a read, so a
 * filter here narrows what arrives; it is not what keeps someone
 * else's rows out.
 */
export function watchRows(channelName: string, watches: Watch[]): () => void {
  const channel = supabase.channel(channelName);

  // One build writes a section, its columns and its rows in quick
  // succession. Reloading on each would run three round trips and
  // repaint three times to arrive at the same screen.
  const pending = new Map<() => void, ReturnType<typeof setTimeout>>();
  const coalesce = (fn: () => void) => {
    clearTimeout(pending.get(fn));
    pending.set(
      fn,
      setTimeout(() => {
        pending.delete(fn);
        fn();
      }, 150)
    );
  };

  for (const w of watches) {
    channel.on(
      // The typings for postgres_changes are looser than the runtime
      // contract; the shape below is what the server expects.
      "postgres_changes" as never,
      {
        event: "*",
        schema: "public",
        table: w.table,
        ...(w.filter ? { filter: w.filter } : {}),
      } as never,
      (() => coalesce(w.onChange)) as never
    );
  }

  channel.subscribe();

  return () => {
    for (const t of pending.values()) clearTimeout(t);
    pending.clear();
    supabase.removeChannel(channel);
  };
}
