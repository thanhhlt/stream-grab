# Project spec: Universal Streaming Video Downloader

Original requirements for StreamGrab, kept in the repo so every phase works from the same text.
Design decisions and phase status live in [ARCHITECTURE.md](ARCHITECTURE.md).

Act as a Senior Browser Extension Engineer and Media Streaming Engineer. Build a
production-oriented browser extension that detects, downloads, and merges streaming videos from
websites using HLS and MPEG-DASH protocols. The extension must work entirely inside the browser.
No backend server, external API server, or native helper application is allowed.

## 1. Platform and technology

- Browser: Chrome / Chromium-based browsers. Extension standard: Manifest V3.
- Language: TypeScript. UI: React + TypeScript. Build tool: Vite. Styling: Tailwind CSS.
- Media processing: FFmpeg.wasm. Package manager: npm.
- Modern, maintainable TypeScript with strict type checking. Modular, extensible architecture.
  Do not couple protocol-specific logic with the download manager or UI.

## 2. Core features

### 2.1 Automatic video detection

Monitor network requests and detect streaming resources. Initially support HLS (`.m3u8`) and
MPEG-DASH (`.mpd`).

- Detect manifests loaded by the current website.
- Handle URLs containing query strings and authentication tokens.
- Do not rely exclusively on file extensions; some servers return manifests through URLs without
  recognizable extensions.
- Track the originating tab and page URL.
- Deduplicate identical manifests.
- Avoid treating individual `.ts` or `.m4s` segments as separate videos.
- Detect multiple video sources on the same page.
- Update detection results dynamically without requiring a page reload.
- Use Chrome Extension APIs appropriately under Manifest V3.

### 2.2 Multiple video selection

A website may contain multiple videos simultaneously. The popup must display all detected video
sources. Each entry shows: title or best available identifier, source website, protocol
(HLS / DASH), available resolutions, estimated duration (if available), video codec (if
available), audio tracks (if available), detection status.

Users can select an individual video, multiple videos, or all; start downloads independently;
remove detected sources from the list. Retrieve the title from page metadata or the HTML video
element when possible. Do not assume one webpage corresponds to one video.

### 2.3 Manifest parsing

Independent protocol adapters behind a common interface:

```ts
interface StreamingProtocolAdapter {
  canHandle(url: string, contentType?: string): boolean;
  parseManifest(url: string, options?: ParseOptions): Promise<StreamingManifest>;
  getAvailableVariants(manifest: StreamingManifest): Promise<VideoVariant[]>;
  getSegments(manifest: StreamingManifest, variant: VideoVariant): Promise<MediaSegment[]>;
}
```

Adapters: `HlsAdapter`, `DashAdapter`. Use established parsing libraries where appropriate.

HLS: master playlists; media playlists; multiple resolutions and bitrates; MPEG-TS segments;
fragmented MP4 segments; initialization segments; separate audio playlists; multiple audio
tracks; relative and absolute segment URLs; byte-range segments; AES-128 encrypted streams where
the user has legitimate access and valid decryption keys.

DASH: MPD manifests; static presentations; dynamic presentation detection; multiple
representations; separate audio and video adaptation sets; initialization segments; media
segments; SegmentTemplate; SegmentTimeline; SegmentList; relative and absolute URLs.

Keep the architecture ready for additional protocols. DRM-protected content (Widevine,
PlayReady) must not be bypassed: detect it and clearly report it as unsupported.

### 2.4 Download manager

Centralized, independent of UI and protocol adapters.

- Download all segments required for the selected representation; audio and video separately
  when required.
- Preserve segment ordering regardless of completion order.
- Concurrent segment downloads; configurable concurrency, default 6; user-changeable.
- Retry with exponential backoff. Handle HTTP errors and expired URLs.
- Cancellation. Track individual segment states (Pending, Downloading, Completed, Failed,
  Cancelled). Prevent duplicate downloads.
- Memory-efficient; overall and per-video progress.
- Use a controlled worker queue rather than `Promise.all` for thousands of segments.
- Do not keep all segments in memory; use IndexedDB for temporary segment storage.

### 2.5 Parallel downloading

1. Parse the manifest. 2. Build an ordered segment queue. 3. Start multiple workers.
4. Download independent segments concurrently. 5. Store results by original sequence number.
6. Retry failed requests. 7. Notify the UI of progress. 8. Start media processing after all
required segments are downloaded.

Default 6 workers, user range 1–16. Respect server limitations; more concurrency is not always
faster.

### 2.6 Media merging

FFmpeg.wasm, entirely in the browser.

- Merge MPEG-TS segments into a playable video; handle fMP4 init segments and fragments.
- Mux separate audio and video; preserve original quality; prefer `-c copy` over transcoding.
- Output MP4 when compatible; MKV (or another suitable container) otherwise. Preserve audio
  tracks where possible.
