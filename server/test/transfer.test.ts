import { describe, expect, it } from 'vitest';

import { buildExport, readImport, resolveName, slugify, toExportEntry } from '../src/transfer.js';
import type { ProfileRow } from '../src/schemas.js';

function row(overrides: Partial<ProfileRow> = {}): ProfileRow {
  return {
    id: 'id-1',
    name: 'Test',
    fingerprint_seed: 12345,
    proxy: null,
    timezone: null,
    locale: null,
    platform: 'windows',
    user_agent: null,
    screen_width: 1920,
    screen_height: 1080,
    gpu_vendor: null,
    gpu_renderer: null,
    hardware_concurrency: null,
    humanize: false,
    human_preset: 'default',
    headless: false,
    geoip: false,
    clipboard_sync: true,
    auto_launch: false,
    color_scheme: null,
    launch_args: [],
    notes: null,
    user_data_dir: '/data/profiles/id-1',
    created_at: '2026-01-01T00:00:00.000000+00:00',
    updated_at: '2026-01-02T00:00:00.000000+00:00',
    tags: [],
    ...overrides,
  };
}

describe('toExportEntry', () => {
  it('drops exactly the install-specific fields and keeps the rest', () => {
    const entry = toExportEntry(row({ launch_args: ['--x'], tags: [{ tag: 't', color: null }] }));

    for (const key of ['id', 'user_data_dir', 'created_at', 'updated_at']) {
      expect(entry).not.toHaveProperty(key);
    }
    // Everything that defines the profile's identity must survive.
    expect(entry.name).toBe('Test');
    expect(entry.fingerprint_seed).toBe(12345);
    expect(entry.launch_args).toEqual(['--x']);
    expect(entry.tags).toEqual([{ tag: 't', color: null }]);
  });
});

describe('buildExport', () => {
  it('wraps profiles in a versioned envelope', () => {
    const out = buildExport([row({ name: 'A' }), row({ id: 'id-2', name: 'B' })], 'STAMP');
    expect(out.version).toBe(1);
    expect(out.exported_at).toBe('STAMP');
    expect(out.profiles.map((p) => p.name)).toEqual(['A', 'B']);
  });
});

describe('readImport', () => {
  it('accepts the envelope shape', () => {
    expect(readImport({ profiles: [1, 2] })).toEqual([1, 2]);
  });

  it('accepts a bare array', () => {
    expect(readImport([1, 2])).toEqual([1, 2]);
  });
});

describe('resolveName', () => {
  it('keeps a free name unchanged', () => {
    expect(resolveName('Fresh', new Set())).toBe('Fresh');
  });

  it('suffixes a taken name rather than colliding', () => {
    expect(resolveName('Dup', new Set(['Dup']))).toBe('Dup (imported)');
  });

  it('counts upward when the suffixed name is also taken', () => {
    expect(resolveName('Dup', new Set(['Dup', 'Dup (imported)']))).toBe('Dup (imported 2)');
    expect(resolveName('Dup', new Set(['Dup', 'Dup (imported)', 'Dup (imported 2)']))).toBe(
      'Dup (imported 3)'
    );
  });

  it('never returns a name already in the set', () => {
    // The batch importer adds each result back into `taken`, so this invariant is
    // what stops two entries in one file from both becoming the same profile name.
    const taken = new Set(['X']);
    for (let i = 0; i < 5; i++) {
      const name = resolveName('X', taken);
      expect(taken.has(name)).toBe(false);
      taken.add(name);
    }
  });
});

describe('slugify', () => {
  it('produces a filename-safe slug', () => {
    expect(slugify('My Profile')).toBe('my-profile');
    expect(slugify('Amazon Seller #1')).toBe('amazon-seller-1');
    expect(slugify('  spaced  out  ')).toBe('spaced-out');
  });

  it('falls back rather than returning an empty filename', () => {
    expect(slugify('!!!')).toBe('profile');
    expect(slugify('')).toBe('profile');
  });

  it('caps the length', () => {
    expect(slugify('a'.repeat(100)).length).toBeLessThanOrEqual(40);
  });
});
