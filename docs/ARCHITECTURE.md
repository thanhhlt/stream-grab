# StreamGrab architecture

Living design notes. Requirements are in [SPEC.md](SPEC.md); this file records how they map onto
Manifest V3 and why.

StreamGrab is meant to handle several streaming formats and protocols. Version 0.3.0 supports HLS
and MPEG-DASH, and progressive MP4/WebM files; everything protocol-specific sits behind
`StreamingProtocolAdapter`, so further streaming formats are added as adapters (see
[Adding a streaming format](#adding-a-streaming-format)). Progressive files have no manifest and
no segments: they go through the same detection, queue, task store and popup, but are saved as
they are (see [Progressive files](#progressive-files-v030)).

## Phase status

| Phase | Scope                                              | Status |
| ----- | -------------------------------------------------- | ------ |
| 1     | Project initialisation and extension configuration | Done   |
| 2     | Network monitoring and video detection             | Done   |
| 3     | HLS manifest parsing                               | Done   |
| 4     | DASH manifest parsing                              | Done   |
| 5     | Multiple video selection UI                        | Done   |
| 6     | Download queue and concurrent segment downloading  | Done   |
| 7     | IndexedDB storage and recovery                     | Done   |
| 8     | FFmpeg.wasm integration                            | Done   |
| 9     | Audio/video merging and output generation          | Done   |
| 10    | Error handling, performance, testing               | Done   |

Version 0.3.0 (progressive MP4/WebM) was built in four further phases on top of the above:

| Phase | Scope                                              | Status |
| ----- | -------------------------------------------------- | ------ |
| 1     | Architecture analysis (reuse of the existing pipeline) | Done |
| 2     | MP4/WebM detection                                 | Done   |
| 3     | Progressive download integration                   | Done   |
| 4     | Regression testing and release                     | Done   |

Version 0.4.0 (storage and housekeeping) in four phases:

| Phase | Scope                                              | Status |
| ----- | -------------------------------------------------- | ------ |
| 1     | Analysis and Chrome spikes (OPFS, downloads into a subfolder) | Done |
| 2     | Live streams not listed; Completed *Remove all*; Downloads subfolder | Done |
| 3     | Merge output to OPFS                               | Done   |
| 4     | Regression testing and release                     | Done    |

## Execution contexts

```
 web page frame                     extension origin (chrome-extension://<id>)
┌──────────────────┐   runtime     ┌───────────────────────────┐  runtime   ┌─────────────────────────────┐
│ content script    │──messages───▶│ service worker            │──messages─▶│ offscreen document          │
│ (isolated world,  │◀─────────────│ coordinator               │◀───────────│ engine                      │
│  every http(s)    │              │ • webRequest monitor      │            │ • download manager/queue    │
│  frame)           │              │ • detections per tab      │            │ • segment fetch (no CORS)   │
│ • page metadata   │              │ • task metadata (storage) │            │ • IndexedDB segment store   │
│ • <video> titles  │              │ • DNR request context     │            │ • FFmpeg.wasm Web Worker    │
└──────────────────┘              │ • chrome.downloads        │            │ • blob: URL of the result   │
                                   │ • notifications           │            └─────────────────────────────┘
          popup (React) ──────────▶│                           │
          view only; may close     └───────────────────────────┘
          at any time
```

| Context            | Lifetime                                                       | APIs it has                          | Role                                                              |
| ------------------ | -------------------------------------------------------------- | ------------------------------------ | ----------------------------------------------------------------- |
| Service worker     | Terminated after ~30 s without events; restarted on demand     | All declared `chrome.*`              | Coordinator, single owner of persistent task state                |
| Offscreen document | Lives until closed by us                                       | `chrome.runtime` only; DOM, Workers  | Long-running engine (downloads, IndexedDB, FFmpeg)                |
| Popup              | Destroyed whenever it loses focus                              | All declared `chrome.*`              | View/controller only; never runs downloads                        |
| Content script     | Per frame, until navigation                                    | `chrome.runtime` messaging           | Page metadata; everything it sends is untrusted input             |

### Why an offscreen document hosts the engine

- The service worker is killed after ~30 s idle and cannot be relied on to keep a multi-minute
  download or FFmpeg run alive.
- Service workers cannot create dedicated Web Workers (FFmpeg.wasm requires one) or call
  `URL.createObjectURL` (needed to hand a finished file to `chrome.downloads`).
- An offscreen document created with reasons `WORKERS` + `BLOBS` has a DOM, can spawn workers,
  shares the extension origin's IndexedDB, and stays alive until we close it.
- It only gets `chrome.runtime`, so `chrome.downloads`, `chrome.storage`, `declarativeNetRequest`
  and notifications stay in the service worker; the engine requests them by message.
- Only one offscreen document may exist per extension. `ensureOffscreenDocument()`
  (`src/background/offscreen-host.ts`) checks `runtime.getContexts` and deduplicates concurrent
  creation.

### Surviving service-worker suspension

- All listeners are registered synchronously at the top level of `service-worker.ts`; Chrome
  only redelivers wake-up events to listeners present at startup.
- No state lives only in module variables. Settings and task metadata go to
  `chrome.storage.local`; per-tab detections go to `chrome.storage.session` (in memory,
  survives worker restarts, cleared on browser restart); segment bytes go to IndexedDB.
- Downloads run in the offscreen document, so closing the popup or suspending the worker does
  not interrupt them; the engine's progress messages wake the worker when it has something to
  record. If the browser itself restarts, `downloading` tasks resume on the next startup from
  the segments IndexedDB holds (see "Storage and recovery").

## Messaging

`src/shared/messaging/` defines one contract per receiving context (`BackgroundContract`,
`OffscreenContract`, `ContentContract`): message type → request/response types.

- `createMessageRouter(target, handlers)` requires a handler for every type in that context's
  contract (compile-time), ignores envelopes for other targets so the right context answers,
  ignores senders that are not this extension, and always replies with
  `{ ok: true, data } | { ok: false, error }`. Lookups use `Object.hasOwn`, so names like
  `toString` or `__proto__` are rejected.
- `sendToBackground` / `sendToOffscreen` / `sendToContent` infer payload and response types and
  turn transport failures and remote errors into `StreamGrabError`s with a code.
- `runtime.sendMessage` reaches every extension context, hence the `target` field.
- Payloads from content scripts originate in a renderer running untrusted page code. Handlers
  validate payloads at runtime (`parseDomSources`, `parseFrameMetadata`), take the tab/frame from
  the browser-provided `sender`, never from the payload, and refuse popup-only messages
  (`detections/*`) from content scripts.

## Permissions

| Permission                            | Why                                                                                          | Used from |
| ------------------------------------- | -------------------------------------------------------------------------------------------- | --------- |
| `host_permissions: http(s)://*/*`     | Observe requests on any site; fetch manifests/segments cross-origin without CORS from extension pages | Phase 2   |
| `webRequest`                          | Non-blocking observation of manifest requests, response content types and request headers    | Phase 2   |
| `declarativeNetRequestWithHostAccess` | Set `Referer`/`Origin` on the extension's own manifest/segment requests (forbidden headers for `fetch`) | Phase 2   |
| `storage`                             | Settings, task metadata, session detections                                                  | Phase 1   |
| `unlimitedStorage`                    | Multi-GB temporary IndexedDB segment storage without a fixed quota or eviction; free disk space is still checked | Phase 7   |
| `offscreen`                           | Engine host (see above)                                                                      | Phase 6   |
| `downloads`                           | Save the merged file; download progressive files and follow their progress (0.3.0)           | Phase 9   |
| `notifications`                       | Completion notification                                                                      | Phase 9   |

Deliberately not requested: `tabs` (tab URL/title are readable with host permissions),
`scripting` (the content script is declared statically), `webRequestBlocking` (unavailable to
MV3 extensions; not needed for observation), `web_accessible_resources` and
`externally_connectable` (nothing is exposed to web pages). `tests/unit/manifest.test.ts` fails if
the permission list changes, so additions are deliberate.

CSP for extension pages: `script-src 'self' 'wasm-unsafe-eval'; object-src 'self'`.
`wasm-unsafe-eval` is required to compile FFmpeg.wasm; no `unsafe-eval`, no remote code. MV3
forbids remotely hosted code, so the FFmpeg core is copied into the package (`dist/ffmpeg/`,
Phase 8). Workers started by extension pages get the same policy.

## Network access, CORS and the request context

- Extension pages, the service worker and the offscreen document hold host permissions and are
  exempt from CORS for `fetch`. Content scripts are not (they follow the page's CORS rules), so
  content scripts never fetch media.
- Requests from the extension are not the page's requests. `fetch(…, { credentials: 'include' })`
  sends the browser's first-party cookies for the target host, but not the page's `Referer` or
  `Origin`, not headers the page added in JavaScript (e.g. `Authorization`), and not partitioned
  (CHIPS) cookies keyed to the embedding site.
- Controlled request context (`src/background/request-context.ts`):
  1. `webRequest.onSendHeaders` (with `extraHeaders`, required to see `Referer`) observes media
     requests and keeps only `Referer` and `Origin`. Cookie and credential values are never
     copied; the browser attaches cookies itself.
  2. The context is stored with the detection in `chrome.storage.session` (memory only, never
     written to disk) and disappears with the tab or the browser session.
  3. While the extension fetches from a host, `RequestContextRules` installs a
     `declarativeNetRequest` session rule that sets those headers only for requests initiated by
     this extension outside any tab (`initiatorDomains: [extension id]`, `tabIds: [-1]`,
     `requestDomains: [host]`). Rules are reference-counted per host; a different context for the
     same host waits until the current rule is released, so two contexts never mix. Leftover
     rules are removed when a new service-worker instance starts. Inspection holds a rule for the
     length of one fetch; a download holds one lease per (task, host) for the whole task (see
     "Download engine"), re-acquired after a worker restart.
  4. Streams found in the DOM (no request seen yet) get the Referer the element's own request
     would carry under the default referrer policy; a real network observation replaces it.
- Logging goes through `createLogger`, which redacts URLs (query values, credentials, fragments,
  token-like path segments) and masks credential-like keys. See `src/shared/utils/redact.ts`.

## Detection pipeline (Phase 2)

```
webRequest.onSendHeaders ──▶ Referer/Origin by requestId (bounded map)
webRequest.onResponseStarted (xhr, media, other) ──▶ classifyResponse ──▶ DetectionManager
content script: <video>/<source> manifests ──▶ content/domSources ──▶ DetectionManager
                                                                          │
                ManifestFetcher (SW fetch + DNR context) ◀── inspect ─────┤
                page metadata (content script, retried) ◀── title ────────┤
                chrome.storage.session  detections:<tabId> ◀── persist ───┘──▶ popup (live), badge
```

1. **Classification** (`core/detection/manifest-detector.ts`, pure). Signals, strongest first:
   HLS/DASH Content-Type (works for extensionless URLs); a Content-Type that rules a manifest out
   (`video/mp2t`, `video/mp4`, images, HTML, JSON…); `.m3u8`/`.m3u`/`.mpd` path extension (query
   strings and tokens ignored); format hints in the URL (`manifest(format=m3u8-cmaf)`,
   `?url=…/x.m3u8`); manifest keywords with a generic Content-Type → *probe*. Segment, key,
   subtitle and asset extensions are never manifests; WebVTT files are *subtitle* (page subtitle
   files, see Subtitles). Only `GET` 2xx/304 responses of type
   `xmlhttprequest`/`media`/`other` from tab documents are considered; requests without a tab
   (including the extension's own) are skipped.
2. **Probing.** A probe fetches the body and lists the URL only if it is an HLS playlist or an
   MPD. Negative results are cached per URL *shape* (digits collapsed), so the segments of one
   stream are probed once; at most 40 probes per page load.
3. **Inspection** (`manifest-inspector.ts`, `stream-inspector.ts`). Every new manifest is
   fetched once (3 at a time, 15 s timeout, 16 MiB cap, abandoned after the first 4 KB if the
   body is not a manifest) and its protocol confirmed from the content. The body then goes to
   that protocol's adapter, chosen through the `ProtocolRegistry` (reusing the downloaded body;
   see below). For HLS it classifies master vs media playlists, lists the child playlists and
   reads the first variant for live state, duration and keys; for DASH it parses the whole MPD.
   Both yield a media summary (qualities, codecs, audio tracks, duration) for the popup. AES-128
   with an identity key is recorded as supported encryption, not DRM.
4. **Deduplication and grouping** (`detection-manager.ts`). Streams are keyed per tab by
   `dedupeKey` (URL without signed-URL tokens, expiry stamps and cache busters); a re-request
   updates the URL and context to the freshest ones. Variant and rendition playlists of an
   inspected master are removed from the list and ignored afterwards, whichever order they
   arrive in, so a player loading 1 master + N playlists shows one video.
   **Live manifests are not listed** (0.4.0, see *Version 0.4.0* below): a live player reloads
   its playlist every few seconds, often with a query `dedupeKey` keeps.
5. **Statuses.** `pending` → `ready` | `drm` (never downloaded, reason shown) | `error` (HTTP
   status explained; retried when the page requests the manifest again with a new URL or
   context, e.g. a re-signed link). Bodies that turn out not to be manifests are dropped.
6. **Lifecycle.** A top-frame navigation (main-frame response, prerenders excluded) bumps the
   tab's generation and clears its list; results of work started earlier are discarded. Closed
   tabs are forgotten. Removed streams stay hidden until the next navigation. Writes are
   debounced (100 ms) and chained per tab; `pending` streams found after a worker restart are
   re-inspected.
7. **Titles** (`stream-title.ts`). Exact element title for `<video src>` sources; otherwise the
   frame's only `<video>` title, JSON-LD `VideoObject` name, `og:title`, the frame's document
   title (embedded players usually title it after the video), then the top page and the tab.
   Generic titles ("Player", "Video") are skipped. Content-script data is validated and bounded.
8. **Settings.** With automatic detection off, the media listeners are removed (Chrome stops
   waking the worker for every XHR); navigation tracking stays on.

Testing: unit tests per module, plus `tests/integration/detection-pipeline.test.ts`, which
replays the fixture site through the real classifier, fetcher, inspector and manager. The same
site runs locally for manual checks with `npm run fixtures` (see README).

## Protocol adapters and HLS parsing (Phase 3)

```
core/protocols/protocol-adapter.ts   StreamingProtocolAdapter, ParseOptions, SegmentOptions, ProtocolRegistry
core/protocols/manifest-cache.ts     shared parse cache (TTL decided per value, aliases, per-caller abort)
core/protocols/segment-builder.ts    shared ordered segment list with init-section handling
core/protocols/manifest-values.ts    shared validators for parser output (numbers, byte ranges, containers)
core/protocols/codecs.ts, drm.ts     codec kinds/names, DRM descriptions
core/protocols/hls/hls-adapter.ts    HlsAdapter: fetching, caching, DRM guard, track selection
core/protocols/hls/hls-playlist.ts   pure: m3u8-parser output → VideoVariant / AudioTrack / MediaSegment
core/protocols/hls/hls-keys.ts       pure: DRM key formats, IVs, key URIs
core/protocols/dash/                 DashAdapter, dash-mpd (pure normalisation), dash-scan (raw XML: live, DRM)
core/network/manifest-fetcher.ts     shared fetcher (request context, size cap, timeout, sniffing)
core/models/                         StreamingManifest, VideoVariant, AudioTrack, MediaSegment
```

- **Interface.** As in the spec: `canHandle`, `parseManifest`, `getAvailableVariants` (best
  first: resolution, then bandwidth; audio-only last), `getSegments`. `getSegments` takes an
  optional `{ audioTrackIds, signal }` (default: the variant's default audio track) and returns
  one flat list where every segment carries its `trackId`/`trackType` and its `index` within the
  track, so output order never depends on download order. The download manager (Phase 6) only
  sees this protocol-independent model; `ProtocolRegistry` picks the adapter by URL, Content-Type
  or protocol, so DASH (Phase 4) only has to register.
- **Library.** `m3u8-parser` (video.js/VHS) parses the playlist syntax, including implicit
  byte-range offsets, `EXT-X-MAP`, keys and `EXT-X-DEFINE`. Everything taken from it is
  validated (numbers, strings, sizes) because playlists are untrusted, and URLs are resolved
  against the playlist's **final** (post-redirect) URL with only http(s) accepted. Two gaps of the
  library are covered by our own code: it drops `EXT-X-SESSION-KEY` (where a multivariant
  playlist declares FairPlay), so DRM is detected by scanning the raw key tags; and some numeric
  attributes arrive as strings.
- **What is extracted.** Multivariant: variants (bandwidth, average bandwidth, resolution, frame
  rate, codecs split into video/audio, audio-only detection), audio renditions (group, name,
  language, default, playlist or muxed when it has no URI), I-frame playlists. Media: segments
  with duration, media sequence, discontinuity sequence, byte range, container (`EXT-X-MAP` →
  fMP4; otherwise by extension: TS, packed audio), init segments (emitted once before the first
  media segment that needs them and again when `EXT-X-MAP` changes), live state, total duration.
- **Encryption.** AES-128 and SAMPLE-AES with `KEYFORMAT=identity` produce per-segment
  `{ method, keyUrl, iv }`; the IV is the explicit one or, per RFC 8216 §5.2, the media sequence
  number as a 128-bit big-endian integer. Key URIs may be http(s) or inline `data:`. The
  download engine fetches keys and decrypts AES-128 segments (WebCrypto AES-CBC); SAMPLE-AES is
  refused when queuing, since it encrypts inside the media samples.
- **DRM guard.** Any non-identity key format (FairPlay, Widevine, PlayReady, Clear Key, unknown)
  marks the manifest as DRM-protected; `getSegments` then throws `DRM_PROTECTED` instead of
  returning segments, also when only a media playlist declares the key.
- **Requests.** Playlists are fetched through the shared fetcher, so the page's Referer/Origin
  are replayed (DNR) for every playlist, not just the first. Parsed playlists are cached per URL
  (and per post-redirect URL): 5 min for VOD and multivariant playlists, half a target duration
  for live ones, at most 64 entries. A caller's abort signal stops only that caller from waiting;
  the shared request keeps going for others. Detection hands its already-downloaded body to the
  adapter (`prefetched`), so the master is not downloaded twice.
- **Errors.** `MANIFEST_UNAVAILABLE` (HTTP status explained, e.g. expired links),
  `MANIFEST_INVALID` (malformed, over limits: 200 000 segments, 200 variants, 100 audio
  tracks), `DRM_PROTECTED`, `UNSUPPORTED` (e.g. `skd:` key URIs, unknown methods, foreign
  variants or audio tracks). A multivariant playlist whose first variant cannot be read is still
  described (no duration).
- **Live.** Live playlists are parsed and `getSegments` returns the current window, with
  `isLive` set; detection does not list them (0.4.0) and the engine refuses them. Whether to record live
  streams is a later decision, not a parser concern.

## DASH parsing (Phase 4)

- **Library.** `mpd-parser` (video.js/VHS, XML via `@xmldom/xmldom`, both pure JS so they run in
  the service worker) expands SegmentTemplate (`$Number$`, `$Time$`, `$RepresentationID$`,
  `$Bandwidth$`, width formats such as `%05d`), SegmentTimeline (including `r` repeats),
  SegmentList (media URLs or `mediaRange` byte ranges, `Initialization` by URL or range),
  BaseURL inheritance and relative/absolute resolution, and joins Periods by
  `Representation@id`. It ships no typings; `src/types/mpd-parser.d.ts` declares the parts used,
  all optional, and `dash-mpd.ts` validates every value like the HLS side does.
- **Raw-XML scan** (`dash-scan.ts`) is the authority for two facts: `MPD@type="dynamic"` (the
  parser's top-level `endList` is `true` even for dynamic MPDs) and `ContentProtection` (DRM
  systems by scheme UUID; a bare CENC marker counts as DRM).
- **Hardening.** MPDs with `<!DOCTYPE`/`<!ENTITY` are refused (no DTD is ever needed; rules out
  entity-expansion tricks). Segment, representation and audio-track counts are capped like HLS.
- **Model mapping.** Each video Representation becomes a `VideoVariant` (`dash.representationId`;
  duplicates created by several BaseURLs are dropped). Each audio AdaptationSet becomes one
  `AudioTrack`: named by `Label`, or language plus role ("fr (dub)"); default from role `main`;
  its highest-bandwidth Representation is used; the codec is kept per track. An audio-only MPD
  turns its audio tracks into audio-only variants. Text adaptation sets are ignored.
- **Segments.** The shared `SegmentListBuilder` emits the initialization segment before the first
  media segment that needs it and again at each Period whose initialization differs; a change of
  timeline (Period boundary) increments the discontinuity counter. Containers come from the URL
  (fMP4 by default, WebM, TS). `getSegments` adds the default audio track unless the
  representation already carries audio (its codecs include an audio codec).
- **SegmentBase** (on-demand profile: one indexed file per representation): the parser lists no
  segments, only the `sidx` location. Such a representation is returned as **one segment: the
  whole file**, which is a complete MP4 on its own. The download manager, not the parser, splits
  it into ranged requests for parallel download.
- **Dynamic MPDs.** Parsed with the current wall clock, so the segment window is "now"; cached
  only until the next `minimumUpdatePeriod` (1–5 s), so each `getSegments` sees a fresh window.
  Detection does not list them (0.4.0); downloading live streams is not supported yet.
- **Caching and requests** work as for HLS (shared `ManifestCache`, post-redirect aliases,
  `prefetched` body from detection, page request context replayed): one MPD is fetched and
  parsed once for detection, variant listing and segment lists of every representation.

## Adding a streaming format

HLS and DASH are the two streaming formats in 0.3.0; the rest of the pipeline is written against
the protocol-independent model (`StreamingManifest`, `VideoVariant`, `MediaSegment`). A new
streaming format or protocol touches these places:

1. **Protocol id.** Add it to `STREAMING_PROTOCOLS` in `core/models/detected-stream.ts`. Stored
   detections, stored tasks and engine messages validate against `MEDIA_PROTOCOLS`, which is the
   streaming protocols plus `progressive` (0.3.0: plain files, no adapter; see
   [Progressive files](#progressive-files-v030)).
2. **Detection.** Teach `core/detection/manifest-detector.ts` its MIME types
   (`classifyMimeType`), file extensions (`MANIFEST_EXTENSIONS`, `protocolFromUrl`) and URL
   keywords; `core/protocols/sniff.ts` (`sniffManifest`) how to recognise it by its first bytes;
   and `core/detection/manifest-inspector.ts` (`inspectManifest`) how to summarise it for the
   popup. The content script (`content/video-detector.ts`) recognises `hls`/`dash` manifests and
   progressive MP4/WebM files from a `<source type>` or the URL (`parseDomSources` validates them).
3. **Adapter.** Implement `StreamingProtocolAdapter` under `core/protocols/<format>/`, reusing
   `ManifestCache`, `segment-builder` and the shared fetcher, and register it in both registries:
   `background/detection-service.ts` (detection) and `offscreen/offscreen.ts` (download engine).
4. **Segments and merging.** Segments carry a `ContainerFormat` (`mpeg-ts`, `fmp4`, `webm`,
   `packed-audio`); a new segment container needs handling in `core/download/track-layout.ts`
   and `core/media/merge-plan.ts`. Formats whose media is not split into segments can still be
   expressed as byte ranges of one file, as DASH SegmentBase already is.
5. **Protocol-specific defaults.** `defaultAudioTracks` in `core/download/variant-choice.ts`
   and the protocol title in `popup/components/StreamCard.tsx` distinguish HLS from DASH.
6. **Tests and fixtures.** Sample manifests under `tests/fixtures/manifests/<format>/`, adapter
   unit tests, and cases in the detection and media pipeline tests; add the format to the
   fixture site (`npm run fixtures`) when it can be served locally.

Then list it under *Supported formats* in the README and in the changelog.

## Selection UI and download tasks (Phase 5)

```
popup ── downloads/start {requests} ──▶ service worker: TaskService
                                            │ stream still listed? ready, not DRM, not live?
                                            │ parse manifest (adapter cache) → quality + audio tracks still offered?
                                            │ sanitise + uniquify the file name
                                            ▼
                         chrome.storage.local "tasks" (queued)   chrome.storage.session "taskContexts"
popup ◀── storage change events ── Queue tab, tab count
```

- **Detected tab.** Each stream has a checkbox; it is enabled only when the stream can be
  downloaded (ready, not live, not DRM, parsed media), otherwise its tooltip says why.
  "Select all" is tri-state over the downloadable streams; selections of streams that vanish or
  become unavailable drop out by themselves. Each card has a quality selector, an
  "Audio: English ▾" toggle that expands into the audio tracks offered for that quality
  (several may be ticked) and the file name with the extension that the output format implies,
  and its own Download button; "Download selected (n)" queues the selection, each with its own
  choice (layout since 0.2.0, see [Popup progress, estimates and layout](#popup-progress-estimates-and-layout-v020)).
- **Defaults** (`core/download/variant-choice.ts`): the preferred resolution from Settings, or
  the nearest lower one (the smallest when all are taller); audio-only variants only when
  nothing else exists. Audio: the quality's default track, none for a DASH representation that
  already carries audio. Name: `Title_Words_1080p`. Changing quality resets audio and the name,
  unless the user edited the name.
- **Validation in the service worker** (`core/download/task-service.ts`). The popup sends IDs,
  not URLs. Each request is checked on its own and refused with a reason when the stream is no
  longer listed, still being inspected, DRM-protected, live, or its link expired (the manifest
  is re-parsed through the adapter, normally from cache), or when the chosen quality or audio
  track is no longer offered. Variant IDs are positions in the manifest, so if the manifest
  changed the variant with the same resolution and bandwidth is used. Requests are validated as
  untrusted input (`parseDownloadRequests`) and accepted only from extension pages.
- **File names** (`core/download/file-name.ts`): characters Windows/Chrome reject, control
  characters, leading/trailing dots and spaces are removed, device names (`CON`, `nul.txt`) are
  renamed, length is capped at 120 characters without splitting a character; letters of any
  script are kept. Names are unique among active tasks (`_2`, `_3`, case-insensitive). The
  extension is `.mp4` (`auto`, `mp4`) or `.mkv`; `auto` may still become `.mkv` when merging.
- **Tasks** (`core/models/download-task.ts`, `core/download/task-store.ts`). A task records the
  source (protocol, manifest URL, title, page, stream), the selection (variant, label,
  resolution, audio tracks, duration) and the output (name, format), with status `queued`.
  Tasks live in `chrome.storage.local` (they must survive restarts for Phase 7), capped at 500
  with the oldest finished ones dropped first. The page's Referer/Origin for each task stays in
  `chrome.storage.session` and is never written to disk. The service worker is the only writer;
  writes are serialised; the popup only reads and follows change events. Queued and finished
  tasks can be removed; running ones must be cancelled first.
- **Duplicates.** A request is refused when an active task already downloads the same video
  (manifest URL without token-like parameters), quality and set of audio tracks; once that task
  failed or was cancelled the video can be queued again.

## Download engine (Phase 6)

```
popup ── downloads/start|cancel|retry|remove ──▶ service worker: DownloadCoordinator
                                                   │ tasks in chrome.storage.local (status, progress)
                                                   │ pump(): queued → downloading, oldest first, ≤ "simultaneous downloads"
                                                   ▼
          engine/sync {tasks}, engine/cancel ──────▶ offscreen document: DownloadManager
          ◀── engine/report (progress, outcome)       plan: manifest → quality → segments (protocol adapters)
          ◀── engine/acquireContext/releaseContext    worker pool ("parallel segments") → SegmentFetcher
          ◀── engine/freshSource                      → IndexedDB "streamgrab-segments"
```

- **Roles.** The service worker owns task state and is the only writer of the task store; the
  engine (`src/offscreen/offscreen.ts` hosting `core/download/download-manager.ts`) owns the
  transfers and keeps nothing the worker needs. `pump()` is serialised: it moves queued tasks
  to `downloading`, oldest first, up to "simultaneous downloads" (Settings, 1–4, default 2),
  creates the offscreen document when something runs and closes it when nothing does, then sends
  `engine/sync` with every task that should run. The engine converges on that list: it starts
  missing tasks and aborts ones no longer listed. A restarted worker re-sends the same list, so
  nothing runs twice.
- **Reports.** The engine reports progress at most every 500 ms per task, and once with the
  outcome (`downloaded`, `failed` with a message, `cancelled`). The coordinator ignores reports
  for tasks that are no longer `downloading` (cancelled or removed meanwhile), stores the rest,
  and pumps the next queued task when one ends. Engine messages are accepted only from the
  offscreen document's URL.
- **Planning.** The engine re-reads the manifest (fresh fetch with the task's request context),
  finds the chosen quality by ID, or by resolution and bandwidth if positions moved, and refuses
  DRM, live streams, SAMPLE-AES and a quality that disappeared. The video and every selected
  audio track form one segment list; each segment keeps its track and index, so storage order
  never depends on download order.
- **Concurrency** (`download-queue.ts`). A bounded worker pool: N workers ("parallel segments",
  1–16, default 6) pull from a shared cursor, so at most N requests per task are in flight and
  memory does not grow with the number of segments. The first fatal error aborts the others.
- **Retries** (`retry-policy.ts`). Network errors, stalled bodies (30 s without data), HTTP 408,
  425, 429 and 5xx are retried, up to 5 attempts, with exponential backoff (1 s base, 30 s cap,
  "equal jitter"); `Retry-After` is honoured up to 60 s. Other 4xx responses, invalid data and
  storage errors fail the task at once, naming the segment ("Segment 88 of 150 failed after 5
  attempts: Server error (HTTP 500)").
- **Expired links.** HTTP 401/403/404/410 on a segment or key means the signed URL or session
  expired. The engine asks for a fresh source (`engine/freshSource`): the newest detection of
  the same video (same URL without token parameters) with its request context, which also
  replaces the task's stored URL and context. It re-plans from it and continues; at most 2
  refreshes per task. Without a fresh detection the task fails with "The video link expired or
  access was denied. Play the video again on its page, then press Retry."
- **Request context.** The offscreen document has no DNR API. `ContextLeases` asks the worker
  for a lease on the first request to each host of a task (`engine/acquireContext`) and
  releases them when the task ends: a few messages per download, not two per segment. The
  worker drops all rules when it restarts, so on startup it asks a running engine to re-acquire
  (`engine/reacquireContexts`).
- **Transfer** (`segment-fetcher.ts`). Response bodies are streamed and written to IndexedDB in
  8 MiB parts, so a large segment never sits in memory whole. Byte-range segments use `Range`; a
  server that answers 200 with the whole file is sliced locally. A SegmentBase file (one segment
  for a whole representation) is probed with `Range: bytes=0-0` for its size and split into
  16 MiB ranged chunks downloaded in parallel; if the server does not support ranges it is
  downloaded as one stream.
- **AES-128** (`aes.ts`). Keys are fetched once per URL per task (`data:` URIs decoded inline),
  must be 16 bytes, and are imported into WebCrypto; segments are decrypted with AES-CBC and the
  playlist's IV. Encrypted segments are buffered whole (WebCrypto has no streaming CBC), capped
  at 256 MiB. Keys are never logged or stored.
- **Storage** (`download-storage.ts`). Object store `parts`, key
  `[taskId, trackId, index, part]`, value a Blob plus its size, index `byTask`. Phase 6 started
  every run from scratch; since Phase 7 runs resume from completed segments and a full disk
  stops a task cleanly (see "Storage and recovery"). Cancel and remove delete a task's data.
- **Stopping.** The worker closes the offscreen document as soon as nothing is running, which
  kills whatever the engine is still doing. So `engine/cancel`, and an `engine/sync` that stops
  tasks, answer only after those tasks have stopped, deleted their parts and released their
  rules (at most 15 s). A lease still queued behind another context's rule does not hold a
  stopping task up: it is released when granted, and the worker drops any rule granted to a
  task that is no longer downloading, and every remaining rule when it closes the engine.
- **Progress** (`progress.ts`). Percent = completed segments / total, floored to 0.1 % so 100 %
  appears only when done; bytes stored; speed over a 5 s sliding window; retries. The Queue tab
  shows each task and the sum over running ones.
- **Statuses.** `queued → downloading → downloaded` (all segments stored; media processing,
  Phases 8–9, adds `processing → completed`), or `failed` / `cancelled`. Cancel stops a running task and
  deletes its data; Retry re-queues failed and cancelled tasks (a failed one continues from its
  stored segments, Phase 7); Remove deletes queued and finished tasks with their data.

## Storage and recovery (Phase 7)

```
IndexedDB "streamgrab-segments", version 2 (offscreen engine writes; service worker reads and cleans up)
  parts     [taskId, trackId, index, part] → Blob + size     index byTask   segment bytes (Phase 6)
  segments  [taskId, trackId, index]       → bytes, parts    index byTask   completion markers
  plans     taskId                         → signature, segmentsTotal,      what the stored segments belong to
                                             layout (Phase 8)               and how each track fits together
```

- **Completion markers** (`download-storage.ts`). Parts are written while a segment streams in;
  its marker only after the last part is stored. Parts alone never prove a segment complete. A
  segment counts as complete when its marker exists and exactly parts 0…n−1 are stored (checked
  with a key cursor, so the Blobs are not touched). Parts without a marker (a write cut off by a
  crash) and markers whose parts are missing are deleted, and those segments are fetched again.
  Retrying a segment deletes its marker and parts in one transaction.
- **Plan signature** (`planSignature()` in `download-manager.ts`). A hash of the segment list's
  shape: track, position, kind, byte range, duration. URLs are left out, since re-signed links
  change them and the video stays the same. A run whose signature matches the stored plan reuses
  the stored segments. Otherwise the task's data is replaced by an empty plan in one transaction,
  and the run starts over: the server published another version, and two versions must not be
  mixed. A version change found mid-run (manifest refresh) fails the task and discards its data,
  as in Phase 6. The size probe that splits single-file representations into ranges retries
  transient errors instead of falling back to one segment, because a different split changes
  the plan and would discard the stored chunks.
- **Every run resumes**: Retry, an engine restarted by the service worker, a browser restart.
  Failed runs keep their segments, so Retry continues where they stopped. Cancel and Remove
  delete them. A run that finds the video changed deletes them too.
- **Truthful progress.** Reused segments count as done, and their bytes as stored, but never as
  received bytes, so the speed stays real. Reports carry `resumedSegments`. Until the engine
  confirms, the coordinator shows what storage holds (markers and plan, read in the service
  worker), marked `stale` and with no speed. This covers a retried task waiting for a slot and
  tasks interrupted by a restart. Queue lines:
  - waiting: "Waiting for a free download slot · 30 / 240 segments already downloaded"
  - before the engine checked: "Resuming · 54 / 120 segments already downloaded"
  - running: "62.5% · 150 / 240 segments (96 reused) · 113 MB · 2.4 MB/s"
  - failed: "36.6% · 88 / 240 segments kept · 66 MB"

  A run that fails before it has read its segment list keeps showing what is stored, not
  "0 / 0".
- **Browser restart.** Tasks (`chrome.storage.local`) and segments (IndexedDB) survive. The
  request context (Referer/Origin in `chrome.storage.session`) does not, by design. On startup
  without an engine, the coordinator treats `downloading` tasks as interrupted: their progress
  becomes what storage holds, then the queue resumes. If a task's context is missing
  (`TaskStore.findContext()` → undefined, while every task gets one, possibly empty, when it is
  created), the coordinator looks for the same video among current detections. It checks the
  task's own tab first, then any open tab: stream IDs come from the URL without tokens, so they
  are the same in every tab, while tab IDs change after a restart. If it finds the video, it
  adopts its URL, tab and context. If not, it tries the stored link without a context, since
  many CDNs do not check the Referer. If that link fails as expired (reason `expired`), the task
  fails with "The browser (or the extension) restarted since this download began, and the video
  now needs its page again: play the video on its page, then press Retry…" and keeps its
  segments. Once the page has played the video again, Retry picks up the new detection and
  continues. When the stored link of a task expired before a run, the engine asks for a fresh
  source once (`engine/freshSource`, which also searches every tab) before giving up. Reloading
  or updating the extension behaves the same: it clears session storage and closes the
  offscreen document.
- **Orphans.** Data whose task was removed, cancelled or completed: queued, downloading,
  downloaded, processing and failed tasks keep theirs. `DownloadCoordinator.cleanup()` first
  lists the task IDs present in IndexedDB (one `nextunique` key-cursor step per task and store),
  then reads the task store, then deletes. Because storage is read first, a task created in
  between cannot be taken for an orphan. Because cleanup runs serialised with `pump()`, no task
  starts writing between the reads and the deletes. Cleanup runs at service-worker startup and
  whenever `pump()` finds nothing to run and closes the engine, which catches cancel cleanups
  that hit the 15 s limit.
- **Disk space** (`storage-space.ts`). With `unlimitedStorage` the origin has no fixed quota and
  its data is never evicted. Chrome then reports a quota of about usage + free disk, minus a
  margin it keeps. `SpaceGuard`, shared by all tasks of the engine, works like this:
  - It checks before each run (fresh `navigator.storage.estimate()`) and after each stored
    segment, and stops while 256 MiB are still free. It re-reads the estimate every 64 MiB
    written or every 15 s, and subtracts the bytes written since locally.
  - The failure has reason `disk-full` and the message "Not enough disk space to continue
    (200 MB free). Free up disk space, then press Retry: the download continues where it
    stopped." The segments are kept.
  - A `QuotaExceededError`, or any write error while the disk is nearly full (Chrome may report
    a full disk as `UnknownError`), gets the same message.
  - Queued tasks that start meanwhile fail at their pre-check, before any request. "Retry all
    failed" in the Queue tab re-queues them all at once.
  - The Queue tab shows the downloaded data and the free space, and warns below 512 MiB.
- **Schema upgrade.** A version 1 database (Phase 6) gains the two stores. Its parts have no
  markers, so a task interrupted under Phase 6 downloads again (and orphaned Phase 6 data is
  cleaned up).
- **Failure reasons.** Failed outcomes in `EngineReport` carry `reason: 'expired' | 'disk-full'`,
  so the coordinator words them (context lost) without matching message text.

Testing: `tests/unit/core/download/download-storage.test.ts` (markers, inspection, reset,
orphan listing, v1 upgrade), `storage-space.test.ts`, `progress.test.ts`,
`download-manager.test.ts` ("resume", "disk full": Retry, a crashed engine with cut-off writes,
another video version, size-probe retries), `download-coordinator.test.ts` ("resume and
recovery": carried progress, lost contexts, cleanup), and
`tests/integration/download-pipeline.test.ts` "across a browser restart". There, the first
browser session's engine is crashed mid-download (`tests/fakes/crash.ts`), and a second session
starts on the same `chrome.storage.local` and IndexedDB with an empty session area. One case
checks that the download resumes without fetching a stored segment twice, never shows less than
what was stored, and that orphaned data is deleted. The other checks that a Referer-protected
stream fails with the restart message and then completes once the video is detected again.
Storage deletes are slowed down there, as in Phase 6.

## Media processing with FFmpeg.wasm (Phase 8)

```
service worker: DownloadCoordinator
  downloaded ──▶ processing ── engine/sync {downloads, media: [{taskId, job: 'process', format, title}]}
                                                    │
offscreen document: Engine = DownloadManager + MediaManager
  MediaManager ── analyseTask ── IndexedDB: plan.layout, completion markers, track Blobs (references, no copies)
       │
       ▼  FfmpegService (main thread)  ── postMessage {run, coreUrl, job: tool, args, input Blobs} ──▶
  workers/media-worker.js (module worker)
       MediaWorkerHost → import('/ffmpeg/ffmpeg-core.js') once → FfmpegSession
         InputFs /in (mounted Blobs, read in 4 MiB chunks)   SinkFs /out (merge → OPFS file; else Blob parts)
       ◀── started / progress / done {stdout, stderr tail, output Blobs} / failed {kind}
  ◀── engine/mediaReport (stage, step, percent; outcome failed | cancelled)
  ── engine/save (merged file, Phase 9) ──▶ service worker
```

- **Package.** `@ffmpeg/core` 0.12.10 (exact pin; FFmpeg 5.1, single-threaded build: no
  `SharedArrayBuffer`, so no COOP/COEP headers, and stream copy is I/O bound anyway). The
  `streamgrab:ffmpeg-core` Vite plugin (`build/ffmpeg-core-plugin.ts`) copies `ffmpeg-core.js`
  (112 KB) and `ffmpeg-core.wasm` (32 MB) unchanged into `dist/ffmpeg/`; they are not bundled.
  `@ffmpeg/ffmpeg`, the wrapper, is not used: its default core URL points at a CDN (remote code)
  and its worker hides the parts we need (WORKERFS mounts, chunked output reads, abort
  semantics). The core's Emscripten build runs only in Web Workers and caps its heap at 2 GiB.
- **Lazy loading.** Nothing FFmpeg-related runs until a task needs processing. `FfmpegService`
  starts `workers/media-worker.js` (6 KB, built by Vite from `new Worker(new URL(…), { type:
  'module' })` in `offscreen.ts`) with the first command; the worker imports the core from the
  extension URL it is given (only same-origin URLs are accepted) on its first command and keeps
  it for the next ones. The worker is terminated after 10 s without commands, which is the only
  way to give the WebAssembly heap back (Emscripten heaps only grow); the offscreen document
  itself closes when no download and no processing is left.
- **Commands** (`ffmpeg-job.ts`, `ffmpeg-session.ts`). A job is one `ffmpeg` or `ffprobe`
  command with named input Blobs and output names. Inputs are mounted read-only (WORKERFS until
  Phase 10, now InputFs, which reads larger chunks)
  under `/in`: FFmpeg reads them on demand through `FileReaderSync`, so a multi-GB track is never
  copied into the heap. Outputs are written to `/out` (SinkFs, Phase 9; Phase 8 used MEMFS): to
  a file on disk in OPFS when the job names one (`outputFiles`, the merge since 0.4.0), otherwise
  streamed into Blob parts. Every command unmounts its inputs and clears `/out`, and its
  logger/progress handlers are scoped to it. Names, argument counts and input counts are
  validated. Behaviour of the core that was checked rather than assumed: `exec()` returns 0/1
  and calls `onAbort("")` after every run; `ffprobe()` always returns −1, so its stdout (JSON)
  and stderr are the result; an instance survives failed commands and timeouts.
- **One command at a time.** FFmpeg's `exec()` is synchronous: the worker cannot even receive
  messages while it runs. `FfmpegService` serialises commands; aborting one, its timeout (the
  core's own timer first, then a watchdog 5 s later), a load that takes over 2 minutes, a crash
  or running out of memory **terminate the worker**. Any FFmpeg failure discards the instance; the
  next command starts a fresh worker.
- **Memory.** Out-of-memory shows up as an abort reason ("OOM"), a `RangeError` from
  `Memory.grow`, "Cannot allocate memory" in FFmpeg's log, or "memory access out of bounds".
  All become `FfmpegError` kind `memory` with "FFmpeg ran out of memory. The browser gives it at
  most 2 GB…"; the downloaded segments are kept for Retry. Other kinds: `load`, `timeout`,
  `crashed`, `invalid-job`, each worded for the Queue tab (`describeFfmpegFailure`).
- **Task lifecycle.** `downloaded → processing → completed` (Phase 8 stopped after the
  analysis). The coordinator hands downloaded tasks to the engine one at a time
  (`MEDIA_SLOTS = 1`: FFmpeg's heap can take 2 GB), oldest first,
  in the same `engine/sync` as downloads, so processing runs alongside downloads and a restarted
  worker converges the same way. Cancel stops FFmpeg (worker terminated) and deletes the data.
  After a browser restart, `processing` tasks go back to `downloaded` and are processed again.
  Retry of a failed task re-queues it: its download run reuses every stored segment.
- **Track layout.** Media processing must not depend on the manifest (its link may have expired)
  and URLs never go to IndexedDB, so the download manager saves each track's layout with the
  plan: segment count, positions of init segments and discontinuities, container, duration,
  audio track name and language (`core/download/track-layout.ts`). A plan stored by Phase 7
  gets its layout on the next download run (all segments reused); analysing a task without one
  fails with "downloaded by an earlier version… press Retry".
- **Analysis** (`analyseTask`, `media-analysis.ts`). Checks that storage holds every segment
  of the layout (markers and parts, and that the Blob sizes add up), builds each track as one
  Blob of its stored Blobs in output order (references: no bytes are read or copied), and runs
  `ffprobe -show_format -show_streams -of json` on it. Result per track: demuxer, duration,
  bytes, segments, streams (codec, profile, resolution, frame rate, channels, sample rate,
  language; cover art is not video). Then the output container (`containers.ts`): `auto` → MP4
  when every audio/video stream can be stream-copied into MP4 (H.264, HEVC, AV1, VP9, MPEG-4/2,
  AAC, MP3, MP2, AC-3, E-AC-3, Opus, ALAC; checked against this FFmpeg build: VP8 and Theora are
  refused, FLAC is "experimental", Vorbis is written but players ignore it), otherwise MKV with
  the reason; `mkv` always; `mp4` fails clearly when re-encoding would be needed.
- **Failures and data.** Data FFmpeg cannot read as media (an HTML error page answered with 200
  instead of segments), an audio track without audio, or Blob sizes that do not add up: the task
  fails and its data is **discarded** (`discardedData`), so Retry downloads it again. Missing
  segments, an old plan, FFmpeg load/memory/crash errors and a refused forced MP4 keep the data.
- **Progress.** Stages `waiting` (set by the service worker), `preparing`, `loading` (only
  while FFmpeg loads), `analysing` with step/steps and the audio track's name; new stages and
  steps are always reported, finer updates at most every 250 ms. The Queue tab shows a bar and
  "Loading FFmpeg…" / "FFmpeg is checking "English" (2 of 2)…"; once the file is handed over,
  "H.264 640×360 · English: AAC stereo → MP4", and the output name takes the chosen extension.
  Overall percentage: analysis 0–10, merge 10–95, check 95, saving 97.
- **Measured** (Chromium, production bundle under the extension CSP, 8-minute demo stream): the
  first analysis including loading FFmpeg took about 0.2 s on a fast machine; a download of 241
  segments plus analysis less than a second from localhost.

Testing. The real core runs in Node for tests (`tests/fixtures/media/node-core.ts`: it gets
`self.location` and a `FileReaderSync` that reads `SyncBlob`, the only Node stand-in; WORKERFS,
commands and output collection are the production code). Synthetic media
(`tests/fixtures/media/synthetic-media.ts`) is generated by the same core in about a second: a
test pattern with a frame counter and a beep, encoded once per rendition (H.264/AAC) and repeated
with `-stream_loop` and stream copy into MPEG-TS (video-only, audio-only, muxed) and fMP4 (init +
fragments) segments, with playlists and SegmentTimeline MPDs built from the real durations
(`synthetic-manifests.ts`). Unit tests: `ffmpeg-session` (probe through WORKERFS, TS → MP4 remux
read back in chunks, failing commands, crash/OOM), `ffmpeg-service` (fake worker: laziness,
ordering, abort, timeouts, load failure, idle release), `media-worker-host`, `ffmpeg-protocol`,
`probe`, `containers`, `track-layout`, `media-manager` (real FFmpeg on stored synthetic HLS TS,
fMP4/DASH and muxed tracks; not-media, missing segments, old plans, forced MP4, cancel). The
integration test `media-pipeline.test.ts` downloads HLS MPEG-TS, HLS fMP4 and DASH (separate
audio and video) streams of synthetic media end to end and checks FFmpeg's findings (spec
scenarios 1–3); the download pipeline tests answer probes with canned output, since their
segments are filler bytes that prove storage order. The fixture site's download demo now serves
real media (generated at server start), so the whole flow can be watched in Chrome.

## Build

Two Vite 8 builds, orchestrated by `scripts/build.ts`:

1. `vite.config.ts`: popup, offscreen document and the module service worker. They share ES
   module chunks; Vite's root is `src/`, so pages land at `dist/popup/index.html` and
   `dist/offscreen/offscreen.html`. File names carry no hashes (no caching concerns inside a
   package; watch rebuilds overwrite instead of accumulating).
2. `vite.content.config.ts`: the content script as a single IIFE, because manifest-declared
   content scripts are classic scripts and cannot `import`.

`build/manifest-plugin.ts` emits `manifest.json` with the version from `package.json`;
`build/ffmpeg-core-plugin.ts` copies the FFmpeg core into `dist/ffmpeg/`. Web Workers are built as
ES modules into `dist/workers/`. `scripts/verify-dist.ts` then checks the output: every referenced
file exists, no `_`-prefixed names (Chrome rejects them), no module syntax in the content script,
no dynamic `import()` in the service worker's module graph, no remote resources in pages, the
FFmpeg core is byte-identical to the package's (and its .wasm is WebAssembly), some script
references it and starts a worker, and each worker's module graph resolves without remote URLs.

Type checking uses three configurations: `tsconfig.app.json` (extension code, DOM, no Node
types), `tsconfig.test.json` (tests: also Node, which loads the FFmpeg core from `node_modules`)
and `tsconfig.node.json` (build tooling, scripts, Vitest configs). `vitest.config.ts` runs unit
and integration tests (`npm test`, `npm run coverage`); `vitest.e2e.config.ts` runs the
end-to-end tests in Chrome for Testing (`npm run test:e2e`).

TypeScript is pinned to 6.0.x: the TypeScript 7 native compiler is out, but `typescript-eslint`
supports only `<6.1` today.

## Storage plan

| Data                         | Where                     | Why                                                           |
| ---------------------------- | ------------------------- | ------------------------------------------------------------- |
| Settings                     | `chrome.storage.local`    | Persistent; readable from SW and popup; normalised on read    |
| Download tasks and progress  | `chrome.storage.local`    | Popup can render them while the SW sleeps; survive restarts   |
| Task request context         | `chrome.storage.session`  | Referer/Origin per task; sensitive, so never written to disk  |
| Detections per tab           | `chrome.storage.session`  | Survives SW restarts, never hits disk, cleared with browser   |
| Request context headers      | `chrome.storage.session`  | Same; sensitive, so never persisted                           |
| Segment bytes                | IndexedDB (offscreen doc) | Large binary data in 8 MiB Blob parts; never all in RAM; deleted on cancel/remove; kept by failed tasks for Retry |
| Segment completion markers   | IndexedDB                 | A segment is complete only with its marker; resume reuses exactly those |
| Plan per task                | IndexedDB                 | Signature of the segment list the stored data belongs to; another version starts over |
| Track layout                 | IndexedDB (with the plan) | Init segments, discontinuities, containers per track; no URLs. Media processing reads it |
| Media analysis               | `chrome.storage.local`    | On the task: what FFmpeg found and the container chosen |
| FFmpeg.wasm core             | Extension package         | `dist/ffmpeg/`, loaded by the media worker only while processing |
| Merged file while saving     | OPFS `merges/` (0.4.0)    | `<taskId>.<attempt>.mp4\|mkv`, written by the media worker; a blob: URL of its File Chrome reads; deleted after the save, orphans at startup. Blob parts if OPFS fails |
| Progressive file (0.3.0)     | Downloads folder (Chrome) | Chrome writes it there itself; with the engine fallback, a Blob of parts until Chrome saved it. Never IndexedDB |
| Saved file                   | Downloads folder          | Path, size and download ID on the task (`output.saved`), for the Completed tab |

## Merging and saving (Phase 9)

```
offscreen: MediaManager job ─ analyseTask ─ mergeTask ─────────────────────────────▶ blob: URL
             tracks → runs (init / discontinuity) → FFmpeg -c copy → SinkFs → OPFS File ─ ffprobe check
             ── engine/save {taskId, url, container, size, media} ──▶
service worker: DownloadCoordinator.startSave
             chrome.downloads.download({url, filename: baseName + .mp4|.mkv, conflictAction: 'uniquify'})
             task: processing (stage saving, downloadId)
chrome.downloads.onChanged (complete | interrupted) ──▶ #settleSave
             complete: task completed (saved path, size), segments deleted, notification, pump
             interrupted: task failed with Chrome's reason, segments kept
             pump → engine/sync without the task → MediaManager revokes the blob: URL, deletes the OPFS file
```

- **Runs** (`merge-plan.ts`, `trackRuns`). Byte-joining a track's segments is valid only within
  a run: MPEG-TS and packed audio between discontinuities; fMP4 and WebM as an init segment plus
  the fragments that use it, also cut at discontinuities (a run that starts without its own init
  gets the current one prepended, a run of only an init segment is dropped). One run is mounted
  as one input; several runs go through FFmpeg's concat demuxer (`ffconcat` list mounted as a
  Blob), which places each run after the previous one, so timestamps that restart at a
  discontinuity (ad breaks, re-encodes) do not fold the video back on itself. Each run is a Blob
  of the stored Blobs (`trackData` returns them with their segment positions): nothing is copied.
- **Command** (`buildMergeJob`). Main track first (video, and muxed audio if any), then each
  alternative audio track; `-map 0:V? -map 0:a? -map N:a` (no cover art, no data or in-stream subtitle
  streams), `-c copy`, no re-encoding. FFmpeg starts every input at 0, which would lose the
  offset between separately delivered audio and video, so each input gets `-itsoffset` = its
  start (probed: `startSec`) minus the earliest track's. Metadata: `-map_metadata -1` (no
  encoder or service tags from the inputs), the page title as `title`, each audio stream's
  ISO 639-2 language (`languages.ts` maps manifest codes such as `en`, `pt-BR`), its manifest
  name as `title` and, in MP4, as `handler_name` (what players show for MP4 tracks; a name that
  is only the language code is left out), the first audio stream as default. HEVC in MP4 is
  tagged `hvc1`. No `faststart`: moving the index to the front means rewriting the file.
- **Streaming output** (`output-sink.ts`, `sink-fs.ts`). Since 0.4.0 the merged file is a file
  on disk (FileSink, see "Merged files on disk"); what follows is the fallback when OPFS cannot
  be used. `/out` is a custom Emscripten
  filesystem whose files are BlobSinks: the first 1 MiB stays in memory (muxers patch sizes and
  durations there at the end), the most recent ≤ 64 MiB too, everything older is flushed into
  32 MiB Blob parts, which Chrome's Blob storage holds (in its own memory up to a limit, then on
  disk; see Known limitations). The merged file is therefore never in
  memory whole, and neither MEMFS's growth-by-copy nor its single typed array limits the output
  size. A muxer that writes or reads inside flushed data gets EIO, and the session refuses the
  output even if FFmpeg exits with 0 (MP4 `faststart` does exactly that). Tested byte for byte
  against MEMFS for MP4 and Matroska with a window far smaller than the file.
- **Check** (`mergeTask`). After the merge, ffprobe reads the file: it must have the planned
  number of video and audio streams and must not be shorter than half the expected duration
  (manifest sum, or probed duration plus offsets). Failures keep the segments; Retry merges again.
  A merge is stopped when FFmpeg reports no progress for 2 minutes (`stallTimeoutMs`), whatever
  the video's length.
- **Saving** (`file-saver.ts`). Service workers cannot create blob: URLs, so the offscreen document
  does and keeps it alive (`MediaManager` holds it) until the service worker drops the task from
  its work list; the offscreen document stays open meanwhile, since processing tasks count as
  work. `chrome.downloads.download` gets the task's file name (`baseName` + the analysed
  container's extension) in the Downloads folder (or its subfolder from Settings, 0.4.0),
  `conflictAction: 'uniquify'` (an existing file
  is never overwritten: Chrome adds " (1)"), `saveAs: false`. The merged Blob carries the
  container's MIME type (`video/mp4`, `video/x-matroska`): Chrome names a download after the
  response's type and replaces an extension that does not belong to it, and an untyped Blob was
  sniffed as text/plain, so the first real test saved "Movie.txt". The tests' chrome.downloads
  stand-in applies the same rule (`chromeFileName`). `engine/save` is accepted only from
  the offscreen document and only for a blob: URL of this extension (`parseSaveRequest`), so no
  message can make Chrome download anything else. `startSave` never pumps while the engine waits
  for its answer (that would deadlock a sync); a save Chrome finished before the download ID was
  stored is caught by checking right after storing it, and repeated change events are idempotent.
- **Completion.** `chrome.downloads.onChanged` (registered at the top of the service worker, so
  it also wakes a suspended worker) → the item's final path and size go into
  `task.output.saved`, the task is `completed`, its segments are deleted ("clean up temporary
  files after success") and a notification names the file and its size; clicking it shows the
  file in its folder (`chrome.downloads.show`, no extra permission). An interrupted save fails the
  task with Chrome's reason worded (`saveFailureMessage`: no space, FAT32's 4 GB limit, name too
  long, blocked, cancelled in Chrome's download bar, Chrome closed) and keeps the segments: Retry
  merges and saves again without downloading anything. Failed downloads and failed processing are
  notified too.
- **Recovery.** Cancel while saving cancels Chrome's download (the partial file goes) and the
  engine releases the URL and deletes the data. A service-worker restart finds saves Chrome
  finished meanwhile at startup. An engine that restarted while saving processes the task again;
  the new save abandons the old download first. After a browser restart, the blob: URL is gone, so
  processing (and saving) starts over from the stored segments.
- **Popup.** Queue: "Merging the tracks into one file · 63%", "Checking the merged file…",
  "Saving to the Downloads folder…", then a *Finished* section with *Show in folder* and *Clear*
  (`downloads/dismiss`), unless Settings → *Remove finished tasks from the queue* is on.
  Completed: every saved video, newest first, with file name (as saved, e.g. "Movie (1).mp4"),
  size, time, quality, what FFmpeg found, *Show in folder*, and *Remove* (the entry, never the
  file); a file moved or deleted since is marked as such (`chrome.downloads.search` → `exists`).
- **Measured** (Chromium, production bundle under the extension CSP, 8-minute 360p demo): download
  of 241 segments 0.8 s from localhost, analysis + merge + check 0.4 s; the 5.3 MB MP4 plays in a
  `<video>` element (480 s, 640×360, seekable). Multi-GB merges: see Phase 10.

Testing: `output-sink.test.ts` (window logic; MP4 and Matroska written through a 16 KiB window
identical to MEMFS; faststart refused), `merge-plan.test.ts` (runs, arguments, offsets,
metadata, concat lists, languages), `media-manager.test.ts` (real FFmpeg: separate A/V TS, fMP4,
muxed into MKV, read back by ffprobe; scripted: merge failure, missing streams, cancel during
merge and while saving, a save the service worker refuses), `download-coordinator.test.ts`
(save, completion, cleanup, notification, interruption, refusal, cancel while saving, restart),
`notifier.test.ts`, and `media-pipeline.test.ts`, which downloads HLS MPEG-TS, HLS fMP4 and DASH
streams of synthetic media, merges them with the real core, "saves" them through a
chrome.downloads stand-in that resolves the blob: URL, and reads each saved file back with
FFmpeg (streams, 8 s duration, title, language, track name), plus a playlist whose timestamps
restart at a discontinuity (8 s, not 4) and a save that fails for lack of space, then succeeds
after Retry without downloading again. The download pipeline tests use a stand-in FFmpeg whose
"merge" concatenates its inputs, so the saved file proves the order in which segments were
assembled across a browser restart.


## Error handling, performance and testing (Phase 10)

### Error handling

- **Pages instead of segments** (`segment-fetcher.ts`, `documentKind`). A server that answers 200
  with an HTML error or login page, an XML "AccessDenied" document or a JSON error used to have it
  stored as a segment; the merge then skipped it and saved a video with a gap. No media container
  starts with "<" or "{" (MPEG-TS starts with 0x47, MP4 with a box size, WebM with 0x1A,
  ADTS/MP3 with 0xFF, ID3 with "I"), so a body that does (after whitespace or a BOM) is refused
  before anything is stored (`SegmentContentError`). Encrypted bodies are random bytes, so for
  them only a `text/html`/XML/JSON Content-Type counts; a range from the middle of a file is not
  judged. The segment is retried like a network error (overload pages go away), and if it
  persists the task fails with "Segment 12 of 240 failed after 5 attempts: The server sent a web
  page instead of video data (HTTP 200). The link may have expired, or the site may want you
  signed in: play the video again on its page, then press Retry".
- **Disk space before merging** (`MediaManager`, `mergeSpaceNeeded`). The merged file (about the
  size of the segments; Chrome moves large Blobs to disk beyond its memory limit) and the copy Chrome saves need room on
  top of the stored segments. Before merging, `navigator.storage.estimate()` must leave twice the
  tracks' size plus the 256 MiB reserve; otherwise the task fails at once with how much is needed
  and free, and keeps its segments for Retry. (Seen working in Chromium: a plain web page's
  quota refused a 1.5 GB merge with "about 3.1 GB is needed…, 2.5 GB is free".)
- **Unhandled errors** of the service worker and the offscreen document are logged (redacted)
  instead of disappearing (`unhandledrejection`, `error`).
- **Saved file type** (found in the first real test after Phase 9): merged Blobs carry
  `video/mp4` / `video/x-matroska`, or Chrome sniffs them as text/plain and saves "Movie.txt".

### Performance (measured)

| What                                   | Before                     | After                      | How |
| -------------------------------------- | -------------------------- | -------------------------- | --- |
| Storage write per progress report (300 completed tasks in the list) | 255 KiB | 0.2 KiB | progress in its own key (`taskProgress`) |
| Merge of a 1.48 GB HLS stream (Chromium, production bundle) | 20.8 s (71 MiB/s) | 4.6 s (322 MiB/s) | `InputFs` reads 4 MiB chunks |

- **Task progress** (`task-store.ts`). Engine reports arrive twice a second per running task and
  used to rewrite the whole task list (up to 500 tasks with their media details), which
  Chrome writes to disk and delivers, old and new value, in an onChanged event to every
  extension context. Progress, processing stage and their time now live under `taskProgress`;
  `tasks` is written only when something else changes. Readers merge both (`mergeStoredTasks`,
  `useTasks`); tasks stored the old way are still read and migrate on their next write.
- **Reading inputs** (`input-fs.ts`). FFmpeg reads its inputs 32 KiB at a time; WORKERFS made each
  read a synchronous Blob read (some 47 000 for 1.5 GB). `InputFs` reads 4 MiB at once and serves
  the following reads from it, keeping four chunks across inputs (a merge alternates between
  video and audio): 16 MiB of memory whatever the input size. The bytes FFmpeg sees are the same
  (the MP4/Matroska byte-for-byte tests now run through it).
- Measured with a 5-minute 720p stream at ~40 Mb/s (synthetic, `noise` option of the generator):
  download 1479 MiB from localhost in 6–10 s, analysis 0.5 s, merge 4.6 s, check 0.1 s; the
  1446 MiB MP4 is written through SinkFs with about 70 MiB in memory.

### Testing

- **End to end in Chrome** (`tests/e2e/extension.e2e.ts`, `npm run test:e2e`). Chrome for Testing
  (`npm run e2e:install`: downloaded into `.cache/chrome`; branded Chrome ignores
  `--load-extension`) runs headless with `dist/` loaded unpacked, its own profile and Downloads
  folder; the fixture site runs on a free port. The popup's messages are sent from an extension
  page. Two scenarios, about 20 s together:
  1. The download page's five streams are detected by the real webRequest listener; the plain
     HLS, the DASH and the Referer-protected HLS streams are queued with the popup's defaults,
     downloaded, merged by FFmpeg in the offscreen document's worker and saved by
     chrome.downloads; each saved `.mp4` is read back (H.264 + AAC, 8 minutes), and every request
     of the protected stream carried the page as Referer (the DNR rule).
  2. Chrome is closed while a download is under way and started again on the same profile: the
     task resumes (≥ 30 segments reused, not downloaded again) and its file is saved.
  Scenario 1 also opens the real popup's Completed tab and checks each saved video's line
  (resolution · duration · the saved file's real size, codecs · container, *Show in folder*).
  `STREAMGRAB_EXTENSION_DIR=<folder>` runs the suite against another extension folder, e.g. an
  extracted release ZIP (`npx vitest run --config vitest.e2e.config.ts` skips the build).
  Not covered there: notifications (headless Chrome has no notification center to inspect), the
  Queue tab's live progress (component tests), and real sites.
- **Estimates** (`tests/unit/core/download/estimate.test.ts`, `progress.test.ts`,
  `tests/unit/popup/task-view.test.ts`): known and extrapolated totals, per-track extrapolation,
  lower bounds, zero speed, too few samples, fluctuating speeds, live streams (no segment count),
  stalls, stale progress, completed downloads, the real final size and missing files, and the
  status mapping from download to processing to completed.
- **Detected tab** (`tests/unit/popup/detected-page.test.ts`, happy-dom): title and secondary
  line, manifest names only for repeated titles, quality selector, audio toggle, per-video and
  bulk download with the selected count.
- **Popup components** (`tests/unit/popup/pages.test.ts`, happy-dom): the Queue tab's stages,
  progress bars, Finished section and its Settings switch, and the messages its buttons send; the
  Completed tab's list, sizes, missing files, *Show in folder* and *Remove*.
- **Coverage** (`npm run coverage`, V8): 87 % of lines of `src/` (core modules 92–99 %; the rest
  is chrome.* wiring, which the end-to-end tests exercise, and the Detected and Settings tabs).

Spec scenarios (SPEC.md §8) and where they are tested:

| # | Scenario | Tests |
| - | -------- | ----- |
| 1 | HLS with MPEG-TS segments | `media-pipeline.test.ts`, `extension.e2e.ts` (1), `hls-adapter.test.ts` |
| 2 | HLS with fMP4 segments | `media-pipeline.test.ts`, `media-manager.test.ts`, `hls-playlist.test.ts` |
| 3 | DASH with separate audio and video | `media-pipeline.test.ts`, `extension.e2e.ts` (1), `dash-adapter.test.ts` |
| 4 | Page with multiple streaming videos | `detection-pipeline.test.ts`, `extension.e2e.ts` (1) |
| 5 | Manifest with multiple resolutions | `hls-adapter.test.ts`, `dash-mpd.test.ts`, `variant-choice.test.ts`, `extension.e2e.ts` (1) |
| 6 | Failed segment requests with retry | `download-manager.test.ts` (5xx, error pages), `download-fixtures.test.ts` (flaky), `retry-policy.test.ts` |
| 7 | Large downloads with limited memory | `segment-fetcher.test.ts` (bounded parts), `download-manager.test.ts` (ranged chunks), `output-sink.test.ts`, `input-fs.test.ts`, the 1.5 GB benchmark above |
| 8 | Expired manifest URLs | `download-manager.test.ts` (refresh, expired), `download-fixtures.test.ts` (expiring), `download-pipeline.test.ts` (lost context) |
| 9 | Popup closed during download | `download-pipeline.test.ts` (no popup at all), `extension.e2e.ts` (no popup; browser restart) |
| 10 | Unsupported DRM-protected streams | `detection-pipeline.test.ts`, `manifest-inspector.test.ts`, `download-manager.test.ts` (refusals), `task-service.test.ts` |

Unit tests asked for by the spec: HLS parsing (`hls-playlist`, `hls-adapter`), DASH MPD parsing
(`dash-mpd`, `dash-scan`, `dash-adapter`), relative URL resolution (`url`, `hls-playlist`,
`dash-mpd`), segment ordering (`download-manager`, `download-storage`, `trackRuns`), concurrent
download scheduling (`download-queue`), retry logic (`retry-policy`), cancellation
(`download-manager`, `media-manager`, `ffmpeg-service`), progress calculation (`progress`,
`format`), FFmpeg processing workflows (`ffmpeg-session`, `merge-plan`, `media-manager`,
`output-sink`, `input-fs`).

## Popup progress, estimates and layout (v0.2.0)

Version 0.2.0 changes what the popup shows, not how videos are detected, downloaded or merged.

**Data sources.** Everything shown comes from data the extension already measures:

| Shown | Source |
| ----- | ------ |
| Percentage, completed / total segments | `progress.segmentsDone` / `segmentsTotal` (engine, per completed segment) |
| Downloaded size | `progress.bytes`: bytes stored in IndexedDB (reused segments included) |
| Current speed | `progress.bytesPerSecond`: received bytes over the last 5 s (`ProgressTracker`) |
| Average speed (for ETA) | `progress.averageBytesPerSecond`: time-based exponential moving average (τ = 10 s) of the current speed |
| Per-track figures (for size estimates) | `progress.tracks[]`: media segments total / done and their stored bytes per track, plus `declaredBytes` when every segment of the track has a byte range and is not encrypted |
| FFmpeg stage and percentage | `task.processing` (`MediaProgress`, unchanged) |
| Resolution, duration, codecs, channels, container (Completed) | `task.media` (FFmpeg's analysis of the downloaded data) |
| Final file size (Completed) | `task.output.saved.bytes`: the size Chrome reports for the saved file (`DownloadItem.fileSize`) |
| File missing (Completed) | `chrome.downloads.search({ id }).exists` |

`tracks` and `averageBytesPerSecond` are optional fields of `TaskProgress`: progress stored by
0.1.0 has neither and is still read (the parsers in `engine-messages.ts` and `task-store.ts`
drop malformed values instead of the whole progress). Without `tracks` the task is estimated as
one track.

**Estimates** (`core/download/estimate.ts`, pure functions; the engine uses `averageSpeed`, the
popup `estimateDownload`):

- *Known size*: a track whose every segment declares its byte range (HLS `EXT-X-BYTERANGE`, DASH
  SegmentList/SegmentBase, single files split into ranged chunks) contributes its exact size.
  When all tracks are known (or done), sizes are shown without `~`.
- *Unknown size*: each track is extrapolated from its own completed media segments
  (stored bytes ÷ segments done × segments left), from at least 3 segments. Per track because
  the plan lists the main track before the audio tracks and the worker pool takes positions in
  order: a per-task average taken during the video phase applies video-sized segments to the
  audio ones and overestimates by up to 2×. Init segments are not counted (a few KB).
- A track without enough samples is left out and the total is marked as a lower bound
  (`partial`, shown with `+` and a tooltip). If no track has samples, no estimate is shown.
- *ETA* = remaining bytes ÷ average speed, only when a size estimate exists, the run is at least
  3 s old (`progress.startedAt` to the latest report, `task.updatedAt`), the speed is above 0,
  and the progress is not carried over from an earlier run (`stale`).
- *Stalled*: the current speed is 0, or no report arrived for 8 s while downloading (the engine
  reports at most twice a second, but only when data arrives; `useNow` re-renders the Queue tab
  every second while something downloads). A run that has not completed a segment of its own
  yet (just planned, or just resumed) is not called stalled.
- Live streams never reach the engine (refused when queued and when planned); a progress without
  a segment count has no estimate and no ETA.

**Popup view model** (`popup/format.ts`): `downloadStats` turns a progress into the strings of a
Queue item; `taskPhase` maps the seven stored statuses onto the six the user sees (Pending,
Downloading, Processing — `downloaded` and `processing` —, Completed, Failed, Cancelled);
`processingStageLabel` names FFmpeg's stage; `completedFacts` and `completedSummary` build the
Completed tab; `qualityOptions` labels the quality selector (bitrate only to tell equal labels
apart); `fileNameAddsInfo` decides whether a file name says more than the title (a generated name
is the title plus the quality).

**Layout.** Queue items: title (tooltip: title and file name), protocol · quality · audio ·
duration, then per state: network progress (bar, segments, sizes, speed, remaining, ETA,
retries) or FFmpeg progress (a "Downloaded · n segments · size" line, then a violet bar with the
stage) or a status line; actions at the bottom right. Completed items: title, file name only when
it adds something, protocol · resolution · duration · size, codecs · audio layout · container,
date, *Show in folder* and a ⋯ menu with *Remove from list*. Detected cards: checkbox, title,
protocol · site · duration (manifest file name only when titles repeat), badges for status other
than ready and for Live/encryption, then quality selector, audio/options toggle and Download;
options hold audio tracks, file name and codecs. Shared pieces live in `popup/components/`
(`Badge`/`ProtocolBadge`, `ProgressBar`, `Menu`, `buttons.ts`, `EmptyState`).

## Progressive files (v0.3.0)

A progressive file is one plain media file (MP4, WebM) that a `<video>` element plays while it
downloads. It has no manifest and no segments, so it needs neither adapters, IndexedDB nor FFmpeg:
the original file is saved as it is. Everything else is the existing pipeline: detection manager,
task service, queue and slots (`DownloadCoordinator.pump`), task store, retry/cancel/remove,
`chrome.downloads` saving and its `onChanged` follow-up, notifications and the popup's tabs.

```
webRequest (type media, MP4/WebM)  ─┐
content script <video src>/<source> ┴─▶ DetectionManager ── inspect first 64 KiB (DNR context) ──▶ ready
popup Download ─▶ TaskService (#prepareFile) ─▶ task { progressive: { container, fetch: 'browser' } }
pump: one slot ─▶ chrome.downloads.download(url, baseName.mp4|.webm) ── poll search() 1/s ──▶ progress
                  onChanged complete ─▶ completed (saved path, size)
                  refused (401/403/404, page, other size) + context ─▶ fetch: 'extension'
                       ─▶ engine/sync ─▶ DownloadManager #runFile ─▶ Blob parts ─▶ engine/save ─▶ Chrome
```

- **Detection** (`manifest-detector.ts`, `file-inspector.ts`). `classifyResponse` reports
  `progressive` for an MP4/WebM Content-Type (`video/mp4`, `video/x-m4v`, `video/webm`), or a
  generic one with a `.mp4`/`.m4v`/`.webm` path, but only for the `media` resource type (a media
  element's own requests), and before the manifest size cap. XHR/fetch requests for such files
  are Media Source Extensions segments and stay ignored. The content script reports `<video src>`
  and `<source>` files the same way. Each new candidate is inspected once: a `Range: bytes=0-65535`
  request with the page's Referer/Origin (the existing DNR rules) whose first bytes must be a
  whole file — MP4 starting with `ftyp`/`moov`/`mdat`/`free`… (and holding media data when the
  whole file fits), or WebM (EBML DocType `webm`). Segments (`styp`/`moof`/`sidx`, a WebM Cluster)
  and initialization segments of streams (native HLS playback through a media element) are
  dropped, and later requests of the same URL shape are skipped until the next navigation; a web
  page or JSON instead of media lists the file as unavailable with the reason. The detection
  records the container (from the bytes), MIME type, size (Content-Range total or Content-Length),
  whether ranges are served (206), and a file name (Content-Disposition, else the URL). A link that
  redirects folds its target under it (`childKeys`), whichever is seen first. A ready file is
  listed with one variant, `file` ("Single quality"), so the Detected tab's selection works
  unchanged; an element's own title wins over frame-level titles even when its request came first.
- **Tasks** (`task-service.ts`, `download-task.ts`). `source.protocol` is `progressive` and
  `progressive = { container, fetch, bytes?, resumeId? }`; the default name is the title without
  a quality. The output format setting does not apply: the file keeps its container. Duplicate
  prevention and name uniqueness are the existing ones.
- **The `browser` route** (default). In `pump`, a progressive task takes a download slot but not
  the engine: the coordinator adopts the freshest detection of the video (a re-signed link), then
  `chrome.downloads.download({ url, filename: baseName.container, conflictAction: 'uniquify' })`.
  Chrome sends the site's cookies; it sends **no Referer/Origin**: declarativeNetRequest rules never
  apply to `chrome.downloads` requests, and webRequest does not see them (checked in Chrome 157
  under every rule condition, including `urlFilter` alone), while the `headers` option refuses
  them (forbidden XHR headers). `chrome.downloads.onChanged` reports no progress, so the service
  worker reads `chrome.downloads.search` once a second while such downloads run and writes the
  bytes into the existing `TaskProgress` (`fileProgress`: one "segment", the size as the track's
  declared bytes), so estimates, ETA and the Queue tab work as for streams.
- **Refusals and the `extension` route.** A download that ends with `SERVER_UNAUTHORIZED`,
  `SERVER_FORBIDDEN` or `SERVER_BAD_CONTENT` (401/403/404), whose MIME type is a page or JSON
  (Chrome would save it as `.htm`), or whose size differs from the detected file while a request
  context exists (a hotlink placeholder), is stopped (a saved page is deleted with
  `removeFile`). If the task has the page's Referer/Origin, it switches to `fetch: 'extension'`:
  the engine (`DownloadManager.#runFile`) fetches the file with its DNR leases through the
  segment fetcher (8 MiB Blob parts, stall detection, web pages refused, retries with backoff, an
  expired link refreshed from the newest detection), then hands it over with `engine/save`
  (no container, no analysis) and holds the blob: URL until the service worker drops the task;
  `startSave` saves it under the task's name. Without a context the task fails saying what the
  server did.
- **Lifecycle.** Completion and interruption come through the existing `onChanged` listener
  (`#settleFile`). Interruptions keep the Chrome download's ID as `resumeId` when Chrome can
  resume it: Retry calls `chrome.downloads.resume`, otherwise it starts over (deleting the
  partial file). Cancel cancels the Chrome download; Remove of a failed task deletes a
  resumable partial file (`beforeRemove`). A download erased from Chrome's list fails the task.
  At service-worker start, downloads Chrome finished meanwhile are completed; one interrupted by a
  crash, a shutdown or the network is resumed once. Browser facts checked in Chrome 157: a
  dropped connection is resumed by Chrome itself with `Range`/`If-Range`; after a crash the file
  was completed but fetched again from the start; quitting Chrome normally **cancels** running
  downloads (`USER_CANCELED`, partial file deleted), which the task reports, and Retry downloads
  again; after Chrome resumes a download by itself, the file may take the URL's name instead of
  the one the extension gave (the task records the real path).

### Merge fixes (v0.3.0)

Found with a 2.5 GB, 7407 s HLS video that came out "30 of 7407 seconds" long:

- **Segments disguised as pictures.** The site served its MPEG-TS segments as `.png` with a 1×1
  PNG (95 bytes) before the data; players skip it, FFmpeg read the track as one picture per
  segment (750 at 25 per second: 30 s). `track-data.ts` (`prepareTrack`, used by analysis and
  merge) reads each segment's first 64 KiB (1 MiB if needed) and skips the bytes before the first
  MPEG-TS packet (`tsSyncOffset`: sync bytes 188 apart), for tracks declared MPEG-TS and for
  segments whose names give no container; MP4, WebM and packed-audio starts are never cut. The
  stored data is not changed.
- **Timestamps that go back without a discontinuity in the manifest** (an intro or ad on its own
  timeline, a clock wrap) made FFmpeg clamp decode times and squeeze the rest of the video onto
  their end. `timestamps.ts` reads each segment's first decode time (the first PES DTS/PTS per PID;
  `tfdt` per track fragment) and such places start a run of their own (concat demuxer):
  fragmented MP4 always (FFmpeg corrects no jump in MP4 input; `-use_tfdt 0` does not help in
  5.1), MPEG-TS when the track already has several runs (FFmpeg corrects jumps in one MPEG-TS
  input, not inside concat runs). A command may mount up to 8 192 inputs.
- **Analysis by the first run.** A track joined from several runs is probed by its first run (a
  new initialization segment mid-track made ffprobe fail and the data be discarded); its duration
  is the manifest's.
- "The merged file is much shorter…" quotes FFmpeg's last notable log line.

Testing: `file-inspector.test.ts` (real MP4/WebM from `tests/fixtures/media/synthetic-files.ts`,
segments, init segments, pages, headers, ranges), `progressive-detection.test.ts` (fixture site
`/files` through the real classifier, inspector, manager and RequestContextRules),
`download-coordinator.test.ts` (route, progress poll, refusals and fallback, resume, cancel,
remove, gone, restart), `download-manager.test.ts` (`#runFile`), `timestamps.test.ts`,
`media-manager.test.ts` (disguised segments and timestamp jumps with the real FFmpeg core), and
three end-to-end scenarios in Chrome for Testing: detection on `/files`, byte-for-byte downloads
next to an HLS stream with the Referer fallback, and cancel/retry/crash/quit on `/files/slow`
(a 6 MiB file served at 1 MiB/s). Coverage: 90 % of lines of `src/`.

## Version 0.4.0

### Live streams are not listed (Phase 2)

On a live page the Detected list and the badge used to grow to 99+: live manifests were listed
(tagged *Live*, download refused), and each reload with a changing query (LL-HLS
`_HLS_msn`/`_HLS_part`, `t=`, unknown tokens) got a new `dedupeKey`, so a new entry and a new
inspection, until `maxStreamsPerTab` (100) evicted real videos.

`DetectionManager` now drops a manifest whose inspection says live (HLS without
`#EXT-X-ENDLIST`, a master by its first variant; DASH `type="dynamic"`), from an inspection or a
content probe. It remembers its `liveKey` (host + exact path, query ignored) and those of a live
master's playlists in the tab's in-memory `liveKeys`, drops entries of those keys still `pending`
or in `error` (never `ready` ones: they are downloadable videos), and skips later candidates with
those keys before any fetch. An inspection waiting for a slot looks its entry up when its turn
comes and is applied before the slot is freed, so reloads queued behind the first one are not
fetched once it says live. `urlShape` is not used: its collapsed digits would also hide a VOD
such as `/hls/456/index.m3u8` next to a live `/hls/123/index.m3u8`. The keys are cleared with the
list (navigation, *Clear list*) and with the worker (the next reload is inspected once more). A
page that plays a VOD and a live lists the VOD, before and after any number of live reloads.

Trade-offs: a live whose path changes per reload is still fetched once per reload, but never
listed; an entry of the same path as a live, only by query, is not listed either (it is ignored
like a reload); a broken VOD playlist without `#EXT-X-ENDLIST` counts as live and is now hidden
(it could not be downloaded before either). End-to-end: the fixture site's `/live` page (a VOD
and 30 live reloads) lists the VOD only, badge 1, at most a few live fetches by the extension.
The popup's live guards (`selection.ts`, the card's
message) and the engine's refusals stay for a future live feature.

### Completed tab: Remove all, Remove missing (Phase 2)

The Completed tab's summary bar has *Remove all* (a confirmation dialog first:
`ConfirmDialog`, focus on Cancel, Tab kept inside, Escape or a click outside cancels) and, only
while files are missing, *Remove missing (N)*. Both send the existing `downloads/remove` with the
task IDs: entries go, files stay on disk. *Remove all* is named so on purpose: the Queue's
*Clear all* only hides finished tasks from the Queue.

### Merged files on disk: OPFS (Phase 3)

Until 0.4.0 a merge streamed into 32 MiB Blob parts (BlobSink), which Chrome keeps in its browser
process up to about 1–2 GB before paging to disk, so a multi-GB merge raised Chrome's memory by
that much until the save completed (Phase 1 spike: +0.5–1.0 GiB for 1 GiB). The media worker now
writes the merged file to the extension's origin private file system (`output-files.ts`):

- **Name.** `merges/<taskId>.<attempt>.mp4|mkv` (`mergeFileName`; attempt = MediaManager's clock
  and a counter in base 36): every attempt gets a new file, so a file whose blob: URL Chrome may
  still be reading is never written again. Chrome types the File from its extension
  (`video/mp4`, `video/matroska`); `mergeTask` slices it to `video/x-matroska` for MKV as before
  (slicing copies nothing).
- **Writing** (`FileSink`, `FfmpegSession`). FFmpeg's file calls are synchronous; synchronous
  access handles exist only in dedicated workers, and opening one is asynchronous. So the job
  names the file (`FfmpegJob.outputFiles`: output → file name), the session opens it (created or
  emptied) before `exec()`, and SinkFs creates the output's node on it: every write and read goes
  straight to the file (`write(data, { at })`), nothing is kept in memory, and a muxer may read
  back (MP4 `faststart` works on it; not used). After the command the handle is flushed and
  closed, and its File is the output; it reaches the offscreen document by `postMessage` (a
  reference, no copy) and is mounted again for the ffprobe check. The session deletes the file of
  a failed command. `FfmpegSession.run()` is asynchronous now (opening, reading back).
- **Failures.** A write the disk cannot hold (`QuotaExceededError`) becomes EIO for FFmpeg and a
  `disk` error for the task: "There is not enough disk space to write the merged file. Free up
  disk space, then press Retry; the downloaded segments are kept." The check before merging (2 ×
  the tracks + 256 MiB) is unchanged: `navigator.storage.estimate()` counts OPFS, and so does the
  popup's storage figure while a merged file exists. A file that cannot be opened (no OPFS)
  makes the output stream into Blob parts as before (`fileError`, logged by MediaManager).
- **Lifetime.** MediaManager holds the blob: URL and the file while Chrome saves, and deletes the
  file when the service worker drops the task (saved or interrupted) or on cancel, never sooner:
  a download Chrome has not started yet fails (`NETWORK_FAILED`) once its file is gone, one that
  has started completes (Phase 1). A merge that fails its check, is cancelled or is refused
  deletes its file at once; a file still open (its worker just terminated) is retried for 3 s.
  Whatever is left (the browser closed mid-merge, a deletion cut short by the document closing)
  goes with the coordinator's orphan cleanup (`#removeOrphanFiles`, at startup and whenever the
  engine closes): every file of `merges/` except those of `processing` tasks, skipping files
  still open. The service worker can list and delete OPFS files, not write them.
- **Tested.** Unit: FileSink (patches, reads past the end, full disk), real FFmpeg into a file
  byte for byte like MEMFS (MP4, Matroska) and MP4 faststart, the session's files (kept for the
  caller, deleted on failure, full disk → `disk`, fallback with its reason), `OpfsOutputFiles`
  against a fake OPFS (locks, retry, missing), MediaManager (a file per attempt, typed, deleted
  after the save, a failed check, cancel during the merge and while saving, a refused save) and
  the coordinator's cleanup. End-to-end: each of the three demo merges appears in OPFS as
  `<taskId>.*.mp4` with exactly the size Chrome saved, and `merges/` is empty afterwards (an
  orphan placed there first included).

Memory was measured in the Phase 1 spike with the same mechanism (Chrome's private bytes: OPFS
write of 4.5 GiB +13 MiB, saving it +3–12 MiB), not again with the extension on a multi-GB video.
Not tested: Chrome 116 (the minimum; sync handle methods are synchronous since Chrome 108) and a
disk that really fills up.

### Downloads subfolder (Phase 2)

Setting *Save in a subfolder* (`downloadFolder`, default empty = Chrome's download folder as
before). `parseDownloadFolder` (`core/download/file-name.ts`) normalises what the user types:
trim, `\` → `/`, empty and `.` segments dropped, each segment cleaned with the file-name rules
(reserved characters, trailing dots/spaces, device names such as `CON`), at most 80 characters
(folder + name must stay under Windows' 260); `..` and absolute paths (`C:\…`, `\\server`) are
refused with a reason in the Settings field and never saved (Chrome throws "Invalid filename"
for them, checked in Chrome 157). The coordinator reads the setting when Chrome starts saving
(`#inFolder`, merged and progressive files alike) and passes `folder/name` to
`chrome.downloads.download`, which creates the folders and uniquifies per folder. Two failures
only a subfolder causes get their own message (`folderFailureMessage`): `FILE_FAILED` (a file has
the folder's name) and `USER_CANCELED` before Chrome chose a path (the full path is too long).
End-to-end: the real Settings field takes `StreamGrab\Phim Việt`, stores `StreamGrab/Phim Việt`,
and a WebM (Chrome's download) and a merged HLS video land in that folder; the real Completed
tab's *Remove all* then empties the list after its dialog, with every file still on disk.

## Version 0.6.0

### Range resume of engine-fetched files

A progressive file the engine fetches itself (the site needs the page's Referer, so Chrome's own
download cannot be used) is written to OPFS instead of Blob parts. `partial-files.ts` keeps
`files/<taskId>.<mp4|webm>` plus `<taskId>.json` (`{v:1, etag|lastModified, total}`);
`workers/file-worker.ts` writes it through a sync access handle (a main-thread `createWritable`
loses data on a crash), flushing every 64 MiB. `file-target.ts` holds `DiskTarget`, a
`MemoryTarget` fallback when OPFS fails, the validator choice (strong ETag, else Last-Modified;
none when the response is content-encoded or says `Accept-Ranges: none`) and the Content-Range
parser.

`#runFile` resumes at the stored size with `Range: bytes=N-` and `If-Range`: 206 continues, 200
truncates and restarts (applied on the first bytes, so a refused HTML page keeps the file), 416
with total equal to the size means complete, a wrong Content-Range starts over. No validator
means a restart from 0, as Chrome does. Resume works across in-run retries, a refreshed link, a
user Retry and an offscreen or browser restart (after a browser restart the request context is
lost: the first run fails with 403, then reopen the page and Retry). Up to one 8 MiB write part
is fetched again after a crash.

Chrome saves a blob: URL of the OPFS file. The service worker deletes the partial file after the
save completes (`#settleFile`), on cancel, on remove and in the orphan sweep (which keeps files of
tasks that keep their data); a failed Chrome save keeps it, so Retry saves without fetching.

### Save as MKV and early audio samples

A forced-MP4 task whose codecs MP4 cannot hold fails with `failureReason: 'mp4-unsupported'`
(`MEDIA_FAILURE_REASONS`, carried by `MediaFailure` through the media report) and keeps its
segments. The Queue shows *Save as MKV* instead of Retry; `saveAsMkv` in the coordinator sets
`output.format = 'mkv'` and calls the normal `retry`, which merges the stored segments without
downloading again. The MP4 setting itself stays a hard choice.

`samplesFirst` (`estimate.ts`) reorders the pending positions so the first three segments of
every track download first, so the size estimate includes audio early; the plan is unchanged.

## Version 0.7.0

### Subtitles

**Detection.** `TrackType` has `'subtitle'` and `ContainerFormat` `'webvtt'`. HLS `TYPE=SUBTITLES`
renditions become `subtitleTracks` of the manifest (their playlists are in `childUrls`; each
variant lists `subtitleTrackIds` through its `SUBTITLES` group); DASH text adaptation sets with
`text/vtt` are read from `mediaGroups.SUBTITLES` (fMP4 text, `codecs="wvtt"`/`stpp`, is skipped by
`isPlainWebVtt`). For progressive files the content script reports the `<video>`'s `<track src>`
elements (`findTrackSubtitles`, ids `track-N`); the detection manager keeps them per tab and
stores them with the stream (`domSubtitles`), so they survive a service-worker restart.

**Page subtitle files (0.7.2).** Many players fetch one WebVTT file on their own, outside the
manifest and without a `<track>`. `classifyResponse` answers `subtitle` for `text/vtt` or a
`.vtt`/`.webvtt` name, also with one suffix after it (`captions.zh.vtt.r20240612`); the network
monitor hands it to `DetectionManager.handleSubtitleFile`. Each file is fetched once per page
(`subtitle-inspector.ts`, ≤ 4 MB, with the request context): it must be WebVTT with cues of
text (a thumbnail track, `sprite.jpg#xywh=…`, is not) and without `X-TIMESTAMP-MAP` (that would
be a segment of a rendition, which comes with its manifest). A fetch failure is checked again
when the page loads the file again. Its language comes from a `Language:` header line or the file
name's last word when that is a known code (not an everyday word such as `my`, `id`, `it`); its
name from the language (`Intl.DisplayNames`) or the file name. Checked files get ids `page-N`
(never reused within a page), are kept per tab (`StoredTabDetections.subtitleFiles`, the newest
8, ≤ 30 checks per page or since the last new video, kept when the list is cleared, forgotten
on navigation) and are appended to every stream's `subtitleTracks` and every variant's
`subtitleTrackIds` (`#applySubtitles`). What the video already has is not offered again: a
progressive file's `<track>` of the same URL, a file in a language a manifest rendition has
(players often fetch the manifest's own file whole), and numbered files of one URL shape on a
page whose video has renditions (that rendition's segments).
A task keeps their `url`; for HLS/DASH the coordinator sends them as `EngineTaskSpec.pageSubtitles`,
for progressive files the service worker fetches them like `<track>` files.

Some players move a file's cues when they load it (a site added 4.56 s to every cue, kept in a
hidden `metadata` track): the file's own times are then not what the viewer sees. After a file is
accepted, the detection manager asks the content script of the frame that loaded it, then the top
frame (`content/getTextTracks`, the first cues of every `<video>` text track, any kind or mode),
after 1, 3, 8, 20 and 60 s, until a track holds the file's cues. `cueOffsetSec` pairs cues by
text (lines the file repeats are skipped; two pairs must agree within 50 ms) and the shift is
stored as `offsetSec` on the page file, the task's subtitle, `PageSubtitleFile` and the layout
(`TrackLayout.offsetSec`); it is added when cues are timed (`subtitle-files.ts`) or a progressive
file's subtitles are converted (`convertTrackFile`). A player that draws cues without text tracks
cannot be read: its files keep their own times.

**Download.** `getSegments({subtitleTrackIds})` adds `subtitle` segments; the engine stores them
like other tracks (`buildLayout` takes subtitle tracks for name and language). Page subtitle files
are appended as one-segment `subtitle` tracks (`pageSubtitleTracks`), marked `pageFile` in the
layout; an expired page-file link is skipped at once (no manifest refresh can renew it). A subtitle playlist or segment that fails is stored empty and never fails the video.

**Timing and joining** (`core/subtitles/webvtt.ts`, `core/media/subtitle-files.ts`). FFmpeg does not
move a subtitle input to 0 and `-itsoffset` adds, so cues are written on the merged file's
timeline: HLS `out = runStart + MPEGTS/90000 − LOCAL − runFirstPts + cue` from `X-TIMESTAMP-MAP`,
DASH and page subtitle files `out = runStart + cue` (period-relative; a page file is on the
player's timeline, 0 = the video's start); a run starts at the sum of the earlier runs'
durations. Repeated cues are removed, split cues joined, cues cut at the video's end (a later cue
lengthens the file). Joined files have no `STYLE` block (FFmpeg's WebVTT demuxer then drops every
cue). Multi-run files are probed run by run only when useful (≤ 100 runs).

**Output.** `subtitleMode` (`file` default, `embed`, `both`) and `subtitleFormat` (`srt` default,
`vtt`) are Settings. Embedding (`media-merge`/`merge-plan`): `-f webvtt -i` after the tracks, MKV
keeps WebVTT, MP4 `-c:s mov_text`, language and title (MKV) or `handler_name` (MP4), no default
disposition (FFmpeg's MP4 muxer still enables the first subtitle). A merge that fails with
subtitles is repeated without them (`MediaFailure` with `withSubtitles`), which then become files.
Files are saved by the service worker (`subtitle-saves.ts`) after the video has completed, named
`<final video name>.<lang>[.forced][.<name>].<ext>`, as `text/vtt` or `application/x-subrip`
(an untyped blob becomes `.txt`), from a blob: URL (merged tasks) or a data: URL (progressive
`<track>` files, ≤ 1.5 MB, fetched by the service worker with the request context). The task stays
*processing* until its subtitle saves settle; `output.subtitles` records each one.

**Popup.** `StreamChoice.subtitleTrackIds`; the default is one track per Settings language, in
order, never a forced one (`languageKey` maps ISO 639-2/B codes to /T, `pt-BR` takes `pt-BR` or
`pt`). A changed quality keeps the picks the new variant also offers.

## Known limitations

- **Subtitles.** fMP4 text (`wvtt`, `stpp`/TTML), CEA-608/708 captions inside the video, image and
  burned-in subtitles are not supported. A single MPEG-TS input whose PTS jumps without a
  discontinuity (FFmpeg corrects it itself) is timed by its first run. Progressive `<track>` files
  larger than 1.5 MB are not saved. `subtitleLanguages` is empty by default: nothing is ticked
  until the user ticks it or sets a language. Page subtitle files are offered with every video
  of the page (a page with several videos, or a single-page site moving from video to video,
  lists each file under each of them, until the page is reloaded), and only once the player has
  loaded them (usually when playback starts or the track is chosen). A page file in a language
  the manifest already has is not offered, even when its text differs. SRT, ASS and TTML files a
  player loads are not detected.
- **Progressive files.** Chrome's own downloads carry no Referer/Origin; the engine fallback
  needs the task's request context (lost after a browser restart until the video is played
  again), resumes with Range after a failure only when the server sends a strong ETag or Last-Modified (otherwise it starts over) and needs room for the file twice while
  Chrome saves it. Quitting Chrome normally cancels running downloads (Retry downloads again);
  resumption is Chrome's decision (server ranges and validators). Files show no resolution or
  codecs (no FFmpeg analysis). Audio-only files, Matroska/MOV, and files fetched by script are not
  listed; each candidate costs one 64 KiB request, so single-use links fail inspection; a server
  sending a decoy of exactly the detected size is not noticed; two links redirecting to the same
  file are listed twice.

- Merging is stream copy only: no re-encoding, so a forced MP4 of codecs MP4 cannot hold fails
  (after the download, keeping the data; since 0.6.0 the Queue offers
  Save as MKV, which merges the stored segments again). `auto` never has this problem.
- The pre-merge analysis reads where each track starts; the merge reads every packet, and the
  check after it only counts streams and compares the duration (it fails below half the expected
  length). Error pages sent with 200 instead of segments are refused while downloading
  (Phase 10); damaged media data inside a segment is not detected.
- Discontinuities are joined in time order by the concat demuxer; a codec or resolution change
  between runs is copied as is (MP4 and Matroska accept it, some players handle it badly).
  Packed-audio tracks (HLS `.aac` segments) carry their timestamps in ID3 tags that FFmpeg's
  demuxer ignores, so such a track starts at 0 and may be off by the video's start offset.
- MP4 files have their index at the end (no faststart): players that stream from a network
  need the whole file first; local playback is unaffected. The OPFS output could move it (it
  reads back fine); not done.
- **Memory while merging and saving a large video.** Since 0.4.0 the merged file is written to
  OPFS, on disk, and Chrome's memory hardly grows. Only when OPFS cannot be used does the output
  stream into Blob parts as before: Chrome keeps Blob data in its own (browser process) memory up
  to a limit that depends on the machine's RAM (on desktops about 1–2 GB) and pages the rest to
  disk, so such a merge raises Chrome's memory use by up to that much until the task is completed
  (blob URL revoked, FFmpeg worker ended after 10 s idle, offscreen document closed).
- FFmpeg's heap is 2 GiB, but the merge does not depend on it: outputs go to a file on disk (or
  stream into Blob parts). The disk needs room for the stored segments, the merged file while
  saving, and the saved copy at once, about three times the video's size at the peak (checked
  before merging). A 1.5 GB merge takes about 5 s in Chromium on a fast machine; slower disks
  and CPUs scale it.
- Saving uses the Downloads folder (Chrome's setting) or a subfolder of it (Settings, 0.4.0);
  a folder elsewhere cannot be chosen, and "Ask where to save each file" may still show a
  dialog. The subfolder is read when Chrome starts saving, so a change applies to saves that
  start afterwards.
- **Live streams** are not listed at all (0.4.0) until live download exists; a broken VOD
  playlist without `#EXT-X-ENDLIST` looks live and is hidden too. There is no "Open file" button: it needs the `downloads.open` permission.
- The merged file lives in the offscreen document until Chrome has saved it: a browser restart in
  that window means merging again (from the stored segments).
- The core is FFmpeg 5.1 from `@ffmpeg/core` 0.12.10, single-threaded, without SIMD; the
  project's last release dates from 2025. It is licensed GPL-2.0-or-later (it includes x264 and
  other GPL libraries): distributing the extension with it brings GPL obligations for the
  package, which is why StreamGrab itself is licensed GPL-3.0-or-later (compatible with both
  FFmpeg's GPL-2.0-or-later and the Apache-2.0 manifest parsers). It adds 32 MB to the extension.
- The end-to-end tests run the installed extension in Chrome for Testing, headless, against the
  local fixture site: notifications are not inspected, the Settings tab is checked by hand
  except its subfolder field (0.4.0; the Detected tab by component tests), and real sites are
  not part of any automated test.
- Size estimates are lower bounds (`+`) while a track has no samples: the audio tracks start
  after the video track, so for most of a download with separate audio its size is not
  included. Audio is usually a few percent of a video, but for low-bitrate video it can be a
  large share (about 40 % in the fixture site's demo). The download order is unchanged from 0.1.0.
- Estimates describe the downloaded data; the merged file is usually smaller (MPEG-TS overhead
  is dropped by the remux). The Completed tab shows the saved file's real size.
- A stall is noticed 8 s after the last report; a retry waiting in backoff shows as *Stalled*.
- Tasks downloaded before Phase 8 have no track layout: their processing fails asking for Retry,
  which reuses all their segments and then merges them.
- Orphaned data (a cancel cleanup that exceeded 15 s, a task removed while the engine was gone)
  is deleted when the service worker starts or the engine closes, not immediately.
- The disk-space check stops a download while 256 MiB are free; it does not estimate a
  download's size before starting (manifest bandwidths are peaks, too imprecise to refuse a
  download on). A download larger than the free space fails when it reaches the reserve, with
  its segments kept, and queued tasks that start meanwhile fail at their pre-check (one press of
  "Retry all failed" re-queues them). `navigator.storage.estimate()` counts the whole extension
  origin, and other programs can fill the disk between two checks; writes that fail then get the
  same disk-space message.
- A segment counts as complete by its marker and its part count, not by a checksum of its bytes.
  A Blob file damaged on disk would only show when merging. Chrome's IndexedDB uses relaxed
  durability: an OS crash can lose the last writes; resume verification then simply fetches the
  affected segments again.
- A failed task keeps its segments until it is retried or removed. Queuing the same video again
  as a new task (instead of Retry) downloads it from scratch; tasks do not share data.
- Streams whose segment list differs per request (server-side ad insertion) cannot resume: the
  plan signature differs on every run, so each run starts over (and a refresh mid-run fails
  with "The video changed on the server").
- After a browser restart the request context is gone by design. A site that needs the page's
  Referer fails with the restart message until the video is played again (in any tab) and the
  task retried; recovery is automatic only when a tab already lists the video when the task
  starts.
- Two tasks with different Referer/Origin contexts for the same host take turns: DNR rules are
  per host, so the second waits until the first ends. Tasks with the same context, or without
  one, run in parallel.
- Encrypted segments (AES-128) are held in memory whole while decrypted (max 256 MiB each);
  plain segments are streamed in 8 MiB parts.
- Selections and edited options live only while the popup is open (Chrome destroys the popup
  when it loses focus); queued tasks themselves are persistent.
- The file name typed by the user is cleaned by the service worker; the popup shows the
  cleaned name only afterwards, in the Queue tab.
- DASH details not handled: multiple Periods are joined only when their Representation ids
  match (a Period with new ids yields separate variants); per-Period changes of available
  representations, `Location` redirects of dynamic MPDs, XLink-resolved remote Periods, content
  steering and DVB fonts/events are ignored; SegmentBase files are split into fixed 16 MiB
  ranges rather than along their `sidx`; fMP4 subtitle adaptation sets are ignored (see Subtitles); for each audio
  adaptation set only its best bitrate is offered.
- The service-worker module graph is ~175 KB, mostly the manifest parsers and the XML parser
  `@xmldom/xmldom` needed by mpd-parser (no DOMParser exists in service workers). Rollup names
  that shared chunk after one of its modules (`chunks/engine-messages.js`).
- HLS details not handled yet: an `EXT-X-MAP` encrypted with AES-128 is not decrypted (rare;
  CMAF content uses SAMPLE-AES/cbcs); alternative
  video renditions (`TYPE=VIDEO`, multi-angle) are ignored; Low-Latency HLS partial segments are
  ignored in favour of full segments; the duration shown for a multivariant playlist comes from
  its first variant.
- SAMPLE-AES streams (identity key) are refused when queuing: their samples are encrypted inside
  the container. FFmpeg 5.1 can decrypt SAMPLE-AES only in its own HLS demuxer, which reads from
  the network, not from stored segments; supporting them is not planned.
- `chrome.runtime.reload()` of an extension that Puppeteer loaded is not tested: Chrome for
  Testing blocks the reloaded extension's pages in that setup. A real browser restart is tested
  instead (same effect on the engine and session storage).
- Manifests fetched by a page's own service worker reach the network with tabId −1 and are not
  attributed to a tab, so they are missed.
- Players that add `Authorization` or other custom headers to manifest requests are not
  replayed (by design: credentials are not captured). Such streams show HTTP 401/403.
- Single-use manifest URLs fail inspection because the extension requests them a second time.
- Two different videos whose URLs differ only in a token-like query parameter (e.g. `token=`)
  are merged into one entry.
- Same-document (SPA) navigations do not clear the list; streams from the previous view stay
  until the next full navigation or "Clear list". Back/forward-cache restores do not restore
  the list.
- When a frame has several `<video>` elements, script-loaded streams get the page title, not a
  per-element title (MSE players expose only `blob:` URLs, so the element cannot be matched).
- After install or update, tabs that were already open get the content script only after a
  reload. Network detection does not depend on it.
