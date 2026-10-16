# Limits

Every cap on how much is read, shown, sent or worked through is here, with what it
bounds and **who is told** when it cuts. The rule (12 Oct 2026): no limit drops data or
work silently. A limit either scales (pages until done), or it says what it cut to the
owner, to Luke, or to both: "showing 200 of 3,412", "read cut short", "20 orders
match; only the newest 20 are listed".

Why: a rule read the first 500 of 2,058 stock rows and wrote nothing, and nobody could
see it. Luke's snapshot listed the 15 lowest stock rows with no count, and he told a
merchant "15 out of stock" when 311 were.

`node scripts/check-limits.mjs` (pure tier) fails when a `.limit(` in `src/` is not in
the table below. Register a new one, or put a `limit:` comment on its line or the line
above saying what tells the reader it cut.

## Row limits in `src/`

`.limit(1)` (one row) is not listed. **Said** names who learns of the cut:
- `owner`: the screen says it;
- `Luke`: the result or the prompt says it;
- `both`;
- `by design`: a sample or a recency window where a cut is the point.

| File | Limit | What it bounds | Said |
| --- | --- | --- | --- |
| `src/app/api/chat/route.ts` | `THREAD_PAGE + 1` | The thread list, one page; the extra row says there is another | owner (more) |
| `src/app/api/chat/route.ts` | `200` | A thread's messages when opened, newest 200. The longest on prod was 43 (12 Oct) | not yet: a "load earlier" when a thread passes 200 |
| `src/app/api/luke-notes/route.ts` | `40` | What Luke knows about the merchant, newest 40, shown to the owner | by design |
| `src/app/api/luke-notes/route.ts` | `20` | The merchant's problems, newest 20, shown to the owner | by design |
| `src/app/api/luke-skills/route.ts` | `200` | Luke's per-merchant skills listed for the owner | by design |
| `src/app/api/mcp/route.ts` | `40` | Rules listed to their AI | by design |
| `src/app/api/mcp/route.ts` | `30` | A section's version history | by design |
| `src/app/api/mcp/route.ts` | `SHOW_WAITING` | What waits on the owner, per kind, newest first | Luke (count beside it) |
| `src/app/api/mcp/route.ts` | `limit + 1` | Build history pages; the extra row says there is more | Luke |
| `src/app/api/mcp/route.ts` | `500` | Values a filter on a section of their own can offer, read from 500 rows. The biggest own section was 11 rows (12 Oct) | not yet |
| `src/lib/row-decide.ts` | `500` | A batch of Luke's row-change asks decided at once; a batch holds at most `ASK_MAX` (500), so none is left | by design |
| `src/components/AppShell.tsx` | `500` | The link picker's rows of their own section (loadLinkOptions), and the rows a scanned code matches | not yet: search as typed once a section passes 500 |
| `src/components/AppShell.tsx` | `limit` | A section read for a design card or a written screen, the size asked | by design (a preview) |
| `src/components/ChatPanel.tsx` | `10` | Their AI's requests this week, shown in the chat | by design |
| `src/components/ChatPanel.tsx` | `20` | The same, the newest 20 | by design |
| `src/components/RecordModal.tsx` | `20` | A row's history in its pop-up, newest 20 | by design |
| `src/components/StoreSend.tsx` | `100` | The owner's on/off history for store changes | by design |
| `src/lib/app-actions.ts` | `ASK_MAX` | Row approvals waiting, listed to Luke | Luke |
| `src/lib/app-actions.ts` | `20` | Store changes, AI requests and alerts waiting, listed to Luke | Luke |
| `src/lib/client-guide.ts` | `5` | Apps listed in their AI's guide | by design |
| `src/lib/client-guide.ts` | `8` | Merchant problems in their AI's guide | by design |
| `src/lib/code-rules.ts` | `JOB_BATCH` | Queued rule jobs claimed at a time; batches go on until the worker's time is spent | scales |
| `src/lib/design-view.ts` | `SAMPLE` | Sample rows a design is checked against | by design |
| `src/lib/engine.ts` | `REQUESTS_IN_CONTEXT` | Their AI's recent requests in Luke's context | by design |
| `src/lib/import-step.ts` | `3` | A peek at whether a table has rows | by design |
| `src/lib/learning.ts` | `SKILLS_READ` | Per-merchant skills read into a turn, most helpful first | by design |
| `src/lib/memory.ts` | `KNOWN_LINES` | What Luke knows about the merchant, read into a turn | by design |
| `src/lib/memory.ts` | `8` | Open merchant problems read into a turn | by design |
| `src/lib/section-read.ts` | `limit` | Luke's and MCP's read of a section's rows, ≤ 200; `total` and `showing` say the cut | Luke |
| `src/lib/shopify-import.ts` | `STOCK_PAGE` | Stock marked to count again, a batch at a time until none is due | scales |
| `src/lib/store-read.ts` | `limit` | Leaders (top customers and best sellers), the top N asked | by design (a ranking) |
| `src/lib/store-read.ts` | `Math.min(Math.max(limit, 1), 500)` | storeRowsMatching and readStoreRows: one read of a store list ≤ 500; callers say `total` and `showing` (search_store, slices) or page (code rules, 0206) | Luke |
| `src/lib/store-read.ts` | `limit` | A store row's related rows (readRelated 50, ordersOfCustomer 20) in its detail | not yet: the detail shows the page's length as the count |
| `src/lib/store-read.ts` | `Math.min(Math.max(search.limit ?? 20, 1), MAX_LIMIT)` | search_orders, ≤ 100; `matched` is the exact count | Luke |
| `src/lib/store-read.ts` | `MAX_LIMIT` | Customers a search term matches, before their orders are searched | not yet: past 100 people, only their orders |
| `src/lib/store-read.ts` | `Math.min(Math.max(limit, 1), MAX_LIMIT)` | low_stock and slices, ≤ 100; `matched` is the exact count, tracked variants only | Luke |
| `src/lib/store-read.ts` | `500` | Rows read to learn how a column's values are spelled | by design |
| `src/lib/turn-run.ts` | `HISTORY_LIMIT` | A thread's last 30 messages replayed to Luke | not yet: see Luke's caps |
| `src/lib/walk.ts` | `WALK_ROWS` | Rows a screen walk is played on | by design |

