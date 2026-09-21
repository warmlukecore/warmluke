# Warmluke (Adaptive OS)

Warmluke is a schema-driven business application platform. A merchant describes how
their business works, the assistant proposes a concrete application design, and the
approved design becomes sections, fields, views, statistics, records, and declarative
automations. A connected Shopify store can supply canonical commerce data, and a
merchant can use either Warmluke's built-in assistant or their own OAuth-connected AI
client through MCP.

This repository is an actively evolving product prototype. Its important safety
properties—tenant isolation, human approval, read-only third-party tokens, plan
validation, version history, and undo—are enforced in code and PostgreSQL rather than
left to model instructions.

## Technology

- Next.js 16 App Router and React 19
- TypeScript 7
- Supabase Auth, Postgres, Row Level Security, PostgREST, and Realtime
- Anthropic or Gemini for design generation and gap analysis
- Typesafe Jev for question routing and design judgement
- Shopify Admin GraphQL API, bulk operations, OAuth, and webhooks
- Model Context Protocol (MCP) over stateless HTTP

## Start locally

Prerequisites:

- Node.js version from `.nvmrc`
- pnpm
- A Supabase project with this repository's migrations applied

```bash
pnpm install
cp .env.example .env.local
# Fill in the required values in .env.local.
pnpm dev
```

The development server runs at `http://localhost:3100`.

Useful commands:

```bash
pnpm typecheck       # TypeScript validation
pnpm build           # Production build
pnpm check:pure      # Deterministic checks that need no live services
pnpm check:list      # Show all check tiers
pnpm check:live      # Live database/server checks
pnpm check           # Pure, live, and model tiers
```

Do not run live checks against production. See
[Development and deployment](docs/operations/development-and-deployment.md) for the
test-project workflow and migration process.

## Documentation

Start with the [documentation index](docs/README.md).

- [Architecture overview](docs/architecture/overview.md)
- [Runtime flows](docs/architecture/runtime-flows.md)
- [Frontend architecture](docs/architecture/frontend.md)
- [Domain and data model](docs/domain/data-model.md)
- [AI builder engine](docs/ai-builder/engine.md)
- [Security model](docs/security/security-model.md)
- [Shopify integration](docs/integrations/shopify.md)
- [MCP integration](docs/integrations/mcp.md)
- [HTTP API reference](docs/reference/http-api.md)
- [Environment reference](docs/reference/environment.md)
- [Testing strategy](docs/operations/testing.md)
- [Change guide](docs/contributing/change-guide.md)
- [Architecture decisions](docs/decisions/README.md)

## Repository map

```text
src/app/          Next.js pages, route handlers, and server actions
src/components/   Interactive application and marketing UI
src/lib/          Domain contracts, AI engine, validation, reads, and integrations
supabase/          Bootstrap schema and ordered database migrations
scripts/           Migration, seed, session, webhook, and regression-check tooling
docs/              Maintained engineering documentation
.agents/skills/    Repository-scoped agent skills
```

`supabase/schema.sql` is the historical `0001` bootstrap, not the current database by
itself. The current schema is that file followed by every numbered migration in
`supabase/migrations/`.

## Documentation maintenance

Invoke `$update-readme-agent` after a meaningful codebase change. The repository skill
compares the last documented commit with the current tree, traces the impacted runtime
areas, and updates the relevant documents and checkpoint.

## Security

Please read [SECURITY.md](SECURITY.md) for vulnerability reporting. Architectural
security guarantees and trust boundaries are documented in
[docs/security/security-model.md](docs/security/security-model.md).
