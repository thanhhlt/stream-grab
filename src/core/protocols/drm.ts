import type { DrmSystem } from '@/core/models/detected-stream';

const DRM_NAMES: Record<DrmSystem, string> = {
  widevine: 'Widevine',
  playready: 'PlayReady',
  fairplay: 'FairPlay',
  clearkey: 'Clear Key',
  unknown: 'an unidentified',
};

/** User-facing explanation for DRM-protected streams, which are never downloaded. */
export function describeDrm(systems: readonly DrmSystem[]): string {
  const names = systems.map((system) => DRM_NAMES[system]);
  return `Protected by ${names.join(' / ')} DRM. DRM-protected streams are not supported.`;
}
