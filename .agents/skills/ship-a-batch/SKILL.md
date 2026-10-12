---
name: ship-a-batch
description: How to integrate work from several agents or sessions and ship it to production safely — the gates, the order (migrations before code), pushing from a clean copy, watching CI to the deploy, and the traps that have bitten this repo. Use when committing, pushing, running migrations on production, or when a check or tape replay passes in one place and fails in another.
---

# Ship a batch

Production deploys from CI on a push to `main` (memory: the checks' deploy job, not
Vercel's git hook). Nothing reaches merchants until every gate below is green.

## The gates, in order

1. **Format, with the failure visible.** `pnpm run -s format:check` on its own line.
   Never pipe it (`| tail`): a pipe returns the last command's status and a failing
   check sails through (it did, 12 Oct). Format only the files you own:
   `pnpm exec oxfmt <files>`.
2. **Typecheck:** `pnpm exec tsc --noEmit -p . --pretty false` (coloured output hid an error once).
3. **Lint:** `pnpm exec oxlint src scripts e2e | grep -c ": error "` must be 0 (warnings exist; `rtk proxy pnpm lint` exits 1 on them).
4. **Pure checks:** `node scripts/run-checks.mjs --tier pure`.
5. **Live checks** on the check project, server on :3101 with `MODEL_TAPE=replay`:
   `APP_URL=http://localhost:3101 node scripts/run-checks.mjs --tier live --env .env.check.local`.
   Never run two live suites or e2e runs at once: they share the check project's users.
6. **Browser walks**, both widths: `ENV_FILE=.env.check.local APP_URL=http://localhost:3101 pnpm exec playwright test`.
   A failure under a long loaded run is re-run alone before it is called a regression.
7. **Build:** `pnpm build` must reach "Compiled workflows" after any change under `src/workflows`.

## Commit only what is finished

- Stage paths you know (`git add <files>`), not `git add -A` over folders others write in: an
  agent's half-written file went into a commit that way. Check `git show --stat HEAD`.
- Short messages, 8–12 lines (memory: short-commit-messages).

## Migrations before code

- Check project: `node scripts/apply-migrations.mjs --env .env.check.local`.
- Production: the owner runs `node scripts/apply-migrations.mjs --env .env.local` (agents are
  blocked from production writes). Verify read-only that the ledger row says
  `recorded_only: false` and the objects exist before pushing.
- Never set `import_worker_url` or `connector_worker_url` on the check project.

## Push from a clean copy when others are still working

The pre-push hook runs checks against the working tree. With agents mid-edit, push the
commit from its own worktree so their unfinished files cannot fail it:

```bash
git worktree add ../ship-<sha> <sha>
ln -s "$PWD/node_modules" ../ship-<sha>/node_modules   # node scripts only; Turbopack refuses this link
cp .env.check.local .env.local ../ship-<sha>/            # gitignored; delete after
(cd ../ship-<sha> && git push origin <sha>:main)
```

Then watch: `gh run list --branch main --limit 3`, `gh run watch <id> --exit-status`.
A dropped watch is not a failed run: read `gh run view <id> --json conclusion,jobs`.
Confirm the change is live with a request that only the new code answers.

## Tapes (recorded model calls)

- Keys ignore volatile values (ids, dates, times, gids, shop names) and `cache_control`.
- A request that matches no recording exactly falls back to a recording of the same
  conversation (same road tag, else same tools, else the first by name). Several stale
  recordings of one conversation make that choice fragile: keep one per conversation and
  step, and delete superseded ones when re-recording a check whole.
- `MODEL_TAPE_DUMP=<dir>` on the server writes each request as sent, to compare a miss.
- Recording is paid. It needs the owner's yes and a stated cap; record a check whole when a
  filled call would sit beside replayed thinking blocks (they carry signatures).
