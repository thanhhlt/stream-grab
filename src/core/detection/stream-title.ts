import type { FrameMetadata } from '@/shared/types/page-metadata';
import { cleanText } from '@/shared/types/page-metadata';
import type { PageInfo } from './detection-manager';

/** Titles that name the widget rather than the video. */
const GENERIC_TITLE = /^(?:video|videos|player|video player|media player|embed|embedded video|iframe|untitled|loading\.*|home|watch)$/i;

export function isUsefulTitle(title: string | undefined): title is string {
  return title !== undefined && !GENERIC_TITLE.test(title);
}

export interface TitleSources {
  /** Metadata of the frame that loaded the manifest. */
  frame: FrameMetadata | null;
  /** Metadata of the top frame (same object as `frame` when the manifest came from the top frame). */
  top: FrameMetadata | null;
  tab: { url?: string | undefined; title?: string | undefined } | null;
}

/**
 * Best available title for a stream, most specific first: the frame's only
 * <video> element, structured data of the frame (JSON-LD, og:title), the
 * frame's document title (embedded players usually title their document after
 * the video), then the same for the top page, then the tab title.
 */
export function buildPageInfo({ frame, top, tab }: TitleSources): PageInfo {
  const onlyVideo = frame?.videos.length === 1 ? frame.videos[0] : undefined;
  const topTitle = [top?.structuredTitle, top?.socialTitle, top?.documentTitle, cleanText(tab?.title)].find(isUsefulTitle);
  const title = [
    onlyVideo?.title,
    frame?.structuredTitle,
    frame?.socialTitle,
    frame?.documentTitle,
    topTitle,
  ].find(isUsefulTitle);

  const info: PageInfo = {};
  if (title !== undefined) info.title = title;
  if (topTitle !== undefined) info.pageTitle = topTitle;
  const pageUrl = tab?.url ?? top?.url;
  if (pageUrl !== undefined) info.pageUrl = pageUrl;
  if (onlyVideo?.duration !== undefined) info.durationHint = onlyVideo.duration;
  return info;
}
