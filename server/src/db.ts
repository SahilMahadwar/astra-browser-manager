/**
 * SQLite persistence for browser profiles. Ported from backend/database.py.
 *
 * The schema and the three ALTER TABLE migrations must stay byte-compatible
 * with the Python version — existing installs have live data in the
 * `cloakprofiles` volume and must keep working across the backend swap.
 */

import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

import type { ProfileRow, TagCreate, TagResponse } from './schemas.js';

/**
 * Root of the persistent volume. Resolved at initDb() time rather than at
 * import time so tests can redirect it to a temp directory (the Python suite
 * monkeypatches database.DATA_DIR for the same reason).
 */
let dataDir = process.env.CLOAKBROWSER_DATA_DIR || '/data';

export function getDataDir(): string {
  return dataDir;
}

let db: DatabaseSync | null = null;

function conn(): DatabaseSync {
  if (!db) throw new Error('Database not initialized — call initDb() first');
  return db;
}

export function initDb(dir?: string): void {
  dataDir = dir ?? process.env.CLOAKBROWSER_DATA_DIR ?? '/data';
  const dbPath = path.join(dataDir, 'profiles.db');

  mkdirSync(path.dirname(dbPath), { recursive: true });
  db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode=WAL');
  db.exec('PRAGMA foreign_keys=ON');

  db.exec(`
    CREATE TABLE IF NOT EXISTS profiles (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        fingerprint_seed INTEGER NOT NULL,
        proxy TEXT,
        timezone TEXT,
        locale TEXT,
        platform TEXT DEFAULT 'windows',
        user_agent TEXT,
        screen_width INTEGER DEFAULT 1920,
        screen_height INTEGER DEFAULT 1080,
        gpu_vendor TEXT,
        gpu_renderer TEXT,
        hardware_concurrency INTEGER,
        humanize BOOLEAN DEFAULT 0,
        human_preset TEXT DEFAULT 'default',
        headless BOOLEAN DEFAULT 0,
        geoip BOOLEAN DEFAULT 0,
        clipboard_sync BOOLEAN DEFAULT 1,
        auto_launch BOOLEAN DEFAULT 0,
        color_scheme TEXT,
        notes TEXT,
        user_data_dir TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS profile_tags (
        profile_id TEXT REFERENCES profiles(id) ON DELETE CASCADE,
        tag TEXT NOT NULL,
        color TEXT,
        PRIMARY KEY (profile_id, tag)
    );
  `);

  // Migrations for databases created by older versions.
  const cols = new Set(
    (db.prepare('PRAGMA table_info(profiles)').all() as Array<{ name: string }>).map(
      (r) => r.name
    )
  );
  if (!cols.has('clipboard_sync')) {
    db.exec('ALTER TABLE profiles ADD COLUMN clipboard_sync BOOLEAN DEFAULT 1');
  }
  if (!cols.has('launch_args')) {
    db.exec("ALTER TABLE profiles ADD COLUMN launch_args TEXT DEFAULT '[]'");
  }
  if (!cols.has('auto_launch')) {
    db.exec('ALTER TABLE profiles ADD COLUMN auto_launch BOOLEAN DEFAULT 0');
  }
}

export function closeDb(): void {
  db?.close();
  db = null;
}

function now(): string {
  return new Date().toISOString().replace(/\.(\d{3})Z$/, '.$1000+00:00');
}

/** SQLite has no boolean type — columns come back as 0/1 integers. */
function toBool(v: unknown, fallback = false): boolean {
  if (v === null || v === undefined) return fallback;
  return Boolean(v);
}

type RawRow = Record<string, unknown>;

function rowToProfile(row: RawRow, tags: TagResponse[]): ProfileRow {
  return {
    id: row.id as string,
    name: row.name as string,
    fingerprint_seed: row.fingerprint_seed as number,
    proxy: (row.proxy as string) ?? null,
    timezone: (row.timezone as string) ?? null,
    locale: (row.locale as string) ?? null,
    platform: (row.platform as string) ?? 'windows',
    user_agent: (row.user_agent as string) ?? null,
    screen_width: (row.screen_width as number) ?? 1920,
    screen_height: (row.screen_height as number) ?? 1080,
    gpu_vendor: (row.gpu_vendor as string) ?? null,
    gpu_renderer: (row.gpu_renderer as string) ?? null,
    hardware_concurrency: (row.hardware_concurrency as number) ?? null,
    humanize: toBool(row.humanize),
    human_preset: (row.human_preset as string) ?? 'default',
    headless: toBool(row.headless),
    geoip: toBool(row.geoip),
    // Matches Pydantic's coerce_clipboard_sync: null means "on".
    clipboard_sync: toBool(row.clipboard_sync, true),
    auto_launch: toBool(row.auto_launch),
    color_scheme: (row.color_scheme as string) ?? null,
    launch_args: JSON.parse((row.launch_args as string) || '[]'),
    notes: (row.notes as string) ?? null,
    user_data_dir: row.user_data_dir as string,
    created_at: row.created_at as string,
    updated_at: row.updated_at as string,
    tags,
  };
}

