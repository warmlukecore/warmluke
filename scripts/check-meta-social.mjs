// Facebook & Instagram, stood in for (lib/connectors/meta-social, 0215).
//
// No network: fetch answers as the Graph API does. Holds connecting (a
// system user's token traded for the Page's own, the linked Instagram
// found, a token that cannot act as the Page refused), a Page post and
// an Instagram post mapped with their likes, comments and shares, and a
// run reading the Page back to its cut-off and Instagram until it passes it.
//
//   node --experimental-strip-types --import ./scripts/ts-hook.mjs scripts/check-meta-social.mjs
import { ConnectorRefused } from "../src/lib/connectors/kit.ts";
import { facebookRow, instagramRow, login, sync } from "../src/lib/connectors/meta-social.ts";

const fails = [];
const check = (name, cond) => {
  console.log(`${cond ? "  ok  " : "  FAIL"}  ${name}`);
  if (!cond) fails.push(name);
};
const json = (status, body) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const caught = async (fn) => {
  try {
    await fn();
    return null;
  } catch (e) {
    return e;
  }
};

console.log("\nconnecting");
{
  const asked = [];
  const ok = await login({ token: "SYS", page_id: "1122334455" }, async (url, init) => {
    asked.push({ url: new URL(String(url)), auth: init.headers.Authorization });
    return json(200, {
      name: "Chai Co",
      access_token: "PAGE",
      instagram_business_account: { id: "1784000", username: "chaico" },
    });
  });
  check(
    "asks the Page for its own token and its Instagram",
    asked[0].url.pathname.endsWith("/1122334455") &&
      asked[0].url.searchParams.get("fields").includes("instagram_business_account")
  );
  check(
    "with the system user's token as a header",
    asked[0].auth === "Bearer SYS" && !asked[0].url.href.includes("SYS")
  );
  const kept = JSON.parse(ok.secret);
  check("keeps the Page's token and the Instagram account", kept.page_token === "PAGE" && kept.ig === "1784000");
  check("named by both", ok.accountLabel === "Chai Co · @chaico");
  const cannot = await caught(() =>
    login({ token: "SYS", page_id: "1122334455" }, async () => json(200, { name: "Chai Co" }))
  );
  check(
    "a token that cannot act as the Page says how to give it",
    cannot instanceof ConnectorRefused && /give the system user the Page/.test(cannot.message)
  );
  const bad = await caught(() => login({ token: "SYS", page_id: "chai" }, async () => json(200, {})));
  check("a Page id that is not one is refused before any call", bad instanceof ConnectorRefused);
}

console.log("\nposts");
{
  const fb = facebookRow({
    id: "1122334455_99",
    message: " New flavours ",
    created_time: "2026-10-10T10:00:00+0000",
    permalink_url: "https://facebook.com/x/posts/99",
    status_type: "added_photos",
    shares: { count: 12 },
    reactions: { summary: { total_count: 340 } },
    comments: { summary: { total_count: 21 } },
  });
  check(
    "a Page post keeps its reactions, comments and shares",
    fb.network === "facebook" && fb.likes === 340 && fb.comments === 21 && fb.shares === 12
  );
  const ig = instagramRow({
    id: "1801",
    caption: "Reel!",
    media_product_type: "REELS",
    permalink: "https://instagram.com/p/x",
    timestamp: "2026-10-11T10:00:00+0000",
    like_count: 900,
    comments_count: 33,
  });
  check(
    "an Instagram post keeps its likes and comments",
    ig.network === "instagram" && ig.likes === 900 && ig.kind === "reels" && ig.shares === null
  );
  check("and is kept apart from Page posts by its reference", ig.post_ref === "ig_1801");
}

console.log("\na run");
{
  const put = [];
  const cursors = [];
  const asked = [];
  const now = Date.now();
  const iso = (daysAgo) => new Date(now - daysAgo * 86_400_000).toISOString();
  await sync(
    { secret: JSON.stringify({ page: "1122334455", page_token: "PAGE", ig: "1784000" }), cursors: {} },
    {
      deadline: now + 60_000,
      put: async (list, rows) => put.push(...rows.map((r) => ({ list, ...r }))),
      putCursor: async (resource, cursor, through) => cursors.push({ resource, through }),
    },
    async (url) => {
      const u = new URL(String(url));
      asked.push(u);
      if (u.pathname.endsWith("/published_posts")) {
        return u.searchParams.get("after")
          ? json(200, { data: [{ id: "p2", created_time: iso(5) }] })
          : json(200, {
              data: [{ id: "p1", created_time: iso(1) }],
              paging: { cursors: { after: "A" }, next: "n" },
            });
      }
      // Instagram, newest first: the second page crosses the 90-day cut-off.
      return u.searchParams.get("after")
        ? json(200, {
            data: [
              { id: "i2", timestamp: iso(80) },
              { id: "i3", timestamp: iso(120) },
            ],
            paging: { cursors: { after: "B" }, next: "n" },
          })
        : json(200, { data: [{ id: "i1", timestamp: iso(2) }], paging: { cursors: { after: "B1" }, next: "n" } });
    }
  );
  const posts = asked.filter((u) => u.pathname.endsWith("/published_posts"));
  const media = asked.filter((u) => u.pathname.endsWith("/media"));
  check(
    "reads the Page's posts since 90 days back",
    Number(posts[0].searchParams.get("since")) < now / 1000 - 89 * 86400
  );
  check("following its pages", posts.length === 2 && posts[1].searchParams.get("after") === "A");
  check("then Instagram until it passes the cut-off", media.length === 2);
  check("keeping only the posts inside it", put.map((p) => p.post_ref).join() === "p1,p2,ig_i1,ig_i2");
  check(
    "all into social posts",
    put.every((p) => p.list === "social_posts")
  );
  check("then where it got to is kept", cursors.at(-1)?.resource === "posts" && !!cursors.at(-1)?.through);
}

if (fails.length) {
  console.error(`\n${fails.length} failed`);
  process.exit(1);
}
console.log("\na store's posts are read as Meta writes them");
