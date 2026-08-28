import { useCallback, useEffect, useState } from "react";
import { Check, Copy, ExternalLink, RefreshCw, X } from "lucide-react";
import { api, type AutomationProtocol, type CdpTarget } from "../lib/api";

interface CdpPanelProps {
  profileId: string;
  /** Relative automation path, e.g. /api/profiles/<id>/cdp or .../pw */
  cdpUrl: string;
  protocol: AutomationProtocol;
  onClose: () => void;
}

/**
 * Snippets differ per engine because the protocols do. Camoufox is Firefox and
 * has no CDP at all (Firefox removed it in 141), so connectOverCDP there does
 * not merely underperform — it throws. Showing the wrong snippet would send
 * someone down a long debugging hole, so this branches rather than generalises.
 */
function snippets(endpoint: string, protocol: AutomationProtocol) {
  if (protocol === "playwright-firefox") {
    return [
      {
        label: "Python",
        code: `from playwright.sync_api import sync_playwright

with sync_playwright() as pw:
    browser = pw.firefox.connect("${endpoint}")
    # contexts[0] is the profile's persistent context - the same window you
    # are watching in the live view. Do not call new_context().
    context = browser.contexts[0]
    page = context.pages[0] if context.pages else context.new_page()
    page.goto("https://example.com")
    print(page.title())`,
      },
      {
        label: "JavaScript",
        code: `const { firefox } = require("playwright");

const browser = await firefox.connect("${endpoint}");
// contexts()[0] is the profile's persistent context - the same window you
// are watching in the live view. Do not call newContext().
const context = browser.contexts()[0];
const page = context.pages()[0] ?? (await context.newPage());
await page.goto("https://example.com");
console.log(await page.title());`,
      },
    ];
  }

  return [
    {
      label: "Python",
      code: `from playwright.sync_api import sync_playwright

with sync_playwright() as pw:
    browser = pw.chromium.connect_over_cdp("${endpoint}")
    page = browser.contexts[0].pages[0]
    page.goto("https://example.com")
    print(page.title())`,
    },
    {
      label: "JavaScript",
      code: `const { chromium } = require("playwright");

const browser = await chromium.connectOverCDP("${endpoint}");
const page = browser.contexts()[0].pages()[0];
await page.goto("https://example.com");
console.log(await page.title());`,
    },
    {
      label: "Puppeteer",
      code: `const puppeteer = require("puppeteer-core");

const browser = await puppeteer.connect({
  browserURL: "${endpoint}",
});
const [page] = await browser.pages();
await page.goto("https://example.com");`,
    },
  ];
}

