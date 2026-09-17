-- The public name follows what the counter now measures: only a turn
-- that produces a design counts. Questions and clarifying replies are
-- refunded, and building an existing design does not run the model.

comment on column public.account_settings.free_turns is
  'Designs Warmluke may produce for this account. Raise it to grant more.';

NOTIFY pgrst, 'reload schema';
