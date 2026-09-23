<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

## Repository documentation

The maintained documentation lives in `docs/`, with `README.md` as its entry point.

When a user invokes `$update-readme-agent` or asks to run the update-readme agent,
read and follow `.agents/skills/update-readme-agent/SKILL.md`. The skill updates the
whole documentation set, not only the root README.

When a user invokes `$ui-designer-agent`, or asks to redesign, restyle or audit a screen,
read and follow `.agents/skills/ui-designer-agent/SKILL.md`. It works from
`docs/design/design-system.md`, which says what every token and shared block is for.
Any UI change, by whoever makes it, uses those tokens and blocks, is walked in a real
browser with Playwright at desktop and phone width, and proposes newer techniques to the
user with pros and cons instead of adopting them unasked.