- Report processing progress; allow cancellation; clean up temporary files after success.
- Do not assume concatenating arbitrary `.m4s` files or buffers yields a valid MP4; use the
  appropriate demux/mux workflow per input format.
- Run FFmpeg.wasm in a Web Worker or other background context so the popup is never blocked.
- Handle FFmpeg.wasm memory limits carefully. Lazy-load the core only when processing is needed.

### 2.7 Download output

Chrome Downloads API. User-specified output filename; sensible defaults (e.g.
`Movie_Title_1080p.mp4`); avoid collisions; show final file size; multiple independent tasks;
clear completion notification.

### 2.8 User interface

Clean, modern popup, usable within Chrome's popup dimensions, with clear visual states for
pending, downloading, processing, completed and failed.

- Detected Videos: all detected sources with protocol and quality; individual or multiple
  selection; Download button.
- Download Queue: active downloads; progress %; downloaded/total segments; speed where
  measurable; retry and error status; cancellation.
- Completed: output filename and file size.
- Settings: maximum concurrent downloads; default video resolution; output format; automatically
  detect videos; automatically remove completed tasks from the queue.

## 3. Architecture

Suggested structure (may be adjusted when technically necessary, keeping separation of
responsibilities):

```
src/
├── background/   service-worker.ts, network-monitor.ts, message-router.ts
├── content/      content-script.ts, video-detector.ts, page-metadata.ts
├── core/
│   ├── detection/  detection-manager.ts, manifest-detector.ts
│   ├── protocols/  protocol-adapter.ts, hls/hls-adapter.ts, dash/dash-adapter.ts
│   ├── download/   download-manager.ts, download-queue.ts, segment-worker.ts,
│   │               retry-policy.ts, download-storage.ts
│   ├── media/      media-processor.ts, ffmpeg-service.ts, hls-merger.ts, dash-merger.ts
│   └── models/     streaming-manifest.ts, video-variant.ts, media-segment.ts, download-task.ts
├── popup/        components/, pages/, hooks/, popup.tsx
├── workers/      download-worker.ts, media-worker.ts
├── shared/       types/, constants/, utils/, messaging/
└── manifest/     manifest.json
```

## 4. Chrome extension requirements

Manifest V3; minimum necessary permissions; appropriate host permissions; `chrome.webRequest`
for monitoring where supported; `chrome.runtime` messaging; `chrome.storage` for settings and
task metadata; IndexedDB for temporary segments; `chrome.downloads` for output; handle service
worker suspension and recovery; never depend on popup lifetime; downloads continue when the
popup is closed. Investigate MV3 limitations and design around them.

## 5. Security and compatibility

- Do not bypass DRM, authentication or access restrictions. Only download resources accessible
  through the user's authorized browser session.
- Handle CORS and browser security restrictions explicitly.
- Do not expose authentication tokens in logs; do not store sensitive headers unnecessarily.
- Handle malformed manifests safely. Do not execute scripts obtained from websites.
- Some servers need specific headers, cookies or Referer: design a controlled request-context
  mechanism that reuses only the required authorized session context. Do not assume `fetch()`
  from the popup or service worker inherits the page's authentication context.

## 6. Performance

Avoid unnecessary allocations; streaming/chunked storage; limit concurrency; never block the UI
thread; avoid re-parsing manifests (cache metadata); clean up temporary resources; support large
videos without keeping all segments in RAM.

## 7. Development workflow

Work incrementally, never one giant code dump:

1. Project initialization and extension configuration.
2. Network monitoring and video detection.
3. HLS manifest parsing.
4. DASH manifest parsing.
5. Multiple video selection UI.
6. Download queue and concurrent segment downloading.
7. IndexedDB storage and recovery.
8. FFmpeg.wasm integration.
9. Audio/video merging and output generation.
10. Error handling, performance optimization, and testing.

After each phase: TypeScript compiles; relevant tests run; errors fixed before continuing;
explain files created/modified, architectural decisions, and remaining limitations.

## 8. Testing

Unit tests for: HLS parsing; DASH MPD parsing; relative URL resolution; segment ordering;
concurrent download scheduling; retry logic; cancellation; progress calculation; FFmpeg
processing workflows. Provide sample manifests and synthetic media fixtures.

Scenarios: (1) HLS with MPEG-TS segments; (2) HLS with fMP4 segments; (3) DASH with separate
audio and video; (4) page with multiple streaming videos; (5) manifest with multiple
resolutions; (6) failed segment requests with retry; (7) large downloads with limited memory;
(8) expired manifest URLs; (9) popup closed during download; (10) unsupported DRM-protected
streams.

## 9. Final expectations

A working Chrome extension, not a UI prototype. Priorities: correct detection; correct parsing;
reliable parallel downloading; correct merging; stable task management; clean, extensible
architecture; good UX. No mock data in place of real functionality. Do not silently ignore
unsupported formats. When a browser API limits something, explain it and implement the best
technically valid alternative.
