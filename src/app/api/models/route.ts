import { NextResponse } from "next/server";
import { getUserClient } from "@/lib/supabase-server";
import { lukeSettings, modelsOnOffer } from "@/lib/luke-models";
import { modelName, priceOf } from "@/lib/model-prices";

export const runtime = "nodejs";

// ─────────────────────────────────────────────────────────────
// GET /api/models — the models Luke may answer on for the caller, the
// one used when they pick none, and what each reply shows them.
//
// For the panel's picker and the line under each reply. What this says
// is a courtesy; the chat route asks the same question itself before a
// turn, so a model left off the list is never used however it is asked.
//
// An administrator also gets every model on offer, for choosing which
// of them another account may use.
//
// Callers: src/components/AppShell.tsx, src/components/AccountDetail.tsx.
// ─────────────────────────────────────────────────────────────

export async function GET(req: Request) {
  const auth = await getUserClient(req);
  if (!auth) return NextResponse.json({ error: "Not signed in." }, { status: 401 });
  const settings = await lukeSettings(auth.client, auth.userId);
  const { data: admin } = await auth.client.rpc("abo_is_superadmin");
  const offered =
    admin === true
      ? (await modelsOnOffer()).ids.map((id) => ({ id, name: modelName(id), price: priceOf(id) }))
      : undefined;
  return NextResponse.json(
    { models: settings.models, default: settings.default, shows: settings.shows, ...(offered ? { offered } : {}) },
    { headers: { "cache-control": "private, no-store" } }
  );
}
