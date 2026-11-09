# Alternative popup designs

Two directions from the November 2026 proposals. The owner liked them and wants them kept; they
were not chosen for the next version, which uses [Claw](../DESIGN.md). Both are mocked up,
interactive, in [proposals.html](proposals.html) (sections 2 and 3). Their colors come from the
mockup and have **not** been contrast-checked like Claw's: measure them before using them.

Both share Claw's brief:

- Friendly to people who know nothing about streaming.
- International: titles in any language, UI text unchanged.
- Technical details kept but quiet.
- One signature motion that respects `prefers-reduced-motion`.
- Fonts bundled in the extension.
- No new dependencies.

## 2 · Current

Screens: [light](screens/current-light.webp), [dark](screens/current-dark.webp),
[stalled](screens/current-stalled.webp), [animation](screens/current-animation.webp).

**Idea.** A stream is water. StreamGrab scoops it into a file. The design is calm and soft, and it
reassures.

**Signature motion: liquid progress.**

- The progress bar is a 12 px tube of water. Its leading edge is a wave (an SVG mask on the fill's
  `::after`, moving down 12 px every 0.9 s).
- The wave moves while data arrives. When the download stalls, the wave stops and the fill turns
  amber, next to the "Stalled" label. Anyone can tell at a glance whether the download is still
  working.
- Merging shows two dashed streams, picture (water) and sound (amber), flowing into one line.
- On Download, a drop leaves the row, falls into the Queue tab, and the count pulses.
- The empty Detected page shows ripples spreading around a drop (3 rings, 3 s, staggered 1 s).

**Tokens (light / dark).**

| Token | Light | Dark |
|---|---|---|
| Background | `#F6FAFA` | `#0E1719` |
| Surface | `#FFFFFF` | `#152226` |
| Line | `#DDE7E8` | `#22343A` |
| Ink | `#12262B` | `#E7F1F1` |
| Muted | `#53676D` | `#95ABAF` |
| Primary button (on-primary) | `#087A7F` (`#FFFFFF`) | `#3CC7C4` (`#052022`) |
| Water (progress) | `#22AFAC` | `#3CC7C4` |
| Sound stream, stalled | `#F0A73A` | `#F2B457` |
| Selected tint | `#E3F4F3` | `#16302F` |
| Error | `#CF4339` | `#FF7468` |

**Type and shape.**

- Type: Lexend (300–700), designed for easier reading. It has Latin and Vietnamese; other scripts
  use the system font.
- Radii: 10 px buttons and fields, 14 px rows.
- Surfaces are soft and there are few rules. Row avatars become a small duration line with a
  clock icon.

**Strengths.**

- The motion carries real information: running vs stalled.
- It is the quietest of the three.
- It works well for long downloads.

**Trade-offs.**

- Water and teal palettes are common in wellness apps, so the identity is less tied to the name.
- The wave runs continuously during downloads. Keep it to the progress tubes, and pause it when
  the popup is hidden.

## 3 · Ticket

Screens: [light](screens/ticket-light.webp), [dark](screens/ticket-dark.webp),
[animation](screens/ticket-animation.webp).

**Idea.** Every video is a cinema ticket, an international metaphor. The ticket body holds the
title, site and length. A tear-off stub on the right holds the quality and Download.

**Signature motion: tear and stamp.**

- On Download, the stub tears along the dashed perforation. It tilts 9° and flies into the Queue
  tab, whose count bumps.
- At the same time, the ticket gets a red "Queued" stamp (scale 1.6 → 1, then it fades).
- In the Queue, tickets have a torn right edge (a conic-gradient mask). A saved file gets a green
  "Saved" stamp.
- The empty Detected page prints a blank ticket out of a slot (3.2 s loop).

**Tokens (light / dark).**

| Token | Light | Dark |
|---|---|---|
| Lobby (background) | `#ECEDF1` | `#121318` |
| Ticket paper | `#FFFFFF` | `#1E2027` |
| Perforation | `#C5C8D0` | `#3D414B` |
| Ink | `#1C1F26` | `#EEEFF2` |
| Muted | `#5E6472` | `#A1A6B2` |
| Ticket gold, primary (on-primary) | `#F2B705` (`#1C1A10`) | `#FFC83D` (`#1C1606`) |
| Saved, merging | `#21885A` | `#53C98B` |
| Stamp | `#C2362F` | `#FF7A6E` |
| Error | `#CC3838` | `#FF6F6F` |

**Type and shape.**

- Type: Archivo, using its width axis: 75% for the stub's quality, 112% for the wordmark. It has
  Latin and Vietnamese.
- Tickets have a 10 px radius, 8 px notches cut at the perforation (radial-gradient masks), and a
  dashed perforation line.
- The selected ticket gets a 2 px gold inset outline.

**Strengths.**

- The most tactile and witty of the three.
- The stamps make the states (queued, saved) memorable.

**Trade-offs.**

- The 96 px stub narrows titles.
- The masks and stamps are more CSS to maintain.
- The cards with gaps fit fewer videos on screen than flat rows.

## Earlier round (rejected)

The first round explored more technical directions:

- Timeline: a video editor look with V/A track chips and a segment-cell progress lane.
- Field Recorder: hardware keycaps and an amber readout.
- Manifest: big quality numerals and a highlighter selection.

The owner asked for something international and friendly to non-technical users instead.
Timeline's segment lane and track chips assume knowledge of streaming. Those mockups were not
kept in the repository.
