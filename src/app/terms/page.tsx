// ─────────────────────────────────────────────────────────────
// Terms. Shopify asks whether there is a data protection agreement
// with merchants; a privacy page nobody agrees to is not one. This is
// the agreement, and ConnectShopify points at it at the moment the
// merchant is about to hand over their store.
//
// Kept in the same plain words as /privacy on purpose. A merchant who
// cannot tell what they agreed to has not really agreed to it.
// ─────────────────────────────────────────────────────────────

import Image from "next/image";
import Link from "next/link";

export const metadata = {
  title: "Terms · Warmluke",
  description: "The agreement between Warmluke and a merchant who connects a store.",
};

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="mt-8">
      <h2 className="font-serif text-lg font-semibold text-ink">{title}</h2>
      <div className="mt-2 space-y-2 text-sm leading-relaxed text-neutral-700">{children}</div>
    </section>
  );
}

export default function Terms() {
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
              src="/images/logowarmluke.png"
              alt=""
              width={28}
              height={28}
              className="h-7 w-7 rounded-lg object-cover"
            />
            <span className="text-lg font-semibold tracking-tight">Warmluke</span>
          </Link>
          <Link href="/" className="text-sm text-quiet transition-colors hover:text-ink">
            Back to the site
          </Link>
        </div>
      </header>

      <main className="mx-auto w-full max-w-2xl flex-1 px-4 py-14 sm:px-6">
        <h1 className="font-serif text-2xl font-bold tracking-tight">Terms</h1>
        <p className="mt-2 text-sm text-quiet">Last updated 14 September 2026.</p>
        <p className="mt-4 text-sm leading-relaxed text-neutral-700">
          Connecting a store to Warmluke means agreeing to what follows, together with
          the{" "}
          <a className="text-accent underline" href="/privacy">
            privacy policy
          </a>
          .
        </p>

        <Section title="What you are agreeing to">
          <p>
            You give Warmluke read access to the store you connect, so it can copy
            products, stock, orders and customers and answer questions about them.
          </p>
          <p>
            Warmluke can also change some things in your store: add or remove a tag,
            write a note on an order, set a stock count. It never does so on its own.
            Every change is shown to you first, in plain words, and nothing is sent
            until you say yes to that exact change. An assistant you have connected can
            ask for one; it cannot agree to one for you.
          </p>
          <p>
            Anything else in your store, Warmluke does not touch. It does not refund,
            cancel, fulfil, publish, reprice or message anyone. The app asks Shopify
            only for what the changes above need, and Shopify refuses it the rest.
          </p>
          <p>You keep ownership of your data. Disconnecting the store deletes our copy.</p>
        </Section>

        <Section title="How we handle personal data">
          <p>
            Your customers&rsquo; personal data is processed only to run the app for
            you. Never to market to anyone, never sold, never sent to AI model
            providers.
          </p>
          <p>
            We keep it only while your store is connected, encrypt it at rest and in
            transit, and isolate it from every other store at the database level.
          </p>
          <p>
            When a shopper asks to see or erase their data, Shopify tells us and we act
            on it. Erasing a person leaves your orders intact.
          </p>
          <p>
            You are the controller of that data and we are your processor: we act on
            your instructions and Shopify&rsquo;s, not on our own.
          </p>
        </Section>

        <Section title="Your side">
          <p>
            Keep your account secure, and only connect stores you are entitled to
            connect. Do not use the app to break the law or Shopify&rsquo;s own rules.
          </p>
        </Section>

        <Section title="Stopping">
          <p>
            You can disconnect a store or delete your account at any time, and the data
            goes with it. We can end an account that is being used to break these terms,
            and will say why.
          </p>
        </Section>

        <Section title="The honest part">
          <p>
            Warmluke is early software provided as it is. We work to keep it correct and
            available, but do not promise it never fails, and we are not liable for
            business losses arising from using it.
          </p>
          <p>
            Questions, or anything above that is unclear:{" "}
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
            <Link href="/privacy" className="hover:text-ink">
              Privacy
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
