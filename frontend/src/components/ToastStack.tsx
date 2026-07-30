import { AlertCircle, CheckCircle2, Info, X } from "lucide-react";
import type { Toast } from "../hooks/useToast";

interface ToastStackProps {
  toasts: Toast[];
  onDismiss: (id: number) => void;
}

const STYLES = {
  success: {
    box: "bg-accent/10 border-accent/30 text-accent",
    Icon: CheckCircle2,
  },
  error: {
    box: "bg-danger/10 border-danger/30 text-danger",
    Icon: AlertCircle,
  },
  info: {
    box: "bg-surface-2 border-border-strong text-ink-muted",
    Icon: Info,
  },
} as const;

export function ToastStack({ toasts, onDismiss }: ToastStackProps) {
  if (toasts.length === 0) return null;

  return (
    <div
      // Announced politely so a screen reader hears the outcome without stealing focus.
      aria-live="polite"
      className="fixed bottom-4 right-4 z-50 flex flex-col gap-2 w-80 max-w-[calc(100vw-2rem)]"
    >
      {toasts.map(({ id, kind, message }) => {
        const { box, Icon } = STYLES[kind];
        return (
          <div
            key={id}
            className={`flex items-start gap-2 px-3 py-2.5 rounded-chip border text-sm shadow-[0_20px_50px_rgba(0,0,0,.5)] animate-cbrise ${box}`}
          >
            <Icon className="h-4 w-4 flex-shrink-0 mt-0.5" />
            <span className="flex-1 min-w-0 break-words">{message}</span>
            <button
              onClick={() => onDismiss(id)}
              className="flex-shrink-0 opacity-60 hover:opacity-100"
              aria-label="Dismiss notification"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
        );
      })}
    </div>
  );
}
