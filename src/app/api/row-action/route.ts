import { NextResponse, after } from "next/server";
import { getUserClient } from "@/lib/supabase-server";
import { Refused } from "@/lib/record-write";
import { decide, press } from "@/lib/row-decide";

export const runtime = "nodejs";

/**
 * POST /api/row-action — a row's button that waits for the owner (0183,
 * lib/row-approval.ts).
 *
 *   { projectId, moduleId, recordId | storeRowId, label }
 *     Pressed. What it does is worked out here, from the row as it stands,
 *     never from the browser. The owner's press, or any press of a button
 *     that needs no yes, is made at once through the one door; a
 *     teammate's press of one that does waits in the owner's bell.
 *
 *   { projectId, approvalId, decision: "approve" | "decline" }
 *     The owner's word on one that waits. Approved, the change is worked
 *     out again from the row as it is now (a date it stamps is today's)
 *     and made under the owner's own rights; a row that no longer shows
 *     the button is told so, and nothing changes. Only the owner decides,
 *     and only here: the database refuses anyone else and any AI's token.
 *
 *   { projectId, batch, decision }
 *     The owner's word on an ask Luke or their own AI made over many rows
 *     (0208, lib/app-actions.ts): each row settled on its own, a change
 *     made only where the row still holds what the asker saw. Answers how
 *     many were done, stale (changed or gone since) and failed.
 */
export async function POST(req: Request) {
  try {
    const auth = await getUserClient(req);
    if (!auth) return NextResponse.json({ error: "Not signed in." }, { status: 401 });
    const body = (await req.json()) as Record<string, unknown>;
    const deciding = typeof body.approvalId === "string" || typeof body.batch === "string";
    const later = (run: () => unknown) => after(run);
    const out = deciding ? await decide(auth.client, body, later) : await press(auth.client, body, later);
    return NextResponse.json(out.body, { status: out.status });
  } catch (e) {
    if (e instanceof Refused) return NextResponse.json({ error: e.message, refused: true }, { status: 409 });
    return NextResponse.json({ error: e instanceof Error ? e.message : "Something went wrong." }, { status: 500 });
  }
}
