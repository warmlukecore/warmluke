import { NextResponse } from "next/server";
import { getUserClient } from "@/lib/supabase-server";
import { DEFAULT_CURRENCY, DEFAULT_LOCALE } from "@/lib/format";

export const runtime = "nodejs";

/** GET /api/projects — the caller's projects (RLS-scoped). */
export async function GET(req: Request) {
  const auth = await getUserClient(req);
  if (!auth) {
    return NextResponse.json({ error: "Not signed in." }, { status: 401 });
  }
  const { data, error } = await auth.client
    .from("projects")
    .select("*")
    .order("created_at", { ascending: false });
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  return NextResponse.json({ projects: data ?? [] });
}

/** POST /api/projects — create an empty project for the caller. */
export async function POST(req: Request) {
  const auth = await getUserClient(req);
  if (!auth) {
    return NextResponse.json({ error: "Not signed in." }, { status: 401 });
  }
  const { name, locale, currency } = (await req.json().catch(() => ({}))) as {
    name?: string;
    locale?: string;
    currency?: string;
  };
  const { data, error } = await auth.client
    .from("projects")
    .insert({
      name: name?.trim() || "Untitled project",
      locale: locale?.trim() || DEFAULT_LOCALE,
      currency: currency?.trim().toUpperCase() || DEFAULT_CURRENCY,
    })
    .select()
    .single();
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  return NextResponse.json({ project: data });
}

/**
 * PATCH /api/projects — rename a project or change how it formats money
 * and dates. Only the fields sent are touched.
 */
export async function PATCH(req: Request) {
  const auth = await getUserClient(req);
  if (!auth) {
    return NextResponse.json({ error: "Not signed in." }, { status: 401 });
  }
  const { id, name, description, locale, currency, auto_build } = (await req
    .json()
    .catch(() => ({}))) as {
    id?: string;
    name?: string;
    description?: string | null;
    locale?: string;
    currency?: string;
    auto_build?: boolean;
  };
  if (!id) {
    return NextResponse.json({ error: "id is required" }, { status: 400 });
  }

  const patch: Record<string, unknown> = {};
  if (name !== undefined) {
    const trimmed = name.trim();
    if (!trimmed) {
      return NextResponse.json({ error: "A project needs a name." }, { status: 400 });
    }
    patch.name = trimmed.slice(0, 80);
  }
  if (description !== undefined) patch.description = description?.trim() || null;
  if (locale !== undefined) patch.locale = locale.trim() || DEFAULT_LOCALE;
  if (currency !== undefined) {
    const code = currency.trim().toUpperCase();
    // Intl throws on an unknown code, which would break every amount on
    // the page — reject it here instead.
    try {
      new Intl.NumberFormat("en", { style: "currency", currency: code });
    } catch {
      return NextResponse.json({ error: `"${code}" isn't a currency code.` }, { status: 400 });
    }
    patch.currency = code;
  }
  // Reachable only under the caller's own RLS, which is what keeps an
  // assistant from granting itself permission to skip approval: a
  // token carrying client_id cannot write this table at all (0028).
  if (typeof auto_build === "boolean") patch.auto_build = auto_build;
  if (Object.keys(patch).length === 0) {
    return NextResponse.json({ error: "Nothing to update." }, { status: 400 });
  }

  // RLS means a project the caller doesn't own simply matches nothing.
  const { data, error } = await auth.client
    .from("projects")
    .update(patch)
    .eq("id", id)
    .select();
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  if (!data || data.length === 0) {
    return NextResponse.json({ error: "Project not found." }, { status: 404 });
  }
  return NextResponse.json({ project: data[0] });
}

/**
 * DELETE /api/projects — remove a project and everything inside it.
 * `confirmName` must match: this cascades to every section, row, rule
 * and conversation, and there is no undo.
 */
export async function DELETE(req: Request) {
  const auth = await getUserClient(req);
  if (!auth) {
    return NextResponse.json({ error: "Not signed in." }, { status: 401 });
  }
  const { id, confirmName } = (await req.json().catch(() => ({}))) as {
    id?: string;
    confirmName?: string;
  };
  if (!id) {
    return NextResponse.json({ error: "id is required" }, { status: 400 });
  }

  const { data: found } = await auth.client
    .from("projects")
    .select("id, name")
    .eq("id", id)
    .limit(1);
  const project = found?.[0] as { id: string; name: string } | undefined;
  if (!project) {
    return NextResponse.json({ error: "Project not found." }, { status: 404 });
  }
  if ((confirmName ?? "").trim().toLowerCase() !== project.name.trim().toLowerCase()) {
    return NextResponse.json(
      { error: "Type the project's name exactly to delete it." },
      { status: 400 }
    );
  }

  const { error } = await auth.client.from("projects").delete().eq("id", id);
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  return NextResponse.json({ ok: true, deleted: id });
}
