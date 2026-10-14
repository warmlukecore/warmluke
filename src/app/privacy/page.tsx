// ─────────────────────────────────────────────────────────────
// Privacy policy. Shopify asks for a URL before it will grant
// protected customer data, and a merchant deciding whether to connect
// their store deserves to read this in plain words rather than in the
// language of a contract.
//
// Every claim here has to stay true of the code. If the app starts
// sending store data to a model, or keeps data after a disconnect, this
// page is wrong and has to change in the same commit.
// ─────────────────────────────────────────────────────────────

import Link from "next/link";
import { Logo } from "@/components/ui/Logo";

export const metadata = {
  title: "Privacy · Warmluke",
  description: "What Warmluke stores from a connected store, and how to get it back or gone.",
};

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="mt-8">
      <h2 className="font-serif text-lg font-semibold text-ink">{title}</h2>
      <div className="mt-2 space-y-2 text-sm leading-relaxed text-neutral-700">{children}</div>
    </section>
  );
}

export default function Privacy() {
  return (
    <div className="font-ui flex min-h-screen flex-col bg-white text-ink">
      {/* The same way in and out as every other page. A legal page
          with no navigation reads as a dead end, and this is the one
          a merchant opens at the moment they are deciding whether to
          trust us with their store. */}
      <header className="border-b border-hair">
        <div className="mx-auto flex w-full max-w-2xl items-center justify-between px-4 py-5 sm:px-6">
          <Link href="/" className="flex items-center gap-2">
            <Logo className="h-5" />
            <span className="text-lg font-semibold tracking-tight">Warmluke</span>
          </Link>
          <Link href="/" className="text-sm text-quiet transition-colors hover:text-ink">
            Back to the site
          </Link>
        </div>
      </header>

      <main className="mx-auto w-full max-w-2xl flex-1 px-4 py-14 sm:px-6">
        <h1 className="font-serif text-2xl font-bold tracking-tight">Privacy</h1>
        <p className="mt-2 text-sm text-quiet">Last updated 12 October 2026.</p>

        <Section title="What we store">
          <p>
            When a merchant connects a Shopify store, we copy products, variants, stock levels, orders, order lines,
            refunds and customers into our own database so the app can answer questions about them without asking
            Shopify each time.
          </p>
          <p>
            For customers that includes name, email, phone and address, because the work merchants use this for, like
            packing an order, finding a shipment or calling a buyer about a COD order, cannot be done without them.
          </p>
          <p>We also store the store&rsquo;s access token, its timezone and its currency.</p>
          <p>
            If a merchant connects a courier account (Shiprocket or GoSwift), we keep its API login, encrypted, to fetch
            their shipments, and copy each shipment&rsquo;s AWB, courier, status and the order it belongs to.
            Disconnecting the courier deletes the login; the shipments already copied stay with the store.
          </p>
          <p>
            If a merchant connects a Meta or Google Ads account, we keep the credential they made for it, encrypted, to
            read what each campaign spent by day, with its impressions, clicks and the purchases or conversions the ad
            platform counted. No customer&rsquo;s details come from either.
          </p>
          <p>
            The other accounts a merchant can connect work the same way, each with a credential they made, kept
            encrypted, read only:
          </p>
          <ul className="list-disc space-y-1 pl-5">
            <li>
              Google Analytics: visits, purchases and revenue by day and where the visits came from, with no
              visitor&rsquo;s details.
            </li>
            <li>
              Mailchimp and Brevo: each email campaign&rsquo;s sends, opens, clicks, unsubscribes and revenue, with no
              subscriber&rsquo;s details.
            </li>
            <li>
              Zendesk: each ticket&rsquo;s subject, status and tags, with the name, email and phone of the person who
              raised it, so it can be matched to their order history.
            </li>
            <li>
              HubSpot: each contact&rsquo;s name, email, phone, lifecycle stage and lead status, matched the same way.
            </li>
            <li>
              A Facebook Page and its Instagram account: the store&rsquo;s own posts and their counts of likes, comments
              and shares.
            </li>
          </ul>
          <p>
            Disconnecting any of them deletes its credential; what was already copied stays with the store, and goes
            when the store does.
          </p>
        </Section>

        <Section title="What we do not do">
          <p>
            The assistant that builds apps and answers questions runs on Anthropic&rsquo;s models. It is sent what the
            merchant types, the structure of their app, and the store rows a question needs to be answered from &mdash;
            the latest orders, what is running low, the top customers and best sellers, and the rows for the question
            asked. It is never sent the store as a whole, and nothing sent is used to train a model.
          </p>
          <p>
            A second, smaller model (Jev, by Typesafe) reads a request before and after the assistant works: what kind
            of question it is, and whether a design does what was asked. It is sent the request and a description of the
            design &mdash; never store rows.
          </p>
          <p>We do not sell store data or use connected stores&rsquo; customer records for advertising.</p>
        </Section>

        <Section title="Website advertising measurement">
          <p>
            When you send the early-access form, we tell Meta about that sign-up as a Lead event through its Conversions
            API, as the form says under its button: a hashed email address, the event time, the page address, the ad you
            came from if you came from one, your IP address and browser information, and Meta&rsquo;s advertising
            cookies if the page has set them. This measures and improves our Facebook and Instagram ads. Hashing lets
            Meta match an email; it does not make the event anonymous.
          </p>
          <p>
            Separately, and only if you allow it, the landing page runs Meta Pixel in your browser to measure visits.
            The page asks first, and the Pixel and its cookies are never loaded before you choose Allow.
          </p>
          <p>
            On the same yes, the landing page also uses Google Analytics to count visits and see which parts of the page
            people read. Google receives the page address, the page you came from, a cookie identifier and browser
            information; it is not sent your email or anything you type into the form.
          </p>
          <p>
            This tracking does not run inside your business app or send your store&rsquo;s orders or customer records.
            When your browser sends Global Privacy Control, we send Meta nothing, the sign-up&rsquo;s Lead included. You
            can change your answer about the Pixel and Google Analytics at any time from &ldquo;Ad measurement&rdquo; at
            the foot of the landing page.
          </p>
        </Section>

        <Section title="Who can see it">
          <p>
            A store&rsquo;s data is readable only by the account that connected it, and by the people on its team that
            account chooses to let see the store. This is enforced in the database itself, by row-level security, not by
            a check an endpoint could forget to make.
          </p>
          <p>
            Data is held in Supabase (Postgres, hosted on AWS in Mumbai, India) and the app runs on Vercel, also in
            Mumbai. Both encrypt data at rest, backups included, and everything in transit is over TLS.
          </p>
        </Section>

        <Section title="Getting it back, or gone">
          <p>
            Disconnecting a store in Warmluke deletes everything we copied from it at once: products, orders, customers
            and the access token, not just the link. Uninstalling the app from Shopify ends our access immediately, and
            the copy is deleted when Shopify sends its erasure request, 48 hours later.
          </p>
          <p>
            A shopper&rsquo;s request to see or erase their data reaches us through Shopify&rsquo;s own channels and we
            act on it. Erasing a person removes them; their past orders stay with the merchant, no longer attached to a
            name.
          </p>
          <p>
            Anything else:{" "}
            <a className="text-accent underline" href="mailto:dev.warmluke@gmail.com">
              dev.warmluke@gmail.com
            </a>
            .
          </p>
        </Section>
      </main>

      <footer className="border-t border-hair py-8">
        <div className="mx-auto flex w-full max-w-2xl flex-wrap items-center justify-between gap-3 px-4 text-xs text-neutral-400 sm:px-6">
          <span>Warmluke. One intelligent operating layer for your ecommerce business.</span>
          <span className="flex gap-4">
            <Link href="/terms" className="hover:text-ink">
              Terms
            </Link>
            <Link href="/" className="hover:text-ink">
              Home
            </Link>
          </span>
        </div>
      </footer>
    </div>
  );
}
