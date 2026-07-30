import { ChevronLeft } from "lucide-react";
import type { Profile } from "../lib/api";

interface SessionTabsProps {
  /** Running profiles, in the order the hotkeys are numbered. */
  sessions: Profile[];
  activeId: string | null;
  onBack: () => void;
  onSelect: (id: string) => void;
  /** Right-aligned controls for the active session (Settings, Launch/Stop). */
  actions?: React.ReactNode;
}

/** ⌘ on Apple hardware, Ctrl everywhere else — the hint has to match the binding. */
const MOD_LABEL = /Mac|iPhone|iPad/i.test(navigator.userAgent) ? "⌘" : "^";

/**
 * Switcher across live sessions, so hopping between running browsers does not
 * mean a round trip through the dashboard. Only the first nine get a hotkey
 * hint; the rest are still clickable.
 */
export function SessionTabs({
  sessions,
  activeId,
  onBack,
  onSelect,
  actions,
}: SessionTabsProps) {
  return (
    <div className="flex items-center gap-3 px-7 py-3 border-b border-border bg-surface-0">
      <button
        onClick={onBack}
        className="flex items-center gap-1.5 flex-shrink-0 rounded-ctl bg-surface-2 border border-border-strong px-3 py-[7px] font-display text-[13px] font-semibold text-ink-muted transition-colors hover:border-border-hover hover:text-ink"
      >
        <ChevronLeft className="h-3.5 w-3.5" />
        Dashboard
      </button>

      <span className="h-[22px] w-px flex-shrink-0 bg-border-strong" />

      <div className="flex items-center gap-2 overflow-x-auto">
        {sessions.map((session, index) => {
          const active = session.id === activeId;
          return (
            <button
              key={session.id}
              onClick={() => onSelect(session.id)}
              aria-current={active}
              className={`flex items-center gap-2 flex-shrink-0 rounded-ctl border px-3 py-[7px] text-[13px] whitespace-nowrap transition-colors ${
                active
                  ? "border-[#2f6b4f] bg-[#0f1a14] text-ink"
                  : "border-border-strong bg-surface-2 text-ink-muted hover:border-border-hover hover:text-ink"
              }`}
            >
              <span className="h-[5px] w-[5px] rounded-full bg-accent" />
              {session.name}
              {index < 9 && (
                <span className="font-mono text-[10px] text-ink-faint">
                  {MOD_LABEL}
                  {index + 1}
                </span>
              )}
            </button>
          );
        })}
      </div>

      {actions && (
        <div className="ml-auto flex items-center gap-2 flex-shrink-0">{actions}</div>
      )}
    </div>
  );
}
