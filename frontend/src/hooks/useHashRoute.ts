import { useCallback, useEffect, useState } from "react";

export type View = "empty" | "create" | "edit" | "view";

export interface Route {
  view: View;
  profileId: string | null;
}

const EMPTY: Route = { view: "empty", profileId: null };

/**
 * Parse `#/new`, `#/p/<id>/edit`, `#/p/<id>/view`. Anything unrecognised is the
 * empty view rather than an error — a stale or hand-edited hash should not break
 * the app.
 */
export function parseHash(hash: string): Route {
  const path = hash.replace(/^#\/?/, "");
  if (path === "new") return { view: "create", profileId: null };

  const match = /^p\/([^/]+)\/(edit|view)$/.exec(path);
  if (match) return { view: match[2] as View, profileId: match[1]! };

  return EMPTY;
}

export function formatHash({ view, profileId }: Route): string {
  if (view === "create") return "#/new";
  if ((view === "edit" || view === "view") && profileId) return `#/p/${profileId}/${view}`;
  return "#/";
}

/**
 * Keeps the view in the URL so a refresh restores it and Back works. Deliberately
 * hash-based: the SPA is served by a catch-all, and a hash needs no router and no
 * server route changes.
 */
export function useHashRoute() {
  const [route, setRoute] = useState<Route>(() => parseHash(window.location.hash));

  useEffect(() => {
    const onHashChange = () => setRoute(parseHash(window.location.hash));
    window.addEventListener("hashchange", onHashChange);
    return () => window.removeEventListener("hashchange", onHashChange);
  }, []);

  // Writing location.hash fires hashchange, which updates state — so this is the
  // single source of truth rather than two states kept in sync.
  const navigate = useCallback((next: Route, { replace = false } = {}) => {
    const hash = formatHash(next);
    if (hash === window.location.hash) {
      setRoute(next);
      return;
    }
    if (replace) {
      history.replaceState(null, "", hash);
      setRoute(next);
    } else {
      window.location.hash = hash;
    }
  }, []);

  return { route, navigate };
}
