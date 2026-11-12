# StreamGrab roadmap

Plan agreed on 2026-11-11. Released versions are in [CHANGELOG.md](../CHANGELOG.md); v0.6.0
(Range resume, Save as MKV) is the latest.

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
  (`.vtt`, or `.srt`). A setting switches to embedding it in the merged file instead (MKV keeps
  WebVTT; MP4 needs `mov_text`) or doing both. Progressive files are never merged, so they always
  get separate files. Each track keeps its language and name, as audio tracks do.
- **UI:** subtitles are picked by language in the Detected tab, like audio tracks; Settings has
  default subtitle languages and the output mode.
- **Not planned:** subtitles inside fMP4 (`wvtt`, `stpp`/TTML; FFmpeg 5.1 handles them poorly),
  CEA-608/708 captions inside the video stream, image subtitles, burned-in subtitles.

Phases:

1. Analysis and Chrome spikes: does the bundled FFmpeg.wasm core have the WebVTT demuxer, the
   `mov_text` encoder and the SRT muxer; `X-TIMESTAMP-MAP` against the current `-itsoffset`
   alignment (also across discontinuities); one extra `chrome.downloads` file per subtitle with
   the current naming and Completed list.
2. Parse HLS/DASH subtitle renditions and `<track>`, download and join WebVTT, save separate
   `.vtt`/`.srt` files; unit tests.
3. Embed in MKV/MP4 (when the setting asks for it), subtitle picker in the popup, Settings; e2e.
4. Regression tests, docs, release.

## v0.8.0: Chrome Web Store preparation

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
