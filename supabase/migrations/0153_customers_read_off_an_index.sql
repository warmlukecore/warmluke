-- Migration 0153: customers read off an index
--
-- With 0152 the permission check costs nothing per row, and what was
-- left at a million customers was the sort: the list cuts its first
-- 200 by name, or by what they spent ("top buyers"), and neither had an
-- index, so every customer was sorted to find them. Measured on a copy
-- with a million customers: 0.88 s and 0.47 s, both 4 ms with these.
-- Orders and abandoned carts already have theirs; the other lists sort
-- through joins an index on one table cannot serve, and stay as they are.

create index if not exists idx_customers_name on public.customers (store_id, name);
create index if not exists idx_customers_spent on public.customers (store_id, total_spent desc nulls last);
