import { NextResponse } from "next/server";
import { getUserClient } from "@/lib/supabase-server";
import { ensureFreshToken, graphql } from "@/lib/shopify-import";
import { EXTENDED_ORDER_HISTORY_SCOPE, WINDOWED, hasScope } from "@/lib/shopify-resources";
import { ShopifyError } from "@/lib/shopify";

export const runtime = "nodejs";
export const maxDuration = 30;

/** Without read_all_orders Shopify hands back sixty days of orders, whatever is asked. */
const WITHOUT_ALL_ORDERS = 60;

/**
 * A count past this is said as "more than": exact enough to choose by,
 * and a bound on what one question asks of Shopify for a store with
 * millions of rows.
 */
const COUNT_LIMIT = 1_000_000;

type Count = { count: number; precision: string };

/**
 * POST /api/shopify/history { projectId } — what each window would bring.
 *
 * One question to Shopify, however many windows: a count of orders and
 * of customers for each, the products (which come in full), and when the
 * first order Warmluke can see was placed. The windows are the database's
 * own midnights in the store's timezone (abo_days_ago), the same ones a
 * choice then imports, so a count describes exactly what it would bring.
 */
export async function POST(req: Request) {
  const auth = await getUserClient(req);
  if (!auth) return NextResponse.json({ error: "Not signed in." }, { status: 401 });
  const { projectId } = (await req.json().catch(() => ({}))) as { projectId?: string };
  if (!projectId) return NextResponse.json({ error: "projectId is required." }, { status: 400 });

  const { data: found } = await auth.client
    .from("stores")
    .select("id, shop_domain, status, timezone, granted_scopes, history_from, history_days, history_set_at")
    .eq("project_id", projectId)
    .maybeSingle();
  if (!found || found.status !== "connected") {
    return NextResponse.json({ error: "No store connected." }, { status: 404 });
  }
  // The owner's alone, like the import: the token answers nobody else.
  const { data: secret } = await auth.client.rpc("abo_store_token", { p_store: found.id }).maybeSingle();
  const token = secret as {
    access_token?: string;
    refresh_token?: string | null;
    token_expires_at?: string | null;
  } | null;
  if (!token?.access_token)
    return NextResponse.json({ error: "Only the store's owner can choose this." }, { status: 403 });

  // What an administrator offers (history_settings, 0154).
  const { data: offered } = await auth.client
    .from("history_settings")
    .select("enabled, choices, default_days")
    .maybeSingle();
  if (offered && offered.enabled === false) {
    return NextResponse.json({ error: "Choosing how far back is switched off.", disabled: true }, { status: 409 });
  }
  const days = ((offered?.choices as number[] | null) ?? [30, 60, 90, 180, 365]).slice().sort((a, b) => a - b);
  const defaultDays = (offered?.default_days as number | null) ?? 60;

  const { data: since, error: noDates } = await auth.client.rpc("abo_days_ago", {
    p_tz: found.timezone,
    p_days: days,
  });
  if (noDates || !Array.isArray(since)) {
    return NextResponse.json({ error: "Could not work out the dates." }, { status: 500 });
  }

  const allOrders = hasScope((found.granted_scopes as string[] | null) ?? [], EXTENDED_ORDER_HISTORY_SCOPE);
  const choices = days.map((d, i) => ({
    days: d,
    from: new Date(since[i] as string).toISOString(),
    available: allOrders || d <= WITHOUT_ALL_ORDERS,
  }));

  const q = (s: string) => JSON.stringify(s);
  const counted = choices.filter((c) => c.available);
  const query = `{
    first: orders(first: 1, sortKey: PROCESSED_AT) { nodes { processedAt } }
    products: productsCount(limit: ${COUNT_LIMIT}) { count precision }
    ${counted
      .map(
        (c) => `o${c.days}: ordersCount(query: ${q(WINDOWED.orders(c.from))}, limit: ${COUNT_LIMIT}) { count precision }
    c${c.days}: customersCount(query: ${q(WINDOWED.customers(c.from))}, limit: ${COUNT_LIMIT}) { count precision }`
      )
      .join("\n    ")}
  }`;

  try {
    const fresh = await ensureFreshToken(auth.client, { ...found, ...token, access_token: token.access_token });
    const data = await graphql<Record<string, unknown>>(found.shop_domain, fresh, query);
    const first =
      (data.first as { nodes?: Array<{ processedAt?: string }> } | undefined)?.nodes?.[0]?.processedAt ?? null;
    return NextResponse.json({
      storeId: found.id,
      timezone: found.timezone,
      defaultDays,
      allOrders,
      firstOrderAt: first,
      products: (data.products as Count | undefined) ?? null,
      choices: choices.map((c) => ({
        ...c,
        orders: c.available ? ((data[`o${c.days}`] as Count | undefined) ?? null) : null,
        customers: c.available ? ((data[`c${c.days}`] as Count | undefined) ?? null) : null,
      })),
      current: {
        days: found.history_days ?? null,
        from: found.history_from ?? null,
        chosen: !!found.history_set_at,
      },
    });
  } catch (e) {
    const message = e instanceof ShopifyError || e instanceof Error ? e.message : "Shopify could not be asked.";
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
