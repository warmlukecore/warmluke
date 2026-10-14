// ─────────────────────────────────────────────────────────────
// Facebook & Instagram: the store's own posts, with their likes,
// comments and shares, from its Facebook Page and the Instagram
// business account linked to it (0215; docs/integrations/connectors.md,
// phase 7).
//
// Reached as Meta Ads is (0214): a system user's token from the store's
// own business, given the Page. Connecting trades it for the Page's own
// token, which reads the Page's posts and the linked Instagram's media;
// no review of Warmluke's app is needed.
//
// What a sync reads: posts from a month before the last run (likes and
// comments keep coming), newest first, 100 a page; the first run reads
// 90 days.
// ─────────────────────────────────────────────────────────────

import { graph, num } from "./meta-graph";
import { ConnectorRefused, type Fetch, type Job, type SocialPostRow, type SyncIO } from "./kit";

const FIRST_DAYS = 90;
const SETTLING_DAYS = 30;
const PAGE = 100;
const GIVE_PAGE = "give the system user the Page (and its Instagram account)";

export type Secret = { page: string; page_token: string; ig?: string | null };

type FbPost = {
  id?: string;
  message?: string;
  created_time?: string;
  permalink_url?: string;
  status_type?: string;
  shares?: { count?: number };
  reactions?: { summary?: { total_count?: number } };
  comments?: { summary?: { total_count?: number } };
};
type IgMedia = {
  id?: string;
  caption?: string;
  media_type?: string;
  media_product_type?: string;
  permalink?: string;
  timestamp?: string;
  like_count?: number;
  comments_count?: number;
};
type Paged<T> = { data?: T[]; paging?: { cursors?: { after?: string }; next?: string } };

/** A Page post as social_posts keeps it. */
export function facebookRow(p: FbPost): SocialPostRow | null {
  if (!p.id) return null;
  return {
    post_ref: p.id,
    network: "facebook",
    posted_at: p.created_time ?? null,
    text: p.message?.trim() || null,
    kind: p.status_type ?? null,
    likes: num(p.reactions?.summary?.total_count),
    comments: num(p.comments?.summary?.total_count),
    shares: num(p.shares?.count) ?? 0,
    url: p.permalink_url ?? null,
  };
}

/** An Instagram post as social_posts keeps it. */
export function instagramRow(m: IgMedia): SocialPostRow | null {
  if (!m.id) return null;
  return {
    post_ref: `ig_${m.id}`,
    network: "instagram",
    posted_at: m.timestamp ?? null,
    text: m.caption?.trim() || null,
    kind: (m.media_product_type ?? m.media_type ?? "").toLowerCase() || null,
    likes: num(m.like_count),
    comments: num(m.comments_count),
    shares: null,
    url: m.permalink ?? null,
  };
}

/** Proves the token can act as the Page and returns what to keep. */
export async function login(
  fields: Record<string, string>,
  f: Fetch = fetch
): Promise<{ accountRef: string; accountLabel: string; secret: string }> {
  const token = (fields.token ?? "").trim();
  const page = (fields.page_id ?? "").trim();
  if (!token || !/^\d{5,25}$/.test(page)) {
    throw new ConnectorRefused(
      "Facebook & Instagram needs a system user's access token and the Page ID (digits, in the Page's About → Page transparency)."
    );
  }
  const found = (await graph(
    page,
    token,
    f,
    { fields: "name,access_token,instagram_business_account{id,username}" },
    GIVE_PAGE
  )) as { name?: string; access_token?: string; instagram_business_account?: { id?: string; username?: string } };
  if (!found.access_token) {
    throw new ConnectorRefused(
      "This token cannot act as that Page. In Meta Business settings, give the system user the Page, then make the token again."
    );
  }
  const ig = found.instagram_business_account;
  const secret: Secret = { page, page_token: found.access_token, ig: ig?.id ?? null };
  const label = [found.name?.trim(), ig?.username ? `@${ig.username}` : null].filter(Boolean).join(" · ");
  return { accountRef: page, accountLabel: label || page, secret: JSON.stringify(secret) };
}

/** One run: the Page's posts, then the Instagram account's, back to the cut-off. */
export async function sync(job: Job, io: SyncIO, f: Fetch = fetch): Promise<{ nextMinutes: number }> {
  const s = JSON.parse(job.secret) as Secret;
  const through = job.cursors.posts?.synced_through;
  const cutoff = through ? Date.parse(through) - SETTLING_DAYS * 86_400_000 : Date.now() - FIRST_DAYS * 86_400_000;
  const startedAt = new Date().toISOString();

  let after: string | undefined;
  do {
    if (Date.now() > io.deadline) return { nextMinutes: 5 };
    const page = (await graph(
      `${s.page}/published_posts`,
      s.page_token,
      f,
      {
        fields: // limit: Graph's own field syntax; .limit(0) asks for each count alone, not a cut of rows.
          "id,message,created_time,permalink_url,status_type,shares,reactions.summary(total_count).limit(0),comments.summary(total_count).limit(0)",
        since: String(Math.floor(cutoff / 1000)),
        limit: String(PAGE),
        ...(after ? { after } : {}),
      },
      GIVE_PAGE
    )) as Paged<FbPost>;
    const rows = (page.data ?? []).map(facebookRow).filter((r): r is SocialPostRow => r !== null);
    if (rows.length) await io.put("social_posts", rows);
    after = page.paging?.next ? page.paging.cursors?.after : undefined;
  } while (after);

  if (s.ig) {
    let next: string | undefined;
    for (;;) {
      if (Date.now() > io.deadline) return { nextMinutes: 5 };
      const page = (await graph(
        `${s.ig}/media`,
        s.page_token,
        f,
        {
          fields: "id,caption,media_type,media_product_type,permalink,timestamp,like_count,comments_count",
          limit: String(PAGE),
          ...(next ? { after: next } : {}),
        },
        GIVE_PAGE
      )) as Paged<IgMedia>;
      // Instagram has no "since": newest first, so stop at the first post before the cut-off.
      const fresh = (page.data ?? []).filter((m) => !m.timestamp || Date.parse(m.timestamp) >= cutoff);
      const rows = fresh.map(instagramRow).filter((r): r is SocialPostRow => r !== null);
      if (rows.length) await io.put("social_posts", rows);
      next = page.paging?.next ? page.paging.cursors?.after : undefined;
      if (!next || fresh.length < (page.data ?? []).length) break;
    }
  }
  await io.putCursor("posts", null, startedAt);
  return { nextMinutes: 180 };
}
