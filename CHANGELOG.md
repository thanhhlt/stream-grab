# Changelog

All notable changes to StreamGrab are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.2.0] - 2026-11-06

UI/UX release: detailed download progress with size estimates and ETA, a compact Completed tab
and an easier Detected tab. Detection, parsing, downloading and merging work as in 0.1.0.

### Added

- **Queue: detailed progress per download** — percentage, completed / total segments,
  downloaded size, estimated total size, remaining size, current speed and estimated time left
  (ETA). Estimated values carry `~`; a total that cannot include a track yet (its first segments
  are not in) is shown as a lower bound with `+` and a tooltip.
- **Size and ETA estimates** (`src/core/download/estimate.ts`, shared by the engine and the
  popup): exact sizes when the manifest declares every segment's byte range; otherwise each
  track is extrapolated from its own completed segments (the engine downloads the video track
  before the audio tracks, so a per-task average would overestimate by up to 2×). ETA uses a
  time-based moving average of the speed and is withheld when there is not enough data (fewer
  than 3 segments of a track, a run younger than 3 s, zero speed, no segment count).
- **Stall detection**: a download that receives nothing for 8 s shows *Stalled* instead of a
  stale speed and ETA.
- The engine's progress reports carry per-track figures (`progress.tracks`) and an averaged
  speed (`progress.averageBytesPerSecond`); both are optional, so progress stored by 0.1.0 is
  still read (and estimated as a single track).
- **Completed: summary** of saved videos, their total size, and how many files are missing.
- **Completed: overflow menu (⋯)** holding *Remove from list*.
- **Detected: per-card quality selector and Download button**; the bulk button shows the number
  of selected videos (*Download selected (n)*).
- `STREAMGRAB_EXTENSION_DIR` lets the end-to-end tests run against another extension folder,
  e.g. an extracted release ZIP.
- `LICENSE`: StreamGrab is licensed under GPL-3.0-or-later (`license` field in `package.json`,
  License section in the README).
- README *Supported formats* section and an *Adding a streaming format* guide in
  `docs/ARCHITECTURE.md`.

### Changed

- **Queue items** are grouped into six states: Pending, Downloading, Processing, Completed,
  Failed and Cancelled (a downloaded task waiting for FFmpeg is *Processing*). FFmpeg's progress
  has its own violet bar and stage label ("Merging tracks 63%") under a "Downloaded · n segments ·
  size" line, separate from network progress. The output file name moved into the title tooltip.
- **Completed items** follow a compact hierarchy: title; protocol · resolution · duration · real
  file size (as saved by Chrome, not the downloaded segment bytes); codecs · audio layout ·
  container in smaller type; completion date. The file name is shown only when it differs from
  the title; manifest URLs are never shown. *Show in folder* is the primary action. A file that
  is no longer on disk is marked *File missing* (was "File moved or deleted").
- **Detected cards**: the title is the most prominent line; protocol, site and duration follow
  in smaller type; the manifest file name appears only to tell apart streams with the same
  title; codecs moved into the expandable options (audio tracks and file name); selected cards
  are highlighted; "Ready" is no longer shown as a badge.
- Visual consistency: shared button styles, badges, progress bars, hover and selection states,
  empty states with icons, and translucent dark-mode banners; same dark navy theme and indigo
  accent.
- The project, `package.json` and extension (`manifest.json`) descriptions are no longer limited
  to HLS and MPEG-DASH: StreamGrab is described as a downloader for online media streams, with
  HLS and MPEG-DASH listed as the formats supported so far.
- Popup texts on the Detected tab and the "Detect videos automatically" setting now refer to
  supported streams instead of naming HLS and DASH.

### Known limitations

- While the video track downloads, the audio track has no samples yet: the total, remaining
  size and ETA are lower bounds (`+`) until its first segments arrive. Usually audio is a small
  share of a video; for low-bitrate video it can be large.
- Estimates are of the downloaded data. The merged file is usually somewhat smaller (MPEG-TS
  overhead is removed); the Completed tab shows the real size.

## [0.1.0] - 2026-11-06

First release: a Chrome (Manifest V3) extension that detects, downloads and merges HLS and
MPEG-DASH streams entirely in the browser, with no server and no native helper.

### Added

- **Stream detection**: network monitoring (`webRequest`) and a content script find HLS and DASH
  manifests per tab, including extensionless manifests, manifests in iframes and
  `<video src="….m3u8">`; segments and API calls are ignored, duplicates are merged and
  DRM-protected streams are flagged.
- **HLS parsing**: master and media playlists, variants, alternative audio renditions,
  AES-128 keys, discontinuities and `EXT-X-MAP` initialization segments.
- **DASH parsing**: MPDs with SegmentTemplate, SegmentList and SegmentBase, multiple Periods
  with matching Representations, and audio adaptation sets.
- **Selection UI** (React + Tailwind popup): select one, several or all detected videos and
  choose quality, audio tracks, output format and file name.
- **Download engine**: persistent queue running in an offscreen document, segments downloaded
  in parallel with retries and backoff, AES-128 decryption, cancel and retry, and the page's
  Referer/Origin replayed through `declarativeNetRequest` rules.
- **Storage and recovery**: segments stored in IndexedDB with completion markers; downloads
  resume after Retry, a browser restart or an extension reload; disk-space guard; orphaned data
  cleaned up.
- **Merging**: bundled FFmpeg.wasm (`@ffmpeg/core` 0.12.10, loaded on demand in a Web Worker)
  merges video and audio by stream copy into MP4, or MKV when MP4 cannot hold the codecs,
  streaming the output without holding the whole file in memory.
- **Output**: files saved to the Downloads folder through `chrome.downloads` (never overwriting
  an existing file), temporary segments deleted, a completion notification shown, and a
  Completed tab listing saved videos.
- **Error handling and privacy**: clear error messages per failure type; signed URL tokens,
  cookies and credential headers redacted from logs.
- **Tooling and tests**: Vite build with dist verification, TypeScript checks, ESLint, Vitest
  unit and integration tests, an end-to-end test of the built extension in Chrome for Testing,
  and a local fixture site for manual checks (`npm run fixtures`).

### Known limitations

See [Known limitations](docs/ARCHITECTURE.md#known-limitations) in the architecture notes.
Notably: merging is stream copy only (no re-encoding); SAMPLE-AES and DRM-protected streams are
not supported; subtitles are ignored; the bundled FFmpeg.wasm core is licensed
GPL-2.0-or-later and adds 32 MB to the extension.

[Unreleased]: https://github.com/thanhhlt/stream-grab/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/thanhhlt/stream-grab/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/thanhhlt/stream-grab/releases/tag/v0.1.0
