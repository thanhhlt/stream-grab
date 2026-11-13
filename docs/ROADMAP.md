# StreamGrab roadmap

Plan agreed on 2026-11-11. Released versions are in [CHANGELOG.md](../CHANGELOG.md); v0.8.0
(Chrome Web Store preparation) is the latest.

StreamGrab is built and tested by one person. There is no beta group: the release candidate is
checked against the checklist below, and then the public Chrome Web Store listing collects real
use. 1.0.0 means "stable and public", not a feature milestone.

| Version | Content |
|---|---|
| v0.6.0 | Range resume for the progressive engine fallback; a failed forced-MP4 task switches to MKV and is merged again from the stored segments; audio size known earlier for estimates |
| v0.7.0 | Subtitles |
| v0.8.0 | Chrome Web Store preparation (below) |
| v0.9.0 | Self-test checklist (below), then a **public** Chrome Web Store listing |
| v1.0.0 | After a few weeks on the store without serious bugs; bug fixes only, no new features |

Not planned: DRM, SAMPLE-AES, live download, an "always ask where to save" setting (Chrome's own
setting does it), an Open file button (needs `downloads.open`), an FFmpeg upgrade.

## Funding: donate-only (decided 2026-11-12)

StreamGrab stays free and fully featured, funded by voluntary donations only (see the Donate link
item under v0.8.0). No paid plan, license check or feature limit is built for 0.x or 1.0.0.

A paid plan is a question for after v1.0.0, and only if there is real demand. If it comes:

- Only **new** features may be paid; nothing users already have for free is removed or limited.
- It needs its own payment provider (Chrome Web Store payments no longer exist), a license server,
  an updated privacy policy (a license check is a network call, so "nothing is sent anywhere" no
  longer holds) and a host permission for that server.
- Selling makes the developer a "trader" under the EU DSA: name and address shown publicly on the
  store listing.
- The code is GPL-3.0-or-later, so anyone can fork it without the check; the limit only stops
  ordinary users. The license stays GPL (the bundled FFmpeg core is GPL).
- The store description must not promise "free forever".

## v0.6.0: phases

1. Analysis and Chrome spikes (done 2026-11-11): a worker's OPFS sync access handle keeps every
   written byte when the offscreen document closes or Chrome is killed, and `Range` + `If-Range`
   from the offscreen document continue the file byte for byte.
