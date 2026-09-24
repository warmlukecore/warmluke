# Design system

Every product screen — the app, dashboard, accounts, onboarding, sign-in, connect,
invite and consent — is drawn from one set of tokens and a handful of shared building
blocks. The look changes in those places, not screen by screen. The landing and legal
pages have their own editorial style (`font-serif`, `ink`, `accent`) and are outside this
system.

## The logo

The logo is the one image in `public/brand/`, under any name. The build finds it
(`src/lib/brand-file.mjs`) and every screen, and the browser tab's icon (`src/app/icon.tsx`),
shows it through `LOGO` from `src/lib/brand.ts`. To change the logo, put the new file in
`public/brand/` and take the old one out: the build stops with a plain message if the folder
holds none or more than one. Show it with `<Logo className="h-5" />`
(`ui/Logo.tsx`): the height is the mark's own, because where the mark sits in the file is
measured at build with sharp and any empty margin is left out; `onDark` lifts it on the dark
frame so its darker strokes stay visible. There is no tile of ours behind it. `check-brand`
holds this, and fails if a component types an image path.

## Tokens

Defined once in the `@theme` block of [`src/app/globals.css`](../../src/app/globals.css).
Tailwind v4 turns each into utilities (`bg-surface`, `text-fg-muted`, `shadow-card`, …).

| Group | Tokens | Used for |
| --- | --- | --- |
| Frame | `frame`, `frame-raised`, `frame-line`, `frame-fg`, `frame-fg-muted` | The dark surround: sidebar, top bar, the edge around the page |
| Page | `canvas`, `surface`, `surface-subdued`, `surface-hover`, `line`, `line-strong` | The rounded page, cards on it, rows, dividers |
| Text | `fg`, `fg-muted`, `fg-faint`, `link` | Body text, secondary text, hints, links |
| Action | `primary`, `primary-hover`, `on-primary`, `focus`, `critical`, `critical-hover` | Near-black primary buttons, the focus ring, destructive buttons |
| Tones | `tone-{attention,warning,success,info,critical,neutral}` and `…-fg` | Badge and note fills, with their text colour |
| Signals | `signal-{success,attention,info,critical,neutral}` | Small solid marks: status dots, notification counts |
| Luke | `luke-deep`, `luke`, `luke-light`, `luke-pale` | Luke alone: its orb, and the beam round the composer while it works |
| Shape | `radius-card`, `radius-control` | Cards and dialogs; buttons and fields |
| Depth | `shadow-card`, `shadow-control`, `shadow-raised`, `shadow-popover`, `shadow-dialog` | Resting card, button, hovered card, menu, dialog |

Rules:

- No raw palette classes (`bg-slate-900`, `text-blue-600`, `amber-…`) in app screens.
  A pale note is a tone at an opacity (`bg-tone-attention/25`), never a new hue.
- Colour means state. The page is neutral; attention, critical and success are the only
  colours, and each always means the same thing.
- The app uses Inter (`font-ui`). Headings are `font-semibold`, not a display face.

## Building blocks

| Block | File | What it guarantees |
| --- | --- | --- |
| `button(tone, size)` | [`ui/controls.ts`](../../src/components/ui/controls.ts) | Tones `primary`, `secondary`, `plain`, `critical`, `critical-secondary`, `critical-plain`; sizes `sm` 28px, `md` 32px, `lg` 40px. Works on `<button>`, `<Link>` and `<a>` |
| `iconButton`, `iconButtonCritical` | same | A 32px square holding one icon |
| `field`, `fieldOf(size)` | same | One height, one focus ring; `aria-invalid` turns it red. `field` is full width; `fieldOf` leaves width to the caller |
| `label`, `hint`, `card`, `note.*` | same | Form labels, help lines, white cards, and notes by meaning |
| `menu`, `menuItem` | same | Popovers and their rows: compact, rounded rows inside a padded card |
| `Dialog` | [`ui/Dialog.tsx`](../../src/components/ui/Dialog.tsx) | The browser's modal `<dialog>`: one width (560px), same header and footer, focus kept inside, Escape and backdrop close it, the page behind stops scrolling; a bottom sheet on phones; `tall` fixes the height for tabbed or long content. Nothing slides in from an edge: every dialog opens in the same place |
| `Group` | [`ui/Group.tsx`](../../src/components/ui/Group.tsx) | A bordered, headed part of a long form; `danger` for what cannot be undone, always last |
| `Switch` | [`ui/Switch.tsx`](../../src/components/ui/Switch.tsx) | `role="switch"`; always shown with its state in words beside it |
| `PasswordInput` | [`ui/PasswordInput.tsx`](../../src/components/ui/PasswordInput.tsx) | A password field with show and hide |
| `PageFrame` | [`PageFrame.tsx`](../../src/components/PageFrame.tsx) | Dashboard and accounts: dark top bar, tabs, account menu, rounded page |
| `CenteredCard` | [`CenteredCard.tsx`](../../src/components/CenteredCard.tsx) | One card under the mark: sign-in, sign-up, password reset, connect, invite, AI consent |
| `LukeMark` | [`ui/LukeMark.tsx`](../../src/components/ui/LukeMark.tsx) | Luke's face: an orb in the Luke colours with eyes that blink; sizes `xs` 20px, `sm` 28px, `lg` 48px; `state="thinking"` while it works (the eyes look about, the glow breathes). CSS only, still under reduced motion |
| `.beam`, `.beam-ink`, `.shimmer` | [`globals.css`](../../src/app/globals.css) | The composer's border: while Luke works, a beam of Luke's colour; while the merchant types, a beam in the page's ink that flares with each key and goes a moment after they stop. `.shimmer` is the light along the step Luke is on. Nowhere else |
| `Icon` | [`ui/`](../../src/components/ui/) | Section icons by name (`ALLOWED_ICONS`) |

