/**
 * API client for AstraBrowser Manager backend.
 */

export interface Profile {
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
  tags: { tag: string; color: string | null }[];
  status: "running" | "stopped";
  vnc_ws_port: number | null;
  cdp_url: string | null;
}

export interface ProfileCreateData {
  name: string;
  fingerprint_seed?: number | null;
  proxy?: string | null;
  timezone?: string | null;
  locale?: string | null;
  platform?: string;
  user_agent?: string | null;
  screen_width?: number;
  screen_height?: number;
  gpu_vendor?: string | null;
  gpu_renderer?: string | null;
  hardware_concurrency?: number | null;
  humanize?: boolean;
  human_preset?: string;
  headless?: boolean;
  geoip?: boolean;
  clipboard_sync?: boolean;
  auto_launch?: boolean;
  color_scheme?: string | null;
  launch_args?: string[];
  notes?: string | null;
  tags?: { tag: string; color: string | null }[];
}

export interface LaunchResult {
  profile_id: string;
  status: string;
  vnc_ws_port: number;
  display: string;
  cdp_url: string | null;
}

export interface SystemStatus {
  running_count: number;
  binary_version: string;
  profiles_total: number;
}

/** One open tab, from Chrome's /json/list via the CDP proxy. */
export interface CdpTarget {
  id: string;
  type: string;
  title: string;
  url: string;
  webSocketDebuggerUrl?: string;
}

/** Export payload. Profiles carry no id, data dir, or timestamps. */
export interface ProfileExport {
  version: number;
  exported_at: string;
  profiles: ProfileCreateData[];
}

export interface ImportResult {
  created: number;
  skipped: { name: string; reason: string }[];
  renamed: { from: string; to: string }[];
}

export interface ProxyTestResult {
  ok: boolean;
  exit_ip: string | null;
  latency_ms: number | null;
  error: string | null;
}

class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

// Global 401 callback — set by App to trigger login page on auth failure
let _onUnauthorized: (() => void) | null = null;
export function setOnUnauthorized(cb: (() => void) | null) {
  _onUnauthorized = cb;
}

/**
 * Validation failures (422) return an array of zod issues rather than a string,
 * which would otherwise stringify to "[object Object]" in the error banner.
 */
function formatDetail(detail: unknown): string {
  if (typeof detail === "string") return detail;
  if (Array.isArray(detail)) {
    return detail
      .map((issue) => {
        const path = Array.isArray(issue?.path) ? issue.path.join(".") : "";
        const message = issue?.message ?? String(issue);
        return path ? `${path}: ${message}` : message;
      })
      .join("; ");
  }
  return "";
}

async function request<T>(path: string, options?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    headers: { "Content-Type": "application/json" },
    // Auth rides on an httpOnly cookie. This is the fetch default for
    // same-origin, but stating it keeps a cross-origin dev setup from silently
    // dropping the cookie and looking like an auth bug.
    credentials: "same-origin",
    ...options,
  });
  if (!res.ok) {
    // Read the body first either way — the server's detail ("Invalid token")
    // is more useful than the generic status text, and the 401 branch used to
    // discard it, so LoginPage showed "Unauthorized" for a wrong token.
    const body = await res.json().catch(() => ({ detail: res.statusText }));
    const detail = formatDetail(body.detail) || res.statusText;

    if (res.status === 401) {
      if (_onUnauthorized) _onUnauthorized();
      throw new ApiError(401, detail);
    }
    throw new ApiError(res.status, detail);
  }
  return res.json();
}

export const api = {
  authStatus: () =>
    request<{ auth_required: boolean; authenticated: boolean }>(
      "/api/auth/status",
    ),

  login: (token: string) =>
    request<{ ok: boolean }>("/api/auth/login", {
      method: "POST",
      body: JSON.stringify({ token }),
    }),

  logout: () =>
    request<{ ok: boolean }>("/api/auth/logout", { method: "POST" }),

  listProfiles: () => request<Profile[]>("/api/profiles"),

  getProfile: (id: string) => request<Profile>(`/api/profiles/${id}`),

  createProfile: (data: ProfileCreateData) =>
    request<Profile>("/api/profiles", {
      method: "POST",
      body: JSON.stringify(data),
    }),

  updateProfile: (id: string, data: Partial<ProfileCreateData>) =>
    request<Profile>(`/api/profiles/${id}`, {
      method: "PUT",
      body: JSON.stringify(data),
    }),

  deleteProfile: (id: string) =>
    request<{ ok: boolean }>(`/api/profiles/${id}`, { method: "DELETE" }),

  launchProfile: (id: string) =>
    request<LaunchResult>(`/api/profiles/${id}/launch`, { method: "POST" }),

  stopProfile: (id: string) =>
    request<{ ok: boolean }>(`/api/profiles/${id}/stop`, { method: "POST" }),

  getStatus: () => request<SystemStatus>("/api/status"),

  setClipboard: (id: string, text: string) =>
    request<{ ok: boolean }>(`/api/profiles/${id}/clipboard`, {
      method: "POST",
      body: JSON.stringify({ text }),
    }),

  getClipboard: (id: string) =>
    request<{ text: string }>(`/api/profiles/${id}/clipboard`),

  /**
   * Live probe of Chrome's CDP port. Distinguishes "running" from "wedged" — a
   * profile the manager still lists as running but whose browser is unreachable.
   * 404s when the profile is not running at all.
   */
  cdpAlive: (id: string) =>
    request<{ alive: boolean }>(`/api/profiles/${id}/cdp/alive`),

  /** Open tabs for a running profile. */
  cdpTargets: (id: string) =>
    request<CdpTarget[]>(`/api/profiles/${id}/cdp/json/list`),

  /** Drops a wedged session the manager still tracks but whose browser is gone. */
  forceStopProfile: (id: string) =>
    request<{ ok: boolean }>(`/api/profiles/${id}/force-stop`, {
      method: "POST",
    }),

  exportProfiles: () => request<ProfileExport>("/api/profiles/export"),

  exportProfile: (id: string) =>
    request<ProfileExport>(`/api/profiles/${id}/export`),

  importProfiles: (payload: ProfileExport | ProfileCreateData[]) =>
    request<ImportResult>("/api/profiles/import", {
      method: "POST",
      body: JSON.stringify(payload),
    }),

  testProxy: (proxy: string) =>
    request<ProxyTestResult>("/api/proxy/test", {
      method: "POST",
      body: JSON.stringify({ proxy }),
    }),

  /**
   * Screenshot URL rather than a fetch: an <img src> lets the browser handle
   * loading and decoding. `t` busts the cache on manual refresh.
   */
  screenshotUrl: (id: string, cacheBust?: number) =>
    `/api/profiles/${id}/screenshot${cacheBust ? `?t=${cacheBust}` : ""}`,
};
