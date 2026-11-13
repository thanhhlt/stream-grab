import { describe, expect, it } from 'vitest';
import { involvesBlockedSite, isBlockedHost, isBlockedUrl } from '@/core/detection/blocked-sites';

describe('blocked sites', () => {
  it('blocks YouTube, its short links, privacy-enhanced embeds and media hosts, with subdomains', () => {
    for (const host of [
      'youtube.com',
      'www.youtube.com',
      'm.youtube.com',
      'music.youtube.com',
      'youtu.be',
      'www.youtube-nocookie.com',
      'www.youtubekids.com',
      'youtube.googleapis.com',
      'rr3---sn-8qj-i5oe.googlevideo.com',
      'WWW.YouTube.COM',
      'www.youtube.com.',
    ]) {
      expect(isBlockedHost(host), host).toBe(true);
    }
  });

  it('does not block look-alike or unrelated hosts', () => {
    for (const host of ['notyoutube.com', 'youtube.com.example.org', 'myyoutu.be', 'googlevideo.example.com', 'video.google.com', 'googleapis.com', 'www.googleapis.com', 'cdn.example.com']) {
      expect(isBlockedHost(host), host).toBe(false);
    }
  });

  it('checks http(s) URLs only and tolerates absent or malformed ones', () => {
    expect(isBlockedUrl('https://www.youtube.com/watch?v=abc')).toBe(true);
    expect(isBlockedUrl('http://youtu.be/abc')).toBe(true);
    expect(isBlockedUrl('https://example.com/?next=https://www.youtube.com/')).toBe(false);
    expect(isBlockedUrl(undefined)).toBe(false);
    expect(isBlockedUrl('not a url')).toBe(false);
    expect(isBlockedUrl('chrome://extensions')).toBe(false);
  });

  it('flags a request when any related URL is on a blocked site', () => {
    expect(involvesBlockedSite('https://cdn.example.com/a.mp4', undefined, 'https://www.youtube.com/')).toBe(true);
    expect(involvesBlockedSite('https://cdn.example.com/a.mp4', 'https://site.example/watch', undefined)).toBe(false);
    expect(involvesBlockedSite()).toBe(false);
  });
});
