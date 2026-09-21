---
name: update-readme-agent
description: Review repository changes since the last documentation checkpoint and update Warmluke's README and engineering docs. Use when the user invokes $update-readme-agent, asks to refresh docs after code changes, or wants documentation drift checked.
---

# Update Warmluke documentation

Keep `README.md` and `docs/` aligned with observable repository behavior. Write all
documentation in professional English.

## Establish the change set

1. Read the repository `AGENTS.md`, `docs/README.md`, and
   `docs/.documentation-state.json`.
2. Resolve `documented_commit` and verify it is an ancestor of `HEAD`.
   - If it is valid, inspect commits and `git diff --name-status <commit>..HEAD`.
   - If it is missing or not an ancestor, use the merge base only as a diagnostic and
     report the checkpoint problem. Do not silently pretend a different commit was the
     last documented state.
3. Also inspect staged, unstaged, and relevant untracked files. Documentation may need to
   describe work that has not been committed yet.
4. Read changed implementation files, their callers, their latest defining migrations,
   and relevant checks. Commit subjects are navigation aids, not evidence of behavior.

Do not expose `.env` values, tokens, credentials, customer data, or local tool artifacts.

## Determine documentation impact

Use the document map in `docs/README.md`. Typical routing:

- `src/lib/ai.ts`, `engine.ts`, `capabilities.ts`, `judge.ts`, `route.ts`, `slice.ts`:
  AI builder, runtime flows, decisions, and relevant reference docs.
- `src/lib/apply.ts`, build/undo routes, build migrations: runtime flows, domain,
  security, HTTP API, and decisions.
- `src/lib/shopify-*`, Shopify routes, commerce migrations: Shopify, data model,
  security, HTTP API, environment, and operations.
- MCP route or OAuth/client migrations: MCP, security, runtime flows, HTTP API, and data
  model.
- pages/components/styles: frontend architecture and user-facing portions of README.
- tables, views, policies, functions, indexes: data model and security; integration or
  operations docs when applicable.
- scripts, CI, hooks, package/config/env examples: testing, development/deployment,
  environment, root README.

Update architecture decisions only for durable rationale or a reversed trade-off. Do not
turn ordinary implementation details into ADRs.

## Edit rules

- Preserve the documentation hierarchy and relative Markdown links.
- Prefer updating the owning document over duplicating the same explanation elsewhere.
- Keep root `README.md` concise and route detail into `docs/`.
- Describe current behavior in the present tense. Put historical context only where it
  prevents a real misunderstanding.
- Distinguish code-enforced guarantees from model prompts, UI behavior, assumptions, and
  operational conventions.
- For database behavior, read the complete migration evolution needed to identify the
  latest definition. `supabase/schema.sql` alone is never the current schema.
- For Next.js behavior, read the relevant installed guide in `node_modules/next/dist/docs/`
  before documenting a changed convention.
- Update diagrams when nodes, trust boundaries, ordering, or failure behavior changes.
- Preserve unrelated user edits and do not modify application code unless separately
  requested.

## Checkpoint rules

Update `docs/.documentation-state.json` only after documentation and verification finish.

- If all reviewed source changes are committed, set `documented_commit` to the full
  current `HEAD` SHA and `documented_at` to the current date.
- If relevant source changes remain staged, unstaged, or untracked, update the docs but
  do not advance the commit. Report that the next run must review the eventual commit.
- Documentation-only working-tree changes created by this skill do not prevent advancing
  the checkpoint.
- Keep `schema_version` unchanged unless the checkpoint format itself changes.

## Verification

Before finishing:

1. Re-scan routes, environment lookups, migrations, MCP tools, capability declarations,
   and check inventory when any of them changed.
2. Verify every relative Markdown link and documented local path exists.
3. Search the edited docs for superseded names and contradictory claims.
4. Run `pnpm typecheck` and `pnpm check:pure` for a normal documentation refresh. Run a
   production build or targeted live checks when the underlying change warrants them and
   the required safe environment is available. Never run paid model checks implicitly.
5. Inspect `git diff --check` and the final diff. Documentation updates must not include
   secrets, generated build output, or unrelated code changes.

Report the reviewed commit range, documents changed, verification performed, and any
uncertainty or intentionally deferred live/model validation.
