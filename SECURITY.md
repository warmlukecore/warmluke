# Security

## Reporting

Email **dev.warmluke@gmail.com**. Say what you saw and how to reproduce it.
Do not open a public issue for anything that exposes data. You will get a
reply within 48 hours.

## What we hold

Connected Shopify stores: products, variants, stock, orders, order lines,
refunds, and customers including name, email, phone and address. Also each
store's Shopify access token.

The controls that matter:

- **Row-level security on every table.** A store's rows are reachable only
  by the account that connected it and the staff that account invites,
  enforced in Postgres rather than by a check an endpoint could forget.
- **The service-role key is never deployed.** It bypasses RLS entirely, so
  it exists only on a developer machine for scripts. The app has no code
  path that reads it.
- **Read-only Shopify scopes.** The app cannot write to a merchant's store,
  and a check asserts that no write scope is ever requested.
- **Signatures before anything else.** OAuth callbacks and webhooks are
  verified before their contents are parsed or acted on.
- **Access to personal data is logged** at the database level, so a read of
  a customer record leaves a record of its own.

## Incident response

An incident is any unauthorised access to merchant or shopper data, any
leak of a credential, or any failure that loses data.

1. **Contain — within 1 hour of detection.** Revoke the affected Shopify
   tokens, rotate the Supabase and provider keys, and take the affected
   path offline if it is still reachable.
2. **Assess — within 24 hours.** Determine which stores and which records
   were reachable, and over what window, from the database access log and
   the platform logs.
3. **Notify — within 72 hours of becoming aware.** Tell every affected
   merchant what happened, what data was involved, and what they should do.
   Tell Shopify, through the Partner Dashboard, for anything touching
   protected customer data. Merchants are told even when the count is one.
4. **Fix.** Close the hole, and add the check that would have caught it —
   an incident without a new check is an incident waiting to repeat.
5. **Write it down.** A short record of what happened, what was reachable,
   and what changed, kept in the repository.

Credentials are treated as compromised the moment they are pasted anywhere
they should not be, and are rotated on that basis alone — not on proof of
misuse.

## Access

Only the maintainer has production access. Every account involved —
Supabase, GitHub, Vercel, Shopify Partners — requires a strong unique
password and two-factor authentication. There are no shared logins.
