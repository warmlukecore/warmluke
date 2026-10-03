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

| Group   | Tokens                                                                              | Used for                                                                                                                       |
| ------- | ----------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| Frame   | `frame`, `frame-raised`, `frame-line`, `frame-fg`, `frame-fg-muted`                 | The near-black surround (#0a0a0a): sidebar, top bar, the edge round the panes; `frame-raised` is the lit tile of where you are |
| Page    | `canvas`, `surface`, `surface-subdued`, `surface-hover`, `line`, `line-strong`      | The rounded page, cards on it, rows, dividers                                                                                  |
| Text    | `fg`, `fg-muted`, `fg-faint`, `link`                                                | Body text, secondary text, hints, links                                                                                        |
| Action  | `primary`, `primary-hover`, `on-primary`, `focus`, `critical`, `critical-hover`     | Near-black primary buttons, the focus ring, destructive buttons                                                                |
| Tones   | `tone-{attention,warning,success,info,critical,neutral}` and `…-fg`                 | Badge and note fills, with their text colour; `neutral` is a settled state (Paid, Delivered), grey with dark words             |
| Signals | `signal-{success,attention,info,critical,neutral}`                                  | Small solid marks: status dots, notification counts                                                                            |
| Luke    | `luke-deep`, `luke`, `luke-light`, `luke-pale`                                      | Luke alone: its orb, and the beam round the composer while it works                                                            |
| Shape   | `radius-card`, `radius-control`, `radius-pane`                                      | Cards and dialogs; buttons and fields; the section and Luke's panel on the frame                                               |
| Depth   | `shadow-card`, `shadow-control`, `shadow-raised`, `shadow-popover`, `shadow-dialog` | Resting card, button, hovered card, menu, dialog                                                                               |

Rules:

- No raw palette classes (`bg-slate-900`, `text-blue-600`, `amber-…`) in app screens.
  A pale note is a tone at an opacity (`bg-tone-attention/25`), never a new hue.
- Colour means state. The page is neutral; attention, critical and success are the only
  colours, and each always means the same thing.
- The app uses Inter (`font-ui`). Headings are `font-semibold`, not a display face.

## Building blocks

| Block                                                               | File                                                                                                  | What it guarantees                                                                                                                                                                                                                                                                                                                                                                                                                 |
| ------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `button(tone, size)`                                                | [`ui/controls.ts`](../../src/components/ui/controls.ts)                                               | Tones `primary`, `secondary`, `plain`, `critical`, `critical-secondary`, `critical-plain`; sizes `sm` 28px, `md` 32px, `lg` 40px. Works on `<button>`, `<Link>` and `<a>`                                                                                                                                                                                                                                                          |
| `iconButton`, `iconButtonCritical`, `iconButtonRound`, `sendButton` | same                                                                                                  | A 32px square holding one icon; `iconButtonRound` is the same inside something round (the Ask Luke bar, the table's pages); `sendButton` is a composer's one filled round send                                                                                                                                                                                                                                                     |
| `field`, `fieldOf(size)`                                            | same                                                                                                  | One height, one focus ring; `aria-invalid` turns it red. `field` is full width; `fieldOf` leaves width to the caller                                                                                                                                                                                                                                                                                                               |
| `label`, `hint`, `card`, `note.*`                                   | same                                                                                                  | Form labels, help lines, white cards, and notes by meaning                                                                                                                                                                                                                                                                                                                                                                         |
| `menu`, `menuItem`                                                  | same                                                                                                  | Popovers and their rows: compact, rounded rows inside a padded card                                                                                                                                                                                                                                                                                                                                                                |
| `Dialog`                                                            | [`ui/Dialog.tsx`](../../src/components/ui/Dialog.tsx)                                                 | The browser's modal `<dialog>`: one width (560px), same header and footer, focus kept inside, Escape and backdrop close it, the page behind stops scrolling; a bottom sheet on phones; `tall` fixes the height for tabbed or long content. Nothing slides in from an edge: every dialog opens in the same place                                                                                                                    |
| `Group`                                                             | [`ui/Group.tsx`](../../src/components/ui/Group.tsx)                                                   | A bordered, headed part of a long form; `danger` for what cannot be undone, always last                                                                                                                                                                                                                                                                                                                                            |
| `Switch`                                                            | [`ui/Switch.tsx`](../../src/components/ui/Switch.tsx)                                                 | `role="switch"`; always shown with its state in words beside it                                                                                                                                                                                                                                                                                                                                                                    |
| `PasswordInput`                                                     | [`ui/PasswordInput.tsx`](../../src/components/ui/PasswordInput.tsx)                                   | A password field with show and hide                                                                                                                                                                                                                                                                                                                                                                                                |
| `PageFrame`                                                         | [`PageFrame.tsx`](../../src/components/PageFrame.tsx)                                                 | Outside the console: dark top bar with Projects, one Superadmin link for an administrator, theme switch and account menu. Inside the console: a sidebar like the app's, its screens grouped and read from one list (`lib/console-nav.ts`, a new screen is one line there), a search once there are eight or more, folding to a 64px rail (`abo_console_rail`), a drawer behind a menu button on a phone; Back to projects, account and theme at its foot |
| `ThemeToggle`                                                       | [`ThemeSync.tsx`](../../src/components/ThemeSync.tsx)                                                 | The light and dark switch, one icon; given `value` and `onChange` it switches only what its owner holds                                                                                                                                                                                                                                                                                                                            |
| `OverviewBoard`                                                     | [`Overview.tsx`](../../src/components/Overview.tsx)                                                   | The store overview drawn from counts already made; `Overview` loads them and hands them to it, and the landing hands it the sample store                                                                                                                                                                                                                                                                                           |
| `Stat`, `Breakdown`                                                 | [`AdminParts.tsx`](../../src/components/AdminParts.tsx)                                               | The admin screens' numbers: a figure with a line under it, and the top answers as bars                                                                                                                                                                                                                                                                                                                                             |
| `Choices`, `DEMO_STAGES`, `STAGE_TONE`                              | [`AdminParts.tsx`](../../src/components/AdminParts.tsx)                                               | A row of choices with one picked (an invite's length, a demo's stage, the stage filter), and each demo stage's badge                                                                                                                                                                                                                                                                                                               |
| `AccountDetail`                                                     | [`AccountDetail.tsx`](../../src/components/AccountDetail.tsx)                                         | One account in the Dialog: what they told us, how they came, the apps and stores they own, and the admin trail; a skeleton until it loads                                                                                                                                                                                                                                                                                          |
| `CenteredCard`                                                      | [`CenteredCard.tsx`](../../src/components/CenteredCard.tsx)                                           | One card under the mark: sign-in, sign-up, password reset, connect, invite, AI consent                                                                                                                                                                                                                                                                                                                                             |
| `LukeMark`                                                          | [`ui/LukeMark.tsx`](../../src/components/ui/LukeMark.tsx)                                             | Luke's face: an orb in the Luke colours with eyes that blink; sizes `xs` 20px, `sm` 28px, `lg` 48px; `state="thinking"` while it works (the eyes look about, the glow breathes). CSS only, still under reduced motion                                                                                                                                                                                                              |
| `.beam`, `.beam-ink`, `.shimmer`                                    | [`globals.css`](../../src/app/globals.css)                                                            | The composer's border: while Luke works, a beam of Luke's colour; while the merchant types, a beam in the page's ink that flares with each key and goes a moment after they stop. `.shimmer` is the light along the step Luke is on. Nowhere else                                                                                                                                                                                  |
| `Icon`                                                              | [`ui/`](../../src/components/ui/)                                                                     | Section icons by name (`ALLOWED_ICONS`)                                                                                                                                                                                                                                                                                                                                                                                            |
| `Badge`, `StatusMark`                                               | [`views.tsx`](../../src/components/views.tsx)                                                         | A status as a pill with its mark: a hollow ring while something is left to do, half filled while under way, filled once done; the colour is the tone of what it means (lib/tone). `StatusMark` alone is the mark, for a status said as words in a list (the Overview's latest orders)                                                                                                                                              |
| `TableView`                                                         | [`views.tsx`](../../src/components/views.tsx)                                                         | Every section's table: its head a grey band with rounded ends that stays in view, sort by a button in each head (arrow on the sorted one, `aria-sort`), the first column (what the row is) in bold and pinned at the left while the rest scroll across, amounts to the right in tabular figures, 44px rows with hairlines. A row whose statuses are all settled (`isSettled`: finished and quiet) is muted; a cancelled one struck |
| `EmptyState`                                                        | [`views.tsx`](../../src/components/views.tsx)                                                         | A section with nothing to show: none yet (and "Add the first one" where rows can be added), or nothing that fits the search and filters (and the way to clear them)                                                                                                                                                                                                                                                                |
| `FilterMenu`                                                        | [`GenericRenderer.tsx`](../../src/components/GenericRenderer.tsx)                                     | A section's filter as the app's own listbox, never the system's select: a status's choices drawn as its badges, arrows, Home, End, Enter and Escape, opening towards the room there is. With a table, the section fills the page below its counters and its rows scroll inside it, so the head and the foot stay in view; the foot pages the loaded rows 50 at a time as one pill (‹ 1–50 ›). Over the store (0167) the page, its size (25, 50, 100 or 200, kept per section), the search, the filters and the sort are the server's, over the whole list: the foot says "1–50 of 2,487", the search box is always there, and a filter offers the values of the whole list                                       |
| `PeriodBar`                                                         | [`GenericRenderer.tsx`](../../src/components/GenericRenderer.tsx)                                     | A section's choice of dates (features.period) above its counters: its windows of days, All and "Your dates" as one `Choices` row, the two dates in the same date fields a row's date uses; the pick narrows the rows, the counters and the view together, and is said in words for a screen reader |
| `Tabs`                                                              | [`ui/Tabs.tsx`](../../src/components/ui/Tabs.tsx)                                                     | A row of tabs over what they switch between, the one open underlined: the settings' panes, the bell's Noticed and Asked for, and a section's views (features.tabs: its own view first, then a written screen or another view beside it), below its counters, the one open remembered per section. Arrows move along the row, Home and End to its ends; on a phone the row scrolls rather than the page |
| `DateRange`                                                         | [`ui/DateRange.tsx`](../../src/components/ui/DateRange.tsx)                                         | The dates a list is read over: one button saying which ("4 Sep – 3 Oct 2026"), opening shortcuts (Today, Yesterday, Last 7/30/90 days, This week, Last week, This month, Last month, This year, All time) beside a two-month calendar, a one-month sheet on a phone. A shortcut applies at once, their own days with Apply. Named spans roll over (`lib/period`). The grid is react-day-picker's, drawn with the tokens |
| `Select`                                                            | [`ui/Select.tsx`](../../src/components/ui/Select.tsx)                                               | One choice from a list, drawn by the app and never the computer's own menu: a field-shaped button saying what is chosen, and a list (arrows, Home/End, Enter or Space, Escape, a letter jumps). First option clears it; opens upward when there is no room below, fixed to the screen (`placeBy`) so a dialog's scrolling body never cuts it off. Used for a row's dropdowns and links |
| `DateField`                                                         | [`ui/DateField.tsx`](../../src/components/ui/DateField.tsx)                                         | One day for a field: a button saying it ("2 Oct 2026") opening a month (react-day-picker, with the tokens), with Clear, placed as `Select` places its list. Replaces the browser's date box in a row |
| `AlertList`, `AlertsPanel`, `AlertSettings` | [`Alerts.tsx`](../../src/components/Alerts.tsx) | What Luke noticed (0163), worst first: a tile in the tone of how bad, a dot while new, the numbers, Ask Luke (or "See what Luke said" once asked) for whoever can build, and put away. The same rows in the bell's Noticed tab and the Overview's card, which says so when nothing needs them; `AlertSettings` is Settings → Alerts, each kind's switch and its numbers as a sentence, kept at once, and what is coming, shown and not offered. On the Overview it sits at the foot, below the numbers, small: the panel only while something needs them, else one line. A builder is asked once what to watch as one line there: "Choose what" opens the Dialog (each kind a checkbox row, what is coming greyed with "Coming soon", "Anything else?" sent to Luke), and the cross keeps everything as it is and hides it |
| `AskLuke`                                                           | [`AskLuke.tsx`](../../src/components/AskLuke.tsx)                                                     | Luke from wherever the owner is while Luke's panel is not on screen: a pill floating at the foot of the page. What is sent opens the panel with it already sent; the panel glyph opens the panel as it is; what their own AI waits on them for is counted on Luke's face. The page keeps its foot clear of it                                                                                                                      |
| `SectionSkeleton`, `NavSkeleton`, `.skeleton`                       | [`ui/Skeleton.tsx`](../../src/components/ui/Skeleton.tsx), [`globals.css`](../../src/app/globals.css) | The shape of what is coming while it loads: a section's table (tools, head band, rows of differing widths), the sidebar's rows, a counter still being counted. A slow light crosses each bar, still under reduced motion; `.skeleton-dark` in the frame                                                                                                                                                                            |
| `ResizeHandle`                                                      | [`ui/ResizeHandle.tsx`](../../src/components/ui/ResizeHandle.tsx)                                     | A panel's edge: the drag cursor over the whole gap, a grip always faintly there and in Luke's colour while dragged, the edge lit in Luke's colour under the pointer with a soft glow that follows it, a separator with arrow keys (Shift for bigger steps), Enter and double-click to reset |
| `Tour` | [`Tour.tsx`](../../src/components/Tour.tsx), [`lib/tour.ts`](../../src/lib/tour.ts) | The first look round the app: the browser's modal `<dialog>` with a spotlight that glides between real parts of the screen and a card beside each; Escape, arrow keys, focus kept in the card; a sheet on a phone, at the top when what it lights is low. Stops are in `lib/tour.ts`; their words, the switch and who saw it are on /admin/tour (0157) |
| `CodeValue`                                                         | [`views.tsx`](../../src/components/views.tsx)                                                         | A value that reads as a code — SKU, AWB, order number, coupon — in mono with a copy button that says "Copied" for a moment and never opens the row. The value decides (`looksLikeCode` in `lib/no-ids.ts`): one token with a digit, no spaces, not a date or an id; `barcode` columns always. Never a list of field names                                                                                                          |
| `CustomView`                                                        | [`CustomView.tsx`](../../src/components/CustomView.tsx)                                               | A screen Luke wrote, in a sealed frame: the page's colours handed in as `--fg`, `--surface`, `--primary`, `--success`, `--critical` and the rest, so it follows light and dark. Its own markup is Luke's; a written screen is the one place a block's classes are not used                                                                                                                                                         |
| `Markdown`                                                          | [`ui/Markdown.tsx`](../../src/components/ui/Markdown.tsx)                                             | What Luke writes: one small heading size, bullets, steps, bold and links in the panel's type. Raw HTML is dropped; tables, images and code blocks are unwrapped to their text. `streaming` reads a reply still arriving, so a half-written `**` or list never flashes as symbols                                                                                                                                                   |

Why size and width are separate: two Tailwind classes for the same property on one
element are resolved by stylesheet order, not by the order written. `field w-32` or
`button("plain") text-red…` therefore renders either way. Ask for the variant instead.

## Screens Luke writes

A custom view runs in a sealed frame, so it cannot reach the app's stylesheet. It is
handed the look instead (`CUSTOM_VIEW_KIT` and `CUSTOM_VIEW_TOKENS` in
`src/lib/custom-view.ts`): the app's two faces, read from its own stylesheet and passed in
inline (the frame's policy allows fonts from data only); its colours, corners and depth, in
light or dark as the app chose (never the computer's setting), and again in place, with no
reload, the moment the owner switches; and a small kit drawn as the app draws them. The kit is `wl-page`,
`wl-stack`, `wl-inline`, `wl-grid`, `wl-card` (`now`, `bad`), `wl-title`, `wl-big`,
`wl-count`, `wl-label`, `wl-muted`, `wl-scan`, `wl-banner` and `wl-badge` (`ok`, `bad`,
`warn`, `info`), `wl-list` of `wl-row` (`done`, `bad`), and `wl-button` (`primary`,
`critical`, `big`). Its sizes are the app's own (a `wl-count` is a stat card's figure);
`big` on a count or a banner is for a station read from a step away. A question is
`wl.ask`, drawn as the app's dialog: the frame blocks the browser's own, so `alert` shows
it too, and while it is open a key from outside it (a scanner's Enter) answers nothing. Plain headings, inputs, buttons and tables are styled too. Luke is told
to build from the kit and write CSS for layout alone. A custom screen is the section: it
fills the page below Luke's counters, without the list's search, filters or paging, and
offers full screen for a device at a desk. A screen may keep focus on its own scan box, but
never takes it back from the page around it: while the owner is in Luke's panel its request
waits, and is kept when they return to the screen. `check-custom-view` holds that every piece the
prompt names is drawn, and that the kit sets no colour of its own.

## Previews

What Luke proposes is shown before it is built, with a bar of its own at the top: a small
info dot, "Preview", and "Nothing is built until you approve it", as a browser frame
labels what it holds, never a word laid across the rows. A preview draws only what the
change does (`changeShown` in `src/lib/change-preview.ts`): new fields beside the section's
first column, the parts of how it works the change names, a written screen alone, a new
section whole with its parts. It is drawn over the section the change is for, read once when
the card first shows, so it holds still while the owner works beside it and is right
whichever section is open. Its list shows three rows; its stat cards count every row. A
written screen in a preview is the screen drawn at 70% in a box 260px high, with no full
screen, and leaves the owner's focus in Luke's panel. Under it, **Build this** and **Change
something**; once built the preview goes and the card says Done and where, with what Luke
offered to do next on the receipt right below. The section's stat cards size to the space
they are in, so four do not break every word in a narrow preview.

## Meaning of a badge

[`src/lib/tone.ts`](../../src/lib/tone.ts) decides what a status says and how it is
drawn. A store status is recognised only in Shopify's own form (capitals and
underscores, `PARTIALLY_PAID`), so a merchant's own "Pending" in their repairs section is
never shown as a payment. Everything else gets one of the calm colours, chosen by the
word, so the same word always looks the same. The store's words known here are its orders'
payment and fulfilment, its products', its shipments' (In transit, Delivered, Not delivered),
its transactions', its draft orders' and its returns'. `isSettled` is a status with nothing left
in it for the merchant (finished and neutral: Paid, Fulfilled, Delivered, not Active), which
is what mutes a table's row. `check-tone` holds this.

## Light and dark

The app has both. The dark theme is every product token given a night value under
`[data-theme="dark"]` in `globals.css`, and nothing else: screens built from tokens
follow without a line of their own. A screen Luke wrote is told the new values in place
(`CustomView`), so it switches with the app and keeps where its user was. `ThemeToggle` (`components/ThemeSync.tsx`) sits in
the app's sidebar and the page frame; the choice is kept in the browser and put on
`<html>` before the first paint (`lib/theme.ts`), so a dark app does not flash white.

- The pages a visitor is sold on (`/`, privacy, terms) stay light whatever was chosen.
- A primary fill carries `text-on-primary`, never `text-white`: at night primary is light.
- The calm badge colours in `lib/tone.ts` are the app's only raw colours, so each has a
  `dark:` pair; `dark:` follows the app's switch, not the computer's.
- `check-theme` fails a token without a night value, white words on primary, or a calm
  colour without its pair.

## Icons and motion

- Icons are Lucide line icons at `strokeWidth` 1.75 (2 for small emphasis). No emoji
  and no text glyphs (`✓`, `⚙`, `+ Add`) as marks.
- Motion is CSS only: `.rise` for arriving content, `.pop` for menus, and the dialog's own
  entrance. All of it stops under `prefers-reduced-motion`.

## Layout rules

- Dialogs open centred, the same width, and never from an edge; a phone gets a sheet from
  the bottom. Nothing leaves the frame or hides behind the assistant panel.
- A wide screen shows three panes: the sidebar, the section, Luke. The section's header
  offers **Show only this section**, and Luke's header **Open Luke full width** (its
  conversation then a readable column in the middle); the same buttons bring the three back,
  and the choice is kept in the browser. With the section alone, the sidebar and Luke are
  the drawers a phone opens them in, behind the same header buttons. A phone shows one pane
  at a time already, so neither button is there.
- The sidebar starts with its names, because the sections in it are the merchant's own and an
  icon alone would not say which is which. On a wide screen the panel glyph at its top folds
  it to a rail of icons (64px): each top section as its icon, the store's and their own apart
  by a hairline, what is open lit, each named in a tip beside it on hover or focus, settings
  and the theme pinned at the foot. The choice is kept in the browser (`abo_nav_rail`); the
  store's strip is out of sight on the rail but never unmounted.
- Luke's panel has the same glyph at its top right on a wide screen: it shuts the panel
  (`abo_luke_shut`), and Ask Luke floats over the page instead, as it does whenever the panel
  is not on screen (a phone, the section alone). "Show the side panels" brings it back too.
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
- **Streamed Markdown** in the chat: `streamdown`, which closes a reply's half-written
  Markdown as it arrives, with `remark-breaks` so one line break stays a line break.
  Its own controls (copy, download, link warnings) are off; `Markdown` styles every element.

The landing's other motion is plain CSS in `globals.css` and stops under reduced motion:
the `.orbit` / `.orbit-back` hub of logos, the `.caret` and the `wl-tool` roll that
`cycleCss` builds. Everything else on it stands still on purpose: one moving thing per
screen at most, colour only where it means
something (connected, low, done), and labels in sentence case rather than small capitals.
Anything on the landing that may bleed past its column relies on the page root's
`overflow-x-clip`, never on a negative margin that would scroll the page sideways.

The first screen's dashboard is the app itself, not a drawing of it: `StorePreview`
draws the app's frame in the product tokens and fills it with the app's own
`OverviewBoard`, `TableView` and `BoardView`, fed the sample store in
`lib/sample-store.ts` instead of a database. It is drawn at the visitor's own screen
size (the app's breakpoints read the window, so any other size would pick a layout
for a screen it is not on) and zoomed into the column: a laptop sees the laptop app, a
phone the phone app. It stands on the first screen's bottom edge and fades out there:
a glimpse, not the whole app. Its theme switch works on the glimpse alone and starts
light for every visitor; a link out of it (the store's Shopify admin) brings a word
from Luke instead of a dead page. Every figure about
"your store" on the landing, Luke's answers and drawings included, is read from that
one sample, so a change to it changes all of them together. When the app's screens
change, the glimpse changes with them; nothing needs redrawing.

A choice from a list is the page's own listbox, never the system's select menu: on the
landing that is `Pick` in `components/Landing.tsx` (arrows, Enter, Escape and a letter to
jump; the question moves up small once answered). The footer's name and mark pop up as
the page ends (`.reveal-pop`, timed on their own entry because the foot of a page never
scrolls far enough to finish a cover range), and the mark gives when pressed and springs
back. Anything timed with `view()` must not sit inside an `overflow: hidden` box, which
becomes the scroller it is timed to; clip with `overflow-clip` instead.

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
