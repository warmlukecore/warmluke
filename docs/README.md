# Engineering documentation

This directory documents the system as it behaves at the commit recorded in
[`.documentation-state.json`](.documentation-state.json). Code, migrations, and checks
remain authoritative; the documents explain how those sources fit together.

## Reading paths

### New engineer

1. [Architecture overview](architecture/overview.md)
2. [Domain and data model](domain/data-model.md)
3. [Runtime flows](architecture/runtime-flows.md)
4. [Frontend architecture](architecture/frontend.md)
5. [Development and deployment](operations/development-and-deployment.md)
6. [Testing strategy](operations/testing.md)

### AI and platform engineer

1. [AI builder engine](ai-builder/engine.md)
   - [Luke as an agent](ai-builder/agent-loop.md): the tool loop behind `LUKE_AGENT=on`
1. [Parity: what Luke and their own AI can see and do](ai-builder/parity.md)
2. [Architecture decisions](decisions/README.md)
3. [MCP integration](integrations/mcp.md)
4. [Security model](security/security-model.md)
5. [Change guide](contributing/change-guide.md)

### Commerce/integration engineer

1. [Shopify integration](integrations/shopify.md)
2. [Connectors: couriers and ad accounts](integrations/connectors.md)
3. [Meta website lead tracking](integrations/meta-conversions.md)
4. [Domain and data model](domain/data-model.md)
5. [HTTP API reference](reference/http-api.md)
6. [Environment reference](reference/environment.md)
7. [Limits: every cap and who is told](reference/limits.md)
8. [Operations](operations/development-and-deployment.md)

### Security reviewer

1. [Security model](security/security-model.md)
2. [Incident response](security/incident-response.md)
3. [MCP integration](integrations/mcp.md)
4. [Shopify integration](integrations/shopify.md)
5. [Testing strategy](operations/testing.md)

## Document map

| Area                             | Document                                                           | Primary implementation sources                       |
| -------------------------------- | ------------------------------------------------------------------ | ---------------------------------------------------- |
| System boundaries                | [Architecture overview](architecture/overview.md)                  | `src/app`, `src/lib`, `supabase/migrations`          |
| Critical sequences               | [Runtime flows](architecture/runtime-flows.md)                     | `engine.ts`, `apply.ts`, API routes                  |
| UI runtime                       | [Frontend architecture](architecture/frontend.md)                  | `AppShell.tsx`, `ChatPanel.tsx`, renderer components |
| Look and feel                    | [Design system](design/design-system.md)                           | `globals.css` tokens, `src/components/ui/`           |
| Domain/storage                   | [Data model](domain/data-model.md)                                 | `types.ts`, migrations                               |
| AI design contract               | [AI builder](ai-builder/engine.md)                                 | `ai.ts`, `engine.ts`, `capabilities.ts`              |
| Measuring Luke                   | [Luke evals](../evals/README.md)                                   | `eval-luke.mjs`, `evals/`, `fixtures/shops.ts`       |
| Authentication and authorization | [Security](security/security-model.md)                             | RLS migrations, auth helpers, build RPCs             |
| Shopify                          | [Shopify](integrations/shopify.md)                                 | Shopify libraries, routes, commerce migrations       |
| Couriers and ad accounts         | [Connectors](integrations/connectors.md)                           | `connectors.ts`, connector routes and migrations     |
| External assistants              | [MCP](integrations/mcp.md)                                         | `/api/mcp`, OAuth migrations                         |
| HTTP surface                     | [HTTP API](reference/http-api.md)                                  | `src/app/**/route.ts`                                |
| Configuration                    | [Environment](reference/environment.md)                            | `.env.example`, runtime lookups                      |
| Caps on reads and work           | [Limits](reference/limits.md)                                      | every `.limit(`, `scripts/check-limits.mjs`          |
| Local and production operations  | [Development/deployment](operations/development-and-deployment.md) | package scripts, CI, migration runner                |
| Verification                     | [Testing](operations/testing.md)                                   | `scripts/run-checks.mjs`, `check-*.mjs`              |
| Change recipes                   | [Change guide](contributing/change-guide.md)                       | cross-cutting source map                             |
| Why the system has this shape    | [Decisions](decisions/README.md)                                   | source comments and migration history                |

## Sources of truth

When sources disagree, use this order:

1. Current executable code and the complete ordered migration chain.
2. Regression checks that assert observable behavior.
3. These documents.
4. Historical comments, commit messages, and the bootstrap schema in isolation.

Important exceptions and seams are called out in the relevant documents. In particular:

- `supabase/schema.sql` is migration `0001`; it is not a current-schema snapshot.
- Platform capability declarations live in `src/lib/capabilities.ts`; prompt prose should
  not independently invent capabilities.
- Shopify resource metadata lives in `src/lib/shopify-resources.ts`.
- The TypeScript and PostgreSQL expression evaluators are separate implementations;
  `check-operator-parity` guards their shared contract.

## Keeping documentation current

Run `$update-readme-agent`. Its instructions are in
`.agents/skills/update-readme-agent/SKILL.md`; it uses the documentation checkpoint and
Git history to update only the affected documents.
