interface StatusIndicatorProps {
  status: "running" | "stopped";
  size?: "sm" | "md";
}

export function StatusIndicator({ status, size = "sm" }: StatusIndicatorProps) {
  const sizeClass = size === "sm" ? "h-2 w-2" : "h-2.5 w-2.5";
  const isRunning = status === "running";

  return (
    <span className="relative inline-flex">
      <span
        className={`relative inline-flex ${sizeClass} rounded-full ${
          isRunning ? "bg-accent animate-cbpulse" : "bg-ink-ghost"
        }`}
      />
    </span>
  );
}
