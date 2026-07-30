/**
 * The release filter is the part of binary.ts that is ours rather than
 * cloakbrowser's, and getting it wrong offers an "update" that can never be
 * downloaded — Pro releases publish a tag but no archive.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  archiveNameFor,
  fetchLatestFreeVersion,
  pickLatestFreeVersion,
  resetLatestCache,
  versionNewer,
} from '../src/binary.js';

const LINUX_ARCHIVE = 'cloakbrowser-linux-x64.tar.gz';

/** Shape of the real GitHub payload, verified against the live API. */
const RELEASES = [
  {
    tag_name: 'chromium-v150.0.7871.114.3-pro',
    assets: [{ name: 'SHA256SUMS.sig' }],
  },
  {
    tag_name: 'v0.5.3',
    assets: [],
  },
  {
    tag_name: 'chromium-v146.0.7680.177.5',
    assets: [
      { name: LINUX_ARCHIVE },
      { name: 'cloakbrowser-windows-x64.zip' },
      { name: 'SHA256SUMS.sig' },
    ],
  },
];

describe('pickLatestFreeVersion', () => {
  it('skips pro tags, which ship no binary', () => {
    expect(pickLatestFreeVersion(RELEASES, 'linux-x64')).toBe('146.0.7680.177.5');
  });

  it('skips a chromium release with no archive for this platform', () => {
    expect(pickLatestFreeVersion(RELEASES, 'darwin-arm64')).toBeNull();
  });

  it('ignores wrapper releases', () => {
    expect(pickLatestFreeVersion([{ tag_name: 'v0.5.3', assets: [] }], 'linux-x64')).toBeNull();
  });

  it('skips drafts', () => {
    const drafts = [
      { tag_name: 'chromium-v147.0.0.0', draft: true, assets: [{ name: LINUX_ARCHIVE }] },
      { tag_name: 'chromium-v146.0.7680.177.5', assets: [{ name: LINUX_ARCHIVE }] },
    ];
    expect(pickLatestFreeVersion(drafts, 'linux-x64')).toBe('146.0.7680.177.5');
  });

  it('returns null for an empty release list', () => {
    expect(pickLatestFreeVersion([], 'linux-x64')).toBeNull();
  });
});

describe('fetchLatestFreeVersion', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    resetLatestCache();
  });

  const okResponse = () =>
    ({ ok: true, status: 200, json: async () => RELEASES }) as unknown as Response;

  it('reads the newest usable release and caches it', async () => {
    const fetchMock = vi.fn(async () => okResponse());
    vi.stubGlobal('fetch', fetchMock);

    expect(await fetchLatestFreeVersion('linux-x64')).toBe('146.0.7680.177.5');
    expect(await fetchLatestFreeVersion('linux-x64')).toBe('146.0.7680.177.5');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('caches a miss too, so a rate-limited API is not re-hit every poll', async () => {
    // 403 is the routine anonymous rate-limit response, not an exceptional case.
    const fetchMock = vi.fn(async () => ({ ok: false, status: 403 }) as unknown as Response);
    vi.stubGlobal('fetch', fetchMock);

    expect(await fetchLatestFreeVersion('linux-x64')).toBeNull();
    expect(await fetchLatestFreeVersion('linux-x64')).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('reports null rather than throwing when the network is unreachable', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('getaddrinfo ENOTFOUND api.github.com');
      })
    );
    await expect(fetchLatestFreeVersion('linux-x64')).resolves.toBeNull();
  });
});

describe('archiveNameFor', () => {
  it('uses a zip on Windows and a tarball elsewhere', () => {
    expect(archiveNameFor('windows-x64')).toBe('cloakbrowser-windows-x64.zip');
    expect(archiveNameFor('linux-arm64')).toBe('cloakbrowser-linux-arm64.tar.gz');
  });
});

describe('versionNewer', () => {
  it('compares the four-part CloakBrowser version numerically', () => {
    // Lexical comparison would call .177.5 newer than .177.10.
    expect(versionNewer('146.0.7680.177.10', '146.0.7680.177.5')).toBe(true);
    expect(versionNewer('146.0.7680.177.5', '146.0.7680.177.5')).toBe(false);
    expect(versionNewer('146.0.7680.177.5', '148.0.7778.215.3')).toBe(false);
  });

  it('treats a missing trailing component as zero', () => {
    expect(versionNewer('146.0.7680.177', '146.0.7680.177.1')).toBe(false);
    expect(versionNewer('146.0.7680.177.1', '146.0.7680.177')).toBe(true);
  });

  it('never reports newer for an unparseable version', () => {
    expect(versionNewer('not-a-version', '146.0.7680.177.5')).toBe(false);
  });
});
