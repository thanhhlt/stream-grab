# StreamGrab design system: Claw

Status: **approved 2026-11-09** for v0.5.0. All three plan steps (1 tokens, fonts and shared components; 2 the four pages and the grab; 3 regression and docs) are done. This file is the
source of truth for the popup's look and motion. Where it differs from the mockup, this file wins
(its colors are contrast-checked).

- Mockups: [design/proposals.html](design/proposals.html) (direction 1). Open it in a browser and
  press Download in a mockup to play the animation.
- Screens: [light](design/screens/claw-light.webp), [dark](design/screens/claw-dark.webp),
  [grab animation](design/screens/claw-animation.webp).
- The two other directions, kept for later: [design/ALTERNATIVES.md](design/ALTERNATIVES.md).

## Who it is for

Anyone who wants to keep a video they can watch in Chrome, anywhere in the world. They do not need
to know what HLS, DASH, a segment or a codec is. They open the popup for a few seconds: see what
the page offers, pick a quality, press Download, check how long is left, find the file.

## Principles

1. **What matters first.** Title, site, length, quality and time left are prominent. Protocol,
   codecs, segment counts and byte counts stay available but quiet: a muted line, the Options
   panel or a tooltip.
2. **One primary action per screen** (Download selected, Retry). Row actions are outlined.
3. **One signature motion**, the grab. It answers the user's action and shows where the video
   went. Everything else stays still.
4. **International.** No assumption about the language of titles. The UI text stays as it is
   (English).
5. **Friendly shapes, not a card kit.** Pills and rounded tiles, flat rows without borders. A
   selected row gets a tint, not a frame.

## Identity

The name says it: an arcade claw that grabs videos off a page.

- **Claw mark:** a string, an ink cap and two tangerine prongs with inward hooks (SVG in the
  mockup, `claw()`). It hangs from the top edge of the header.
- **Toolbar icon** (`scripts/generate-icons.ts`, then `npm run icons`): a flat tangerine rounded
  square (no gradient; drop `GRADIENT_FROM`/`GRADIENT_TO`) with the ink claw holding a small white
  play triangle. It must still read at 16 px: at that size, drop the string and keep the cap and
  prongs.
- **Toolbar badge** (detected streams per tab, `src/background/badge.ts`): `ink` `#1B2030` with
  white text, like the claw's cap. Not tangerine: it would disappear into the tangerine icon (the
  owner compared ink, dark tangerine and tangerine, 2026-11-10).

## Color tokens

The popup has a light and a dark theme. The Theme setting picks one: System (the default) follows
Chrome's appearance setting (`prefers-color-scheme`), live while the popup is open; Light and Dark
override it. The header's sun/moon button sets Light or Dark directly.

| Token | Light | Dark | Use |
|---|---|---|---|
| `bg` | `#FFFFFF` | `#171A21` | Popup background |
| `surface` | `#F3F4F7` | `#21252E` | Active tab, selects, chips, summary panel, fields |
| `line` | `#E5E7EC` | `#2F343F` | Header/footer rules, outlined buttons |
| `ink` | `#1B2030` | `#EEF0F4` | Text, claw cap |
| `muted` | `#5B6274` | `#A3A9B7` | Secondary text, technical lines |
| `faint` | `#7A8091` | `#6E7584` | Icons only (×, chevrons). Never text |
| `primary` | `#FF7A1A` | `#FF8A33` | Primary button, count badge, claw prongs, checkboxes |
| `on-primary` | `#1B1206` | `#1B1206` | Text and icons on `primary` |
| `primary-strong` | `#E0600A` | `#FF8A33` | Download progress fill, outline of the Download button |
| `primary-text` | `#B04600` | `#FF9F57` | Tangerine text and links, focus ring |
| `selected` | `#FFF1E6` | `#2D241B` | Selected row tint |
| `track` | `#F0F1F4` | `#2B303A` | Progress track |
| `merge` | `#0C8784` | `#3CC9C3` | Processing (FFmpeg) progress |
| `merge-text` / `merge-surface` | `#0A6F6C` / `#E2F4F2` | `#3CC9C3` / `#173130` | "Processing" chip |
| `success` / `success-surface` | `#13733F` / `#E4F5EA` | `#4CC985` / `#183324` | Saved, completed |
| `warning` / `warning-surface` | `#8A5A00` / `#FFF4DB` | `#F2B84B` / `#3A301A` | Stalled, cancelled, low disk, file missing, detection off |
| `warning-bar` | `#A87300` | `#F2B84B` | Progress fill while stalled |
| `danger` / `danger-surface` | `#C22E2E` / `#FDECEC` | `#FF6B6B` / `#3A2224` | Failed, DRM, errors; danger button (`#FFFFFF` text in light, `#1B1206` in dark) |

