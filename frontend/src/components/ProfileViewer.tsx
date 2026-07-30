import { useEffect, useRef, useState } from "react";
import { AlertTriangle, ClipboardCopy, Code2, Maximize2, Minimize2, X } from "lucide-react";
import { api } from "../lib/api";
import { CdpPanel } from "./CdpPanel";
import { useCdpAlive } from "../hooks/useCdpAlive";

interface ProfileViewerProps {
  profileId: string;
  cdpUrl: string | null;
  clipboardSync: boolean;
  onDisconnect: () => void;
  /** Force-kills a wedged session (Chrome gone, manager still tracking it). */
  onForceStop?: () => void;
}

// X11 keysym for V key (Ctrl is already held in VNC by the time we intercept)
const XK_v = 0x0076;

// A dropped connection is usually transient (a brief network blip, an Xvnc
// hiccup). Retry with backoff before evicting the user out of the view —
// previously a single disconnect event ended the session outright.
const MAX_RECONNECT_ATTEMPTS = 5;
const RECONNECT_BASE_DELAY_MS = 500;
const RECONNECT_MAX_DELAY_MS = 8000;

/**
 * How long a connection must survive before it counts as "good" and refills the
 * retry budget. Resetting on the `connect` event alone made the budget
 * unreachable: a session that flapped every few hundred ms reconnected forever.
 */
const STABLE_CONNECTION_MS = 10_000;

/**
 * Loaded once, not per attempt. Awaiting the import inside the retry path let a
 * second attempt start while the first was still resolving, producing two live
 * RFBs where only one was tracked.
 */
let rfbModule: Promise<typeof import("@novnc/novnc/core/rfb.js")> | null = null;
const loadRfb = () => (rfbModule ??= import("@novnc/novnc/core/rfb.js"));

const CLIPBOARD_POLL_INTERVAL_MS = 2000;

/**
 * Dev-only tracing. Never pass clipboard or page content in here — this used to
 * log the user's actual clipboard text, which then sat in production devtools.
 */
const debug = import.meta.env.DEV
  ? (...args: unknown[]) => console.log("[vnc]", ...args)
  : () => {};

