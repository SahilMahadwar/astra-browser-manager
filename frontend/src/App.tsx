import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Settings, X } from "lucide-react";
import { useProfiles } from "./hooks/useProfiles";
import { useToast } from "./hooks/useToast";
import { useConfirm } from "./hooks/useConfirm";
import { useHotkeys } from "./hooks/useHotkeys";
import { useHashRoute } from "./hooks/useHashRoute";
import { useSystemStatus } from "./hooks/useSystemStatus";
import { api, setOnUnauthorized, type ProfileCreateData } from "./lib/api";
import { Dashboard } from "./components/Dashboard";
import { ProfileForm } from "./components/ProfileForm";
import { ProfileViewer } from "./components/ProfileViewer";
import { LaunchButton } from "./components/LaunchButton";
import { SessionTabs } from "./components/SessionTabs";
import { LoginPage } from "./components/LoginPage";
import { ToastStack } from "./components/ToastStack";
import { ConfirmDialog } from "./components/ConfirmDialog";

type AuthState = "checking" | "required" | "ok" | "error";

export default function App() {
  const [authState, setAuthState] = useState<AuthState>("checking");
  const [authRequired, setAuthRequired] = useState(false);

  const checkAuth = useCallback(
    () =>
      api
        .authStatus()
        .then(({ auth_required, authenticated }) => {
          setAuthRequired(auth_required);
          setAuthState(!auth_required || authenticated ? "ok" : "required");
        })
        .catch((err) => {
          console.warn("[auth] status check failed:", err);
          setAuthState("error");
        }),
    [],
  );

  useEffect(() => {
    setOnUnauthorized(() => setAuthState("required"));
    checkAuth();
    return () => setOnUnauthorized(null);
  }, [checkAuth]);

  if (authState === "checking") {
    return <FullScreenMessage>Loading...</FullScreenMessage>;
  }

  if (authState === "error") {
    return (
      <div className="h-screen flex items-center justify-center bg-surface-0">
        <div className="text-center">
          <p className="text-red-400 text-sm mb-2">Unable to reach the server</p>
          <button
            onClick={() => {
              setAuthState("checking");
              checkAuth();
            }}
            className="text-xs text-ink-muted hover:text-ink underline"
          >
            Retry
          </button>
        </div>
      </div>
    );
  }

  if (authState === "required") {
    return <LoginPage onSuccess={() => setAuthState("ok")} />;
  }

  return (
    <AppContent
      authRequired={authRequired}
      onLogout={async () => {
        await api.logout();
        setAuthState("required");
      }}
    />
  );
}

function FullScreenMessage({ children }: { children: React.ReactNode }) {
  return (
    <div className="h-screen flex items-center justify-center">
      <div className="text-ink-faint text-sm">{children}</div>
    </div>
  );
}

interface AppContentProps {
  authRequired: boolean;
  onLogout: () => void;
}

