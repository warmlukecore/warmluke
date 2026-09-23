---
name: ui-designer-agent
description: Design, restyle or audit Warmluke's screens with its one design system (tokens in globals.css, shared blocks in src/components/ui), test every flow in a real browser with Playwright, and propose newer techniques for approval. Use when the user invokes $ui-designer-agent, asks to redesign or polish a screen, make the UI consistent or more professional, check UX, or find where old styling remains.
---

# Warmluke UI designer

Make Warmluke look and feel professional everywhere, without changing what it does. The
system is written down in [`docs/design/design-system.md`](../../../docs/design/design-system.md);
read it first, every time — it changes, and this skill follows it rather than repeating
it. Write all copy in plain professional English.

## 1. Understand before touching

1. Read `AGENTS.md`, `docs/design/design-system.md`, and each screen's files end to end:
   the page, its components, and every check that reads their source
   (`grep -l "<file name>" scripts/*.mjs`). Some checks assert exact wording or patterns
   (settings sentences, admin confirmations, the bell, the landing's no-dash rule); keep
   them true.
2. Open the screen in a browser before judging it (section 4). Code shows intent; the
   screen shows the result.
3. Survey what is still off-system:
   `grep -nE "(bg|text|border|ring)-(slate|gray|blue|indigo|amber|rose|emerald|violet)-[0-9]" <files>`,
   emoji or text glyphs used as icons, one-off dialogs, and hand-made buttons or fields.

## 2. Build with the system

- Use the blocks: `button(tone, size)`, `iconButton` / `iconButtonCritical`, `field` /
  `fieldOf(size)`, `label`, `hint`, `card`, `note.*`, `menu` / `menuItem`, `Dialog`,
  `Group`, `Switch`, `PasswordInput`, `PageFrame`, `CenteredCard`. Write classes only for
  layout (flex, grid, gap, width, position) around them.
- Never add a second class for a property a block already sets (a width on `field`, a
  text colour on `button("plain")`): Tailwind resolves those by stylesheet order, so the
  result is unpredictable. Use `fieldOf`, a critical tone, or add a variant to the block.
- Colours come from tokens only. A new meaning is a new token in `globals.css` plus a line
  in the design-system table; never a new hue for one screen.
- Every dialog is `Dialog`: centred, one width, header and footer in the same place, a
  bottom sheet on phones. Tabbed or long content uses `tall`. Nothing slides in from an
  edge or leaves the frame.
- Long forms are cut into `Group`s; what cannot be undone is the last group, `danger`.
- Icons are Lucide at `strokeWidth` 1.75. State is said in words as well as colour.
- Motion is CSS (`.rise`, `.pop`, the dialog entrance) and stops under
  `prefers-reduced-motion`.
- Keep it quiet: no decoration that carries no information, no second way to do the
  same thing on one screen, suggestions as sentences rather than chips in the assistant.
- Pages outside the login (`src/app/*/page.tsx` other than app, admin, dashboard, api)
  contain no en or em dashes in their text; `check-landing` enforces it.

Restyling never changes data fetching, permissions, API calls or database behaviour. If a
screen's behaviour is wrong, say so, and fix it separately with its own check.

## 3. Newer techniques: propose, then wait

Aim for the same aesthetic built the most current way. When a newer platform feature,
library version or pattern would do the job better — for example CSS anchor positioning
for menus, View Transitions between screens, `@starting-style` entrances, container
queries, the React Compiler — do not adopt it on your own. Present it first:

- what it is and what it would replace here, with the files it touches;
- pros (less code, smoother, more accessible, faster) and cons (browser support with the
  versions, bundle weight, migration effort, risk to existing checks);
- a recommendation, and what happens on browsers that lack it.

Build it only after the user says yes. Check current behaviour in the installed docs
(`node_modules/next/dist/docs/`, context7 for libraries) rather than from memory. Prefer
a platform feature over a new dependency; a dependency needs a reason the platform cannot
give.

## 4. Test every flow with Playwright

Use the Playwright browser tools. Never look at production data, and never use port 3100
(the user's own server).

1. Build and serve against the check project:
   `(set -a; . ./.env.check.local; set +a; npx next build && npx next start -p 3102)`.
   A production build writes `.next/` beside `next dev`'s `.next/dev`, so it does not
   disturb the user's dev server.
2. Make throwaway accounts on the check project with the service role (a fresh one for
   first-run flows; one with a project, a store row, a section with rows, a waiting
   request and a seat for everything else). Sign in by writing the session into
   `localStorage` under `sb-<project ref>-auth-token`, served from a local file server
   and fetched with `page.request.get`.
3. Walk every screen and state touched, and the screens that share its blocks: open every
   dialog, menu and tab; submit forms empty and filled; press Escape; click the backdrop;
   tab through the controls.
4. Measure, do not eyeball: a dialog's `boundingBox()` is centred on desktop and at the
   bottom on a phone; the same kind of dialog has the same width everywhere;
   `scrollWidth - clientWidth` is 0 for the page and every table; no element sits outside
   the viewport or its frame; the console has no new errors.
5. Screenshot at 1440×900 and 390×844, and read every screenshot before calling it done.
6. Delete the throwaway accounts and their projects afterwards, and stop the servers you
   started.

## 5. UX edge cases to walk every time

- **Loading, empty, error, full**: each designed; loading is a skeleton in the shape of
  what is coming, not a line of text.
- **Long and many**: long names truncate with the full text available; lists past about
  seven items get search; numbers use tabular figures.
- **Where things open**: every dialog in the same place and size; menus open towards the
  space they have and stay inside the window; nothing is hidden behind the assistant panel.
- **Destructive actions**: named consequence, a confirm step, the safe choice as easy to
  reach as the dangerous one.
- **Who is looking**: owner, invited member and administrator each see only what they
  can act on; a control the database would refuse is not offered.
- **Keyboard and screen readers**: visible focus, Escape closes, labels on every control,
  state in words.
- **Phone**: the sheet rises from the bottom, touch targets are at least 32px, and nothing
  scrolls sideways.
- **Coming back**: reloading or returning mid-flow lands somewhere sensible.

## 6. Verification before finishing

1. `pnpm typecheck`, `pnpm check:pure`, and a production build.
2. The Playwright walkthrough in section 4, with screenshots read.
3. The raw-colour survey returns nothing new for the files touched.
4. If a token or block changed, every screen using it was looked at, not only the one
   asked about.
5. `docs/design/design-system.md` updated when a token, block or rule changed; this skill
   updated when a new way of working was learned.

Report what changed on each screen, what was verified and how, any newer technique
proposed and awaiting a yes, and anything left off the system on purpose.
