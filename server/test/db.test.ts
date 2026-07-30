/** Ported from backend/tests/test_database.py. */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  closeDb,
  createProfile,
  deleteProfile,
  getProfile,
  initDb,
  listProfiles,
  updateProfile,
} from '../src/db.js';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'cbm-db-'));
  initDb(dir);
});

afterEach(() => {
  closeDb();
  rmSync(dir, { recursive: true, force: true });
});

describe('initDb', () => {
  it('is idempotent', () => {
    expect(() => initDb(dir)).not.toThrow();
    createProfile({ name: 'after reinit' });
    expect(listProfiles()).toHaveLength(1);
  });
});

describe('createProfile', () => {
  it('creates with sensible defaults', () => {
    const p = createProfile({ name: 'Test' });
    expect(p.name).toBe('Test');
    expect(p.id).toHaveLength(36); // UUID
    expect(p.fingerprint_seed).toBeGreaterThanOrEqual(10000);
    expect(p.fingerprint_seed).toBeLessThanOrEqual(99999);
    expect(p.user_data_dir.startsWith(dir)).toBe(true);
    expect(p.platform).toBe('windows');
    expect(p.created_at).toBeTruthy();
    expect(p.updated_at).toBeTruthy();
  });

  it('honours an explicit seed', () => {
    expect(createProfile({ name: 'Seeded', fingerprint_seed: 42 }).fingerprint_seed).toBe(42);
  });

  it('round-trips all fields', () => {
    const p = createProfile({
      name: 'Full',
      fingerprint_seed: 999,
      proxy: 'http://u:p@h:1',
      timezone: 'America/New_York',
      locale: 'en-US',
      platform: 'macos',
      user_agent: 'UA',
      screen_width: 1280,
      screen_height: 720,
      gpu_vendor: 'Apple',
      gpu_renderer: 'M1',
      hardware_concurrency: 8,
      humanize: true,
      human_preset: 'careful',
      headless: true,
      geoip: true,
      clipboard_sync: false,
      auto_launch: true,
      color_scheme: 'dark',
      launch_args: ['--foo', '--bar=1'],
      notes: 'hello',
    });

    expect(p.proxy).toBe('http://u:p@h:1');
    expect(p.platform).toBe('macos');
    expect(p.screen_width).toBe(1280);
    expect(p.hardware_concurrency).toBe(8);
    expect(p.human_preset).toBe('careful');
    expect(p.color_scheme).toBe('dark');
    expect(p.launch_args).toEqual(['--foo', '--bar=1']);
    expect(p.notes).toBe('hello');
  });

  it('stores booleans as real booleans, not 0/1', () => {
    const p = createProfile({
      name: 'Bools',
      humanize: true,
      headless: false,
      geoip: true,
      clipboard_sync: false,
      auto_launch: true,
    });
    expect(p.humanize).toBe(true);
    expect(p.headless).toBe(false);
    expect(p.geoip).toBe(true);
    expect(p.clipboard_sync).toBe(false);
    expect(p.auto_launch).toBe(true);
  });

  it('defaults clipboard_sync to true', () => {
    expect(createProfile({ name: 'Default' }).clipboard_sync).toBe(true);
  });

  it('persists tags', () => {
    const p = createProfile({
      name: 'Tagged',
      tags: [
        { tag: 'work', color: '#ff0000' },
        { tag: 'social', color: null },
      ],
    });
    expect(p.tags).toHaveLength(2);
    expect(p.tags.map((t) => t.tag).sort()).toEqual(['social', 'work']);
    expect(p.tags.find((t) => t.tag === 'work')?.color).toBe('#ff0000');
    expect(p.tags.find((t) => t.tag === 'social')?.color).toBeNull();
  });

  it('gives each profile a distinct id and data dir', () => {
    const a = createProfile({ name: 'A' });
    const b = createProfile({ name: 'B' });
    expect(a.id).not.toBe(b.id);
    expect(a.user_data_dir).not.toBe(b.user_data_dir);
  });
});

describe('getProfile', () => {
  it('returns null for an unknown id', () => {
    expect(getProfile('nope')).toBeNull();
  });

  it('returns the created profile', () => {
    const created = createProfile({ name: 'Fetch' });
    expect(getProfile(created.id)?.name).toBe('Fetch');
  });
});

describe('listProfiles', () => {
  it('is empty initially', () => {
    expect(listProfiles()).toEqual([]);
  });

  it('returns every profile', () => {
    createProfile({ name: 'One' });
    createProfile({ name: 'Two' });
    expect(listProfiles()).toHaveLength(2);
  });
});

describe('updateProfile', () => {
  it('returns null for an unknown id', () => {
    expect(updateProfile('nope', { name: 'X' })).toBeNull();
  });

  it('updates only the fields provided', () => {
    const p = createProfile({ name: 'Before', proxy: 'http://a:1', notes: 'keep' });
    const u = updateProfile(p.id, { name: 'After' })!;
    expect(u.name).toBe('After');
    expect(u.proxy).toBe('http://a:1'); // untouched
    expect(u.notes).toBe('keep');
  });

  it('can clear a nullable field', () => {
    const p = createProfile({ name: 'P', proxy: 'http://a:1' });
    expect(updateProfile(p.id, { proxy: null })!.proxy).toBeNull();
  });

  it('round-trips launch_args as JSON', () => {
    const p = createProfile({ name: 'P', launch_args: ['--a'] });
    expect(updateProfile(p.id, { launch_args: ['--b', '--c'] })!.launch_args).toEqual([
      '--b',
      '--c',
    ]);
  });

  it('coerces booleans on update', () => {
    const p = createProfile({ name: 'P', humanize: false });
    const u = updateProfile(p.id, { humanize: true, auto_launch: true })!;
    expect(u.humanize).toBe(true);
    expect(u.auto_launch).toBe(true);
  });

  it('replaces tags wholesale', () => {
    const p = createProfile({ name: 'P', tags: [{ tag: 'old', color: null }] });
    const u = updateProfile(p.id, { tags: [{ tag: 'new', color: '#fff' }] })!;
    expect(u.tags).toHaveLength(1);
    expect(u.tags[0].tag).toBe('new');
  });

  it('leaves tags alone when not supplied', () => {
    const p = createProfile({ name: 'P', tags: [{ tag: 'keep', color: null }] });
    expect(updateProfile(p.id, { name: 'Renamed' })!.tags).toHaveLength(1);
  });

  it('bumps updated_at', async () => {
    const p = createProfile({ name: 'P' });
    await new Promise((r) => setTimeout(r, 5));
    expect(updateProfile(p.id, { name: 'Q' })!.updated_at).not.toBe(p.updated_at);
  });
});

describe('deleteProfile', () => {
  it('returns false for an unknown id', () => {
    expect(deleteProfile('nope')).toBe(false);
  });

  it('removes the profile', () => {
    const p = createProfile({ name: 'Doomed' });
    expect(deleteProfile(p.id)).toBe(true);
    expect(getProfile(p.id)).toBeNull();
  });

  it('cascades to tags', () => {
    const p = createProfile({ name: 'Doomed', tags: [{ tag: 't', color: null }] });
    deleteProfile(p.id);
    const revived = createProfile({ name: 'New' });
    expect(revived.tags).toEqual([]);
  });
});