export function ProfileViewer({
  profileId,
  cdpUrl,
  clipboardSync: initialClipboardSync,
  onDisconnect,
  onForceStop,
}: ProfileViewerProps) {
  const wrapperRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const rfbRef = useRef<any>(null);
  const [connected, setConnected] = useState(false);
  const [reconnecting, setReconnecting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fullscreen, setFullscreen] = useState(false);
  const [clipboardSync, setClipboardSync] = useState(initialClipboardSync);
  const [clipboardError, setClipboardError] = useState<string | null>(null);
  const [cdpPanelOpen, setCdpPanelOpen] = useState(false);

  // Only meaningful once the profile claims to be running with a CDP endpoint.
  const wedged = useCdpAlive(profileId, cdpUrl !== null);

  useEffect(() => {
    let cancelled = false;
    let attempt = 0;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    let stableTimer: ReturnType<typeof setTimeout> | null = null;

    // The connection currently owned by this effect, and its identity.
    //
    // Every callback is tagged with the generation that registered it and does
    // nothing once `generation` has moved on. Without this, a dead RFB's
    // `disconnect` listener kept scheduling retries (calling `disconnect()` on an
    // already-dead RFB re-emits the event), and a retry timer queued against the
    // dead connection fired later and tore down its healthy replacement. Each
    // teardown then spawned two more connections, so a single transient drop grew
    // into a permanent connect/close storm against KasmVNC.
    let current: any = null;
    let generation = 0;

    function teardown(instance: any) {
      if (!instance) return;
      try {
        instance.disconnect();
      } catch (err) {
        debug("disconnect failed:", err);
      }
    }

    async function connect() {
      const gen = ++generation;
      try {
        const { default: RFB } = await loadRfb();

        if (cancelled || gen !== generation) return;

        const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
        const wsUrl = `${protocol}//${window.location.host}/api/profiles/${profileId}/vnc`;

        const rfb = new RFB(containerRef.current!, wsUrl, {
          wsProtocols: ["binary"],
        });
        current = rfb;
        rfbRef.current = rfb;

        rfb.scaleViewport = true;
        rfb.resizeSession = false;
        rfb.showDotCursor = true;

        rfb.addEventListener("connect", () => {
          if (cancelled || gen !== generation) return;
          setConnected(true);
          setReconnecting(false);
          // Only a connection that *stays* up refills the retry budget.
          if (stableTimer) clearTimeout(stableTimer);
          stableTimer = setTimeout(() => {
            if (!cancelled && gen === generation) attempt = 0;
          }, STABLE_CONNECTION_MS);
          // Without this the user has to click the canvas before any keystroke
          // reaches the guest.
          try {
            rfb.focus();
          } catch {
            // older noVNC builds may not expose focus()
          }
        });

        rfb.addEventListener("disconnect", () => {
          if (cancelled || gen !== generation) return;
          setConnected(false);
          scheduleReconnect(gen);
        });

        rfb.addEventListener("securityfailure", (e: any) => {
          if (gen !== generation) return;
          // Auth/permission problems will not fix themselves — do not retry.
          cancelled = true;
          setError(`Security failure: ${e.detail.reason}`);
        });
      } catch (err) {
        if (!cancelled && gen === generation) scheduleReconnect(gen, err);
      }
    }

    function scheduleReconnect(gen: number, err?: unknown) {
      if (cancelled || gen !== generation) return;

      if (attempt >= MAX_RECONNECT_ATTEMPTS) {
        console.warn(`[vnc] giving up after ${attempt} reconnect attempts`);
        setReconnecting(false);
        if (err) setError(err instanceof Error ? err.message : "Failed to connect");
        onDisconnect();
        return;
      }

      const delay = Math.min(
        RECONNECT_BASE_DELAY_MS * 2 ** attempt,
        RECONNECT_MAX_DELAY_MS,
      );
      attempt += 1;
      setReconnecting(true);
      console.log(`[vnc] reconnect attempt ${attempt}/${MAX_RECONNECT_ATTEMPTS} in ${delay}ms`);

      // Retire the instance this retry was scheduled for — never whatever
      // happens to be live when the timer fires.
      const dying = current;
      if (retryTimer) clearTimeout(retryTimer);
      retryTimer = setTimeout(() => {
        retryTimer = null;
        if (cancelled || gen !== generation) return;
        // Retire the generation *before* disconnecting: noVNC re-emits
        // `disconnect` when you disconnect an already-dead RFB, and that listener
        // would otherwise schedule a second retry on top of this one.
        generation++;
        teardown(dying);
        if (current === dying) {
          current = null;
          if (rfbRef.current === dying) rfbRef.current = null;
        }
        connect();
      }, delay);
    }

    connect();

    return () => {
      cancelled = true;
      generation++; // invalidates every pending callback, incl. StrictMode's remount
      if (retryTimer) clearTimeout(retryTimer);
      if (stableTimer) clearTimeout(stableTimer);
      teardown(current);
      current = null;
      rfbRef.current = null;
    };
  }, [profileId, onDisconnect]);

  // noVNC only recomputes scale on a *window* resize, so toggling the sidebar or
  // entering fullscreen resized the container and left the canvas at the old
  // scale. Re-assigning scaleViewport re-runs noVNC's _updateScale().
  useEffect(() => {
    const container = containerRef.current;
    if (!container || !connected) return;

    const observer = new ResizeObserver(() => {
      const rfb = rfbRef.current;
      if (rfb) rfb.scaleViewport = true;
    });
    observer.observe(container);
    return () => observer.disconnect();
  }, [connected]);

  // Host→VNC: intercept Ctrl+V/Cmd+V at keydown (capture phase)
  // Must fire BEFORE noVNC's canvas listener to prevent the race condition
  useEffect(() => {
    const container = containerRef.current;
    if (!container || !clipboardSync || !connected) return;

    const handleKeyDown = async (e: KeyboardEvent) => {
      const isPaste =
        e.key === "v" && (e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey;
      if (!isPaste) return;

      debug("intercepted paste shortcut");

      // Block noVNC from sending the keystroke before clipboard is updated
      e.stopPropagation();
      e.preventDefault();

      const rfb = rfbRef.current;
      if (!rfb) return;

      try {
        const text = await navigator.clipboard.readText();
        if (text) await api.setClipboard(profileId, text);
        setClipboardError(null);
      } catch (err) {
        // Do NOT disable sync here. A denied permission or an unfocused document
        // is a per-attempt failure, and silently turning sync off left the user
        // with a greyed-out icon and no explanation for the rest of the session.
        debug("paste failed:", err);
        setClipboardError(
          "Could not read the host clipboard. Grant clipboard permission and try again.",
        );
        return;
      }

      // Send full Ctrl+V sequence to VNC. We can't rely on Ctrl still being
      // held because the user may have released it during the async API call.
      rfb.sendKey(0xffe3, "ControlLeft", true);   // Ctrl press
      rfb.sendKey(XK_v, "KeyV", true);             // V press
      rfb.sendKey(XK_v, "KeyV", false);            // V release
      rfb.sendKey(0xffe3, "ControlLeft", false);   // Ctrl release
    };

    // capture: true ensures we fire before noVNC's canvas listener
    container.addEventListener("keydown", handleKeyDown, true);
    return () => container.removeEventListener("keydown", handleKeyDown, true);
  }, [profileId, clipboardSync, connected]);

  // VNC→Host: listen for noVNC "clipboard" event (fired when proxy converts
  // KasmVNC BinaryClipboard type 180 → standard ServerCutText type 3)
  useEffect(() => {
    const rfb = rfbRef.current;
    if (!rfb || !clipboardSync || !connected) return;

    const handleClipboard = (e: any) => {
      const text = e.detail?.text;
      if (!text) return;
      navigator.clipboard.writeText(text).catch((err) => {
        debug("writeText failed:", err);
      });
    };

    rfb.addEventListener("clipboard", handleClipboard);
    return () => rfb.removeEventListener("clipboard", handleClipboard);
  }, [clipboardSync, connected]);

  // VNC→Host polling: Chrome doesn't write to the X11 clipboard under KasmVNC,
  // so type 180 events won't fire for Chrome copies. Poll the API instead.
  useEffect(() => {
    if (!clipboardSync || !connected) return;

    let cancelled = false;
    let lastText = "";

    const poll = async () => {
      if (cancelled) return;
      try {
        const { text } = await api.getClipboard(profileId);
        if (text && text !== lastText) {
          lastText = text;
          await navigator.clipboard.writeText(text).catch((err) =>
            debug("poll writeText failed:", err)
          );
        }
      } catch (err) {
        debug("clipboard poll stopped:", err);
        cancelled = true;
        return;
      }
      if (!cancelled) {
        setTimeout(poll, CLIPBOARD_POLL_INTERVAL_MS);
      }
    };

    const timer = setTimeout(poll, CLIPBOARD_POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [profileId, clipboardSync, connected]);

  // Fullscreen the whole wrapper, not just the canvas — fullscreening the canvas
  // container left the toolbar (status, clipboard toggle, exit button) outside
  // the fullscreen element, so Esc was the only way back out.
  const toggleFullscreen = () => {
    if (!document.fullscreenElement) {
      wrapperRef.current?.requestFullscreen().catch((err) => {
        console.warn("[vnc] fullscreen request rejected:", err);
        setFullscreen(false);
      });
    } else {
      document.exitFullscreen().catch((err) => {
        console.warn("[vnc] exit fullscreen failed:", err);
      });
    }
  };

  useEffect(() => {
    const handleFsChange = () => {
      setFullscreen(!!document.fullscreenElement);
    };
    document.addEventListener("fullscreenchange", handleFsChange);
    return () => document.removeEventListener("fullscreenchange", handleFsChange);
  }, []);

  // Keep the wheel inside the container: without this it scrolls the ancestor
  // and Chrome's horizontal-swipe gesture navigates back out of the app.
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const handleWheel = (e: WheelEvent) => {
      e.preventDefault();
    };

    container.addEventListener("wheel", handleWheel, { passive: false });
    return () => container.removeEventListener("wheel", handleWheel);
  }, []);

  if (error) {
    return (
      <div className="flex items-center justify-center h-full">
        <div className="text-center">
          <p className="text-red-400 text-sm mb-2">Connection failed</p>
          <p className="text-gray-500 text-xs">{error}</p>
        </div>
      </div>
    );
  }

  return (
    <div ref={wrapperRef} className="relative h-full flex flex-col bg-surface-0">
      {/* Toolbar */}
      <div className="flex items-center justify-between px-3 py-1.5 bg-surface-1 border-b border-border">
        <div className="flex items-center gap-2">
          <span
            className={`h-2 w-2 rounded-full ${
              connected
                ? "bg-emerald-400"
                : reconnecting
                  ? "bg-orange-400 animate-pulse"
                  : "bg-yellow-400 animate-pulse"
            }`}
          />
          <span className="text-xs text-gray-400">
            {connected ? "Connected" : reconnecting ? "Reconnecting..." : "Connecting..."}
          </span>
        </div>
        <div className="flex items-center gap-1">
          {cdpUrl && (
            <button
              onClick={() => setCdpPanelOpen(true)}
              className="text-gray-500 hover:text-gray-300 p-1"
              title="Automation endpoint (CDP)"
              aria-label="Show automation endpoint"
            >
              <Code2 className="h-3.5 w-3.5" />
            </button>
          )}
          <button
            onClick={() => {
              setClipboardError(null);
              setClipboardSync(!clipboardSync);
            }}
            className={`p-1 ${clipboardSync ? "text-accent" : "text-gray-500 hover:text-gray-300"}`}
            title={clipboardSync ? "Disable clipboard sync" : "Enable clipboard sync"}
            aria-label={clipboardSync ? "Disable clipboard sync" : "Enable clipboard sync"}
            disabled={!connected}
          >
            <ClipboardCopy className="h-3.5 w-3.5" />
          </button>
          <button
            onClick={toggleFullscreen}
            className="text-gray-500 hover:text-gray-300 p-1"
            title={fullscreen ? "Exit fullscreen" : "Fullscreen"}
            aria-label={fullscreen ? "Exit fullscreen" : "Enter fullscreen"}
          >
            {fullscreen ? <Minimize2 className="h-3.5 w-3.5" /> : <Maximize2 className="h-3.5 w-3.5" />}
          </button>
        </div>
      </div>

      {/* Chrome's CDP port stopped answering while the manager still lists the
          profile as running. Stopping is the only way out of this state. */}
      {wedged && (
        <div
          role="alert"
          className="flex items-center justify-between gap-3 px-3 py-1.5 bg-red-600/15 border-b border-red-600/30 text-red-300 text-xs"
        >
          <span className="flex items-center gap-1.5 min-w-0">
            <AlertTriangle className="h-3.5 w-3.5 flex-shrink-0" />
            <span className="break-words">
              This session is unresponsive — the browser is no longer answering.
            </span>
          </span>
          {onForceStop && (
            <button
              onClick={onForceStop}
              className="flex-shrink-0 underline hover:text-red-200"
            >
              Force stop
            </button>
          )}
        </div>
      )}

      {/* Clipboard problems are per-attempt and recoverable, so say so instead of
          silently switching sync off. */}
      {clipboardError && (
        <div
          role="status"
          className="flex items-start justify-between gap-3 px-3 py-1.5 bg-amber-500/10 border-b border-amber-500/30 text-amber-400 text-xs"
        >
          <span className="flex items-center gap-1.5 min-w-0">
            <AlertTriangle className="h-3.5 w-3.5 flex-shrink-0" />
            <span className="break-words">{clipboardError}</span>
          </span>
          <button
            onClick={() => setClipboardError(null)}
            className="flex-shrink-0 text-amber-400/70 hover:text-amber-300"
            aria-label="Dismiss clipboard warning"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      )}

      {/* VNC canvas container */}
      <div
        ref={containerRef}
        className="flex-1 bg-black overflow-hidden"
        style={{ minHeight: 0 }}
      />

      {cdpPanelOpen && cdpUrl && (
        <CdpPanel
          profileId={profileId}
          cdpUrl={cdpUrl}
          onClose={() => setCdpPanelOpen(false)}
        />
      )}
    </div>
  );
}
