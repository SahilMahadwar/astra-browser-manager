/**
 * Request/response schemas. Ported from backend/models.py.
 *
 * Keys stay snake_case throughout: the React frontend consumes these shapes
 * directly (frontend/src/lib/api.ts), so renaming anything here is a breaking
 * wire change, not a style choice.
 */

import { z } from 'zod';

export const PLATFORMS = ['windows', 'macos', 'linux'] as const;
export const HUMAN_PRESETS = ['default', 'careful'] as const;
export const COLOR_SCHEMES = ['light', 'dark', 'no-preference'] as const;

export const tagCreateSchema = z.object({
  tag: z.string(),
  color: z.string().nullable().optional(), // hex color
});

export const profileCreateSchema = z.object({
  name: z.string(),
  fingerprint_seed: z.number().int().nullable().optional(), // random if not set
  proxy: z.string().nullable().optional(), // "http://user:pass@host:port"
  timezone: z.string().nullable().optional(), // "America/New_York"
  locale: z.string().nullable().optional(), // "en-US"
  platform: z.enum(PLATFORMS).default('windows'),
  user_agent: z.string().nullable().optional(),
  screen_width: z.number().int().default(1920),
  screen_height: z.number().int().default(1080),
  gpu_vendor: z.string().nullable().optional(),
  gpu_renderer: z.string().nullable().optional(),
  hardware_concurrency: z.number().int().nullable().optional(),
  humanize: z.boolean().default(false),
  human_preset: z.enum(HUMAN_PRESETS).default('default'),
  headless: z.boolean().default(false),
  geoip: z.boolean().default(false),
  clipboard_sync: z.boolean().default(true),
  auto_launch: z.boolean().default(false),
  color_scheme: z.enum(COLOR_SCHEMES).nullable().optional(),
  launch_args: z.array(z.string()).default([]),
  notes: z.string().nullable().optional(),
  tags: z.array(tagCreateSchema).nullable().optional(),
});

/**
 * Every field optional — mirrors Pydantic's `exclude_unset` behaviour. Only
 * keys actually present in the request body are written to the row.
 */
export const profileUpdateSchema = z.object({
  name: z.string().optional(),
  fingerprint_seed: z.number().int().nullable().optional(),
  proxy: z.string().nullable().optional(),
  timezone: z.string().nullable().optional(),
  locale: z.string().nullable().optional(),
  platform: z.enum(PLATFORMS).nullable().optional(),
  user_agent: z.string().nullable().optional(),
  screen_width: z.number().int().nullable().optional(),
  screen_height: z.number().int().nullable().optional(),
  gpu_vendor: z.string().nullable().optional(),
  gpu_renderer: z.string().nullable().optional(),
  hardware_concurrency: z.number().int().nullable().optional(),
  humanize: z.boolean().nullable().optional(),
  human_preset: z.enum(HUMAN_PRESETS).nullable().optional(),
  headless: z.boolean().nullable().optional(),
  geoip: z.boolean().nullable().optional(),
  clipboard_sync: z.boolean().nullable().optional(),
  auto_launch: z.boolean().nullable().optional(),
  color_scheme: z.enum(COLOR_SCHEMES).nullable().optional(),
  launch_args: z.array(z.string()).nullable().optional(),
  notes: z.string().nullable().optional(),
  tags: z.array(tagCreateSchema).nullable().optional(),
});

export const clipboardRequestSchema = z.object({
  text: z.string().max(1_048_576), // 1MB max
});

export const loginRequestSchema = z.object({
  token: z.string(),
});

/** Current export format. Bump when the shape of `profiles[]` changes. */
export const EXPORT_VERSION = 1;

/**
 * Accepts either the full envelope this server emits or a bare array, so a
 * hand-written or hand-trimmed file still imports.
 */
export const profileImportSchema = z.union([
  z.object({
    version: z.number().int().optional(),
    exported_at: z.string().optional(),
    profiles: z.array(profileCreateSchema),
  }),
  z.array(profileCreateSchema),
]);

export const proxyTestRequestSchema = z.object({
  proxy: z.string().min(1),
});

export type TagCreate = z.infer<typeof tagCreateSchema>;
export type ProfileCreate = z.infer<typeof profileCreateSchema>;
export type ProfileUpdate = z.infer<typeof profileUpdateSchema>;

export interface TagResponse {
  tag: string;
  color: string | null;
}

export interface ProfileRow {
  id: string;
  name: string;
  fingerprint_seed: number;
  proxy: string | null;
  timezone: string | null;
  locale: string | null;
  platform: string;
  user_agent: string | null;
  screen_width: number;
  screen_height: number;
  gpu_vendor: string | null;
  gpu_renderer: string | null;
  hardware_concurrency: number | null;
  humanize: boolean;
  human_preset: string;
  headless: boolean;
  geoip: boolean;
  clipboard_sync: boolean;
  auto_launch: boolean;
  color_scheme: string | null;
  launch_args: string[];
  notes: string | null;
  user_data_dir: string;
  created_at: string;
  updated_at: string;
  tags: TagResponse[];
}

export interface ProfileResponse extends ProfileRow {
  status: 'running' | 'stopped';
  vnc_ws_port: number | null;
  cdp_url: string | null;
}

export interface LaunchResponse {
  profile_id: string;
  status: 'running';
  vnc_ws_port: number;
  display: string;
  cdp_url: string | null;
}

export interface StatusResponse {
  running_count: number;
  binary_version: string;
  profiles_total: number;
}

export interface ProfileStatusResponse {
  status: 'running' | 'stopped';
  vnc_ws_port: number | null;
  display: string | null;
  cdp_url: string | null;
}

/** A profile stripped of everything install-specific, ready to import elsewhere. */
export type ProfileExportEntry = Omit<
  ProfileRow,
  'id' | 'user_data_dir' | 'created_at' | 'updated_at'
>;

export interface ProfileExport {
  version: number;
  exported_at: string;
  profiles: ProfileExportEntry[];
}

export interface ProfileImportResponse {
  created: number;
  /** Names that could not be created, with the reason. */
  skipped: Array<{ name: string; reason: string }>;
  /** Names that were renamed to avoid colliding with an existing profile. */
  renamed: Array<{ from: string; to: string }>;
}

export interface ProxyTestResponse {
  ok: boolean;
  /** The proxy's exit IP, when the request succeeded. */
  exit_ip: string | null;
  latency_ms: number | null;
  error: string | null;
}
