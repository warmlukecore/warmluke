// Where the superadmin console is (lib/console-path), told only to an
// administrator, so the header can link to it from outside it. Anyone
// else gets the same answer as an address that does not exist.

import { NextResponse } from "next/server";
import { getUserClient } from "@/lib/supabase-server";
import { consoleSegment } from "@/lib/console-path";

const nothing = () => new NextResponse(null, { status: 404 });

export async function POST(req: Request) {
  const auth = await getUserClient(req);
  if (!auth) return nothing();
  const { data } = await auth.client.rpc("abo_is_superadmin");
  if (data !== true) return nothing();
  return NextResponse.json({ base: `/${consoleSegment()}` }, { headers: { "cache-control": "no-store" } });
}
