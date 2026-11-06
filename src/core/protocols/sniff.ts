import type { StreamingProtocol } from '@/core/models/detected-stream';

const BOM = new RegExp('^\\uFEFF');
export const XML_PREAMBLE = /^\s*(?:<\?xml[^>]*\?>\s*)?(?:<!--[\s\S]*?-->\s*|<!DOCTYPE[^>]*>\s*)*/i;
export const MPD_ROOT = /^<(?:[\w.-]+:)?MPD[\s>/]/;

/** Protocol from the first bytes of a body, or null when it is neither an HLS playlist nor an MPD. */
export function sniffManifest(prefix: string): StreamingProtocol | null {
  const text = prefix.replace(BOM, '');
  if (/^\s*#EXTM3U/.test(text)) return 'hls';
  const afterPreamble = text.replace(XML_PREAMBLE, '');
  if (MPD_ROOT.test(afterPreamble)) return 'dash';
  return null;
}
