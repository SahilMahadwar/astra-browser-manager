/** Ported from backend/tests/test_vnc_manager.py, plus spawn-failure coverage. */

import { describe, expect, it } from 'vitest';

import { BASE_DISPLAY, BASE_WS_PORT, VNCManager } from '../src/vnc.js';

describe('allocate', () => {
  it('starts at the base display and port', () => {
    expect(new VNCManager().allocate()).toEqual({
      display: BASE_DISPLAY,
      wsPort: BASE_WS_PORT,
    });
  });

  it('hands out sequential displays with paired ports', () => {
    const vnc = new VNCManager();
    expect(vnc.allocate()).toEqual({ display: 100, wsPort: 6100 });
    expect(vnc.allocate()).toEqual({ display: 101, wsPort: 6101 });
    expect(vnc.allocate()).toEqual({ display: 102, wsPort: 6102 });
  });

  it('reuses a display after it is released', async () => {
    const vnc = new VNCManager();
    const first = vnc.allocate();
    vnc.allocate();
    await vnc.stopVnc(first.display);
    expect(vnc.allocate().display).toBe(first.display);
  });
});

describe('getWsPort', () => {
  it('returns null for an unallocated display', () => {
    expect(new VNCManager().getWsPort(999)).toBeNull();
  });

  it('returns the paired port for an allocated display', () => {
    const vnc = new VNCManager();
    const { display, wsPort } = vnc.allocate();
    expect(vnc.getWsPort(display)).toBe(wsPort);
  });
});

describe('activeDisplays', () => {
  it('is empty initially', () => {
    expect(new VNCManager().activeDisplays).toEqual([]);
  });

  it('tracks allocations', () => {
    const vnc = new VNCManager();
    vnc.allocate();
    vnc.allocate();
    expect(vnc.activeDisplays).toEqual([100, 101]);
  });
});

describe('startVnc failure handling', () => {
  /**
   * Regression: a missing Xvnc binary emits 'error' on the child process. With
   * no listener attached that becomes an unhandled exception and kills the
   * server rather than failing this one launch.
   */
  it('rejects instead of crashing when Xvnc is not installed', async () => {
    const vnc = new VNCManager();
    const { display, wsPort } = vnc.allocate();

    await expect(vnc.startVnc(display, wsPort)).rejects.toThrow(/Xvnc failed to start/);
  });

  it('releases the display allocation after a failed start', async () => {
    const vnc = new VNCManager();
    const { display, wsPort } = vnc.allocate();
    await vnc.startVnc(display, wsPort).catch(() => {});
    expect(vnc.activeDisplays).not.toContain(display);
  });

  it('reports the display as not alive after a failed start', async () => {
    const vnc = new VNCManager();
    const { display, wsPort } = vnc.allocate();
    await vnc.startVnc(display, wsPort).catch(() => {});
    expect(vnc.isAlive(display)).toBe(false);
  });
});

describe('stopVnc', () => {
  it('is a no-op for an unknown display', async () => {
    await expect(new VNCManager().stopVnc(999)).resolves.toBeUndefined();
  });

  it('releases the allocation', async () => {
    const vnc = new VNCManager();
    const { display } = vnc.allocate();
    await vnc.stopVnc(display);
    expect(vnc.activeDisplays).toEqual([]);
  });
});
