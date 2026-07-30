import {
  ArrowDownUp,
  Download,
  Lock,
  MoreHorizontal,
  Plus,
  Upload,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import type { Profile, SystemStatus } from "../lib/api";
import { ProfileCard } from "./ProfileCard";
import { Tag } from "./Tag";

type SortKey = "created" | "updated" | "name";
type StatusFilter = "all" | "running" | "stopped";

const SORT_LABELS: Record<SortKey, string> = {
  created: "Newest first",
  updated: "Recently updated",
  name: "Name (A–Z)",
};

interface DashboardProps {
  profiles: Profile[];
  status: SystemStatus | null;
  authRequired: boolean;
  onOpen: (id: string) => void;
  onNew: () => void;
  onLaunch: (id: string) => Promise<void>;
  onStop: (id: string) => Promise<void>;
  onExport: () => void;
  onImport: (file: File) => void;
  onLogout: () => void;
  /** Ordered ids after filter+sort, so keyboard nav matches what is on screen. */
  onVisibleChange?: (ids: string[]) => void;
}

export function Dashboard({
  profiles,
  status,
  authRequired,
  onOpen,
  onNew,
  onLaunch,
  onStop,
  onExport,
  onImport,
  onLogout,
  onVisibleChange,
}: DashboardProps) {
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  const [activeTags, setActiveTags] = useState<string[]>([]);
  const [sortKey, setSortKey] = useState<SortKey>("created");
  const [menuOpen, setMenuOpen] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!menuOpen) return;
    const close = (e: MouseEvent) => {
      if (!menuRef.current?.contains(e.target as Node)) setMenuOpen(false);
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [menuOpen]);

  // Every tag in use, with the first colour seen for it, so the filter row can
  // render chips that match the ones on the profiles.
  const allTags = useMemo(() => {
    const seen = new Map<string, string | null>();
    for (const profile of profiles) {
      for (const t of profile.tags) {
        if (!seen.has(t.tag)) seen.set(t.tag, t.color);
      }
    }
    return [...seen.entries()].sort(([a], [b]) => a.localeCompare(b));
  }, [profiles]);

  const filtered = useMemo(() => {
    const matches = profiles.filter((p) => {
      if (statusFilter !== "all" && p.status !== statusFilter) return false;
      // Multiple selected tags are AND — narrowing, which is what a filter is for.
      if (activeTags.length > 0) {
        const owned = new Set(p.tags.map((t) => t.tag));
        if (!activeTags.every((t) => owned.has(t))) return false;
      }
      return true;
    });

    const sorted = [...matches];
    if (sortKey === "name") {
      sorted.sort((a, b) => a.name.localeCompare(b.name));
    } else if (sortKey === "updated") {
      sorted.sort((a, b) => b.updated_at.localeCompare(a.updated_at));
    }
    // "created" is the API's own order (created_at DESC), so leave it alone.
    return sorted;
  }, [profiles, statusFilter, activeTags, sortKey]);

  // Report the visible order for arrow-key navigation. Keyed on the joined ids so
  // an unchanged list does not re-notify on every poll.
  const visibleKey = filtered.map((p) => p.id).join(",");
  useEffect(() => {
    onVisibleChange?.(visibleKey ? visibleKey.split(",") : []);
  }, [visibleKey, onVisibleChange]);

  const running = profiles.filter((p) => p.status === "running");
  const counts: Record<StatusFilter, number> = {
    all: profiles.length,
    running: running.length,
    stopped: profiles.length - running.length,
  };
  const filtersActive = statusFilter !== "all" || activeTags.length > 0;

  const clearFilters = () => {
    setStatusFilter("all");
    setActiveTags([]);
  };

  return (
    <div className="min-h-full">
      {/* Header */}
      <header className="sticky top-0 z-40 flex items-center gap-[22px] px-7 py-4 border-b border-[#171a20] bg-surface-0/[0.88] backdrop-blur-[14px]">
        <div className="flex items-center gap-[11px]">
          <div className="grid place-items-center h-8 w-8 rounded-ctl bg-[#14171d] border border-[#232833]">
            <svg
              width="17"
              height="17"
              viewBox="0 0 24 24"
              fill="none"
              aria-hidden="true"
            >
              <path
                d="M12 2 4 5v6c0 5 3.4 8.4 8 11 4.6-2.6 8-6 8-11V5l-8-3Z"
                stroke="currentColor"
                strokeWidth="1.6"
                strokeLinejoin="round"
              />
            </svg>
          </div>
          <h1 className="font-display font-semibold text-[15.5px] tracking-[-0.2px]">
            AstraBrowser Manager
          </h1>
        </div>

        <div className="flex-1" />

        <button onClick={onNew} className="btn-primary">
          <Plus className="h-[15px] w-[15px]" />
          <span>New Profile</span>
        </button>

        <div className="relative" ref={menuRef}>
          <button
            onClick={() => setMenuOpen((v) => !v)}
            className="icon-btn"
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            aria-label="More actions"
          >
            <MoreHorizontal className="h-[15px] w-[15px]" />
          </button>
          {menuOpen && (
            <div
              role="menu"
              className="absolute right-0 mt-2 w-52 py-1 rounded-chip bg-surface-1 border border-border-strong shadow-[0_20px_50px_rgba(0,0,0,.55)] animate-cbrise"
            >
              <MenuItem
                icon={<Download className="h-3.5 w-3.5" />}
                label="Export profiles"
                disabled={profiles.length === 0}
                onClick={() => {
                  setMenuOpen(false);
                  onExport();
                }}
              />
              <MenuItem
                icon={<Upload className="h-3.5 w-3.5" />}
                label="Import profiles"
                onClick={() => {
                  setMenuOpen(false);
                  fileInputRef.current?.click();
                }}
              />
              {authRequired && (
                <MenuItem
                  icon={<Lock className="h-3.5 w-3.5" />}
                  label="Log out"
                  onClick={() => {
                    setMenuOpen(false);
                    onLogout();
                  }}
                />
              )}
              {status && (
                <p
                  className="px-3 pt-2 mt-1 border-t border-border text-[11px] text-ink-faint"
                  title={`Chromium ${status.binary_version}`}
                >
                  Chromium {status.binary_version}
                  <br />
                  {status.running_count} running · {status.profiles_total}{" "}
                  {status.profiles_total === 1 ? "profile" : "profiles"}
                </p>
              )}
            </div>
          )}
          <input
            ref={fileInputRef}
            type="file"
            accept="application/json,.json"
            className="hidden"
            onChange={(e) => {
              const file = e.target.files?.[0];
              // Reset so re-picking the same file fires change again.
              e.target.value = "";
              if (file) onImport(file);
            }}
          />
        </div>
      </header>

      {/* Running sessions dock */}
      {running.length > 0 && (
        <div className="flex items-center gap-3 px-7 py-[11px] border-b border-[#12151a] overflow-x-auto">
          <div className="flex items-center gap-[7px] flex-shrink-0 text-[11px] font-semibold tracking-[0.4px] text-accent">
            <span className="h-1.5 w-1.5 rounded-full bg-accent animate-cbpulse" />
            LIVE
          </div>
          {running.map((p) => (
            <button
              key={p.id}
              onClick={() => onOpen(p.id)}
              className="flex items-center gap-2 flex-shrink-0 bg-surface-1 border border-border-strong rounded-ctl px-3 py-1.5 text-[13px] font-medium whitespace-nowrap transition-colors hover:border-border-hover"
            >
              <span className="h-[5px] w-[5px] rounded-full bg-accent" />
              {p.name}
            </button>
          ))}
        </div>
      )}

      {/* Toolbar */}
      <div className="flex flex-wrap items-center gap-2 px-7 pt-[18px] pb-0.5">
        <div className="flex items-center gap-1">
          {(["all", "running", "stopped"] as const).map((value) => (
            <button
              key={value}
              onClick={() => setStatusFilter(value)}
              aria-pressed={statusFilter === value}
              className={`rounded-chip px-3 py-[7px] font-display text-[13.5px] font-semibold capitalize border transition-colors ${
                statusFilter === value
                  ? "bg-surface-3 border-[#242a34] text-ink"
                  : "border-transparent text-ink-faint hover:text-ink"
              }`}
            >
              {value}
              <span className="font-mono text-[11px] opacity-60 ml-1.5">
                {counts[value]}
              </span>
            </button>
          ))}
        </div>

        {allTags.length > 0 && (
          <div className="flex flex-wrap items-center gap-1">
            {allTags.map(([tag, color]) => (
              <Tag
                key={tag}
                tag={tag}
                color={color}
                size="sm"
                active={activeTags.includes(tag)}
                onClick={() =>
                  setActiveTags((prev) =>
                    prev.includes(tag)
                      ? prev.filter((t) => t !== tag)
                      : [...prev, tag],
                  )
                }
              />
            ))}
          </div>
        )}

        <div className="ml-auto flex items-center gap-4">
          <div className="relative flex items-center">
            <select
              value={sortKey}
              onChange={(e) => setSortKey(e.target.value as SortKey)}
              aria-label="Sort profiles"
              className="appearance-none bg-transparent text-xs text-ink-faint hover:text-ink pr-5 cursor-pointer focus:outline-none"
            >
              {Object.entries(SORT_LABELS).map(([key, label]) => (
                <option key={key} value={key} className="bg-surface-2 text-ink">
                  {label}
                </option>
              ))}
            </select>
            <ArrowDownUp className="absolute right-0 h-3 w-3 text-ink-faint pointer-events-none" />
          </div>
          <span className="font-mono text-[11px] text-ink-faint whitespace-nowrap">
            {filtered.length} {filtered.length === 1 ? "profile" : "profiles"}
          </span>
        </div>
      </div>

      {/* Grid */}
      <div className="grid grid-cols-[repeat(auto-fill,minmax(360px,1fr))] content-start gap-4 px-7 pt-[18px] pb-10">
        {filtered.length === 0 ? (
          <div className="col-span-full text-center py-20 px-5">
            {profiles.length === 0 ? (
              <>
                <p className="font-display text-base text-ink-muted mb-1.5">
                  No profiles yet
                </p>
                <p className="text-[13.5px] text-ink-faint mb-5">
                  Each profile is an isolated browser with its own fingerprint,
                  proxy, and cookies.
                </p>
                <button onClick={onNew} className="btn-primary">
                  Create your first profile
                </button>
              </>
            ) : (
              <>
                <p className="font-display text-base text-ink-muted mb-1.5">
                  No profiles match
                </p>
                <p className="text-[13.5px] text-ink-faint mb-4">
                  Try a different tag or status.
                </p>
                {filtersActive && (
                  <button
                    onClick={clearFilters}
                    className="text-[13.5px] text-ink-muted hover:text-ink underline"
                  >
                    Clear filters
                  </button>
                )}
              </>
            )}
          </div>
        ) : (
          filtered.map((profile) => (
            <ProfileCard
              key={profile.id}
              profile={profile}
              onOpen={onOpen}
              onLaunch={onLaunch}
              onStop={onStop}
            />
          ))
        )}
      </div>
    </div>
  );
}

function MenuItem({
  icon,
  label,
  onClick,
  disabled,
}: {
  icon: React.ReactNode;
  label: string;
  onClick: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      role="menuitem"
      onClick={onClick}
      disabled={disabled}
      className="flex w-full items-center gap-2.5 px-3 py-2 text-[13px] text-ink-muted hover:bg-surface-2 hover:text-ink disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-ink-muted"
    >
      {icon}
      {label}
    </button>
  );
}
