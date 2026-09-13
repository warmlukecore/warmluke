-- Migration 0019: the nonce that ties an authorization back to a project
--
-- Shopify hands the state parameter back untouched, which only helps if
-- we can tell a state we issued from one somebody made up — and only
-- once. Stored on the pending store row rather than in a table of its
-- own: the unique index on (provider, shop_domain) then also means two
-- projects cannot both be mid-connect to the same shop, which is the
-- rule we wanted anyway.
alter table public.stores add column if not exists oauth_state text;
alter table public.stores add column if not exists oauth_state_expires_at timestamptz;

-- Looked up by state on the way back in, and there is exactly one.
create unique index if not exists idx_stores_oauth_state
  on public.stores(oauth_state) where oauth_state is not null;

NOTIFY pgrst, 'reload schema';
