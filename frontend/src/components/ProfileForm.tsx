import {
  AlertTriangle,
  ArrowLeft,
  Check,
  ChevronRight,
  Copy,
  Loader2,
  Plug,
  Save,
  Trash2,
  X,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import {
  api,
  type Profile,
  type ProfileCreateData,
  type ProxyTestResult,
} from "../lib/api";
import { DEFAULT_LAUNCH_ARGS } from "../lib/launch-args";
import { Tag } from "./Tag";

interface ProfileFormProps {
  profile: Profile | null; // null = create mode
  onSave: (data: ProfileCreateData) => Promise<void>;
  onDelete?: () => Promise<void>;
  onDuplicate?: (data: ProfileCreateData) => Promise<void>;
  onCancel: () => void;
  /** Lets the parent block navigation while there are unsaved edits. */
  onDirtyChange?: (dirty: boolean) => void;
  /** Extra controls for the sticky header — the app puts Launch/Stop here. */
  headerActions?: React.ReactNode;
}

const RESOLUTION_PRESETS: Record<string, { width: number; height: number }> = {
  "1920 × 1080 (Full HD)": { width: 1920, height: 1080 },
  "2560 × 1440 (QHD)": { width: 2560, height: 1440 },
  "1366 × 768 (HD)": { width: 1366, height: 768 },
  "1440 × 900": { width: 1440, height: 900 },
  "1536 × 864": { width: 1536, height: 864 },
  "1280 × 720 (720p)": { width: 1280, height: 720 },
};

const TAG_COLORS = [
  "#6366f1", // indigo
  "#22c55e", // green
  "#f59e0b", // amber
  "#ef4444", // red
  "#06b6d4", // cyan
  "#a855f7", // purple
  "#f97316", // orange
  "#ec4899", // pink
];

const GPU_PRESETS: Record<string, { vendor: string; renderer: string }> = {
  "NVIDIA RTX 3070": {
    vendor: "Google Inc. (NVIDIA)",
    renderer:
      "ANGLE (NVIDIA, NVIDIA GeForce RTX 3070 (0x00002484) Direct3D11 vs_5_0 ps_5_0, D3D11)",
  },
  "NVIDIA RTX 4070": {
    vendor: "Google Inc. (NVIDIA)",
    renderer:
      "ANGLE (NVIDIA, NVIDIA GeForce RTX 4070 (0x00002786) Direct3D11 vs_5_0 ps_5_0, D3D11)",
  },
  "AMD RX 6800 XT": {
    vendor: "Google Inc. (AMD)",
    renderer:
      "ANGLE (AMD, AMD Radeon RX 6800 XT (0x000073BF) Direct3D11 vs_5_0 ps_5_0, D3D11)",
  },
  "Intel UHD 770": {
    vendor: "Google Inc. (Intel)",
    renderer:
      "ANGLE (Intel, Intel(R) UHD Graphics 770 (0x00004680) Direct3D11 vs_5_0 ps_5_0, D3D11)",
  },
  "Apple M3 (macOS)": {
    vendor: "Google Inc. (Apple)",
    renderer:
      "ANGLE (Apple, ANGLE Metal Renderer: Apple M3, Unspecified Version)",
  },
};

/** Everything the API accepts on create, so a clone carries the whole config. */
function toFormData(profile: Profile): ProfileCreateData {
  return {
    name: profile.name,
    fingerprint_seed: profile.fingerprint_seed,
    proxy: profile.proxy,
    timezone: profile.timezone,
    locale: profile.locale,
    platform: profile.platform,
    user_agent: profile.user_agent,
    screen_width: profile.screen_width,
    screen_height: profile.screen_height,
    gpu_vendor: profile.gpu_vendor,
    gpu_renderer: profile.gpu_renderer,
    hardware_concurrency: profile.hardware_concurrency,
    humanize: profile.humanize,
    human_preset: profile.human_preset,
    headless: profile.headless,
    geoip: profile.geoip,
    clipboard_sync: profile.clipboard_sync,
    auto_launch: profile.auto_launch,
    color_scheme: profile.color_scheme,
    launch_args: profile.launch_args ?? [],
    notes: profile.notes,
    tags: profile.tags ?? [],
  };
}

export function ProfileForm({
  profile,
  onSave,
  onDelete,
  onDuplicate,
  onCancel,
  onDirtyChange,
  headerActions,
}: ProfileFormProps) {
  const isEdit = profile !== null;
  // Chromium reads the profile config at launch, so a save against a live
  // session would silently not apply until the next relaunch.
  const isRunning = profile?.status === "running";

  const [form, setForm] = useState<ProfileCreateData>({
    name: "",
    platform: "windows",
    screen_width: 1920,
    screen_height: 1080,
    humanize: false,
    human_preset: "default",
    headless: false,
    geoip: false,
    clipboard_sync: true,
    auto_launch: false,
    // Only seeds create mode — the effect below overwrites this from the DB for
    // an existing profile, so saved flag lists are never re-defaulted.
    launch_args: [...DEFAULT_LAUNCH_ARGS],
    tags: [],
  });

  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [duplicating, setDuplicating] = useState(false);
  const [tagInput, setTagInput] = useState("");
  const [tagColor, setTagColor] = useState<string | null>("#6366f1");
  const [launchArgInput, setLaunchArgInput] = useState("");
  const [customResolution, setCustomResolution] = useState(false);
  const [testingProxy, setTestingProxy] = useState(false);
  const [proxyTest, setProxyTest] = useState<ProxyTestResult | null>(null);

  // Baseline for dirty tracking. Deliberately re-synced only on profile id: the
  // 3s list poll would otherwise clobber whatever the user is typing.
  const [baseline, setBaseline] = useState<string | null>(null);

  useEffect(() => {
    if (profile) {
      const loaded = toFormData(profile);
      setForm(loaded);
      setBaseline(JSON.stringify(loaded));
      // Let the loaded w/h decide again rather than carrying the previous
      // profile's "Custom" choice across a selection change.
      setCustomResolution(false);
    }
  }, [profile?.id]);

  // Structural compare against the loaded snapshot. Cheap enough at this size,
  // and it means reverting an edit by hand correctly clears the dirty flag.
  const dirty = useMemo(() => {
    if (!isEdit) return form.name.trim() !== "";
    if (baseline === null) return false;
    return JSON.stringify(form) !== baseline;
  }, [form, baseline, isEdit]);

  useEffect(() => {
    onDirtyChange?.(dirty);
  }, [dirty, onDirtyChange]);

  // Clear on unmount. Without this, launching a profile with a half-edited form
  // tears the form down but leaves the parent believing edits are still pending,
  // so the next unrelated navigation wrongly prompts to discard.
  useEffect(() => () => onDirtyChange?.(false), [onDirtyChange]);

  // Unsaved edits also survive a tab close attempt.
  useEffect(() => {
    if (!dirty) return;
    const warn = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);

  const set = <K extends keyof ProfileCreateData>(
    key: K,
    value: ProfileCreateData[K],
  ) => {
    setForm((prev) => ({ ...prev, [key]: value }));
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!form.name.trim()) return;
    // Also guards Ctrl+S, which submits the form without going through the
    // disabled button.
    if (isRunning) return;
    setSaving(true);
    try {
      await onSave(form);
      // Saved state becomes the new baseline, so the form is no longer dirty.
      setBaseline(JSON.stringify(form));
    } finally {
      setSaving(false);
    }
  };

  // Confirmation now lives in the parent, which owns the styled dialog — the old
  // window.confirm blocked the event loop and could not be tested.
  const handleDelete = async () => {
    if (!onDelete) return;
    setDeleting(true);
    try {
      await onDelete();
    } finally {
      setDeleting(false);
    }
  };

  const handleDuplicate = async () => {
    if (!onDuplicate) return;
    setDuplicating(true);
    try {
      await onDuplicate({
        ...form,
        name: `${form.name} (copy)`,
        // A clone must not share its parent's identity, or the whole point of
        // separate profiles is lost.
        fingerprint_seed: Math.floor(Math.random() * 90000) + 10000,
      });
    } finally {
      setDuplicating(false);
    }
  };

  const handleTestProxy = async () => {
    const proxy = form.proxy?.trim();
    if (!proxy) return;
    setTestingProxy(true);
    setProxyTest(null);
    try {
      setProxyTest(await api.testProxy(proxy));
    } catch (err) {
      setProxyTest({
        ok: false,
        exit_ip: null,
        latency_ms: null,
        error: err instanceof Error ? err.message : "Proxy test failed",
      });
    } finally {
      setTestingProxy(false);
    }
  };

  const applyGpuPreset = (name: string) => {
    const preset = GPU_PRESETS[name];
    if (preset) {
      set("gpu_vendor", preset.vendor);
      set("gpu_renderer", preset.renderer);
    }
  };

  const randomizeSeed = () => {
    set("fingerprint_seed", Math.floor(Math.random() * 90000) + 10000);
  };

  const matchedResolution = Object.entries(RESOLUTION_PRESETS).find(
    ([, v]) => v.width === form.screen_width && v.height === form.screen_height,
  )?.[0];

  // Picking "Custom" has to be sticky. Deriving it purely from the current w/h
  // means the option cannot be selected at all whenever those happen to match a
  // preset — the select would snap straight back and the inputs never appear.
  const currentResolution = customResolution
    ? "custom"
    : (matchedResolution ?? "custom");

  // Mirror the resolution logic: a hardcoded value="" left this select stuck on
  // the placeholder, so it never showed which preset was actually applied.
  const currentGpuPreset =
    Object.entries(GPU_PRESETS).find(
      ([, v]) =>
        v.vendor === form.gpu_vendor && v.renderer === form.gpu_renderer,
    )?.[0] ?? "";

  const addTag = () => {
    const tag = tagInput.trim();
    if (!tag) return;
    if (form.tags?.some((t) => t.tag === tag)) return;
    set("tags", [...(form.tags ?? []), { tag, color: tagColor }]);
    setTagInput("");
  };

  const removeTag = (tag: string) => {
    set(
      "tags",
      (form.tags ?? []).filter((t) => t.tag !== tag),
    );
  };

  const addLaunchArg = () => {
    const arg = launchArgInput.trim();
    if (!arg) return;
    if ((form.launch_args ?? []).includes(arg)) return;
    set("launch_args", [...(form.launch_args ?? []), arg]);
    setLaunchArgInput("");
  };

  const removeLaunchArg = (idx: number) => {
    set(
      "launch_args",
      (form.launch_args ?? []).filter((_, i) => i !== idx),
    );
  };

  return (
    <form onSubmit={handleSubmit} className="p-6 max-w-2xl mx-auto">
      {/* Sticky: the form is long enough that the actions scrolled out of reach. */}
      <div className="sticky top-0 z-10 -mx-6 -mt-6 px-6 pt-6 pb-4 mb-6 bg-surface-0/[0.92] backdrop-blur-[14px] border-b border-border">
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-3 min-w-0">
            {/* Doubles as the only way back to the dashboard, so it runs the same
              unsaved-changes guard the old Cancel button did. */}
            <button
              type="button"
              onClick={onCancel}
              className="icon-btn"
              title="Back to dashboard"
              aria-label="Back to dashboard"
            >
              <ArrowLeft className="h-4 w-4" />
            </button>
            <h2 className="font-display text-lg font-semibold tracking-[-0.2px] whitespace-nowrap">
              {isEdit ? "Edit Profile" : "New Profile"}
            </h2>
            {dirty && (
              <span className="text-xs text-amber-400 whitespace-nowrap">
                Unsaved changes
              </span>
            )}
          </div>
          <div className="flex items-center gap-2">
            {headerActions}
            {isEdit && onDuplicate && (
              <button
                type="button"
                onClick={handleDuplicate}
                disabled={duplicating}
                className="btn-secondary flex items-center gap-1.5"
                title="Create a copy with a new fingerprint"
              >
                <Copy className="h-3.5 w-3.5" />
                <span>{duplicating ? "Copying..." : "Duplicate"}</span>
              </button>
            )}
            {isEdit && onDelete && (
              <button
                type="button"
                onClick={handleDelete}
                disabled={deleting}
                className="btn-danger flex items-center gap-1.5"
              >
                <Trash2 className="h-3.5 w-3.5" />
                <span>{deleting ? "Deleting..." : "Delete"}</span>
              </button>
            )}
            <button
              type="submit"
              disabled={saving || isRunning}
              className="btn-primary flex items-center gap-1.5 disabled:opacity-40 disabled:cursor-not-allowed"
              title={
                isRunning
                  ? "Settings are read from disk at launch, so they cannot be saved while the browser is running"
                  : undefined
              }
            >
              <Save className="h-3.5 w-3.5" />
              <span>{saving ? "Saving..." : isEdit ? "Save" : "Create"}</span>
            </button>
          </div>
        </div>

        {isRunning && (
          <p className="mt-3 text-xs text-ink-faint">
            The browser is running. Chromium reads this config at launch, so
            stop the session before saving changes.
          </p>
        )}
      </div>

      <div className="space-y-5">
        {/* Basic */}
        <section>
          <h3 className="font-display text-xs font-semibold text-ink-muted uppercase tracking-wider mb-3">
            Basic
          </h3>
          <div className="grid grid-cols-2 gap-3">
            <div className="col-span-2">
              <label className="label">Profile Name</label>
              <input
                className="input"
                value={form.name}
                onChange={(e) => set("name", e.target.value)}
                placeholder="e.g. Amazon Seller #1"
                required
              />
            </div>
            <div>
              <label className="label">Platform</label>
              <select
                className="input"
                value={form.platform}
                onChange={(e) => set("platform", e.target.value)}
              >
                <option value="windows">Windows</option>
                <option value="macos">macOS</option>
                <option value="linux">Linux</option>
              </select>
            </div>
            <div>
              <label className="label">Fingerprint Seed</label>
              <div className="flex gap-2">
                <input
                  className="input flex-1 no-spin"
                  type="number"
                  value={form.fingerprint_seed ?? ""}
                  onChange={(e) =>
                    set(
                      "fingerprint_seed",
                      e.target.value ? Number(e.target.value) : null,
                    )
                  }
                  placeholder="Auto (random)"
                />
                <button
                  type="button"
                  onClick={randomizeSeed}
                  className="btn-secondary px-2.5"
                  title="Randomize seed"
                >
                  <svg
                    className="h-5 w-5"
                    viewBox="0 0 32 32"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.2"
                    strokeLinejoin="round"
                  >
                    {/* Right face - lightest */}
                    <polygon
                      points="28,10 16,16 16,28 28,22"
                      fill="currentColor"
                      opacity="0.06"
                    />
                    <polygon points="28,10 16,16 16,28 28,22" />
                    {/* Left face - medium shade */}
                    <polygon
                      points="4,10 16,16 16,28 4,22"
                      fill="currentColor"
                      opacity="0.2"
                    />
                    <polygon points="4,10 16,16 16,28 4,22" />
                    {/* Top face - brightest */}
                    <polygon
                      points="16,3 28,10 16,16 4,10"
                      fill="currentColor"
                      opacity="0.1"
                    />
                    <polygon points="16,3 28,10 16,16 4,10" />
                    {/* Dots on top face (3 - diagonal) */}
                    <circle
                      cx="11.5"
                      cy="8.5"
                      r="1"
                      fill="currentColor"
                      opacity="0.7"
                    />
                    <circle
                      cx="16"
                      cy="9.5"
                      r="1"
                      fill="currentColor"
                      opacity="0.7"
                    />
                    <circle
                      cx="20.5"
                      cy="10.5"
                      r="1"
                      fill="currentColor"
                      opacity="0.7"
                    />
                    {/* Dots on left face (5 - dice pattern) */}
                    <circle
                      cx="7.5"
                      cy="14"
                      r="0.9"
                      fill="currentColor"
                      opacity="0.6"
                    />
                    <circle
                      cx="12.5"
                      cy="16.5"
                      r="0.9"
                      fill="currentColor"
                      opacity="0.6"
                    />
                    <circle
                      cx="10"
                      cy="19"
                      r="0.9"
                      fill="currentColor"
                      opacity="0.6"
                    />
                    <circle
                      cx="7.5"
                      cy="22"
                      r="0.9"
                      fill="currentColor"
                      opacity="0.6"
                    />
                    <circle
                      cx="12.5"
                      cy="24.5"
                      r="0.9"
                      fill="currentColor"
                      opacity="0.6"
                    />
                    {/* Dots on right face (2 - diagonal) */}
                    <circle
                      cx="20"
                      cy="15"
                      r="0.9"
                      fill="currentColor"
                      opacity="0.5"
                    />
                    <circle
                      cx="24"
                      cy="20"
                      r="0.9"
                      fill="currentColor"
                      opacity="0.5"
                    />
                  </svg>
                </button>
              </div>
            </div>
          </div>
        </section>

        {/* Network */}
        <section>
          <h3 className="font-display text-xs font-semibold text-ink-muted uppercase tracking-wider mb-3">
            Network
          </h3>
          <div className="space-y-3">
            <div>
              <label className="label">Proxy</label>
              <div className="flex gap-2">
                <input
                  className="input flex-1"
                  value={form.proxy ?? ""}
                  onChange={(e) => {
                    set("proxy", e.target.value || null);
                    setProxyTest(null);
                  }}
                  placeholder="http://user:pass@host:port"
                />
                <button
                  type="button"
                  onClick={handleTestProxy}
                  disabled={testingProxy || !form.proxy?.trim()}
                  className="btn-secondary flex items-center gap-1.5 whitespace-nowrap disabled:opacity-50"
                  title="Route a request through this proxy and report the exit IP"
                >
                  {testingProxy ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <Plug className="h-3.5 w-3.5" />
                  )}
                  <span>{testingProxy ? "Testing..." : "Test"}</span>
                </button>
              </div>
              {/* The accepted formats were previously undiscoverable — a bad proxy
                  only ever surfaced as a failed launch. */}
              <p className="text-xs text-ink-faint mt-1">
                <code className="font-mono">host:port</code>,{" "}
                <code className="font-mono">host:port:user:pass</code>, or a
                full <code className="font-mono">http://</code> /{" "}
                <code className="font-mono">socks5://</code> URL
              </p>
              {proxyTest && (
                <p
                  className={`text-xs mt-1.5 flex items-start gap-1.5 ${
                    proxyTest.ok ? "text-emerald-400" : "text-red-400"
                  }`}
                >
                  {proxyTest.ok ? (
                    <Check className="h-3.5 w-3.5 flex-shrink-0 mt-px" />
                  ) : (
                    <AlertTriangle className="h-3.5 w-3.5 flex-shrink-0 mt-px" />
                  )}
                  <span className="break-words">
                    {proxyTest.ok
                      ? `Working — exit IP ${proxyTest.exit_ip} (${proxyTest.latency_ms}ms)`
                      : proxyTest.error}
                  </span>
                </p>
              )}
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="label">Timezone</label>
                <input
                  className="input"
                  value={form.timezone ?? ""}
                  onChange={(e) => set("timezone", e.target.value || null)}
                  placeholder="America/New_York"
                />
              </div>
              <div>
                <label className="label">Locale</label>
                <input
                  className="input"
                  value={form.locale ?? ""}
                  onChange={(e) => set("locale", e.target.value || null)}
                  placeholder="en-US"
                />
              </div>
            </div>
            <label className="flex items-center gap-2 text-sm text-ink-muted cursor-pointer">
              <input
                type="checkbox"
                checked={form.geoip ?? false}
                onChange={(e) => set("geoip", e.target.checked)}
                className="rounded border-border bg-surface-2"
              />
              Auto-detect timezone/locale from proxy IP (GeoIP)
            </label>
          </div>
        </section>

        {/* Hardware */}
        <section>
          <h3 className="font-display text-xs font-semibold text-ink-muted uppercase tracking-wider mb-3">
            Hardware
          </h3>
          <div className="space-y-3">
            <div>
              <label className="label">Screen Resolution</label>
              <select
                className="input"
                value={currentResolution}
                onChange={(e) => {
                  const preset = RESOLUTION_PRESETS[e.target.value];
                  if (preset) {
                    setCustomResolution(false);
                    set("screen_width", preset.width);
                    set("screen_height", preset.height);
                  } else {
                    setCustomResolution(true);
                  }
                }}
              >
                {Object.keys(RESOLUTION_PRESETS).map((name) => (
                  <option key={name} value={name}>
                    {name}
                  </option>
                ))}
                <option value="custom">Custom</option>
              </select>
            </div>
            {currentResolution === "custom" && (
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="label">Width</label>
                  <input
                    className="input"
                    type="number"
                    value={form.screen_width ?? 1920}
                    onChange={(e) =>
                      set("screen_width", Number(e.target.value))
                    }
                  />
                </div>
                <div>
                  <label className="label">Height</label>
                  <input
                    className="input"
                    type="number"
                    value={form.screen_height ?? 1080}
                    onChange={(e) =>
                      set("screen_height", Number(e.target.value))
                    }
                  />
                </div>
              </div>
            )}
            <div>
              <label className="label">Hardware Concurrency</label>
              <input
                className="input"
                type="number"
                value={form.hardware_concurrency ?? ""}
                onChange={(e) =>
                  set(
                    "hardware_concurrency",
                    e.target.value ? Number(e.target.value) : null,
                  )
                }
                placeholder="Auto (from seed)"
              />
            </div>
            <div>
              <label className="label">GPU Preset</label>
              <select
                className="input"
                value={currentGpuPreset}
                onChange={(e) => {
                  if (e.target.value) applyGpuPreset(e.target.value);
                }}
              >
                <option value="">Select preset...</option>
                {Object.keys(GPU_PRESETS).map((name) => (
                  <option key={name} value={name}>
                    {name}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="label">GPU Vendor</label>
              <input
                className="input"
                value={form.gpu_vendor ?? ""}
                onChange={(e) => set("gpu_vendor", e.target.value || null)}
                placeholder="Auto (from seed)"
              />
            </div>
            <div>
              <label className="label">GPU Renderer</label>
              <input
                className="input"
                value={form.gpu_renderer ?? ""}
                onChange={(e) => set("gpu_renderer", e.target.value || null)}
                placeholder="Auto (from seed)"
              />
            </div>
          </div>
        </section>

        {/* Behavior */}
        <section>
          <h3 className="font-display text-xs font-semibold text-ink-muted uppercase tracking-wider mb-3">
            Behavior
          </h3>
          <div className="space-y-3">
            <label className="flex items-center gap-2 text-sm text-ink-muted cursor-pointer">
              <input
                type="checkbox"
                checked={form.humanize ?? false}
                onChange={(e) => set("humanize", e.target.checked)}
                className="rounded border-border bg-surface-2"
              />
              Human-like mouse, keyboard, and scroll behavior
            </label>
            {form.humanize && (
              <div>
                <label className="label">Human Preset</label>
                <select
                  className="input"
                  value={form.human_preset}
                  onChange={(e) => set("human_preset", e.target.value)}
                >
                  <option value="default">Default (normal speed)</option>
                  <option value="careful">Careful (slower, deliberate)</option>
                </select>
              </div>
            )}
            <label className="flex items-center gap-2 text-sm text-ink-muted cursor-pointer">
              <input
                type="checkbox"
                checked={form.clipboard_sync ?? true}
                onChange={(e) => set("clipboard_sync", e.target.checked)}
                className="rounded border-border bg-surface-2"
              />
              Enable clipboard sync by default in VNC viewer
            </label>
            <label className="flex items-center gap-2 text-sm text-ink-muted cursor-pointer">
              <input
                type="checkbox"
                checked={form.auto_launch ?? false}
                onChange={(e) => set("auto_launch", e.target.checked)}
                className="rounded border-border bg-surface-2"
              />
              Launch automatically when container starts
            </label>
            <label className="flex items-center gap-2 text-sm text-ink-muted cursor-pointer">
              <input
                type="checkbox"
                checked={form.headless ?? false}
                onChange={(e) => set("headless", e.target.checked)}
                className="rounded border-border bg-surface-2"
              />
              <span>
                Headless — no visible window
                <span className="block text-xs text-ink-faint">
                  The browser view will show a blank screen. Use with CDP
                  automation only.
                </span>
              </span>
            </label>
            <div>
              <label className="label">Color Scheme</label>
              <select
                className="input"
                value={form.color_scheme ?? ""}
                onChange={(e) => set("color_scheme", e.target.value || null)}
              >
                <option value="">System default</option>
                <option value="light">Light</option>
                <option value="dark">Dark</option>
                <option value="no-preference">No preference</option>
              </select>
            </div>
            <div>
              <label className="label">User Agent</label>
              <input
                className="input"
                value={form.user_agent ?? ""}
                onChange={(e) => set("user_agent", e.target.value || null)}
                placeholder="Auto (from binary)"
              />
            </div>
          </div>
        </section>

        {/* Tags */}
        <section>
          <h3 className="font-display text-xs font-semibold text-ink-muted uppercase tracking-wider mb-3">
            Tags
          </h3>
          {(form.tags ?? []).length > 0 && (
            <div className="flex flex-wrap gap-1.5 mb-3">
              {(form.tags ?? []).map((t) => (
                <Tag
                  key={t.tag}
                  tag={t.tag}
                  color={t.color}
                  onRemove={() => removeTag(t.tag)}
                />
              ))}
            </div>
          )}
          <div className="flex gap-2 items-center">
            <div className="flex gap-1">
              {TAG_COLORS.map((c) => (
                <button
                  key={c}
                  type="button"
                  onClick={() => setTagColor(c)}
                  className="w-4 h-4 rounded-full border-2 transition-transform"
                  style={{
                    backgroundColor: c,
                    borderColor: tagColor === c ? "#fff" : "transparent",
                    transform: tagColor === c ? "scale(1.2)" : undefined,
                  }}
                />
              ))}
            </div>
            <input
              className="input flex-1"
              value={tagInput}
              onChange={(e) => setTagInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  addTag();
                }
              }}
              placeholder="Add tag..."
            />
            <button
              type="button"
              onClick={addTag}
              className="btn-secondary text-xs"
            >
              Add
            </button>
          </div>
        </section>

        {/* Launch Args */}
        <section>
          <h3 className="font-display text-xs font-semibold text-ink-muted uppercase tracking-wider mb-3">
            Launch Args
          </h3>
          <p className="text-xs text-ink-faint mb-2">
            Chromium flags passed at launch (e.g. --load-extension,
            --disable-features). New profiles start with a default set — remove
            any you don't want.
          </p>
          <p className="text-xs text-ink-faint mb-2">
            Spoofing Windows? Add{" "}
            <code className="font-mono">--fingerprint-windows-font-metrics</code>{" "}
            to match Windows font metrics. Requires the Windows font set in{" "}
            <code className="font-mono">/data/fonts</code> and a Chromium 148+
            binary — see the README.
          </p>
          {(form.launch_args ?? []).length > 0 && (
            <div className="flex flex-wrap gap-1.5 mb-3">
              {(form.launch_args ?? []).map((arg, idx) => (
                <span
                  key={idx}
                  className="inline-flex items-center gap-1 text-xs px-2 py-1 rounded-full bg-surface-3 text-ink-muted font-mono"
                >
                  {arg}
                  <button
                    type="button"
                    onClick={() => removeLaunchArg(idx)}
                    className="hover:opacity-70"
                  >
                    <X className="h-3 w-3" />
                  </button>
                </span>
              ))}
            </div>
          )}
          <div className="flex gap-2">
            <input
              className="input flex-1 font-mono"
              value={launchArgInput}
              onChange={(e) => setLaunchArgInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  addLaunchArg();
                }
              }}
              placeholder="--load-extension=/data/extensions/ublock"
            />
            <button
              type="button"
              onClick={addLaunchArg}
              className="btn-secondary text-xs"
            >
              Add
            </button>
          </div>
        </section>

        {/* Notes */}
        <section>
          <h3 className="font-display text-xs font-semibold text-ink-muted uppercase tracking-wider mb-3">
            Notes
          </h3>
          <textarea
            className="input min-h-[80px] resize-y"
            value={form.notes ?? ""}
            onChange={(e) => set("notes", e.target.value || null)}
            placeholder="Optional notes about this profile..."
          />
        </section>

        {/* Server-side facts. Returned on every profile and previously never shown,
            which made support questions ("where is this profile on disk?") guesswork. */}
        {profile && (
          <details className="group">
            <summary className="font-display text-xs font-semibold text-ink-muted uppercase tracking-wider cursor-pointer hover:text-ink-muted list-none flex items-center gap-1.5">
              <ChevronRight className="h-3 w-3 transition-transform group-open:rotate-90" />
              Details
            </summary>
            <dl className="mt-3 space-y-2">
              <MetaRow label="Profile ID" value={profile.id} mono />
              <MetaRow
                label="Data directory"
                value={profile.user_data_dir}
                mono
              />
              <MetaRow
                label="Created"
                value={formatTimestamp(profile.created_at)}
              />
              <MetaRow
                label="Last updated"
                value={formatTimestamp(profile.updated_at)}
              />
              <MetaRow label="Status" value={profile.status} />
              {profile.vnc_ws_port !== null && (
                <MetaRow
                  label="VNC port"
                  value={String(profile.vnc_ws_port)}
                  mono
                />
              )}
            </dl>
          </details>
        )}
      </div>
    </form>
  );
}

/** ISO-with-offset from the API; fall back to the raw string if unparseable. */
function formatTimestamp(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleString();
}

function MetaRow({
  label,
  value,
  mono,
}: {
  label: string;
  value: string;
  mono?: boolean;
}) {
  return (
    <div className="grid grid-cols-[9rem_1fr] gap-2 text-xs">
      <dt className="text-ink-faint">{label}</dt>
      <dd className={`text-ink-muted break-all ${mono ? "font-mono" : ""}`}>
        {value}
      </dd>
    </div>
  );
}
