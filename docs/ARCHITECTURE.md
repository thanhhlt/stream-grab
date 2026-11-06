# StreamGrab architecture

Living design notes. Requirements are in [SPEC.md](SPEC.md); this file records how they map onto
Manifest V3 and why.

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
| `downloads`                           | Save the merged file                                                                         | Phase 9   |
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
   subtitle and asset extensions are never manifests. Only `GET` 2xx/304 responses of type
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
  `isLive` set; the popup says live download is not supported yet. Whether to record live
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
  The popup marks them live; downloading live streams is not supported yet.
- **Caching and requests** work as for HLS (shared `ManifestCache`, post-redirect aliases,
  `prefetched` body from detection, page request context replayed): one MPD is fetched and
  parsed once for detection, variant listing and segment lists of every representation.

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
  become unavailable drop out by themselves. Each card shows the current choice
  ("720p · English ▾") and expands into options: quality (with bitrate), the audio tracks
  offered for that quality (several may be ticked), and the file name with the extension that
  the output format implies. "Download this video" queues one; "Download (n)" queues the
  selection, each with its own choice.
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
         InputFs /in (mounted Blobs, read in 4 MiB chunks)   SinkFs /out (outputs streamed into Blob parts)
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
  copied into the heap. Outputs are written to `/out`, which streams them into Blob parts
  (SinkFs, Phase 9; Phase 8 used MEMFS). Every command unmounts its inputs and clears `/out`, and its
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
| Merged file while saving     | Blob (offscreen document) | Streamed out of FFmpeg in parts; a blob: URL Chrome reads; released after the save |
| Saved file                   | Downloads folder          | Path, size and download ID on the task (`output.saved`), for the Completed tab |

## Merging and saving (Phase 9)

```
offscreen: MediaManager job ─ analyseTask ─ mergeTask ─────────────────────────────▶ blob: URL
             tracks → runs (init / discontinuity) → FFmpeg -c copy → SinkFs → Blob ─ ffprobe check
             ── engine/save {taskId, url, container, size, media} ──▶
service worker: DownloadCoordinator.startSave
             chrome.downloads.download({url, filename: baseName + .mp4|.mkv, conflictAction: 'uniquify'})
             task: processing (stage saving, downloadId)
chrome.downloads.onChanged (complete | interrupted) ──▶ #settleSave
             complete: task completed (saved path, size), segments deleted, notification, pump
             interrupted: task failed with Chrome's reason, segments kept
             pump → engine/sync without the task → MediaManager revokes the blob: URL
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
  alternative audio track; `-map 0:V? -map 0:a? -map N:a` (no cover art, no data or subtitle
  streams), `-c copy`, no re-encoding. FFmpeg starts every input at 0, which would lose the
  offset between separately delivered audio and video, so each input gets `-itsoffset` = its
  start (probed: `startSec`) minus the earliest track's. Metadata: `-map_metadata -1` (no
  encoder or service tags from the inputs), the page title as `title`, each audio stream's
  ISO 639-2 language (`languages.ts` maps manifest codes such as `en`, `pt-BR`), its manifest
  name as `title` and, in MP4, as `handler_name` (what players show for MP4 tracks; a name that
  is only the language code is left out), the first audio stream as default. HEVC in MP4 is
  tagged `hvc1`. No `faststart`: moving the index to the front means rewriting the file.
- **Streaming output** (`output-sink.ts`, `sink-fs.ts`). `/out` is a custom Emscripten
  filesystem whose files are BlobSinks: the first 1 MiB stays in memory (muxers patch sizes and
  durations there at the end), the most recent ≤ 64 MiB too, everything older is flushed into
  32 MiB Blob parts (Chrome keeps large Blob data on disk). The merged file is therefore never in
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
  container's extension) in the Downloads folder, `conflictAction: 'uniquify'` (an existing file
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
  size of the segments; Chrome keeps large Blobs on disk) and the copy Chrome saves need room on
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
  Not covered there: notifications (headless Chrome has no notification center to inspect), the
  popup's own rendering (covered by component tests), and real sites.
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

## Known limitations

- Merging is stream copy only: no re-encoding, so a forced MP4 of codecs MP4 cannot hold fails
  (after the download, keeping the data; a task's format cannot be changed, so it must be
  downloaded again with Auto or MKV). `auto` never has this problem.
- The pre-merge analysis reads where each track starts; the merge reads every packet, and the
  check after it only counts streams and compares the duration (it fails below half the expected
  length). Error pages sent with 200 instead of segments are refused while downloading
  (Phase 10); damaged media data inside a segment is not detected.
- Discontinuities are joined in time order by the concat demuxer; a codec or resolution change
  between runs is copied as is (MP4 and Matroska accept it, some players handle it badly).
  Packed-audio tracks (HLS `.aac` segments) carry their timestamps in ID3 tags that FFmpeg's
  demuxer ignores, so such a track starts at 0 and may be off by the video's start offset.
- MP4 files have their index at the end (no faststart): players that stream from a network
  need the whole file first; local playback is unaffected.
- FFmpeg's heap is 2 GiB, but the merge does not depend on it: outputs stream into Blob parts.
  Chrome's own Blob storage limits remain (it pages large Blobs to disk; the disk needs room for
  the stored segments, the merged file while saving, and the saved copy at once, about three
  times the video's size at the peak; checked before merging). A 1.5 GB merge takes about 5 s
  in Chromium on a fast machine; slower disks and CPUs scale it.
- Saving uses the Downloads folder (Chrome's setting; "Ask where to save each file" may still
  show a dialog). There is no "Open file" button: it needs the `downloads.open` permission.
- The merged file lives in the offscreen document until Chrome has saved it: a browser restart in
  that window means merging again (from the stored segments).
- The core is FFmpeg 5.1 from `@ffmpeg/core` 0.12.10, single-threaded, without SIMD; the
  project's last release dates from 2025. It is licensed GPL-2.0-or-later (it includes x264 and
  other GPL libraries): distributing the extension with it brings GPL obligations for the
  package. It adds 32 MB to the extension.
- The end-to-end tests run the installed extension in Chrome for Testing, headless, against the
  local fixture site: notifications are not inspected, the Detected and Settings tabs are only
  checked by hand, and real sites are not part of any automated test.
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
  ranges rather than along their `sidx`; subtitle adaptation sets are ignored; for each audio
  adaptation set only its best bitrate is offered.
- The service-worker module graph is ~175 KB, mostly the manifest parsers and the XML parser
  `@xmldom/xmldom` needed by mpd-parser (no DOMParser exists in service workers). Rollup names
  that shared chunk after one of its modules (`chunks/engine-messages.js`).
- HLS details not handled yet: an `EXT-X-MAP` encrypted with AES-128 is not decrypted (rare;
  CMAF content uses SAMPLE-AES/cbcs); subtitle renditions (`TYPE=SUBTITLES`) and alternative
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
