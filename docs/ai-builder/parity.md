# Parity: what Luke and their own AI can see and do

Status: built 12 Oct 2026 (0208).

A merchant who asks Luke for something they could do themselves in the app should never be
told "do it yourself". Luke, and the merchant's own AI over MCP, can read everything the
merchant can see, and ask for everything the merchant can do. Every change waits for the
owner's yes.

## The rule

- **Reading:** through the caller's own client, so RLS decides what is seen. Luke and MCP read
  through one function each (`lib/section-read`, `lib/rule-runs`, `lib/app-actions`
  `whatsWaiting`), so the two never disagree.
- **Changing:** always an ask the owner approves in one click in the bell, never a write by
  the AI. Whether a message asked for exactly this change, on exactly these rows, is a model's
  reading of it, and a wrong change to 500 rows is the costly mistake. One click is cheap, and
  their own AI already could not write without the owner, so the rule is the same for both.
- **Deciding** (approving a design, a press, an ask, a change to the shop) is the owner's,
  in Warmluke, and never an AI's.

## The doors

`src/lib/parity.ts` lists every door a merchant goes through: each API route method, each
database function a screen calls, and each table a screen writes to. Beside each it names
Luke's tools and their AI's tools for it, or why there are none (an owner's decision, a
credential, Warmluke's own plumbing). `scripts/check-parity.mjs` (pure) reads the code and
fails when:

- a door is missing from the list;
- an entry matches no door any more;
- a named tool does not exist;
- an entry has neither tools nor a reason.

## Changing rows (0208)

| | Luke | Their own AI |
| --- | --- | --- |
| Ask | `change_rows` | `propose_row_change` |
| Read what waits | `whats_waiting` | `whats_waiting` (and `pending_changes` for request ids) |
| A section's history | `read_section` with `history` | `read_section` with `history` |

- **One door for both:** `proposeRowChange` in `lib/app-actions.ts`.
- **What an ask may do:** set fields of the section's own (never the store's, never a computed
  one, each value held to its column's type), or press one of the section's row buttons.
- **Which rows:** named by id, by a field's value, or by words, at most 500.
- **How it waits:** in 0183's `row_approvals` as one batch, through `abo_ask_rows`, with the
  server's own sentence and what each row held. The database records whether Luke or their
  AI asked; the caller does not say.
- **On the owner's yes** (`/api/row-action` with `batch`, `lib/row-decide`): each row is settled on its own,
  through the one write door under the owner's rights.
- **A standing yes** (0223, `lib/luke-may`): a section the owner switched on in Settings → Luke
  is settled at once through the same steps, for Luke's `change_rows` while the owner is the one
  talking to him. A teammate's turn and their own AI's `propose_row_change` still wait;
  `whats_waiting` names the sections.
  - A change lands only where the row still holds what was seen.
  - A button is worked out again from the row as it is then.
  - What did not land is said.

Checked by `check-row-asks` (live) and `e2e/approval.spec.ts`.

## Left

- Deleting rows by ask.
- Undoing a build from Luke (he asks for the earlier version as a design today).
- Build history for Luke.
- Moving MCP `pending_changes` onto `whatsWaiting`.
