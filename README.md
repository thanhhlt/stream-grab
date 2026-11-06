# StreamGrab

Browser extension (Chrome, Manifest V3) that detects, downloads and merges online media streams
entirely in the browser. No server, no native helper. It is built to support several streaming
formats and protocols; see [Supported formats](#supported-formats) for what works today.

Current version: **0.3.0** — see [CHANGELOG.md](CHANGELOG.md) and the
[releases](https://github.com/thanhhlt/stream-grab/releases).

Status: **all 10 phases done** (Phase 10: error handling, performance, testing). Streams are
detected and listed per tab; HLS and DASH manifests are fully parsed; videos can be selected (one, several or all) with
quality, audio tracks and file name; queued tasks are downloaded in the background (segments in
parallel, with retries, AES-128 decryption, cancel and retry) into IndexedDB, and resume after
Retry, a browser restart or an extension reload. Once downloaded, FFmpeg.wasm (bundled, loaded on
demand in a Web Worker) checks the segments and merges video and audio by stream copy into one
MP4 (or MKV when MP4 cannot hold the codecs), streamed out of FFmpeg without holding the file in
memory; Chrome saves it to the Downloads folder (never overwriting a file), the temporary
segments are deleted and a notification says so. The Queue tab shows each download's
percentage, segments, downloaded / estimated total and remaining size, speed and ETA, with
FFmpeg's processing shown separately; the Completed tab lists saved videos compactly (resolution,
duration, real file size, codecs, container) with *Show in folder*. A 1.5 GB video merges in
about 5 seconds. Since 0.3.0, plain MP4 and WebM files played by a page are listed too and saved
as they are (byte for byte, no FFmpeg), downloaded by Chrome itself or, when the server wants the
page's Referer, by the extension. Besides unit and integration tests, an
end-to-end test runs the built extension in Chrome for Testing (detection, Referer rules,
download, FFmpeg, saving, resume after a browser restart). See
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the design, measurements and known limitations,
and [docs/SPEC.md](docs/SPEC.md) for the requirements.

FFmpeg.wasm (`@ffmpeg/core`) is licensed GPL-2.0-or-later and adds 32 MB to the package.

## Supported formats

| Format                                                           | Since |
| ---------------------------------------------------------------- | ----- |
| HLS (`.m3u8`): MPEG-TS and fMP4 segments, AES-128 encryption     | 0.1.0 |
| MPEG-DASH (`.mpd`): SegmentTemplate, SegmentList, SegmentBase    | 0.1.0 |
| Progressive MP4 and WebM files played by `<video>` (saved as is) | 0.3.0 |

DRM-protected streams are detected and flagged but never downloaded. Progressive files are listed
when a media element plays or references them; files a player fetches by script (Media Source
Extensions) are parts of a stream, not videos, and are not listed.

More formats and protocols are planned. Each streaming protocol plugs in as a
`StreamingProtocolAdapter`; the download engine, storage, merging and popup work on its output
and stay protocol-independent. See
[Adding a streaming format](docs/ARCHITECTURE.md#adding-a-streaming-format) and
[Progressive files](docs/ARCHITECTURE.md#progressive-files-v030).

## Requirements

- Node.js ≥ 22.18 (build scripts are TypeScript run by Node's type stripping)
- Chrome / Chromium ≥ 116

## Installing a release

1. Download `StreamGrab-v<version>.zip` from the
   [releases page](https://github.com/thanhhlt/stream-grab/releases) and extract it.
2. Open `chrome://extensions` and enable **Developer mode**.
3. Choose **Load unpacked** and select the extracted folder (the one that contains
   `manifest.json`).

StreamGrab is not published on the Chrome Web Store.

## Building from source

```bash
npm install
npm run build
```

Then open `chrome://extensions`, enable **Developer mode**, choose **Load unpacked** and select
the `dist/` folder.

During development:

```bash
npm run dev
```

This rebuilds `dist/` on every change. Press the reload icon on the extension card in
`chrome://extensions` to pick up changes (reload the page too after content-script changes).

## Trying it locally

```bash
npm run fixtures
```

Serves a test site bound to 127.0.0.1, with two pages:

- <http://localhost:5180/>: **detection**. The page loads manifests the way players do: an HLS
  master with its variant playlists, extensionless manifests, a DASH player in an iframe, a
  DRM-protected MPD, a `<video src="….m3u8">`, plus segments and API calls that must *not* be
  detected. The page lists what the popup should show. The same scenario runs automatically in
  `tests/integration/detection-pipeline.test.ts`.
- <http://localhost:5180/download>: **downloading**. Five streams served in full from
  localhost with ~250 ms latency per segment: plain HLS (MPEG-TS), DASH (fragmented MP4), one
  whose segments fail once (retries), one that needs the page as Referer (request context), and
  one whose link "expires" midway. The media is real: 8 minutes of H.264/AAC (test pattern with
  a frame counter, and a beep) in 360p and 180p, generated by the bundled FFmpeg.wasm when the
  server starts (a few seconds). A finished download shows *Processing* while FFmpeg merges it,
  then the MP4 appears in the Downloads folder and under *Completed*, with a notification.
  `tests/integration/download-fixtures.test.ts` checks the same routes. The page also explains how to check resume and recovery: reload the extension
  in `chrome://extensions` mid-download (same effect as a browser restart) and watch the task
  continue from its stored segments in the Queue tab.
- <http://localhost:5180/files>: **progressive MP4 and WebM files** (0.3.0). Four videos played
  by `<video>` elements, served with byte ranges: an MP4, a WebM, an MP4 that needs the page as
  Referer (downloaded through the extension's fallback), and an MP4 behind a redirect; the page
  also fetches an `.mp4` by script, which must not be listed. <http://localhost:5180/files/slow>
  serves a 6 MiB file at 1 MiB/s, to cancel, retry or close Chrome during the download.

## Scripts

| Script                | What it does                                                        |
| --------------------- | ------------------------------------------------------------------- |
| `npm run build`       | Typecheck, production build into `dist/`, verify the output         |
| `npm run build:fast`  | Build and verify without the typecheck                              |
| `npm run dev`         | Development build in watch mode (inline source maps, unminified)    |
| `npm run typecheck`   | `tsc` for extension code, for tests, and for build tooling          |
| `npm run lint`        | ESLint with type-aware rules                                        |
| `npm test`            | Vitest unit and integration tests                                   |
| `npm run coverage`    | The same with a coverage report (`coverage/index.html`)             |
| `npm run e2e:install` | Download Chrome for Testing into `.cache/chrome` (once, ~200 MB)    |
| `npm run test:e2e`    | Build, then run the extension in Chrome for Testing (headless)      |
| `npm run check`       | Typecheck + lint + tests                                            |
| `npm run verify:dist` | Re-run the static checks on an existing `dist/`                     |
| `npm run fixtures`    | Local test site for manual checks in Chrome                         |
| `npm run icons`       | Regenerate `public/icons/*.png`                                     |

## Layout

```
build/            Vite helpers (manifest emitter, FFmpeg core copy, output paths)
docs/             Spec and architecture notes
public/icons/     Extension icons (generated by scripts/generate-icons.ts)
scripts/          build, dist verification, icon generation, fixture server
src/
  background/     Service worker: network monitor, detection service, request-context
                  rules (DNR), page info, badge, message router, offscreen host and engine channel,
                  saving files (chrome.downloads) and notifications
  content/        Content script (IIFE): page metadata, <video>/<source> manifest discovery
  core/
    detection/    Response classifier, manifest inspector, detection manager & store
    models/       Domain types (DetectedStream, StreamingManifest, VideoVariant, MediaSegment, …)
    download/     Download tasks: file names, default choices, validation (TaskService), task store;
                  coordinator (service worker side: queue, restart recovery, orphan cleanup) and
                  engine: download manager (resume), worker pool, segment fetcher, retry policy,
                  AES-128, IndexedDB segment storage with completion markers, disk-space guard,
                  progress
    media/        FFmpeg.wasm: job model, session (InputFs inputs read in chunks, outputs streamed into Blobs by
                  SinkFs), worker protocol and host, FfmpegService (worker lifecycle), probe
                  parsing, container choice, analysis, merge planning and merging, languages,
                  and the engine's MediaManager
    network/      Manifest fetcher (request context, limits, content sniffing)
    protocols/    StreamingProtocolAdapter, registry, shared cache/segment builder, codecs;
                  hls/ (HlsAdapter, playlist parsing, keys), dash/ (DashAdapter, MPD parsing, scan)
  types/          Typings for untyped dependencies (mpd-parser)
  offscreen/      Offscreen document: engine host (downloads + media), request-context leases
  workers/        Media worker: runs FFmpeg.wasm off the offscreen document's main thread
  popup/          React + Tailwind popup (components, hooks, pages)
  shared/         Constants, messaging protocol, settings, storage views, utils
  manifest/       manifest.json (version stamped from package.json at build time)
tests/
  unit/           Unit tests mirroring src/
  integration/    Detection, download and media pipelines, download demo streams
  e2e/            The built extension in Chrome for Testing (npm run test:e2e)
  fixtures/       Sample HLS/DASH manifests, the fixture site's routes and download demo,
                  media/: FFmpeg core loader for Node, synthetic media and its playlists/MPDs
  manual/         Test pages served by `npm run fixtures`
  fakes/          In-memory chrome.storage, fake media sites, task builders, crashing engine,
                  in-process FFmpeg runner, scripted FFmpeg answers, stored synthetic tasks
```

`dist/ffmpeg/` holds FFmpeg.wasm's core, copied unchanged from `@ffmpeg/core`; the media worker
loads it only when a downloaded task is merged.

## License

Copyright (C) 2026 Huỳnh Lê Tấn Thành.

StreamGrab is free software: you can redistribute it and/or modify it under the terms of the
GNU General Public License as published by the Free Software Foundation, either version 3 of the
License, or (at your option) any later version. See [LICENSE](LICENSE) for the full text
(SPDX: `GPL-3.0-or-later`).

Bundled third-party components keep their own licenses: FFmpeg.wasm (`@ffmpeg/core`) is
GPL-2.0-or-later, `m3u8-parser` and `mpd-parser` are Apache-2.0, and React, `@xmldom/xmldom` and
the other runtime dependencies are MIT.
