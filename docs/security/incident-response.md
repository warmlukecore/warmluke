# Security incident response

What happens when merchants' data may have been exposed, lost or changed by someone who
should not have been able to. It is short on purpose: in an incident it is read, not
studied.

**Owner:** the Warmluke operator, dev.warmluke@gmail.com. Merchants and Shopify reach
us there; the same address is on the privacy page.

## What counts

- Someone reads or changes a store's data who is not its owner or a teammate the owner
  let see it.
- A key or token leaves where it belongs: the Shopify client secret, a Supabase key, a
  model key, a merchant's store token, a Vercel or GitHub token.
- Data is lost or cannot be read back.
- A shopper's erasure request (`customers/redact`, `shop/redact`) was not carried out.

A bug that could have allowed any of these, found before anyone used it, is handled the
same way up to step 3 and recorded in step 6.

## Steps

1. **Contain, within the hour.** Close the door first, explain later.
   - Rotate what leaked. The Shopify client secret in the Dev Dashboard, then
     `SHOPIFY_CLIENT_SECRET` in Vercel. Supabase keys in the project's API settings.
     Model keys at the provider.
   - Stop the flow if it is still running. Turn a feature off per account from the admin
     page (Luke, the merchant's own AI, store actions), or for everyone by unsetting its
     model setting. Clearing the vault's `import_worker_url` stops background imports.
   - Keep what shows what happened: Vercel and Supabase logs, `turn_traces`,
     `record_events`, `automation_runs`, before any of it ages out.
2. **Find out what was reached.** Which stores, which people's data, from when to when.
   Row-level security is the boundary (`docs/security/security-model.md`), so start from
   which policy or function let it through.
3. **Fix the cause** in the database or the code, with a check that fails without the
   fix (`scripts/check-*.mjs`), and deploy.
4. **Tell the people it affects.** Without undue delay, and within 72 hours of
   confirming that personal data was exposed:
   - every merchant whose store was affected, with what was reached, what we did and what
     they should do;
   - Shopify, through the Partner Dashboard or partner support, when merchant or shopper
     data from Shopify is involved;
   - the authorities where the law requires it (India's Data Protection Board under the
     DPDP Act; the relevant EU authority when EU shoppers' data is involved).
5. **Recover.** Restore lost data from the database backups, reconnect stores whose
   tokens were rotated, and confirm the imports and webhooks are running again.
6. **Write it down,** within a week: what happened, how it was found, what was reached,
   and what now stops it happening again. Keep it with the fix's commit.
