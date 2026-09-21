# Development and deployment

## Prerequisites

- Node.js version specified in `.nvmrc`
- pnpm and the committed lockfile
- A Supabase project
- `psql` when applying migrations through `DATABASE_URL`
- Provider credentials for the integrations being exercised

## Local setup

```bash
pnpm install
cp .env.example .env.local
```

Fill the required Supabase values and any model/Shopify integrations you intend to use.
Apply the database before starting the app:

```bash
node scripts/apply-migrations.mjs --env .env.local
pnpm dev
```

Open `http://localhost:3100`.

The migration command requires either a project-scoped `DATABASE_URL` or a Supabase
management token in the selected environment file. Prefer `DATABASE_URL` for isolated
development and CI because it cannot reach unrelated projects and gives each migration
one transaction.

## Database lifecycle

The migration runner treats `supabase/schema.sql` as `0001_schema.sql`, then reads every
numbered file from `supabase/migrations`. It creates and consults
`public.abo_migrations`, skipping versions already recorded.

For a database whose historical migrations were applied manually, `--record-only` can
backfill the ledger. Use it only after independently confirming that every recorded
migration is already present; it executes none of their SQL.

To change the schema:

1. Add the next sequential `NNNN_descriptive_name.sql` file.
2. Make the migration safe for the actual current state.
3. End function-replacing migrations with `NOTIFY pgrst, 'reload schema'`.
4. Add/update pure and live checks for the new invariant.
5. Run the migration against the isolated check project before production.
6. Update the data/security/integration documentation affected by the change.

`check-migrations` verifies naming, uniqueness, continuity, non-empty files, and PostgREST
notification for replaced functions.

## Development commands

```bash
pnpm dev             # Next.js development server on port 3100
pnpm typecheck       # tsc --noEmit
pnpm build           # Production Next.js build
pnpm start           # Serve production build on port 3100
pnpm audit           # High-severity dependency audit
pnpm check:list      # Discover/classify all checks
pnpm check:pure      # Deterministic local/CI checks
pnpm check:live      # Database/server checks
pnpm hooks           # Install repository pre-push hook
```

## Isolated check project

Live checks mutate data and exercise security policies. They belong on the dedicated
check Supabase project, never production.

The expected workflow is:

1. Put check-project credentials in `.env.check.local`.
2. Apply migrations to that project.
3. Run `scripts/seed-check-project.mjs`.
4. Build/start the application using the same project's public values.
5. Run the live tier with `--env .env.check.local` as needed.

The runner compares the Supabase project named by the running server with the selected
environment file. A mismatch is treated as no suitable server rather than allowing tests
to cross environments.

## CI

`.github/workflows/checks.yml` contains two jobs:

- **static**: install, dependency audit, typecheck, production build, pure checks;
- **live**: migrate and seed the check project, build/start the server, run live checks.

Fork pull requests do not receive the live-project secrets. Checks needing the
account-wide Supabase management token are deliberately skipped in CI and run by the
local pre-push hook against the check project.

Model-tier checks are paid and non-deterministic, so they are not push gates.

## Deployment

The repository is linked to Vercel, but pushing to `main` does not deploy it. The
`deploy` job in `.github/workflows/checks.yml` does, after both check tiers have passed:
it asks the Vercel API to build that commit from GitHub and waits for the result, so a
failed build turns the commit red. `vercel.json` turns off the git integration for `main`
only, leaving previews on other branches alone.

The production build is `pnpm build`, and the server expects the same runtime environment
variables documented in [Environment reference](../reference/environment.md).

Before deployment:

- apply required migrations;
- confirm public Supabase values match the target database;
- confirm callback/webhook URLs point to the deployed origin;
- run static and relevant live checks;
- verify Shopify scopes before enabling extended order history;
- review security-header changes against the installed Next.js 16 documentation.

They used to be separate systems, and both directions failed on 2026-09-21: a commit
went live while its run was cancelled by the next push, and two commits passed every
check and were never deployed at all. A run on `main` is no longer cancelled by the push
after it, and the deploy is a job rather than a side effect of pushing.

To deploy by hand when that job is in the way, `vercel --prod --yes` from a clean tree
still works. The deploy token is team-scoped, so the Vercel CLI cannot authenticate with
it; the job uses the REST API directly.

## Operational recovery

- **Interrupted Shopify import:** call status, then continue ordinary import requests;
  progress is stored per resource.
- **Suspected missed webhooks:** start a recheck; review drift instead of deleting rows.
- **Expired Shopify refresh token:** reconnect the store.
- **Failed model turn:** inspect normalized error kind; no design was applied by chat.
- **Failed build:** read the returned compensation/stranded-effects message and build
  history before retrying.
- **Incorrect completed build:** use the recorded undo while its optimistic guards still
  permit restoration.
- **Migration failure:** fix the failing new migration and rerun; successfully ledgered
  earlier versions are skipped.
