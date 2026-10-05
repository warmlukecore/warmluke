// What the walk page has for a database: nothing. The row form asks who
// added and last changed a row (RecordModal); in a sealed browser there is
// nobody to ask, and the form shows no names, as it does for a new row.
// The walk page's bundle puts this in place of lib/supabase-client
// (scripts/build-walk-page.mjs).

const nothing = { data: null, error: null };

export const supabase = {
  rpc: async () => nothing,
  from: () => ({ select: async () => nothing }),
  auth: { getSession: async () => ({ data: { session: null } }) },
};
