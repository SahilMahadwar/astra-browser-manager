import { X } from "lucide-react";

interface TagProps {
  tag: string;
  color: string | null;
  size?: "sm" | "md";
  /** Renders a remove button when provided. */
  onRemove?: () => void;
  /** Renders as a toggle button (used by the sidebar tag filter). */
  onClick?: () => void;
  active?: boolean;
}

/**
 * The tag chip, previously duplicated between the sidebar and the form — colour
 * is applied as a 12.5%-alpha background with the full-strength colour as text,
 * hence the `${color}20` suffix.
 */
export function Tag({ tag, color, size = "md", onRemove, onClick, active }: TagProps) {
  const sizing = size === "sm" ? "text-[10px] px-1.5 py-0.5" : "text-xs px-2 py-1";
  const tinted = color
    ? { backgroundColor: `${color}20`, color }
    : undefined;

  const content = (
    <>
      {tag}
      {onRemove && (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onRemove();
          }}
          className="hover:opacity-70"
          aria-label={`Remove tag ${tag}`}
        >
          <X className="h-3 w-3" />
        </button>
      )}
    </>
  );

  const base = `inline-flex items-center gap-1 rounded-full ${sizing} ${
    color ? "" : "bg-surface-3 text-ink-muted"
  }`;

  if (onClick) {
    return (
      <button
        type="button"
        onClick={onClick}
        aria-pressed={active}
        className={`${base} transition-opacity ${active ? "ring-1 ring-inset ring-current" : "opacity-60 hover:opacity-100"}`}
        style={tinted}
      >
        {content}
      </button>
    );
  }

  return (
    <span className={base} style={tinted}>
      {content}
    </span>
  );
}