function getTags(profileId: string): TagResponse[] {
  const rows = conn()
    .prepare('SELECT tag, color FROM profile_tags WHERE profile_id = ?')
    .all(profileId) as Array<{ tag: string; color: string | null }>;
  return rows.map((t) => ({ tag: t.tag, color: t.color ?? null }));
}

export function createProfile(
  fields: Partial<ProfileRow> & { name: string; tags?: TagCreate[] | null }
): ProfileRow {
  const profileId = randomUUID();
  const seed =
    fields.fingerprint_seed ?? Math.floor(Math.random() * (99999 - 10000 + 1)) + 10000;
  const userDataDir = path.join(dataDir, "profiles", profileId);
  const ts = now();
  const tags = fields.tags ?? [];

  conn()
    .prepare(
      `INSERT INTO profiles (
        id, name, fingerprint_seed, proxy, timezone, locale, platform,
        user_agent, screen_width, screen_height, gpu_vendor, gpu_renderer,
        hardware_concurrency, humanize, human_preset, headless, geoip,
        clipboard_sync, auto_launch, color_scheme, launch_args, notes,
        user_data_dir, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      profileId,
      fields.name,
      seed,
      fields.proxy ?? null,
      fields.timezone ?? null,
      fields.locale ?? null,
      fields.platform ?? 'windows',
      fields.user_agent ?? null,
      fields.screen_width ?? 1920,
      fields.screen_height ?? 1080,
      fields.gpu_vendor ?? null,
      fields.gpu_renderer ?? null,
      fields.hardware_concurrency ?? null,
      Number(fields.humanize ?? false),
      fields.human_preset ?? 'default',
      Number(fields.headless ?? false),
      Number(fields.geoip ?? false),
      Number(fields.clipboard_sync ?? true),
      Number(fields.auto_launch ?? false),
      fields.color_scheme ?? null,
      JSON.stringify(fields.launch_args ?? []),
      fields.notes ?? null,
      userDataDir,
      ts,
      ts
    );

  const insertTag = conn().prepare(
    'INSERT INTO profile_tags (profile_id, tag, color) VALUES (?, ?, ?)'
  );
  for (const t of tags) insertTag.run(profileId, t.tag, t.color ?? null);

  return getProfile(profileId)!;
}

export function getProfile(profileId: string): ProfileRow | null {
  const row = conn()
    .prepare('SELECT * FROM profiles WHERE id = ?')
    .get(profileId) as RawRow | undefined;
  if (!row) return null;
  return rowToProfile(row, getTags(profileId));
}

export function listProfiles(): ProfileRow[] {
  const rows = conn()
    .prepare('SELECT * FROM profiles ORDER BY created_at DESC')
    .all() as RawRow[];
  return rows.map((row) => rowToProfile(row, getTags(row.id as string)));
}

/** Columns updatable via PUT, in the same order as the Python implementation. */
const UPDATABLE_COLS = [
  'name', 'fingerprint_seed', 'proxy', 'timezone', 'locale', 'platform',
  'user_agent', 'screen_width', 'screen_height', 'gpu_vendor', 'gpu_renderer',
  'hardware_concurrency', 'humanize', 'human_preset', 'headless', 'geoip',
  'clipboard_sync', 'auto_launch', 'color_scheme', 'launch_args', 'notes',
] as const;

const BOOL_COLS = new Set([
  'humanize', 'headless', 'geoip', 'clipboard_sync', 'auto_launch',
]);

export function updateProfile(
  profileId: string,
  fields: Record<string, unknown> & { tags?: TagCreate[] | null }
): ProfileRow | null {
  if (!getProfile(profileId)) return null;

  const { tags, ...rest } = fields;

  const setClauses: string[] = [];
  const values: unknown[] = [];

  for (const col of UPDATABLE_COLS) {
    if (!(col in rest)) continue;
    let value = rest[col];
    if (col === 'launch_args') value = JSON.stringify(value ?? []);
    else if (BOOL_COLS.has(col)) value = value === null ? null : Number(value);
    setClauses.push(`${col} = ?`);
    values.push(value ?? null);
  }

  if (setClauses.length > 0) {
    setClauses.push('updated_at = ?');
    values.push(now(), profileId);
    conn()
      .prepare(`UPDATE profiles SET ${setClauses.join(', ')} WHERE id = ?`)
      .run(...(values as never[]));
  }

  if (tags !== undefined && tags !== null) {
    conn().prepare('DELETE FROM profile_tags WHERE profile_id = ?').run(profileId);
    const insertTag = conn().prepare(
      'INSERT INTO profile_tags (profile_id, tag, color) VALUES (?, ?, ?)'
    );
    for (const t of tags) insertTag.run(profileId, t.tag, t.color ?? null);
  }

  return getProfile(profileId);
}

export function deleteProfile(profileId: string): boolean {
  const result = conn().prepare('DELETE FROM profiles WHERE id = ?').run(profileId);
  return Number(result.changes) > 0;
}
