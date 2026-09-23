# Environment reference

Never commit real credentials. `.env.example` documents the normal application values;
test and migration workflows may require additional values in `.env.check.local` or CI.

## Application runtime

| Variable | Required | Purpose |
| --- | ---: | --- |
| `NEXT_PUBLIC_ADAPTIVE_OS_SUPABASE_URL` | Yes | Supabase project URL used by browser, server auth verification, CSP, and public callback clients |
| `NEXT_PUBLIC_ADAPTIVE_OS_SUPABASE_ANON_KEY` | Yes | Public Supabase anonymous key; authorization still depends on JWT/RLS |
| `ANTHROPIC_API_KEY` | For Anthropic models/fallback | Built-in assistant and gap-model access |
| `ANTHROPIC_MODEL` | No | Main design model; defaults to `claude-sonnet-4-5` |
| `ANTHROPIC_API_URL` | No | Compatible Messages API host for local/testing use |
| `ANTHROPIC_GAP_MODEL` | No | Lower-cost model used by the gap pass |
| `ANTHROPIC_FALLBACK_MODEL` | No | Anthropic fallback after repeated Gemini transient failure |
| `GEMINI_API_KEY` | For Gemini model IDs | Gemini generation access |
| `TYPESAFE_API_KEY` | No | Enables Jev question routing and asynchronous design judgement |
| `TYPESAFE_MODEL` | No | Jev model name; defaults to `jev-latest` |
| `TYPESAFE_API_URL` | No | Jev-compatible endpoint override |
| `SHOPIFY_CLIENT_ID` | For Shopify | Shopify application client ID |
| `SHOPIFY_CLIENT_SECRET` | For Shopify | OAuth secret and webhook-HMAC secret |
| `SHOPIFY_READ_ALL_ORDERS` | No | Adds `read_all_orders` only after Shopify has approved that scope |
| `SHOPIFY_BULK_THRESHOLD` | No | Resource count above which supported imports use bulk operations; default `250` |
| `NEXT_PUBLIC_SHOPIFY_INSTALL_URL` | No | The app's Shopify listing (`https://apps.shopify.com/…`). Set it once the app is public (unlisted is enough) to show one-tap **Connect with Shopify**. Only `apps.shopify.com` and `admin.shopify.com` over https are accepted. Unset, the address box is the way in. |

`ADAPTIVE_OS_SERVICE_ROLE_KEY` appears in `.env.example` for maintenance/check tooling.
The application runtime deliberately uses caller-scoped clients and narrow database RPCs
instead of this key.

## Migration and check tooling

| Variable | Context | Purpose |
| --- | --- | --- |
| `DATABASE_URL` | Migration runner/CI | Direct project-scoped Postgres connection; each migration runs transactionally |
| `ADAPTIVE_OS_SERVICE_ROLE_KEY` | Live checks/seeding | Privileged key for the isolated check project |
| `SUPABASE_ACCESS_TOKEN` | Local management checks/migrations | Account-wide management API token; intentionally excluded from CI |
| `SUPABASE_DB_QUERY_URL` | Optional parity check | Supabase database-query endpoint paired with the management token |
| `OWNER_PASSWORD` | Live check harness | Password for the seeded check owner when session creation needs it |
| `APP_URL` | Live checks/webhook script | Running application base URL; checks default to `http://localhost:3100` |
| `ENV_FILE` | Scripts | Select environment file; defaults to `.env.local` |
| `CHECK_PROJECT` | CI/check setup | Marks the isolated check environment where applicable |
| `ABO_BASE` | Manual scenario harness | Application base URL for `check-scenarios` |
| `ABO_JWT` | Manual scenario harness | Caller-provided test JWT; never print or commit it |
| `ABO_EVAL_MODEL` | Scenario results | Label/model selector for evaluation output |

## Configuration rules

- Restart the development server after changing values that Next.js loads at startup.
- `NEXT_PUBLIC_*` values are shipped to the browser and are not secrets.
- The Shopify secret, model keys, database URL, service role, management token, passwords,
  and JWTs are secrets.
- Keep production credentials out of the check project and check credentials out of
  production.
- `SUPABASE_ACCESS_TOKEN` is account-wide. The pre-push hook uses it locally for checks
  CI should not be trusted to hold.
- `SHOPIFY_READ_ALL_ORDERS=true` is a capability declaration, not a workaround for
  missing Shopify approval.
