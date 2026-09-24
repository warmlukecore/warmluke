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

import Image from "next/image";
import Link from "next/link";
import { LOGO } from "@/lib/brand";

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
            <Image
              src={LOGO}
              alt=""
              width={28}
              height={28}
              className="h-7 w-7 object-contain"
            />
            <span className="text-lg font-semibold tracking-tight">Warmluke</span>
          </Link>
          <Link href="/" className="text-sm text-quiet transition-colors hover:text-ink">
            Back to the site
          </Link>
        </div>
      </header>

      <main className="mx-auto w-full max-w-2xl flex-1 px-4 py-14 sm:px-6">
        <h1 className="font-serif text-2xl font-bold tracking-tight">Privacy</h1>
        <p className="mt-2 text-sm text-quiet">Last updated 14 September 2026.</p>

        <Section title="What we store">
          <p>
            When a merchant connects a Shopify store, we copy products, variants, stock
            levels, orders, order lines, refunds and customers into our own database so the
            app can answer questions about them without asking Shopify each time.
          </p>
          <p>
            For customers that includes name, email, phone and address, because the work
            merchants use this for, like packing an order, finding a shipment or calling a
            buyer about a COD order, cannot be done without them.
          </p>
          <p>We also store the store&rsquo;s access token, its timezone and its currency.</p>
        </Section>

        <Section title="What we do not do">
          <p>
            The assistant that builds apps and answers questions runs on Anthropic&rsquo;s
            models. It is sent what the merchant types, the structure of their app, and the
            store rows a question needs to be answered from &mdash; the latest orders, what is
            running low, the top customers and best sellers, and the rows for the question
            asked. It is never sent the store as a whole, and nothing sent is used to train a
            model.
          </p>
          <p>
            A second, smaller model (Jev, by Typesafe) reads a request before and after the
            assistant works: what kind of question it is, and whether a design does what was
            asked. It is sent the request and a description of the design &mdash; never store
            rows.
          </p>
          <p>We do not sell data, and we do not use it to advertise to anyone.</p>
        </Section>

        <Section title="Who can see it">
          <p>
            A store&rsquo;s data is readable only by the account that connected it and the
            staff that account invites. This is enforced in the database itself, by
            row-level security, not by a check an endpoint could forget to make.
          </p>
          <p>
            Data is held in Supabase (Postgres, hosted on AWS) and the app runs on Vercel.
            Both encrypt data at rest; everything in transit is over TLS.
          </p>
        </Section>

        <Section title="Getting it back, or gone">
          <p>
            Disconnecting a store or uninstalling the app deletes everything we copied from
            it: products, orders, customers and the access token, not just the link.
          </p>
          <p>
            A shopper&rsquo;s request to see or erase their data reaches us through
            Shopify&rsquo;s own channels and we act on it. Erasing a person removes them;
            their past orders stay with the merchant, no longer attached to a name.
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