Measured contrast (WCAG 2.x). Text pairs are at least 4.5:1, bars and icons at least 3:1:

- Light: ink/bg 16.2, muted/bg 6.1, muted/selected 5.5, on-primary/primary 7.1,
  primary-text/bg 5.6, primary-text/selected 5.1, danger/danger-surface 4.9,
  warning/warning-surface 5.4, success/success-surface 5.2, merge-text/merge-surface 5.3,
  primary-strong/track 3.2, merge/track 3.8, warning-bar/track 3.6, faint/bg 3.9.
- Dark: ink/bg 15.3, muted/bg 7.4, muted/selected 6.5, on-primary/primary 7.9,
  primary-text/bg 8.6, danger/danger-surface 5.3, warning/warning-surface 7.3, primary/track 5.6,
  merge/track 6.5, faint/bg 3.8.

The existing `Tone` values in `src/popup/format.ts` map as follows: `neutral` → surface + muted,
`progress` → selected + primary-text, `accent` (processing) → merge, `success`, `warning`,
`danger`.

**Poster tiles.** Videos have no thumbnail (`DetectedStream` has none), so each row shows a tile
in one of 8 colors, picked from a hash of the site's host name. The play glyph is white; every
color gives it at least 3.5:1: `#E0573A`, `#3C6FE8`, `#16897A`, `#B5477A`, `#6B5BD6`, `#C2780E`,
`#4E7A2E`, `#2F7FB8`. They are the same in both modes. This is presentation only, not a new
feature.

## Typography

- **Bricolage Grotesque** (variable: weight 400–800, optical size 12–96), the only family. The
  woff2 subsets latin, latin-ext and vietnamese are **bundled in the extension** in
  `public/fonts/` (copied to `dist/fonts/`, so the release ZIP carries them), with the OFL license
  next to them (`OFL.txt`) and `@font-face` + `font-display: swap` in `src/popup/styles.css`.
  Source: Google Fonts (v9, axes `opsz` 12–96 and `wght` 400–800). Never load fonts from the
  network.
- Fallback stack: `'Bricolage Grotesque', system-ui, 'Segoe UI', -apple-system, sans-serif`.
  Titles in scripts the font does not cover (CJK, Arabic, Thai…) render in the system font.
- Scale (px / weight):
  - 18 / 800: wordmark, letter-spacing −0.02em (the only tracked text)
  - 15 / 700: empty-state heading
  - 15 / 750: percent in the Queue
  - 14 / 650: row title (2 lines max in Detected, 1 line in Queue and Completed)
  - 13 / 600: tabs, buttons; 13 / 400: body
  - 12.5 / 500: controls (selects, pills)
  - 12 / 400: site and meta
  - 11.5 / 400: technical line, in `muted`, never smaller
  - 11 / 700: count badge
- Numbers use `tabular-nums`. Sentence case everywhere: no all-caps labels (today's `uppercase`
  section and field labels go).

## Layout and shape

- The popup stays 400 × 560. Spacing on a 4 px grid; content inset 16 px.
- **Header** 50 px: the claw (30 × 50, hanging from the top edge), the wordmark, the status on
  the right (green dot + version, "Connecting…", "Background unavailable"), then the theme button
  (28 px; 10 px right padding, so its icon lines up with the 16 px content inset).
- **Tabs:** pills 30 px high. The active tab has a `surface` fill and `ink` text. The Queue count
  is a tangerine circle, 19 px, and is the animation's landing point.
- **Detected rows:** grid `[checkbox 18][tile 52][content]`. The controls row and the Options panel
  span from the tile column to the right edge. Rows sit 6 px from the popup edges with 10 px
  padding and 14 px radius when tinted, 2 px apart, no dividers.
- **Selection bar:** the count ("2 of 3 selected") must never be cut off. If space runs out, the
  Download selected button drops its icon first (CSS only: the icon wraps onto a hidden second
  line), then the count wraps between its two parts ("6 streams" / "on this page"). The bar is
  52 px high in both cases, so the list does not move when a row is selected.
- Radii: 999 for buttons, selects, chips and progress; 14 for rows and the summary panel; 12 for
  tiles and the Options panel; 10 for fields and messages; 16 for the dialog.
- Elevation: none, except the menu and the dialog (one shadow token).

## Components

