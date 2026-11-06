import type { DrmSystem, EncryptionKind } from '@/core/models/detected-stream';
import { MPD_ROOT, XML_PREAMBLE } from '@/core/protocols/sniff';

/**
 * Raw-XML facts read without the parser: whether the MPD is dynamic (live)
 * and which DRM systems protect it. The scan is the authority for both: the
 * parser's own `endList` is not reliable for dynamic MPDs, and DRM must be
 * detected even where the parser would not list it.
 */
export interface DashScan {
  live: boolean;
  drmSystems: DrmSystem[];
  encryption: EncryptionKind;
}

const DASH_SCHEME_SYSTEMS: Record<string, DrmSystem> = {
  'urn:uuid:edef8ba9-79d6-4ace-a3c8-27dcd51d21ed': 'widevine',
  'urn:uuid:9a04f079-9840-4286-ab92-e65be0885f95': 'playready',
  'urn:uuid:79f0049a-4098-8642-ab92-e65be0885f95': 'playready',
  'urn:uuid:94ce86fb-07ff-4f43-adb8-93d2fa968ca2': 'fairplay',
  'urn:uuid:e2719d58-a985-b3c9-781a-b030af78d30e': 'clearkey',
  'urn:uuid:1077efec-c0b2-4d02-ace3-3c1e52e2fb4b': 'clearkey',
};
const CENC_MARKER = 'urn:mpeg:dash:mp4protection:2011';
const BOM = new RegExp('^\\uFEFF');

/** Scans an MPD; null when the root element is not <MPD>. */
export function scanDashManifest(text: string): DashScan | null {
  const body = text.replace(BOM, '').replace(/<!--[\s\S]*?-->/g, '');
  const afterPreamble = body.replace(XML_PREAMBLE, '');
  if (!MPD_ROOT.test(afterPreamble)) return null;
  const rootTag = /^<(?:[\w.-]+:)?MPD\b[^>]*>/.exec(afterPreamble)?.[0] ?? '';
  const live = /\stype\s*=\s*["']dynamic["']/i.test(rootTag);

  const drmSystems = new Set<DrmSystem>();
  let protectedContent = false;
  for (const match of body.matchAll(/<(?:[\w.-]+:)?ContentProtection\b([^>]*)>/gi)) {
    protectedContent = true;
    const scheme = /schemeIdUri\s*=\s*["']([^"']+)["']/i.exec(match[1] ?? '')?.[1]?.toLowerCase() ?? '';
    const system = DASH_SCHEME_SYSTEMS[scheme];
    if (system) drmSystems.add(system);
  }
  if (protectedContent && drmSystems.size === 0) drmSystems.add('unknown');
  // A bare CENC marker without a known system is still DRM: the keys come from a licence server.
  if (body.toLowerCase().includes(CENC_MARKER) && drmSystems.size === 0) drmSystems.add('unknown');

  return { live, drmSystems: [...drmSystems], encryption: protectedContent ? 'cenc' : 'none' };
}
