import { NextResponse } from "next/server";
import { getUserClient } from "@/lib/supabase-server";
import { putBack } from "@/lib/apply";
import type { UndoStep } from "@/lib/undo";

export const runtime = "nodejs";

/**
 * POST /api/undo — body: { projectId, messageId }
 *
 * Puts back what one build changed. The panel passes the message it is
 * offering this under, and the steps are read from that message here
 * rather than sent up with the request: what may be put back is a
 * decision the server made when it wrote the message, and a caller
 * that could name its own modules and versions would be choosing for
 * it. RLS still scopes everything to the owner either way; this is so
 * the button cannot mean more than the sentence above it.
 *
 * Nothing is deleted. Restoring an earlier schema writes a new version
 * holding what the old one held — see putBack.
 */
export async function POST(req: Request) {
  try {
    const auth = await getUserClient(req);
    if (!auth) {
      return NextResponse.json({ error: "Not signed in." }, { status: 401 });
    }
    const { client } = auth;

    const { projectId, messageId } = (await req.json()) as {
      projectId?: string;
      messageId?: string;
    };
    if (!projectId || !messageId) {
      return NextResponse.json({ error: "projectId and messageId are required" }, { status: 400 });
    }

    const { data: msg } = await client
      .from("messages")
      .select("id, payload, conversation_id")
      .eq("id", messageId)
      .maybeSingle();
    const steps = ((msg?.payload as { undo?: UndoStep[] } | null)?.undo ?? []) as UndoStep[];
    if (steps.length === 0) {
      return NextResponse.json(
        { error: "There is nothing on that message to put back." },
        { status: 400 }
      );
    }

    const { done, couldNot } = await putBack(client, projectId, steps);

    // Taking it back is itself a change to the app, so it is written
    // down the same way the build was. A history that records only the
    // changes somebody liked is not a history.
    const line = done.length
      ? `↩️ Put back — ${done.join(", ")}.${couldNot.length ? ` The rest could not be: ${couldNot.join("; ")}.` : ""}`
      : `Nothing could be put back: ${couldNot.join("; ")}.`;
    const thread = (msg as { conversation_id?: string }).conversation_id;
    await client.from("messages").insert({
      conversation_id: thread,
      role: "assistant",
      content: line,
      payload: { type: "applied", message: line },
    });
    // The thread moved, and a panel open elsewhere learns about it
    // from that — every other writer of a message says so too, and a
    // put-back the second tab never hears about is the same stale
    // screen by another road.
    if (thread) {
      await client
        .from("conversations")
        .update({ updated_at: new Date().toISOString() })
        .eq("id", thread);
    }

    return NextResponse.json({ done, couldNot, message: line });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Unknown error";
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