2. Range resume of a video file the engine downloads (when the site needs the page's Referer):
   written to OPFS, continued after an error, a Retry or a browser restart. Without an `ETag` or
   `Last-Modified` from the server it starts again from the beginning, as Chrome does.
3. A failed forced-MP4 task gets a "Save as MKV" button that merges the stored segments again;
   the first segments of every track are fetched early so the size estimate includes audio sooner.
4. Regression tests, docs, release (done 2026-11-11).

## v0.7.0: subtitles

Scope agreed on 2026-11-12. Today every subtitle is dropped: HLS `TYPE=SUBTITLES` renditions and
DASH text adaptation sets are ignored, and the merge maps only video and audio.

- **Sources:** WebVTT text subtitles from HLS `TYPE=SUBTITLES` renditions (segmented `.vtt`),
  DASH text adaptation sets with `mimeType="text/vtt"` (one file or segments), and
  `<track src>` elements on a page's `<video>` for progressive MP4/WebM.
- **Joining:** segmented WebVTT is joined into one file (repeated headers removed) and its cue
  times are aligned with the video through `X-TIMESTAMP-MAP`.
- **Output:** by default each chosen subtitle is saved as a **separate file** next to the video
  (`.srt` by default; `.vtt` is a setting). A setting switches to embedding it in the merged file instead (MKV keeps
  WebVTT; MP4 needs `mov_text`) or doing both. Progressive files are never merged, so they always
  get separate files. Each track keeps its language and name, as audio tracks do.
- **UI:** subtitles are picked by language in the Detected tab, like audio tracks; Settings has
  default subtitle languages and the output mode.
- **Not planned:** subtitles inside fMP4 (`wvtt`, `stpp`/TTML; FFmpeg 5.1 handles them poorly),
  CEA-608/708 captions inside the video stream, image subtitles, burned-in subtitles.

Phases:

1. Analysis and Chrome spikes (done 2026-11-12): the bundled FFmpeg 5.1.4 core has the WebVTT
   demuxer, muxer and codec, the SRT muxer and the `mov_text` encoder; Matroska keeps WebVTT and
   both files still play in Chrome. A `STYLE` block makes its WebVTT demuxer drop every cue, so
   joined files leave it out. FFmpeg does not move a subtitle input to 0, so cues are written on
   the merged file's timeline and get no `-itsoffset`: `cue − LOCAL + MPEGTS/90000 − first PTS of
   the run + start of the run` (the concat demuxer starts a run at the sum of the earlier runs'
   durations), as hls.js does. A cue after the video's end lengthens the file, so cues are cut
   there. Chrome keeps `.vtt` for `text/vtt` and `.srt` for `application/x-subrip` (an untyped or
   `text/plain` Blob becomes `.txt`), from a blob: or a data: URL; `uniquify` renames a subtitle on
   its own, so its name is taken from the saved video's final name.
2. Parse HLS/DASH subtitle renditions and `<track>`, download and join WebVTT, save separate
   `.vtt`/`.srt` files; unit tests. Split in two:
   - 2a (done 2026-11-12): WebVTT parser, joiner (dedupe, split cues, cut to the video) and SRT
     writer; HLS `TYPE=SUBTITLES` and DASH `text/vtt` tracks (fMP4 text skipped); `<track>` of
     progressive files; subtitle lists in the Detected data, requests, tasks and the engine spec;
     Settings `subtitleFormat` (SRT by default).
   - 2b (done 2026-11-12): the engine downloads subtitle segments with the others (a subtitle
     playlist or segment that fails never fails the video), joins them on the merged file's
     timeline (joined runs probed one by one; a segment after a timestamp reset goes to the part it
     fits), and the files are saved after the video as `<video name>.<lang>.srt|vtt`; the task
     completes once they are saved. Progressive `<track>` files are fetched by the service worker
     and saved as data: URLs (at most 1.5 MB each). Cancel, Retry and a restart cover them.
     Not yet shown in the popup (Phase 3).
3. Embed in MKV/MP4 (when the setting asks for it), subtitle picker in the popup, Settings; e2e.
   Split in two:
   - 3a (done 2026-11-12): Settings `subtitleMode` (file by default, embed, both) and
     `subtitleLanguages`; the cues are timed before the merge and embedded after the audio
     (MKV keeps WebVTT, MP4 gets `mov_text`; language, name, none default, though FFmpeg's MP4
     muxer always enables the first one), cut at the video's expected end and counted when the
     result is checked. A merge that fails with subtitles is run again without them, and they are
     saved as files instead.
   - 3b (done 2026-11-12): subtitle picker in the Detected tab's Options (one track per
     Settings language ticked, in that order, never a forced one; a note says where they go),
     Settings rows for the languages, where subtitles go (Files / In video / Both) and the file
     format (SRT / WebVTT), and a Subtitles line in the Completed tab; e2e on a subtitled HLS
     demo stream through the real popup.
4. Regression tests, docs, release (docs and checks done 2026-11-12). fMP4 subtitles (`wvtt`) stay
   out: a real DASH stream with only `wvtt` text (Shaka's Angel One demo) shows none. A parser of
   its own (about 600 lines) is a candidate for a later version.

## v0.8.0: Chrome Web Store preparation

Done (2026-11-13). YouTube is blocked; no permission could be dropped; the About screen and the
Ko-fi line are in the popup; the listing text, single purpose, permission justifications and
data-use answers are in [STORE.md](STORE.md), the privacy policy in [PRIVACY.md](PRIVACY.md)
(its GitHub URL goes into the store; no GitHub Pages site needed), the assets in
[store/](store/). i18n was skipped. The plan as written:

- **Block YouTube** (`youtube.com`, `googlevideo.com`): the Chrome Web Store policy does not allow
  extensions that download YouTube videos, and this is the most common rejection for video
  downloaders. The code has no such block today.
- **Privacy policy page** (for example on GitHub Pages): everything runs in the browser, nothing
  is sent anywhere. Its URL goes into the store's Privacy practices tab.
- **Permission justifications** for the Privacy practices tab: `webRequest`,
  `declarativeNetRequestWithHostAccess`, `downloads`, `offscreen`, `unlimitedStorage`,
  `notifications`, the `http://*/*` and `https://*/*` host permissions, and the content script on
  every page. Drop any permission that turns out not to be needed. The broad host access means a
  longer, more careful review.
- **About section** in the popup: version, source link (GPL-3.0 and FFmpeg's GPL), a "Report a
  problem" link to GitHub Issues, and the donate link.
- **Donate link**: in the About section, the store description and the README
  (`.github/FUNDING.yml` adds GitHub's Sponsor button). It must stay voluntary: no feature behind
  it, no nagging popups, no misleading wording ("donate for faster downloads").
- **Store assets**: 128 px icon, at least one 1280×800 or 640×400 screenshot, a 440×280 small
  promo tile, a description that says DRM-protected content is refused and that the tool is for
  content you are allowed to download.
- Optional: i18n (English and Vietnamese).

## v0.9.0: self-test checklist

Automated tests (`npm run check`, `npm run test:e2e`) cover most behaviour. These are the checks
that have never been run:

- **Chrome 116** (`minimum_chrome_version`): run the e2e suite in Chrome for Testing 116. If it
  fails, raise the minimum version instead of changing code.
- **Nearly full disk**: put the Downloads folder or the profile on a small virtual disk (VHD of a
  few GB) and check the disk-space messages.
- **Multi-GB video**: measure Chrome's RAM during a real merge (OPFS output, v0.4.0).
- **Daily use for 1–2 weeks** on 10–15 different video sites (HLS, DASH, MP4/WebM, a page with a
  live stream); log every problem and fix it.

Then submit to the store as a public listing. A first review often asks for changes (permission
wording, policy); fixing them during 0.9.x keeps 1.0.0 free of that.

## Publishing on the Chrome Web Store

1. Developer account at `chrome.google.com/webstore/devconsole`: a one-time 5 USD fee and 2-step
   verification.
2. Trader / non-trader declaration (EU Digital Services Act). Accepting donations may count as
   trading, which shows a public contact name and address; read Google's definition first.
3. Upload the release ZIP (built from `dist/`, as for GitHub releases); every upload needs a higher
   version.
4. Listing: description, icon, screenshots, promo tile, category, language, support URL (GitHub
   Issues), source link.
5. Privacy practices tab: single purpose, permission justifications, data-use certification,
   privacy policy URL.
6. Submit for review: usually a few days, longer with broad host permissions.

Minified code is accepted; obfuscated code is not.
