# StreamGrab privacy policy

Last updated: 13 November 2026 (StreamGrab 0.9.0)

StreamGrab is a browser extension that saves the videos a web page plays. It runs entirely in
your browser. It has no server, no account and no analytics, and **it does not collect, sell or
share any data about you**.

## What StreamGrab reads

- **Network requests of the pages you visit.** StreamGrab looks at the address (URL), status,
  `Content-Type` and `Content-Length` of the requests your tabs make, to recognise video
  manifests (HLS `.m3u8`, DASH `.mpd`), video files (MP4, WebM) and subtitle files (WebVTT), and
  keeps the `Referer` and `Origin` of those media requests. It does not read the content of
  other requests or form data, and it does not keep or use cookies or any other header.
- **The page itself, through a content script.** On every http(s) page it reads the page title
  and the page's title metadata (social and structured-data tags), the `<video>`, `<source>` and
  `<track>` elements with their labels, size and duration, and the subtitle cues a player holds,
  so a video can be listed with a useful name and the right subtitles. It does not read what you
  type, and it never runs code from the page.

YouTube sites are excluded: StreamGrab does not run on them and does not detect or download their
videos.

## What StreamGrab stores, and where

Everything stays on your computer, in the extension's own storage in your Chrome profile:

- the videos detected in each open tab (cleared when the tab closes or the browser restarts),
- your download tasks and the downloaded parts of each video, until the video is saved or you
  remove the task,
- the list of saved videos shown in the Completed tab (title, the page and the video's address,
  quality, size, and where and when the file was saved), until you remove it,
- your settings.

Saved videos go to your Downloads folder through Chrome's own downloads. Removing the extension
deletes everything it stored; the saved video files stay where Chrome saved them.

## What StreamGrab sends, and to whom

StreamGrab only connects to the sites a page itself loads video from: to read a detected video's
manifest, the first bytes of a video file or a subtitle file, so the video can be listed, and to
download the videos you pick. These requests carry the page's Referer and Origin and the
browser's own cookies for that site, as the page's player does, so the site serves them as it
does to its own player. Nothing about you or your browsing is sent to the developer or to any
third party.

The links in the popup (source code, Report a problem, What's new, Ko-fi) open in a new tab only
when you click them. Donating is voluntary and unlocks nothing.

## Permissions

Each permission the extension asks for, and why:

| Permission | Why |
|---|---|
| `webRequest` | Sees the URL, status, Content-Type and Content-Length of a tab's requests to recognise video manifests, video files and subtitles, and keeps the Referer and Origin of those media requests. Read only: requests are never blocked or changed. |
| `declarativeNetRequestWithHostAccess` | Adds the page's Referer and Origin to the extension's own requests for a video, since many video servers refuse requests without them. Requests of web pages are never changed. |
| `storage` | Keeps your settings, the videos detected in each tab and the download tasks. |
| `unlimitedStorage` | Keeps downloaded segments until they are merged; a long video can be several gigabytes. |
| `offscreen` | Runs the download engine and FFmpeg (WebAssembly) in an offscreen document. |
| `downloads` | Saves the finished video and its subtitles to your Downloads folder and shows them there. |
| `notifications` | Tells you when a video is saved or a download fails. |
| Host access to `http://*/*` and `https://*/*` | Any site can play a video: the extension must see a page's media requests and fetch the video from the site that hosts it. |
| Content script on http(s) pages | Reads the page title and the page's video, source and track elements so detected videos get a name, a duration and the right subtitles. It never runs page code and is not injected on YouTube. |

## Children

StreamGrab is a general-purpose tool and does not knowingly collect information from anyone,
including children.

## Changes

If this policy changes, the new version is published at this address with a new date, and the
change is noted in the [changelog](../CHANGELOG.md). A change that sends data anywhere would be
announced before it ships.

## Contact

Questions or concerns: open an issue at
[github.com/thanhhlt/stream-grab/issues](https://github.com/thanhhlt/stream-grab/issues).