| Component | File | Claw treatment |
|---|---|---|
| Buttons | `components/buttons.ts` | `primary`: tangerine fill, `on-primary` text, pill, 30 px. New `download`: `primary-strong` outline, `primary-text` label, download-arrow icon (rows' Download, Completed's Show in folder). `secondary`: `line` outline. `ghost`: `muted` text. `link`: `primary-text`. `danger`: `danger` fill. `icon`: 28 px hit area |
| Badge, ProtocolBadge | `components/Badge.tsx` | Chips are pills, 20 px. The protocol is no longer a colored badge: it is text in the technical line or the Options panel (`DASH · H.264 · AAC`), keeping its tooltip |
| Header | `components/Header.tsx` | Claw, wordmark, status, theme button. Exposes the claw for the grab animation. The theme button (`BUTTON.icon`, 28 px) shows what a click does: a moon and "Switch to dark theme" in light, a sun and "Switch to light theme" in dark (`aria-label` and `title`). A click saves an explicit Light or Dark, the opposite of the theme in effect |
| TabBar | `components/TabBar.tsx` | Pills + count. Keeps role=tab and arrow keys |
| Poster tile | new presentational component | 52 px, radius 12, color from host hash, white play glyph, duration chip (10 px, white on 45% black). DRM or unavailable: `surface` tile with a lock. Failed: `danger` tile with a warning glyph. Completed: success check |
| StreamCard | `components/StreamCard.tsx` | Tile, title, site. Controls: quality select pill, audio/Options pill, Download (`download` button). Errors in a `danger-surface` message box |
| StreamOptions | `components/StreamOptions.tsx` | `bg` panel inside the tinted row. Labels "Audio", "File", then "Details" with protocol and codecs |
| SelectionBar | `components/SelectionBar.tsx` | Tri-state checkbox in tangerine, count, Clear list (ghost), Download selected (primary) |
| ProgressBar | `components/ProgressBar.tsx` | 8 px pill. `primary-strong` for downloading, `merge` for processing, `warning-bar` + "Stalled" text while stalled. Width transition only, no stripes or shimmer |
| Queue rows | `pages/QueuePage.tsx` | Tile, title, meta with the status chip at its right end ("Downloading", "Stalled", "Processing", "Pending"…). Then the bar, then a line with the percent (15/750), ETA and speed (the speed's "Speed" label is for screen readers only). Then the technical line (segments, sizes) in `muted`, wrapping only between its parts. Failed rows: the reason in a `danger-surface` box, then Retry/Remove. Summary in a `surface` panel. Sections "Finished", "Failed or cancelled" in sentence case |
| Completed rows | `pages/CompletedPage.tsx` | Tile with a check, title, "Saved as …", facts, date; Show in folder (`download` style) + ⋯ menu |
| Settings | `pages/SettingsPage.tsx` | Same rows, range inputs and toggles in tangerine, selects as pills, the folder field as a 10 px field. The last row, "Theme" ("System follows Chrome's appearance setting."), is a System / Light / Dark radio group (`components/Segmented.tsx`): native radios drawn as pills on a `surface` track (`w-48`, three equal pills; the selects are `w-44`), the checked one `bg` with a `line` outline and `ink` semibold text, the focus ring on the pill; Reset to defaults returns to System. Range inputs are drawn like the progress bar (`.range` in `styles.css`: 8 px `track` pill filled in `primary-strong` up to the value, same-colored thumb), because Chrome's own track turns dark gray with a light accent |
| SupportBar | `components/SupportBar.tsx` | 0.8.0. A 36 px line under every tab, above nothing else: a `primary-strong` heart, "StreamGrab is free." in `meta`/`muted` with "Support on Ko-fi" as a `primary-text` semibold link (new tab), then an About `ghost` button. Static: no animation, count, dismiss or repeat prompt (ROADMAP "Funding") |
| AboutPage | `pages/AboutPage.tsx` | 0.8.0. Replaces the tab bar and the support bar: Back (`icon` button) + "About", focus moves to the title; Back refocuses the tab that was open. The 44 px app icon (radius 12), the wordmark, "Version x · Chrome extension", one line on what it does. The support panel is the screen's one primary action: `selected` fill, radius 14, "Keep StreamGrab free" (15/700), a short line, `primary` "Support on Ko-fi" with the heart, "Optional. Opens ko-fi.com" in `tech`. Then Source code, Report a problem, What's new as divided link rows (label, `muted` detail, external icon), and the privacy and license line in `tech` |
| EmptyState | `components/EmptyState.tsx` | Detected "search": the claw hanging from the tab bar rule (see Motion). Other icons: line icons in a `surface` circle |
| ConfirmDialog, Menu, Toggle | `components/*` | Radius 16 / 12 / pill, `danger` confirm button, tangerine toggle |

## Motion

Tokens: ease-out `cubic-bezier(.2,.8,.2,1)`, ease-in-out `cubic-bezier(.45,0,.2,1)`, spring
`cubic-bezier(.3,1.6,.5,1)`. Durations: 120 ms (hover, press, row tint), 200 ms (expand,
collapse), 350 ms (count bump), 1000 ms (grab).

**Grab**, the signature motion:

- **When:** after `downloads/start` resolves, for each stream in `result.created`. A failed
  request flies nothing and shows its error as today. A batch flies at most 3 tiles, 80 ms apart;
  the count still covers all of them.
- **Sequence** (1000 ms, ease-in-out):
  - 0–380 ms: a ghost copy of the row's tile flies to the claw and shrinks to 0.42. The claw drops
    9 px.
  - 300–420 ms: the prongs close (20° → 0).
  - 380–620 ms: hold; the tile rises 6 px under the claw.
  - 620–1000 ms: the tile drops onto the Queue count, shrinks to 0.2 and fades to 0.2. The claw
    rises and the prongs open.
  - At 1000 ms: the count bumps (scale 1 → 1.45 → 1, 350 ms spring).
- **The count itself** always comes from the real task list; the animation never invents numbers.
- **The ghost** is `position: fixed`, `pointer-events: none`, `aria-hidden`. The real row behaves
  exactly as today. It sits under the header (z-index 5 < 10), so the claw is drawn over it and the
  prongs visibly grip its top half (tile center 50 px below the top of the claw). The landing point
  is measured when the drop starts, since the Queue count may only just have appeared.
- **Implementation:** `src/popup/grab.ts` (`playGrab`, `stopGrab`), started by `App` from Detected's
  `onQueued` after the next render (a feedback message may have moved the rows).
- **Never blocks, can be cut short:** input keeps working, and a new grab finishes the previous one
  immediately (ghosts removed).
- `prefers-reduced-motion: reduce`: no flight, no claw motion, no bump; the count just updates.

Other motion:

- **Empty Detected state:** the claw hangs from the tab bar rule like an arcade claw from its rail:
  a small ink carriage under the rule, a string down to the claw, and the claw with the text below
  it in the middle of the empty area (the string and the space below share the height equally).
  Claw and string swing ±2° around the carriage, 3.6 s ease-in-out (a long pendulum moves slowly).
  No background effect. Only while that state is visible; under reduced motion the claw is static.
  The user chose this over a claw-machine window, a pit of placeholder tiles, a three-step guide,
  expanding rings (they competed with the text) and a faint halo, 2026-11-10.
- **Progress:** width transition 400 ms ease-out.
- **Everything else:** color and opacity transitions of 120–200 ms.
- **Implementation:** CSS keyframes and the Web Animations API, no animation library; animate
  `transform` and `opacity` only.

## Accessibility

- Contrast as measured above. Check both modes again after implementation.
- Focus: 2 px `primary-text` outline, 2 px offset, on every interactive element.
- Targets: controls at least 30 px high, icon buttons 28 px (above the 24 px of WCAG 2.2 AA).
- Color is never the only signal: statuses keep their text ("Stalled", "Failed", "File missing"),
  failures keep their icon and message.
- Keep every role, label and keyboard behavior: tab arrows, menu, the dialog's focus trap,
  `role="status"` and `role="alert"` messages.

## Implementation rules

- Keep logic, messages, the API and the architecture. Change presentation only. No new runtime
  dependency.
- Keep every visible string and `aria-label`. Tests and the e2e suite read them: 'Download
  selected', 'Options', 'Audio: …', 'Remove all', the tab names, the progress bar labels, `li` per
  row.
- `tests/unit/popup/detected-page.test.ts:194` checks the selected row by its `bg-indigo-50`
  class. Give the row a semantic marker (for example `data-selected="true"`) and assert that
  instead.
- Tokens go in `src/popup/styles.css` (`@theme` with CSS variables, dark values once under
  `:root[data-theme='dark']`). Components use semantic utilities (`bg-surface`, `text-muted`…),
  not raw palette classes, and no `dark:` variants.
- `<html data-theme>` always holds the theme in effect (`light` or `dark`), with `color-scheme` and
  the color-scheme meta tag matching. `public/popup/theme-init.js`, a classic script in the popup's
  `<head>`, sets it before the first paint from a localStorage copy of the setting
  (`streamgrab.theme`), because chrome.storage is async; `hooks/useTheme.ts` then follows the
  setting (the source of truth) and, for System, `matchMedia` changes.
- Verify with `npm run check`, `npm run test:e2e` and `npm run build`. Then take screenshots of the
  real popup in light and dark (`.cache/design/shoot.mjs`, needs
  `PORT=5181 node scripts/fixture-server.ts`) and fix what looks wrong.

## Plan

1. Tokens, fonts, shared components (buttons, Badge, Header with the claw, TabBar, ProgressBar,
   Menu, ConfirmDialog, Toggle, EmptyState, SettingRow, poster tile) and the toolbar icon.
2. The four pages (Detected, Queue, Completed, Settings) and the grab animation, in light and dark.
3. Regression (check, e2e, build), screenshots, docs (this file, CHANGELOG, README), then the
   version and ZIP on the owner's OK.
