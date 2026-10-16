-- Migration 0224: a design is built once (16 Oct, the sprint's "a retry must not duplicate")
--
-- "Build it" on a design in the chat writes the build into its thread as
-- it starts (/api/apply openBook). A second press, or the same request
-- sent again after the network dropped while the first still ran, built
-- the same sections twice: nothing on the server said the design was
-- already being built. MCP requests always had their claim (abo_build
-- request_claim); a design in the chat now has one too, made by the
-- database as the receipt is written, so two at once cannot both win.
--
-- One build message a design and the plans it sent, while it is building
-- or built. A refused build can be tried again; a build that was put back
-- (/api/undo marks it undone) can be built again.

create unique index if not exists messages_one_build_a_design
  on public.messages ((payload->>'design'), (payload->'sent'))
  where payload->>'type' = 'build'
    and payload->>'design' is not null
    and payload->>'status' in ('building', 'built')
    and coalesce(payload->>'undone', 'false') <> 'true';

notify pgrst, 'reload schema';