function AppContent({ authRequired, onLogout }: AppContentProps) {
  const {
    profiles,
    loading,
    error,
    dismissError,
    confirmedStopped,
    create,
    update,
    remove,
    launch,
    stop,
  } = useProfiles();
  const systemStatus = useSystemStatus();
  const toast = useToast();
  const { request: confirmRequest, confirm, onConfirm, onCancel } = useConfirm();
  const { route, navigate } = useHashRoute();

  const { view, profileId: selectedId } = route;
  const selected = profiles.find((p) => p.id === selectedId) ?? null;
  // The session switcher and its ⌘1-9 bindings index the same list, so they must
  // be derived from one place.
  const runningProfiles = useMemo(
    () => profiles.filter((p) => p.status === "running"),
    [profiles],
  );

  const visibleIdsRef = useRef<string[]>([]);
  const dirtyRef = useRef(false);

  const onVisibleChange = useCallback((ids: string[]) => {
    visibleIdsRef.current = ids;
  }, []);

  const onDirtyChange = useCallback((dirty: boolean) => {
    dirtyRef.current = dirty;
  }, []);

  // A profile that vanished (deleted elsewhere, or a stale bookmark) must not
  // leave the app pointing at nothing.
  useEffect(() => {
    if (!loading && selectedId && !profiles.some((p) => p.id === selectedId)) {
      navigate({ view: "empty", profileId: null }, { replace: true });
    }
  }, [loading, selectedId, profiles, navigate]);

  /** Gate any navigation that would discard unsaved form edits. */
  const leaveForm = useCallback(async () => {
    if (!dirtyRef.current) return true;
    const ok = await confirm({
      title: "Discard unsaved changes?",
      body: "This profile has edits that have not been saved.",
      confirmLabel: "Discard",
      danger: true,
    });
    if (ok) dirtyRef.current = false;
    return ok;
  }, [confirm]);

  const handleSelect = useCallback(
    async (id: string) => {
      if (id === selectedId) return;
      if (!(await leaveForm())) return;
      const profile = profiles.find((p) => p.id === id);
      navigate({ view: profile?.status === "running" ? "view" : "edit", profileId: id });
    },
    [selectedId, leaveForm, profiles, navigate],
  );

  const handleNew = useCallback(async () => {
    if (!(await leaveForm())) return;
    navigate({ view: "create", profileId: null });
  }, [leaveForm, navigate]);

  const handleCreate = useCallback(
    async (data: ProfileCreateData) => {
      const profile = await create(data);
      if (profile) {
        toast.success(`Created “${profile.name}”`);
        dirtyRef.current = false;
        navigate({ view: "edit", profileId: profile.id });
      }
    },
    [create, toast, navigate],
  );

  const handleUpdate = useCallback(
    async (data: ProfileCreateData) => {
      if (!selectedId) return;
      const profile = await update(selectedId, data);
      if (profile) toast.success("Profile saved");
    },
    [selectedId, update, toast],
  );

  const handleDuplicate = useCallback(
    async (data: ProfileCreateData) => {
      const profile = await create(data);
      if (profile) {
        toast.success(`Duplicated as “${profile.name}”`);
        dirtyRef.current = false;
        navigate({ view: "edit", profileId: profile.id });
      }
    },
    [create, toast, navigate],
  );

  const handleDelete = useCallback(async () => {
    if (!selectedId || !selected) return;
    const ok = await confirm({
      title: `Delete “${selected.name}”?`,
      body: "Cookies, localStorage, and all other browser data for this profile will be permanently removed.",
      confirmLabel: "Delete",
      danger: true,
    });
    if (!ok) return;

    const name = selected.name;
    if (await remove(selectedId)) {
      toast.success(`Deleted “${name}”`);
      dirtyRef.current = false;
      navigate({ view: "empty", profileId: null });
    }
  }, [selectedId, selected, confirm, remove, toast, navigate]);

  /**
   * `openViewer` is what separates the two callers: launching from a card should
   * leave you on the dashboard (the LIVE dock picks the session up on the next
   * poll), while launching from a profile page means you want to see it.
   */
  const handleLaunch = useCallback(
    async (id: string, openViewer = false) => {
      // Launching swaps the form out for the viewer, so unsaved edits are lost —
      // and would launch with the *old* settings, which is the surprising part.
      if (!(await leaveForm())) return;
      const result = await launch(id);
      if (result) {
        toast.success("Browser launched");
        if (openViewer) navigate({ view: "view", profileId: id });
      }
    },
    [leaveForm, launch, toast, navigate],
  );

  const handleStop = useCallback(
    async (id: string, returnToEdit = false) => {
      const profile = profiles.find((p) => p.id === id);
      if (!profile) return;
      // Stopping kills a live browser session; it used to happen on a single click
      // with no confirmation at all.
      const ok = await confirm({
        title: `Stop “${profile.name}”?`,
        body: "The browser will close. Session data is kept, so relaunching restores it.",
        confirmLabel: "Stop",
        danger: true,
      });
      if (!ok) return;

      if (await stop(id)) {
        toast.success("Browser stopped");
        if (returnToEdit) navigate({ view: "edit", profileId: id });
      }
    },
    [profiles, confirm, stop, toast, navigate],
  );

  const handleVncDisconnect = useCallback(() => {
    if (selectedId) navigate({ view: "edit", profileId: selectedId });
  }, [selectedId, navigate]);

  const handleForceStop = useCallback(async () => {
    if (!selectedId) return;
    const ok = await confirm({
      title: "Force stop this session?",
      body: "The browser is not responding. This drops the session without waiting for it. Session data on disk is kept.",
      confirmLabel: "Force stop",
      danger: true,
    });
    if (!ok) return;

    try {
      await api.forceStopProfile(selectedId);
      toast.success("Session dropped");
      navigate({ view: "edit", profileId: selectedId });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not force stop");
    }
  }, [selectedId, confirm, toast, navigate]);

  const handleExport = useCallback(async () => {
    try {
      const payload = await api.exportProfiles();
      const url = URL.createObjectURL(
        new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" }),
      );
      const a = document.createElement("a");
      a.href = url;
      a.download = "astrabrowser-profiles.json";
      a.click();
      URL.revokeObjectURL(url);
      const n = payload.profiles.length;
      toast.success(
        `Exported ${n} ${n === 1 ? "profile" : "profiles"} — the file contains proxy credentials`,
      );
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Export failed");
    }
  }, [toast]);

  const handleImport = useCallback(
    async (file: File) => {
      let payload: unknown;
      try {
        payload = JSON.parse(await file.text());
      } catch {
        toast.error(`${file.name} is not valid JSON`);
        return;
      }

      try {
        const result = await api.importProfiles(payload as never);
        if (result.created === 0 && result.skipped.length === 0) {
          toast.info("Nothing to import — the file had no profiles");
          return;
        }
        const parts = [
          `Imported ${result.created} ${result.created === 1 ? "profile" : "profiles"}`,
        ];
        if (result.renamed.length > 0) parts.push(`${result.renamed.length} renamed`);
        if (result.skipped.length > 0) parts.push(`${result.skipped.length} skipped`);
        const message = parts.join(" · ");
        if (result.skipped.length > 0) toast.error(message);
        else toast.success(message);
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "Import failed");
      }
    },
    [toast],
  );

  const handleCancelForm = useCallback(async () => {
    if (!(await leaveForm())) return;
    navigate({ view: "empty", profileId: null });
  }, [leaveForm, navigate]);

  // Move the selection through the list as it is currently filtered and sorted.
  const step = useCallback(
    (delta: number) => {
      const ids = visibleIdsRef.current;
      if (ids.length === 0) return;
      const current = selectedId ? ids.indexOf(selectedId) : -1;
      const next = current === -1 ? 0 : Math.min(ids.length - 1, Math.max(0, current + delta));
      const id = ids[next];
      if (id) handleSelect(id);
    },
    [selectedId, handleSelect],
  );

  useHotkeys([
    {
      key: "s",
      mod: true,
      allowInInput: true,
      handler: () => {
        // Submit the open form rather than letting the browser offer to save the page.
        document.querySelector<HTMLFormElement>("form")?.requestSubmit();
      },
    },
    { key: "n", mod: true, allowInInput: true, handler: handleNew },
    // ⌘1-9 jump straight to a live session, but only from the viewer — elsewhere
    // they would fight the browser's own tab switching for no benefit.
    ...Array.from({ length: 9 }, (_, i) => ({
      key: String(i + 1),
      mod: true,
      allowInInput: true,
      handler: () => {
        if (view !== "view") return;
        const target = runningProfiles[i];
        if (target) navigate({ view: "view", profileId: target.id });
      },
    })),
    { key: "ArrowDown", handler: () => step(1) },
    { key: "ArrowUp", handler: () => step(-1) },
    {
      key: "Escape",
      handler: () => {
        if (document.fullscreenElement) return; // the viewer owns Esc in fullscreen
        if (view === "create" || view === "edit") handleCancelForm();
      },
    },
  ]);

  const selectedStopped = selectedId !== null && confirmedStopped.has(selectedId);

  if (loading) {
    return <FullScreenMessage>Loading...</FullScreenMessage>;
  }

  return (
    <div className="h-screen flex flex-col">
      {/* Error banner */}
      {error && (
        <div
          role="alert"
          className="px-7 py-2 bg-red-600/15 border-b border-red-600/30 text-red-400 text-sm flex items-start justify-between gap-3"
        >
          <span className="min-w-0 break-words">{error}</span>
          <button
            onClick={dismissError}
            className="flex-shrink-0 text-red-400/70 hover:text-red-300 p-0.5"
            aria-label="Dismiss error"
            title="Dismiss"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      )}

      {/* The viewer sizes itself to the space it is given, so it must not sit in
          a scrolling container — everything else does. */}
      <div
        className={`flex-1 flex flex-col min-h-0 ${
          view === "view" ? "overflow-hidden" : "overflow-y-auto overscroll-contain"
        }`}
      >
        {view === "empty" && (
          <Dashboard
            profiles={profiles}
            status={systemStatus}
            authRequired={authRequired}
            onOpen={handleSelect}
            onNew={handleNew}
            onLaunch={handleLaunch}
            onStop={handleStop}
            onExport={handleExport}
            onImport={handleImport}
            onLogout={onLogout}
            onVisibleChange={onVisibleChange}
          />
        )}

        {view === "create" && (
          <ProfileForm
            profile={null}
            onSave={handleCreate}
            onCancel={handleCancelForm}
            onDirtyChange={onDirtyChange}
          />
        )}

        {view === "edit" && selected && (
          <ProfileForm
            key={selected.id}
            profile={selected}
            onSave={handleUpdate}
            onDelete={handleDelete}
            onDuplicate={handleDuplicate}
            onCancel={handleCancelForm}
            onDirtyChange={onDirtyChange}
            headerActions={
              <LaunchButton
                status={selected.status}
                onLaunch={() => handleLaunch(selected.id, true)}
                onStop={() => handleStop(selected.id)}
              />
            }
          />
        )}

        {view === "view" && selected && !selectedStopped && (
          <div className="flex-1 flex flex-col min-h-0">
            {/* The viewer owns the rest of the screen, so its way back to the
                dashboard is a bar of its own rather than the form's sticky header. */}
            <SessionTabs
              sessions={runningProfiles}
              activeId={selected.id}
              onBack={() => navigate({ view: "empty", profileId: null })}
              onSelect={(id) => navigate({ view: "view", profileId: id })}
              actions={
                <>
                  <button
                    onClick={() => navigate({ view: "edit", profileId: selected.id })}
                    className="btn-secondary"
                  >
                    <Settings className="h-3.5 w-3.5" />
                    <span>Settings</span>
                  </button>
                  <LaunchButton
                    status={selected.status}
                    onLaunch={() => handleLaunch(selected.id, true)}
                    onStop={() => handleStop(selected.id, true)}
                  />
                </>
              }
            />
            {/* ProfileViewer is h-full, so it needs a parent with a definite
                height rather than the flex line it would otherwise stretch. */}
            <div className="flex-1 min-h-0">
              <ProfileViewer
                key={selected.id}
                profileId={selected.id}
                cdpUrl={selected.cdp_url}
                clipboardSync={selected.clipboard_sync}
                onDisconnect={handleVncDisconnect}
                onForceStop={handleForceStop}
              />
            </div>
          </div>
        )}
      </div>

      <ToastStack toasts={toast.toasts} onDismiss={toast.dismiss} />
      {confirmRequest && (
        <ConfirmDialog {...confirmRequest} onConfirm={onConfirm} onCancel={onCancel} />
      )}
    </div>
  );
}