function CopyButton({ value, label }: { value: string; label: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      onClick={() => {
        navigator.clipboard?.writeText(value).then(
          () => {
            setCopied(true);
            setTimeout(() => setCopied(false), 2000);
          },
          (err) => console.warn("[cdp] copy failed:", err),
        );
      }}
      className={`flex items-center gap-1 text-xs ${copied ? "text-emerald-400" : "text-gray-400 hover:text-gray-200"}`}
      aria-label={copied ? "Copied" : label}
    >
      {copied ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
      <span>{copied ? "Copied" : "Copy"}</span>
    </button>
  );
}

/**
 * Replaces the copy-only toolbar button. Surfaces ready-to-run snippets and the
 * live tab list from `/cdp/json/list` — an endpoint that has always existed (with
 * page WebSocket URLs already rewritten to route through the proxy) and was never
 * called by the UI.
 */
export function CdpPanel({ profileId, cdpUrl, protocol, onClose }: CdpPanelProps) {
  const isCdp = protocol === "cdp";
  // firefox.connect() takes a ws:// URL; connectOverCDP() takes the http base
  // and discovers the socket itself. Handing either the other's form fails.
  const scheme = isCdp
    ? window.location.protocol
    : window.location.protocol === "https:"
      ? "wss:"
      : "ws:";
  const endpoint = `${scheme}//${window.location.host}${cdpUrl}`;
  const [lang, setLang] = useState(0);
  const [targets, setTargets] = useState<CdpTarget[] | null>(null);
  const [targetsError, setTargetsError] = useState<string | null>(null);
  const [loadingTargets, setLoadingTargets] = useState(false);

  const loadTargets = useCallback(async () => {
    // Firefox has no /json/list — there is no target list to fetch.
    if (!isCdp) return;
    setLoadingTargets(true);
    try {
      const list = await api.cdpTargets(profileId);
      setTargets(list.filter((t) => t.type === "page"));
      setTargetsError(null);
    } catch (err) {
      setTargetsError(err instanceof Error ? err.message : "Could not read open tabs");
    } finally {
      setLoadingTargets(false);
    }
  }, [profileId, isCdp]);

  useEffect(() => {
    loadTargets();
  }, [loadTargets]);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      }
    };
    document.addEventListener("keydown", onKeyDown, true);
    return () => document.removeEventListener("keydown", onKeyDown, true);
  }, [onClose]);

  const langs = snippets(endpoint, protocol);
  const active = langs[lang]!;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="cdp-title"
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-2xl max-h-[85vh] overflow-y-auto bg-surface-1 border border-border rounded-lg p-5 shadow-2xl"
      >
        <div className="flex items-start justify-between mb-4">
          <div>
            <h2 id="cdp-title" className="text-sm font-semibold">
              Automation endpoint
            </h2>
            <p className="text-xs text-gray-500 mt-0.5">
              {isCdp
                ? "Drive this profile with Playwright or Puppeteer while watching it live."
                : "Drive this profile with Playwright while watching it live. This engine is Firefox-based and speaks the Playwright protocol, not CDP."}
            </p>
          </div>
          <button
            onClick={onClose}
            className="text-gray-500 hover:text-gray-300 p-1"
            aria-label="Close"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Endpoint URL */}
        <div className="mb-4">
          <div className="flex items-center justify-between mb-1">
            <span className="label mb-0">
              {isCdp ? "CDP URL" : "Playwright WebSocket URL"}
            </span>
            <CopyButton value={endpoint} label="Copy automation URL" />
          </div>
          <code className="block bg-surface-2 border border-border rounded-md px-3 py-2 text-xs font-mono text-gray-300 break-all">
            {endpoint}
          </code>
        </div>

        {/* Snippets */}
        <div className="mb-4">
          <div className="flex items-center justify-between mb-1.5">
            <div className="flex gap-1">
              {langs.map((l, i) => (
                <button
                  key={l.label}
                  type="button"
                  onClick={() => setLang(i)}
                  aria-pressed={i === lang}
                  className={`text-xs px-2 py-1 rounded-md ${
                    i === lang
                      ? "bg-surface-3 text-gray-200"
                      : "text-gray-500 hover:text-gray-300"
                  }`}
                >
                  {l.label}
                </button>
              ))}
            </div>
            <CopyButton value={active.code} label={`Copy ${active.label} snippet`} />
          </div>
          <pre className="bg-surface-2 border border-border rounded-md px-3 py-2 text-xs font-mono text-gray-300 overflow-x-auto">
            {active.code}
          </pre>
        </div>

        {!isCdp && (
          <p className="mb-4 text-xs text-amber-400/90 bg-amber-400/10 border border-amber-400/20 rounded-md px-3 py-2">
            Your <code className="font-mono">playwright</code> major.minor must match this
            server&rsquo;s. A mismatch is <strong>not</strong> rejected when you connect &mdash;
            it shows up later as{" "}
            <code className="font-mono">timeout: expected float, got undefined</code> on
            calls like <code className="font-mono">goto</code>.
          </p>
        )}

        {/* Live tab list — Chromium only; Firefox exposes no target list. */}
        <div className={isCdp ? undefined : "hidden"}>
          <div className="flex items-center justify-between mb-1.5">
            <span className="label mb-0">
              Open tabs{targets ? ` (${targets.length})` : ""}
            </span>
            <button
              type="button"
              onClick={loadTargets}
              disabled={loadingTargets}
              className="flex items-center gap-1 text-xs text-gray-400 hover:text-gray-200 disabled:opacity-50"
            >
              <RefreshCw className={`h-3 w-3 ${loadingTargets ? "animate-spin" : ""}`} />
              <span>Refresh</span>
            </button>
          </div>

          {targetsError && <p className="text-xs text-red-400">{targetsError}</p>}

          {!targetsError && targets?.length === 0 && (
            <p className="text-xs text-gray-500">No open tabs.</p>
          )}

          {!targetsError && targets && targets.length > 0 && (
            <ul className="space-y-1">
              {targets.map((target) => (
                <li
                  key={target.id}
                  className="flex items-start gap-2 bg-surface-2 border border-border rounded-md px-3 py-2"
                >
                  <ExternalLink className="h-3 w-3 text-gray-500 flex-shrink-0 mt-1" />
                  <div className="min-w-0">
                    <p className="text-xs text-gray-200 truncate">
                      {target.title || "(untitled)"}
                    </p>
                    <p className="text-[11px] text-gray-500 truncate font-mono">
                      {target.url}
                    </p>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}
