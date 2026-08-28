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

/**
 * Which browser a profile runs. The two engines share this table but not their
 * configuration: `chromium` reads the flat fingerprint columns below,
 * `camoufox` reads `engine_config` and ignores them entirely. Keeping the two
 * apart is deliberate — it is what lets Camoufox's settings change without any
 * risk to a working Chromium profile.
 */
export const ENGINES = ['chromium', 'camoufox'] as const;
export type Engine = (typeof ENGINES)[number];

/** How a client talks to a running profile. Firefox has no CDP (removed in FF141). */
export const AUTOMATION_PROTOCOLS = ['cdp', 'playwright-firefox'] as const;
export type AutomationProtocol = (typeof AUTOMATION_PROTOCOLS)[number];

export const CAMOUFOX_OS = ['windows', 'macos', 'linux'] as const;

/**
 * Camoufox-only settings, stored as JSON in `profiles.engine_config`.
 *
 * These map onto camoufox-js's `launchOptions()`, which turns them into a
 * BrowserForge fingerprint serialised into chunked CAMOU_CONFIG_1..N env vars.
 * Deliberately NOT merged with the Chromium fingerprint columns: the two engines
 * spoof different surfaces, and a shared field would have to mean two things.
 */
export const camoufoxConfigSchema = z.object({
  /** Spoofed OS. Drives UA, oscpu, platform, font set and GPU pairing together. */
  os: z.enum(CAMOUFOX_OS).nullable().optional(),
  /** true, or a number = max cursor-movement duration in seconds. */
  humanize: z.union([z.boolean(), z.number()]).default(false),
  /** true = derive geo from the exit IP; a string = use that IP. */
  geoip: z.union([z.boolean(), z.string()]).default(false),
  block_images: z.boolean().default(false),
  block_webrtc: z.boolean().default(false),
  block_webgl: z.boolean().default(false),
  enable_cache: z.boolean().default(false),
  disable_coop: z.boolean().default(false),
  /** Allows `page.evaluate('mw:...')` to run in the main world. Detectable — opt in. */
  main_world_eval: z.boolean().default(false),
  /** Use one of Camoufox's bundled real-device fingerprint presets. */
  fingerprint_preset: z.boolean().default(true),
  webgl_vendor: z.string().nullable().optional(),
  webgl_renderer: z.string().nullable().optional(),
  fonts: z.array(z.string()).default([]),
  /** Camoufox bundles uBlock Origin by default; set to drop the defaults. */
  exclude_default_addons: z.boolean().default(false),
  /**
   * Raw CAMOU_CONFIG property overrides, e.g. `{"webrtc:ipv4": "1.2.3.4"}`.
   * Escape hatch for the full property list in Camoufox's settings/properties.json.
   * Upstream recommends against hand-setting these — it populates them for you.
   */
  config: z.record(z.string(), z.unknown()).default({}),
});

/** Chromium keeps its settings in the flat columns, so this is empty for now. */
export const chromiumConfigSchema = z.object({});

export type CamoufoxConfig = z.infer<typeof camoufoxConfigSchema>;

/**
 * Parse `engine_config` for whichever engine owns the row. Unknown engines fall
 * back to Chromium so a row written by a newer version cannot crash a read.
 */
export function parseEngineConfig(engine: string, raw: unknown): CamoufoxConfig | object {
  if (engine === 'camoufox') return camoufoxConfigSchema.parse(raw ?? {});
  return chromiumConfigSchema.parse(raw ?? {});
}

export const tagCreateSchema = z.object({
  tag: z.string(),
  color: z.string().nullable().optional(), // hex color
});

export const profileCreateSchema = z.object({
  name: z.string(),
  engine: z.enum(ENGINES).default('chromium'),
  /** Engine-specific settings. Validated per engine — see parseEngineConfig(). */
  engine_config: z.record(z.string(), z.unknown()).default({}),
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
  // `engine` is deliberately NOT updatable. The user-data directory is written
  // in the engine's own format (Chromium's Default/ tree vs a Firefox profile),
  // so flipping it would point a browser at a directory it cannot read.
  engine_config: z.record(z.string(), z.unknown()).nullable().optional(),
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
  engine: Engine;
  engine_config: Record<string, unknown>;
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
  /**
   * Chromium only, and kept for backwards compatibility: existing clients read
   * this and call `chromium.connectOverCDP()`. Always null for Camoufox, which
   * has no CDP at all — those clients must read `automation_url` instead.
   */
  cdp_url: string | null;
  automation_url: string | null;
  automation_protocol: AutomationProtocol | null;
}

export interface LaunchResponse {
  profile_id: string;
  status: 'running';
  engine: Engine;
  vnc_ws_port: number;
  display: string;
  cdp_url: string | null;
  automation_url: string | null;
  automation_protocol: AutomationProtocol | null;
}

export interface StatusResponse {
  running_count: number;
  /** CloakBrowser's Chromium version. Key unchanged — existing clients read it. */
  binary_version: string;
  camoufox_version: string | null;
  profiles_total: number;
}

export interface ProfileStatusResponse {
  status: 'running' | 'stopped';
  engine: Engine | null;
  vnc_ws_port: number | null;
  display: string | null;
  cdp_url: string | null;
  automation_url: string | null;
  automation_protocol: AutomationProtocol | null;
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
