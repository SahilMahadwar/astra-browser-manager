/**
 * KasmVNC display allocation and lifecycle. Ported from backend/vnc_manager.py.
 *
 * Each running profile gets its own Xvnc instance — an X11 server that renders
 * into memory instead of a graphics card — and Chromium is pointed at it via
 * the DISPLAY environment variable (see browser.ts).
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { openSync, readFileSync, existsSync } from 'node:fs';

import { logger } from './logger.js';

const log = logger('vnc');

export interface VNCInstance {
  display: number;
  wsPort: number;
  process: ChildProcess | null;
}

export const BASE_DISPLAY = 100;
export const BASE_WS_PORT = 6100;

export class VNCManager {
  private allocated = new Map<number, VNCInstance>();

  /** Reserve the next free display and its paired WebSocket port. */
  allocate(): { display: number; wsPort: number } {
    let display = BASE_DISPLAY;
    while (this.allocated.has(display)) display += 1;
    const wsPort = BASE_WS_PORT + (display - BASE_DISPLAY);
    this.allocated.set(display, { display, wsPort, process: null });
    return { display, wsPort };
  }

  /** Start Xvnc (KasmVNC) on the given display. */
  async startVnc(
    display: number,
    wsPort: number,
    width = 1920,
    height = 1080
  ): Promise<ChildProcess> {
    // -httpd is required: without it the WebSocket port accepts TCP but never
    // performs the WebSocket upgrade.
    const httpdDir = '/usr/share/kasmvnc/www';

    const args = [
      `:${display}`,
      '-websocketPort', String(wsPort),
      '-rfbport', '-1', // disable raw VNC TCP port — WebSocket only
      '-geometry', `${width}x${height}`,
      '-depth', '24',
      '-SecurityTypes', 'None',
      '-DisableBasicAuth',
      '-interface', '127.0.0.1', // internal only, proxied by the app
      '-AlwaysShared',
      '-httpd', httpdDir,
    ];

    const logPath = `/tmp/xvnc-${display}.log`;
    log.info(`Starting Xvnc on :${display} (wsPort=${wsPort}) log=${logPath}`);

    const logFd = openSync(logPath, 'w');
    const proc = spawn('Xvnc', args, { stdio: ['ignore', logFd, logFd] });

    let failure: string | null = null;

    proc.once('exit', (code) => {
      failure ??= `exited with code ${code ?? -1}`;
    });
    // Without this listener a spawn failure (Xvnc missing, not executable)
    // emits an unhandled 'error' and takes the whole server down.
    proc.once('error', (err) => {
      failure ??= err.message;
    });

    // Give Xvnc a moment to bind or fail.
    await new Promise((r) => setTimeout(r, 500));

    if (failure !== null) {
      let logText = '';
      try {
        logText = readFileSync(logPath, 'utf8');
      } catch {
        // log unreadable — fall through with just the failure reason
      }
      this.allocated.delete(display);
      throw new Error(
        `Xvnc failed to start on :${display}: ${failure}${logText ? ` — ${logText}` : ''}`
      );
    }

    const instance = this.allocated.get(display);
    if (instance) instance.process = proc;

    return proc;
  }

  /** Kill Xvnc for the given display and release the allocation. */
  async stopVnc(display: number): Promise<void> {
    const instance = this.allocated.get(display);
    this.allocated.delete(display);
    if (!instance?.process) return;

    log.info(`Stopping Xvnc on :${display}`);
    const proc = instance.process;
    if (proc.exitCode !== null || proc.signalCode !== null) return;

    proc.kill('SIGTERM');
    const exited = await Promise.race([
      new Promise<boolean>((r) => proc.once('exit', () => r(true))),
      new Promise<boolean>((r) => setTimeout(() => r(false), 5000)),
    ]);
    if (!exited) proc.kill('SIGKILL');
  }

  /** Stop every managed Xvnc. Called on shutdown. */
  async cleanupAll(): Promise<void> {
    for (const display of [...this.allocated.keys()]) {
      await this.stopVnc(display);
    }
  }

  /** Kill orphan Xvnc processes left by a previous container run. */
  async cleanupStale(): Promise<void> {
    await new Promise<void>((resolve) => {
      const p = spawn('pkill', ['-f', 'Xvnc :[0-9]'], { stdio: 'ignore' });
      p.once('exit', (code) => {
        if (code === 0) log.info('Cleaned up stale Xvnc processes');
        resolve();
      });
      p.once('error', () => resolve()); // pkill missing — nothing to do
    });
  }

  getWsPort(display: number): number | null {
    return this.allocated.get(display)?.wsPort ?? null;
  }

  getInstance(display: number): VNCInstance | undefined {
    return this.allocated.get(display);
  }

  /** True when the Xvnc process for a display is still alive. */
  isAlive(display: number): boolean {
    const proc = this.allocated.get(display)?.process;
    return !!proc && proc.exitCode === null && proc.signalCode === null;
  }

  /** Tail of the Xvnc log, for diagnosing unexpected disconnects. */
  readLogTail(display: number, lines = 20): string[] {
    const logPath = `/tmp/xvnc-${display}.log`;
    if (!existsSync(logPath)) return [];
    try {
      return readFileSync(logPath, 'utf8').trim().split('\n').slice(-lines).filter(Boolean);
    } catch {
      return [];
    }
  }

  get activeDisplays(): number[] {
    return [...this.allocated.keys()];
  }
}
