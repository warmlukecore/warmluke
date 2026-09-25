# Environment reference

Never commit real credentials. `.env.example` documents the normal application values;
test and migration workflows may require additional values in `.env.check.local` or CI.

## Application runtime

| Variable | Required | Purpose |
| --- | ---: | --- |
| `NEXT_PUBLIC_ADAPTIVE_OS_SUPABASE_URL` | Yes | Supabase project URL used by browser, server auth verification, CSP, and public callback clients |
| `NEXT_PUBLIC_ADAPTIVE_OS_SUPABASE_ANON_KEY` | Yes | Public Supabase anonymous key; authorization still depends on JWT/RLS |
| `ANTHROPIC_API_KEY` | For Anthropic models/fallback | Built-in assistant and gap-model access |
| `ANTHROPIC_MODEL` | For Luke | Main design model; a `gemini-…` name goes to Google, any other name to the Anthropic-format host. Production: `claude-opus-5-5` (see below). No default: unset, Luke says it is not set up |
| `ANTHROPIC_API_URL` | No | The Messages URL (`…/v1/messages`) of a host speaking Anthropic's API, for testing or a proxy. A proxy must accept the model names in `ANTHROPIC_MODEL`, `ANTHROPIC_GAP_MODEL` and `ANTHROPIC_FALLBACK_MODEL`, or those calls are refused |
| `ANTHROPIC_GAP_MODEL` | For the gap pass | Lower-cost model used by the gap pass. Production: `claude-haiku-4-5-20251001`. No default: unset, the gap pass is skipped and logs why |
| `ANTHROPIC_FALLBACK_MODEL` | With a Gemini `ANTHROPIC_MODEL` | Anthropic fallback after repeated Gemini transient failure (unused when `ANTHROPIC_MODEL` is already Anthropic's). Production: `claude-opus-5-5`. No default |
| `GEMINI_API_KEY` | For Gemini model IDs | Gemini generation access |
| `TYPESAFE_API_KEY` | No | Enables Jev question routing and asynchronous design judgement |
| `TYPESAFE_MODEL` | No | Jev model name; defaults to `jev-latest` |
| `TYPESAFE_API_URL` | No | Jev-compatible endpoint override |
| `SHOPIFY_CLIENT_ID` | For Shopify | Shopify application client ID |
| `SHOPIFY_CLIENT_SECRET` | For Shopify | OAuth secret and webhook-HMAC secret |
| `SHOPIFY_READ_ALL_ORDERS` | No | Adds `read_all_orders` only after Shopify has approved that scope |
| `SHOPIFY_BULK_THRESHOLD` | No | Resource count above which supported imports use bulk operations; default `250` |
| `NEXT_PUBLIC_SHOPIFY_INSTALL_URL` | No | Overrides where **Connect with Shopify** sends merchants, for example the app's listing (`https://apps.shopify.com/…`). Unset, it is Shopify's own install link built from `SHOPIFY_CLIENT_ID`. Only `apps.shopify.com` and `admin.shopify.com` over https are accepted. |

`ADAPTIVE_OS_SERVICE_ROLE_KEY` appears in `.env.example` for maintenance/check tooling.
The application runtime deliberately uses caller-scoped clients and narrow database RPCs
instead of this key.

### Which model, and why

Chosen on 2026-09-25 by running the same ten business requests from `scripts/check-scenarios.mjs`
(Hinglish ones included) and `check-luke-lookups` through each model, with cost read from the
usage Anthropic reported:

| Model | Designs right | Store questions | Cost of the run | Per call |
| --- | --- | --- | --- | --- |
| `claude-opus-5-5` | 9 / 10 | 19 / 19 | $1.70 (39 calls) | $0.044 |
| `claude-sonnet-5` | 5 / 10 | 17 / 19 | $1.25 (48 calls) | $0.026 |
| `claude-haiku-4-5-20251001` | 4 / 10 | 18 / 19 | $0.37 (49 calls) | $0.0075 |

The cheaper two missed what the merchant asked for about half the time (a daily check for
overdue things, a balance that subtracts what was paid), and needed more repair calls doing it.
Opus 5.5 is the design model; Haiku keeps the gap pass, which only compares two short texts.
One run each: rerun the comparison before changing either, and after any large prompt change.

Later the same day, after teaching the prompt that a date the owner must act by needs a daily
rule (and "yaad nahi rehta" is "I only find out later"), Opus 5.5 got all 20 scenarios right,
$3.63 for the run. Two of the harness's checks had been failing correct designs that used a
computed column (they only looked in features and rules), which likely cost the cheaper models
a point or two above; their scheduled-rule misses were real.

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
