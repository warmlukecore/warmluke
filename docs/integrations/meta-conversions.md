# Meta website lead tracking

The public landing page sends browser `PageView` and `Lead` events. A `Lead` means
an early-access request was saved by `abo_book_demo`, not a CTA click, form start,
account signup, or a Shopify customer's order. This is website lead tracking,
not CRM feedback for Meta Instant Forms.

The booking action schedules CAPI with Next.js `after`, so Meta cannot delay the
success response. Failed validation, CAPTCHA, and database writes send no Lead.
A database duplicate returns the same event ID without another server send.
The ID hashes the session and submission's idempotency key; the browser uses that
exact ID for deduplication. Server event time is captured at submission, before
the asynchronous send. Email is trimmed, lowercased, and SHA-256 hashed. `_fbp`
and `_fbc` are not hashed; a real landing `fbclid` can supply the missing `_fbc`.
No name, store URL, business details, or free-text answers are sent to Meta.
Automatic Pixel configuration is disabled. Pixel is initialized only by the
public landing tracker, not in the root layout or merchant application.

## Activate

Set these in the deployment's environment settings, then redeploy:

| Variable                    | Purpose                                                                                |
| --------------------------- | -------------------------------------------------------------------------------------- |
| `NEXT_PUBLIC_META_PIXEL_ID` | Dataset/Pixel ID from Events Manager; public, same ID for browser and server           |
| `META_CAPI_ACCESS_TOKEN`    | CAPI access token from dataset settings; server-only secret                            |
| `META_EVENT_SOURCE_URL`     | Canonical public landing page URL, including its path; query and fragment are stripped |
| `META_GRAPH_API_VERSION`    | Optional; defaults to `v26.0`                                                          |
| `META_CAPI_TEST_EVENT_CODE` | Optional test code from Events Manager; remove after testing                           |

Never put the access token in `NEXT_PUBLIC_*`, commit it, or include it in a PR.
The server sender is disabled without an ID or token. The action also requires
the canonical source URL. Pixel alone works without the server token.

Nothing is measured without the visitor's yes (`src/lib/consent.ts`). While a
Pixel ID is set, the landing page asks once, in a bar at its foot: Allow or No
thanks. The Pixel loads only after Allow. The form posts `meta_consent=1` only
then, and the server sends a Lead only when it is there, so a visitor who never
answered, had script off or made the request by hand is never sent. The answer is
kept in the browser (`wl_measure`), and "Ad measurement" in the footer asks
again. A no given later tells a running Pixel `consent revoke`. Do Not Track and
Global Privacy Control are a no already given: never asked, never measured.
Google Analytics (`src/lib/google-analytics.ts`, `NEXT_PUBLIC_GA_ID`) reads the
same choice: its tag loads only after Allow, and a later no sets Google's own
`ga-disable-<id>` switch and denies analytics storage. The privacy page discloses this
measurement separately from connected stores' customer data.

## Verify in Events Manager

1. Set the test code on a staging deployment with its own test configuration.
2. Open the landing page from Test events, submit a valid early-access request,
   and check that it also appears in Warmluke's Early access list.
3. Confirm `Lead` arrives from Browser and Server with the same event ID, and
   deduplicates into one conversion. Confirm the normalized email is hashed,
   and real `_fbp`/`_fbc` identifiers are present when available.
4. Test invalid form input and an unsuccessful booking: neither should send Lead.
5. Test with browser tracking blocked: a successful booking still sends the server
   event unless the visitor opted out. DNT/GPC must suppress both paths.
6. Remove the test code, redeploy, then submit one real test lead. Select the
   dataset's standard `Lead` event when optimizing website lead campaigns.

Watch Diagnostics, event match quality, deduplication, freshness, and coverage.
The server uses the Vercel-overwritten `x-vercel-forwarded-for` header for IP;
other hosts omit IP unless a trusted proxy integration is added.

## Delivery limits and checks

Delivery retries transient failures once using the same ID and time. Logs contain
only generic failures, HTTP status and Meta error code, never payloads or tokens.
There is no persistent queue or replay worker: a prolonged Meta outage can lose
events even though leads remain saved. A resent duplicate does not replay CAPI.
No credentials were needed for mocked tests; live Events Manager verification is
required after deployment configuration.

Run `node --experimental-strip-types --import ./scripts/ts-hook.mjs scripts/check-meta-conversions.mjs`
and `pnpm typecheck`. The pure check mocks outbound HTTP and verifies payloads,
retry IDs, disabled configuration, safe failure behavior, and browser deduplication.