Why size and width are separate: two Tailwind classes for the same property on one
element are resolved by stylesheet order, not by the order written. `field w-32` or
`button("plain") text-red…` therefore renders either way. Ask for the variant instead.

## Meaning of a badge

[`src/lib/tone.ts`](../../src/lib/tone.ts) decides what a status says and how it is
drawn. A store status is recognised only in Shopify's own form (capitals and
underscores, `PARTIALLY_PAID`), so a merchant's own "Pending" in their repairs section is
never shown as a payment. Everything else gets one of the calm colours, chosen by the
word, so the same word always looks the same. `check-tone` holds this.

## Icons and motion

- Icons are Lucide line icons at `strokeWidth` 1.75 (2 for small emphasis). No emoji
  and no text glyphs (`✓`, `⚙`, `+ Add`) as marks.
- Motion is CSS only: `.rise` for arriving content, `.pop` for menus, and the dialog's own
  entrance. All of it stops under `prefers-reduced-motion`.

## Layout rules

- Dialogs open centred, the same width, and never from an edge; a phone gets a sheet from
  the bottom. Nothing leaves the frame or hides behind the assistant panel.
- Long forms are `Group`s with a heading each; the danger group comes last.
- Borders mark structure (a group, a list, a table); shadows mark something raised (a
  card, a menu, a dialog). One of the two, not both, per element.
- A control the person cannot use is not shown (a member does not see project settings).

## Newer techniques

The aesthetic stays; the technique can move on. A newer platform feature or library that
would do the job better is proposed with its pros, cons, browser support and effort, and
adopted only when the user agrees. The platform comes before a dependency.

Adopted so far, each with the user's yes:

- **Scroll-driven reveals** on the landing (`.reveal`, `animation-timeline: view()`):
  sections rise as they enter. Chrome, Edge and Safari 26+; elsewhere they simply show.
- **The orders globe** in the landing's Ask Luke section: WebGL by `cobe` (about 6 KB,
  loaded after the page runs), the one dependency the landing added. It pauses off screen,
  is still under reduced motion, and the section reads the same without WebGL.

The landing's other motion is plain CSS in `globals.css` and stops under reduced motion:
the `.orbit` / `.orbit-back` hub of logos, the `.caret` and the `wl-tool` roll that
`cycleCss` builds. Everything else on it stands still on purpose: one moving thing per
screen at most, colour only where it means
something (connected, low, done), and labels in sentence case rather than small capitals.
Anything on the landing that may bleed past its column relies on the page root's
`overflow-x-clip`, never on a negative margin that would scroll the page sideways.

The landing's navigation is one list (`NAV` in `components/Landing.tsx`) read by the glass
pill on the first screen and by the pill that floats in once that screen has scrolled
away, which lights the section being read.

## Adding or changing UI

1. Reach for a block above before writing classes.
2. If the look must change, change the token or the block, then look at every screen it
   reaches.
3. Walk it in a real browser with Playwright at 1440px and 390px wide: every state
   (loading, empty, error, full), every dialog and menu, keyboard (Tab, Escape), and
   measured positions and overflow rather than a glance.
4. Run `pnpm typecheck`, `pnpm check:pure`, and a production build.

The [UI designer agent](../../.agents/skills/ui-designer-agent/SKILL.md) follows this
document.
