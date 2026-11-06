import { describe, expect, it } from 'vitest';
import { scanDashManifest } from '@/core/protocols/dash/dash-scan';
import dashDrm from '@tests/fixtures/manifests/dash/drm.mpd?raw';
import dashDynamic from '@tests/fixtures/manifests/dash/dynamic.mpd?raw';
import dashStatic from '@tests/fixtures/manifests/dash/static-separate-av.mpd?raw';

describe('scanDashManifest', () => {
  it('reads static and dynamic presentations', () => {
    expect(scanDashManifest(dashStatic)).toEqual({ live: false, drmSystems: [], encryption: 'none' });
    expect(scanDashManifest(dashDynamic)?.live).toBe(true);
  });

  it('detects Widevine and PlayReady protection, case-insensitively', () => {
    expect(scanDashManifest(dashDrm)).toEqual({ live: false, drmSystems: ['widevine', 'playready'], encryption: 'cenc' });
  });

  it('treats a bare CENC marker or an unknown scheme as DRM', () => {
    const mpd = (protection: string) => `<MPD type="static"><Period><AdaptationSet>${protection}</AdaptationSet></Period></MPD>`;
    expect(scanDashManifest(mpd('<ContentProtection schemeIdUri="urn:mpeg:dash:mp4protection:2011"/>'))?.drmSystems).toEqual([
      'unknown',
    ]);
    expect(scanDashManifest(mpd('<ContentProtection schemeIdUri="urn:uuid:0000"/>'))?.drmSystems).toEqual(['unknown']);
  });

  it('ignores protection inside comments and type="dynamic" outside the root element', () => {
    const text = '<MPD type="static"><!-- <ContentProtection schemeIdUri="x"/> --><Period type="dynamic"/></MPD>';
    expect(scanDashManifest(text)).toEqual({ live: false, drmSystems: [], encryption: 'none' });
  });

  it('returns null for non-MPD documents', () => {
    expect(scanDashManifest('<?xml version="1.0"?><SmoothStreamingMedia/>')).toBeNull();
    expect(scanDashManifest('#EXTM3U')).toBeNull();
  });
});
