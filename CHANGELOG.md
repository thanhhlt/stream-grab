# Changelog

All notable changes to StreamGrab are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- `LICENSE`: StreamGrab is licensed under GPL-3.0-or-later (`license` field in `package.json`,
  License section in the README).
- README *Supported formats* section and an *Adding a streaming format* guide in
  `docs/ARCHITECTURE.md`.

### Changed

- The project, `package.json` and extension (`manifest.json`) descriptions are no longer limited
  to HLS and MPEG-DASH: StreamGrab is described as a downloader for online media streams, with
  HLS and MPEG-DASH listed as the formats supported so far.
- Popup texts on the Detected tab and the "Detect videos automatically" setting now refer to
  supported streams instead of naming HLS and DASH.

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

[Unreleased]: https://github.com/thanhhlt/stream-grab/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/thanhhlt/stream-grab/releases/tag/v0.1.0
