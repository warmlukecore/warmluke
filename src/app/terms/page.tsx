// ─────────────────────────────────────────────────────────────
// Terms. Shopify asks whether there is a data protection agreement
// with merchants; a privacy page nobody agrees to is not one. This is
// the agreement, and ConnectShopify points at it at the moment the
// merchant is about to hand over their store.
//
// Kept in the same plain words as /privacy on purpose. A merchant who
// cannot tell what they agreed to has not really agreed to it.
// ─────────────────────────────────────────────────────────────

export const metadata = {
  title: "Terms — Warmluke",
  description: "The agreement between Warmluke and a merchant who connects a store.",
};

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="mt-8">
      <h2 className="font-display text-lg font-semibold text-slate-100">{title}</h2>
      <div className="mt-2 space-y-2 text-sm leading-relaxed text-slate-300">{children}</div>
    </section>
  );
}

export default function Terms() {
  return (
    <div className="min-h-screen bg-slate-950 text-slate-100">
      <main className="mx-auto w-full max-w-2xl px-4 py-14 sm:px-6">
        <h1 className="font-display text-2xl font-bold tracking-tight">Terms</h1>
        <p className="mt-2 text-sm text-slate-400">Last updated 14 September 2026.</p>
        <p className="mt-4 text-sm leading-relaxed text-slate-300">
          Connecting a store to Warmluke means agreeing to what follows, together with
          the{" "}
          <a className="text-blue-400 underline" href="/privacy">
            privacy policy
          </a>
          .
        </p>

        <Section title="What you are agreeing to">
          <p>
            You give Warmluke read access to the store you connect, so it can copy
            products, stock, orders and customers and answer questions about them. We
            read; we do not write anything back to your store.
          </p>
          <p>You keep ownership of your data. Disconnecting the store deletes our copy.</p>
        </Section>

        <Section title="How we handle personal data">
          <p>
            Your customers&rsquo; personal data is processed only to run the app for
            you — never to market to anyone, never sold, never sent to AI model
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
            <a className="text-blue-400 underline" href="mailto:dev.warmluke@gmail.com">
              dev.warmluke@gmail.com
            </a>
            .
          </p>
        </Section>
      </main>
    </div>
  );
}
