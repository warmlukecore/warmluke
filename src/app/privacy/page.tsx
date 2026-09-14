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

export const metadata = {
  title: "Privacy — Warmluke",
  description: "What Warmluke stores from a connected store, and how to get it back or gone.",
};

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="mt-8">
      <h2 className="font-display text-lg font-semibold text-slate-100">{title}</h2>
      <div className="mt-2 space-y-2 text-sm leading-relaxed text-slate-300">{children}</div>
    </section>
  );
}

export default function Privacy() {
  return (
    <div className="min-h-screen bg-slate-950 text-slate-100">
      <main className="mx-auto w-full max-w-2xl px-4 py-14 sm:px-6">
        <h1 className="font-display text-2xl font-bold tracking-tight">Privacy</h1>
        <p className="mt-2 text-sm text-slate-400">Last updated 14 September 2026.</p>

        <Section title="What we store">
          <p>
            When a merchant connects a Shopify store, we copy products, variants, stock
            levels, orders, order lines, refunds and customers into our own database so the
            app can answer questions about them without asking Shopify each time.
          </p>
          <p>
            For customers that includes name, email, phone and address, because the work
            merchants use this for — packing an order, finding a shipment, calling a buyer
            about a COD order — cannot be done without them.
          </p>
          <p>We also store the store&rsquo;s access token, its timezone and its currency.</p>
        </Section>

        <Section title="What we do not do">
          <p>
            We do not send store data to AI model providers. The assistant that builds apps
            sees what the merchant types to it, not the contents of their store.
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
            it — products, orders, customers and the access token — not just the link.
          </p>
          <p>
            A shopper&rsquo;s request to see or erase their data reaches us through
            Shopify&rsquo;s own channels and we act on it. Erasing a person removes them;
            their past orders stay with the merchant, no longer attached to a name.
          </p>
          <p>
            Anything else:{" "}
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