## Luke's caps

| Cap | Where | Said |
| --- | --- | --- |
| A tool result's size | `fitForModel` (store-tools) | Luke: "Only the first N of M … are shown here" |
| Lookup steps, 4 a turn; 3 for the plan | `LOOKUP_STEPS`, `PLAN_STEPS` | Luke: out of steps, he is handed what was found, "all you will get" |
| What was found, folded when the steps run out | `FOLD_CHARS` (ai.ts) | not yet: the JSON is cut mid-way with no word. Say "cut here: N of M" when it cuts |
| History, the last 30 messages | `HISTORY_LIMIT` | not yet: say how many earlier messages are not shown |
| The store snapshot's "running low", the 15 lowest | engine.ts snapshot | not yet: give `stockCounts` (low and out, exact) beside the list |
| A slice of rows for a routed question, 50 | `ROWS` (slice.ts) | Luke: "N of total shown" |
| Sales in a span, the top 20 | `SALES_ROWS` (slice.ts) | Luke: "the top 20 only … not the span's total" when more sold |

## In the database

| Function | Limit | Said |
| --- | --- | --- |
| `abo_store_page` | A page of 25–200 rows, with the exact count | owner |
| `abo_store_page` | Filter values: the 50 most common per field | not yet: say "most common 50; search for others" |
| `abo_store_metrics` | 200 groups, with `truncated` | Luke |
| `abo_store_query` | Rows: 500 a call, with `offset` and the exact `matched`. Totals: 1,000 groups, with `group_count`. 12 conditions, 8 figures, 2 groupings, 10 seconds | Luke and MCP |
| `abo_section_stats` | A stat's groups, the top 1–20 it asks for | by design |
| `abo_sales_between` | The top N products in a span | Luke (via the slice) |
| `abo_store_overview` | The 20 lowest stock rows, beside exact counts | owner |
| `abo_alert_dispatch_late` | The 5 oldest late orders named, beside the count | owner |
| `abo_code_waiting` | 200 projects a tick, oldest waiting first (0210) | scales |
| `abo_import_tick`, `abo_connector_tick` | 200 stores a tick | scales (the rest next tick) |
| `abo_import_sweep` | 1,000 stores a night, 2,000 stock rows each (0207) | scales |
| `abo_connector_open_shipments` | 100 quiet shipments a run, oldest first | scales |
| `abo_trace_sweep`, `abo_store_trim_history` | Housekeeping batches | scales |
| Code rules (0206) | 50,000 rows a section read; 500 sets and 100 adds a run | owner and Luke: "read cut short", `dropped` in the run log |
