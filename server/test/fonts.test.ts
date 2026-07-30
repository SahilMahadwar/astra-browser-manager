import { beforeEach, describe, expect, it, vi } from 'vitest';

const execFileSync = vi.hoisted(() => vi.fn());
vi.mock('node:child_process', () => ({ execFileSync }));

const { WINDOWS_FONT_TELLS, missingWindowsFonts, logFontStatus } = await import(
  '../src/fonts.js'
);

/** An fc-list listing that advertises every given family. */
function listing(families: readonly string[]): string {
  return families
    .map((f, i) => `/usr/share/fonts/truetype/f${i}.ttf: ${f}:style=Regular`)
    .join('\n');
}

describe('missingWindowsFonts', () => {
  beforeEach(() => {
    execFileSync.mockReset();
  });

  it('returns an empty array when every tell is installed', () => {
    execFileSync.mockReturnValue(listing(WINDOWS_FONT_TELLS));
    expect(missingWindowsFonts()).toEqual([]);
  });

  it('matches case-insensitively — fc-list casing varies by host', () => {
    execFileSync.mockReturnValue(listing(WINDOWS_FONT_TELLS).toUpperCase());
    expect(missingWindowsFonts()).toEqual([]);
  });

  it('names only the missing families on a partial set', () => {
    // What the stock image actually ships: msttcorefonts gives Courier New and
    // nothing else from the tell list.
    execFileSync.mockReturnValue(listing(['Courier New', 'Arial', 'Verdana']));
    const missing = missingWindowsFonts();
    expect(missing).not.toContain('Courier New');
    expect(missing).toEqual(WINDOWS_FONT_TELLS.filter((f) => f !== 'Courier New'));
  });

  it('returns null when fc-list is unavailable, NOT an empty array', () => {
    execFileSync.mockImplementation(() => {
      throw new Error('ENOENT');
    });
    const missing = missingWindowsFonts();
    // The distinction is load-bearing: [] means "complete", null means
    // "unknown". Conflating them would silently claim a Windows font set that
    // was never verified.
    expect(missing).toBeNull();
    expect(missing).not.toEqual([]);
  });
});

describe('logFontStatus', () => {
  beforeEach(() => {
    execFileSync.mockReset();
    vi.restoreAllMocks();
  });

  it('warns and names the gaps when the set is incomplete', () => {
    execFileSync.mockReturnValue(listing(['Courier New']));
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});

    logFontStatus();

    expect(err).toHaveBeenCalledOnce();
    const line = err.mock.calls[0][0] as string;
    expect(line).toContain('Segoe UI');
    expect(line).toContain('/data/fonts');
  });

  it('stays silent when fc-list cannot answer', () => {
    execFileSync.mockImplementation(() => {
      throw new Error('ENOENT');
    });
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const out = vi.spyOn(console, 'log').mockImplementation(() => {});

    logFontStatus();

    expect(err).not.toHaveBeenCalled();
    expect(out).not.toHaveBeenCalled();
  });

  it('reports success when the set is complete', () => {
    execFileSync.mockReturnValue(listing(WINDOWS_FONT_TELLS));
    const out = vi.spyOn(console, 'log').mockImplementation(() => {});

    logFontStatus();

    expect(out.mock.calls[0][0]).toContain('Windows font set complete');
  });
});
