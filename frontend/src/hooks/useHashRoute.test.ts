import { describe, expect, it } from "vitest";
import { formatHash, parseHash, type Route } from "./useHashRoute";

describe("parseHash", () => {
  it("reads the create route", () => {
    expect(parseHash("#/new")).toEqual({ view: "create", profileId: null });
  });

  it("reads edit and view routes with an id", () => {
    expect(parseHash("#/p/abc-123/edit")).toEqual({ view: "edit", profileId: "abc-123" });
    expect(parseHash("#/p/abc-123/view")).toEqual({ view: "view", profileId: "abc-123" });
  });

  it("treats anything unrecognised as the empty view", () => {
    // A stale bookmark or a hand-edited hash must not break the app.
    for (const hash of ["", "#", "#/", "#/nonsense", "#/p/abc", "#/p/abc/bogus", "#/p//edit"]) {
      expect(parseHash(hash)).toEqual({ view: "empty", profileId: null });
    }
  });

  it("tolerates a missing leading slash", () => {
    expect(parseHash("#new")).toEqual({ view: "create", profileId: null });
  });
});

describe("formatHash", () => {
  it("round-trips every real route", () => {
    const routes: Route[] = [
      { view: "create", profileId: null },
      { view: "edit", profileId: "abc-123" },
      { view: "view", profileId: "abc-123" },
    ];
    for (const route of routes) {
      expect(parseHash(formatHash(route))).toEqual(route);
    }
  });

  it("falls back to the root when an id-bearing view has no id", () => {
    expect(formatHash({ view: "edit", profileId: null })).toBe("#/");
    expect(formatHash({ view: "empty", profileId: null })).toBe("#/");
  });
});
