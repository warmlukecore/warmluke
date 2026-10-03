// Whether a reply of Luke's helped (0176): the thumbs under it, and the
// one line of why a thumbs down may carry. Each person's own, one per
// reply: a second thumb replaces the first, the same one again takes it
// back.
//
// Kept under the caller's own rights: RLS lets a person read and write
// only their own rows, on projects they can use.
//
// Callers: src/components/ChatPanel.tsx (ReplyFeedback).

import { NextResponse, after } from "next/server";
import { getUserClient } from "@/lib/supabase-server";
import { reflectOnFeedback } from "@/lib/learning";

export const runtime = "nodejs";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The longest note a thumbs down keeps: a line, not a letter. */
const NOTE_MAX = 500;

const idOf = (v: unknown): string | null => (typeof v === "string" && UUID.test(v) ? v : null);

/** POST { messageId, verdict: "up" | "down", note? } */
export async function POST(req: Request) {
  const auth = await getUserClient(req);
  if (!auth) return NextResponse.json({ error: "Not signed in." }, { status: 401 });
  const body = (await req.json().catch(() => ({}))) as { messageId?: unknown; verdict?: unknown; note?: unknown };
  const messageId = idOf(body.messageId);
  if (!messageId) return NextResponse.json({ error: "messageId is required" }, { status: 400 });
  const verdict = body.verdict;
  if (verdict !== "up" && verdict !== "down") {
    return NextResponse.json({ error: "verdict is up or down" }, { status: 400 });
  }
  if (body.note != null && typeof body.note !== "string") {
    return NextResponse.json({ error: "note is text" }, { status: 400 });
  }
  const note = typeof body.note === "string" ? body.note.trim() : "";
  if (note.length > NOTE_MAX) {
    return NextResponse.json({ error: `A note is at most ${NOTE_MAX} characters.` }, { status: 400 });
  }

  // The reply as the caller can read it, and whose app it is on. A thread
  // that is not theirs is hidden by RLS, so it reads as no reply at all;
  // their own words are not Luke's to rate.
  const { data: msg } = await auth.client
    .from("messages")
    .select("role, conversations!inner(project_id)")
    .eq("id", messageId)
    .maybeSingle();
  const reply = msg as { role?: string; conversations?: { project_id?: string } | null } | null;
  const projectId = reply?.conversations?.project_id;
  if (!reply || reply.role !== "assistant" || !projectId) {
    return NextResponse.json({ error: "There is no reply of Luke's like that." }, { status: 404 });
  }

  // The note goes with this verdict: a thumbs up after a thumbs down
  // does not keep the down's complaint.
  const { error } = await auth.client
    .from("reply_feedback")
    .upsert(
      { project_id: projectId, message_id: messageId, user_id: auth.userId, verdict, note: note || null },
      { onConflict: "message_id,user_id" }
    );
  if (error) return NextResponse.json({ error: "Could not keep that." }, { status: 500 });
  // What the owner said of it is learned from after the answer is out
  // (lib/learning): a down may teach a lesson, an up counts the lessons
  // that reply used as having helped. Never in the way of the save.
  after(() => reflectOnFeedback(auth.client, { messageId, verdict, note: note || undefined }));
  return NextResponse.json({ ok: true });
}

/** GET ?conversationId= — { feedback: { [messageId]: "up" | "down" } }, the caller's own in that thread. */
export async function GET(req: Request) {
  const auth = await getUserClient(req);
  if (!auth) return NextResponse.json({ error: "Not signed in." }, { status: 401 });
  const conversationId = idOf(new URL(req.url).searchParams.get("conversationId"));
  if (!conversationId) return NextResponse.json({ error: "conversationId is required" }, { status: 400 });
  const { data, error } = await auth.client
    .from("reply_feedback")
    .select("message_id, verdict, messages!inner(conversation_id)")
    .eq("messages.conversation_id", conversationId)
    .eq("user_id", auth.userId);
  if (error) return NextResponse.json({ error: "Could not read what you said of these replies." }, { status: 500 });
  const rows = (data ?? []) as Array<{ message_id: string; verdict: "up" | "down" }>;
  return NextResponse.json({ feedback: Object.fromEntries(rows.map((r) => [r.message_id, r.verdict])) });
}

/** DELETE { messageId } — takes the caller's own thumb on that reply back. */
export async function DELETE(req: Request) {
  const auth = await getUserClient(req);
  if (!auth) return NextResponse.json({ error: "Not signed in." }, { status: 401 });
  const body = (await req.json().catch(() => ({}))) as { messageId?: unknown };
  const messageId = idOf(body.messageId);
  if (!messageId) return NextResponse.json({ error: "messageId is required" }, { status: 400 });
  const { error } = await auth.client
    .from("reply_feedback")
    .delete()
    .eq("message_id", messageId)
    .eq("user_id", auth.userId);
  if (error) return NextResponse.json({ error: "Could not take that back." }, { status: 500 });
  return NextResponse.json({ ok: true });
}
