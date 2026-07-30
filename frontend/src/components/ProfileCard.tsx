import { Apple, ExternalLink, Globe, Monitor, Terminal } from "lucide-react";
import type { Profile } from "../lib/api";
import { LaunchButton } from "./LaunchButton";
import { Tag } from "./Tag";
import { Thumbnail } from "./Thumbnail";

interface ProfileCardProps {
  profile: Profile;
  onOpen: (id: string) => void;
  onLaunch: (id: string) => Promise<void>;
  onStop: (id: string) => Promise<void>;
}

const PLATFORM_ICONS = {
  windows: Monitor,
  macos: Apple,
  linux: Terminal,
} as const;

const PLATFORM_LABELS = {
  windows: "Windows",
  macos: "macOS",
  linux: "Linux",
} as const;

/**
 * Host:port of a proxy URL, with any credentials dropped — the card is the most
 * screenshot-able surface in the app and proxy passwords do not belong on it.
 * Falls back to the raw string for values the URL parser rejects.
 */
function proxyLabel(proxy: string | null): string {
  if (!proxy) return "Direct connection";
  try {
    const url = new URL(proxy.includes("://") ? proxy : `http://${proxy}`);
    return url.host;
  } catch {
    return proxy.replace(/\/\/[^@/]*@/, "//");
  }
}

export function ProfileCard({ profile, onOpen, onLaunch, onStop }: ProfileCardProps) {
  const running = profile.status === "running";
  const platform = profile.platform as keyof typeof PLATFORM_ICONS;
  const PlatformIcon = PLATFORM_ICONS[platform] ?? Monitor;
  const platformLabel = PLATFORM_LABELS[platform] ?? profile.platform;

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={() => onOpen(profile.id)}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onOpen(profile.id);
        }
      }}
      className="flex flex-col bg-surface-1 border border-border rounded-card overflow-hidden cursor-pointer text-left transition-[border-color,transform] duration-200 hover:border-border-hover hover:-translate-y-0.5 focus:outline-none focus-visible:border-accent"
    >
      {/* Preview. Thumbnail renders null when the server has no screenshot, which
          leaves the placeholder underneath it visible. */}
      <div
        className={`relative grid place-items-center aspect-video border-b border-border ${
          running ? "bg-[#0c0f14]" : "bg-[#0b0c0f]"
        }`}
      >
        <div className="flex items-center gap-[7px] text-xs text-ink-ghost">
          <Monitor className="h-3.5 w-3.5" />
          <span>No preview</span>
        </div>
        <Thumbnail
          profileId={profile.id}
          running={running}
          className={`absolute inset-0 h-full w-full object-cover object-top ${
            running ? "" : "opacity-50"
          }`}
        />
      </div>

      <div className="px-[15px] pt-[13px] pb-[15px]">
        <div className="flex items-center gap-[9px]">
          <PlatformIcon className="h-4 w-4 flex-shrink-0 text-[#8b93a1]" />
          <div className="min-w-0 flex-1">
            <div className="font-display font-semibold text-[15px] tracking-[-0.2px] truncate">
              {profile.name}
            </div>
            <div className="text-xs text-ink-faint mt-px">{platformLabel}</div>
          </div>
          {running && (
            <div className="flex items-center gap-1.5 flex-shrink-0">
              <span className="h-1.5 w-1.5 rounded-full bg-accent animate-cbpulse" />
              <span className="text-[11px] font-semibold text-accent">Running</span>
            </div>
          )}
        </div>

        <div className="flex items-center gap-2 mt-3 px-[11px] py-2 bg-surface-inset border border-border-inset rounded-chip">
          <Globe className="h-[13px] w-[13px] flex-shrink-0 text-[#565d6b]" />
          <span className="text-[12.5px] text-ink-muted truncate">
            {proxyLabel(profile.proxy)}
          </span>
          <span className="font-mono text-[11px] text-ink-faint ml-auto flex-shrink-0">
            {profile.timezone ?? "auto"}
          </span>
        </div>

        {profile.tags.length > 0 && (
          <div className="flex flex-wrap gap-1 mt-2.5">
            {profile.tags.map((t) => (
              <Tag key={t.tag} tag={t.tag} color={t.color} size="sm" />
            ))}
          </div>
        )}

        <div
          className="flex items-center gap-2 mt-3"
          onClick={(e) => e.stopPropagation()}
          onKeyDown={(e) => e.stopPropagation()}
        >
          <LaunchButton
            variant="card"
            status={profile.status}
            onLaunch={() => onLaunch(profile.id)}
            onStop={() => onStop(profile.id)}
          />
          {running && (
            <button
              onClick={() => onOpen(profile.id)}
              className="icon-btn"
              title="Open live view"
              aria-label={`Open live view for ${profile.name}`}
            >
              <ExternalLink className="h-[15px] w-[15px]" />
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
