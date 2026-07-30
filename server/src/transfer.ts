/**
 * Profile export/import.
 *
 * Export deliberately drops everything install-specific — the id, the on-disk
 * data directory, and the timestamps — so a file from one machine creates fresh
 * profiles on another rather than colliding with or overwriting anything. Cookies
 * and session data are NOT included; this moves configuration, not identity state.
 */

import { EXPORT_VERSION, type ProfileExport, type ProfileExportEntry, type ProfileRow } from './schemas.js';

/** Strip install-specific fields from a stored row. */
export function toExportEntry(profile: ProfileRow): ProfileExportEntry {
  const { id: _id, user_data_dir: _dir, created_at: _c, updated_at: _u, ...rest } = profile;
  return rest;
}

export function buildExport(profiles: ProfileRow[], exportedAt: string): ProfileExport {
  return {
    version: EXPORT_VERSION,
    exported_at: exportedAt,
    profiles: profiles.map(toExportEntry),
  };
}

/** Normalise both accepted import shapes (envelope or bare array) to a list. */
export function readImport<T>(payload: { profiles: T[] } | T[]): T[] {
  return Array.isArray(payload) ? payload : payload.profiles;
}

/**
 * Pick a name that does not collide with `taken`, appending "(imported)" and then
 * a counter. Mutates nothing; callers add the result to `taken` themselves so a
 * batch importing two identically-named profiles gets two distinct names.
 */
export function resolveName(name: string, taken: Set<string>): string {
  if (!taken.has(name)) return name;

  const candidate = `${name} (imported)`;
  if (!taken.has(candidate)) return candidate;

  for (let n = 2; ; n++) {
    const numbered = `${name} (imported ${n})`;
    if (!taken.has(numbered)) return numbered;
  }
}

/** A filename-safe slug for the download, e.g. "My Profile!" -> "my-profile". */
export function slugify(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  return slug || 'profile';
}
