import { NextResponse, after } from "next/server";
import { getUserClient } from "@/lib/supabase-server";
import { writeRecord, type WriteInput } from "@/lib/record-write";
import { runCodeRules } from "@/lib/code-rules";

export const runtime = "nodejs";

/**
 * POST /api/records — body: { action, projectId, moduleId, recordId?, storeRowId?, data? }
 *
 * The owner's own writes, through the one door every write uses
 * (lib/record-write.ts). A row written runs the section's code rules
 * after the answer is out (lib/code-rules.ts); their writes come back
 * through the same door and run none of their own.
 */
export async function POST(req: Request) {
  try {
    const auth = await getUserClient(req);
    if (!auth) return NextResponse.json({ error: "Not signed in." }, { status: 401 });
    const { client } = auth;
    const input = (await req.json()) as WriteInput;
    const out = await writeRecord(client, input, (w) => after(() => runCodeRules(client, w)));
    return NextResponse.json(out.body, { status: out.status });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Unknown error";
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
