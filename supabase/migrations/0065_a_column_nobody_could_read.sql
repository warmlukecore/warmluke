-- Migration 0065: the store was connected and the app could not say so.
--
-- 0046 took table-wide SELECT off stores and granted it back one
-- column at a time, so a token could never be read by a client. That
-- is right, and it carries a cost nobody accounted for: a column added
-- afterwards is readable by no one until somebody says otherwise.
--
-- 0054 added webhook_error and the strip began selecting it. PostgREST
-- refuses the whole row when one requested column is not granted, so
-- the strip received an error rather than a store, and told the
-- merchant "not connected" about a store that was connected, synced,
-- and holding a valid token.
--
-- webhook_error exists to be shown to the merchant — it says which
-- topics Shopify refused to send. Leaving it unreadable defeated the
-- reason it was written down instead of only logged.
--
-- The three that stay unreadable stay unreadable: access_token,
-- refresh_token, oauth_state. Those are the point of 0046.
--
-- Callers: src/components/StoreStrip.tsx.

grant select (webhook_error) on public.stores to authenticated;

NOTIFY pgrst, 'reload schema';
