// The superadmin console's address: one path segment, kept in the server's
// environment (ADMIN_PATH), never in the code. The repository is public,
// so a folder named for it would be read on GitHub; a segment in the
// environment is not in the code, the bundle or the repository.
//
// The console's own screens still refuse anyone who is not an
// administrator, and every database function behind them does too: an
// address nobody can guess keeps it from being found and probed, it is
// not what keeps anyone out.
//
// Unset, it is "admin", where the console always was, so nothing is lost
// before the variable is set.
//
// Callers: src/app/[gate]/layout.tsx, src/app/api/console/route.ts.

/** The segment the console answers on. Server only: ADMIN_PATH is not NEXT_PUBLIC. */
export function consoleSegment(): string {
  const set = process.env.ADMIN_PATH?.trim();
  return set && /^[A-Za-z0-9_-]{6,64}$/.test(set) ? set : "admin";
}
