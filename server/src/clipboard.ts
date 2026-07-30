/**
 * Clipboard relay between the host browser and the VNC session.
 * Ported from the clipboard endpoints in backend/main.py.
 *
 * Reading is deliberately two-pronged: Chrome under KasmVNC does not write to
 * the X11 clipboard, so xclip cannot see a Chrome copy. The primary read goes
 * through the page (window.__clipboardText, set by the injected init script);
 * xclip is only the fallback for non-Chrome clipboard owners.
 */

import { spawn, type ChildProcess } from 'node:child_process';

import { logger } from './logger.js';
import type { RunningProfile } from './browser.js';

const log = logger('clipboard');

export const CLIPBOARD_MAX_READ = 1_048_576; // 1MB cap on reads

/**
 * xclip stays resident after reading stdin so it can serve paste requests, so
 * the previous one must be killed before a new one takes ownership.
 */
const xclipProcs = new Map<number, ChildProcess>();

export async function setClipboard(display: number, text: string): Promise<void> {
  const old = xclipProcs.get(display);
  xclipProcs.delete(display);
  if (old && old.exitCode === null) {
    old.kill('SIGKILL');
  }

  const proc = spawn('xclip', ['-selection', 'clipboard'], {
    env: { ...process.env, DISPLAY: `:${display}` },
    stdio: ['pipe', 'ignore', 'ignore'],
  });

  await new Promise<void>((resolve, reject) => {
    proc.once('error', reject);
    proc.stdin!.on('error', reject);
    proc.stdin!.end(text, () => resolve());
  });

  xclipProcs.set(display, proc);
}

/** Read the VNC session's clipboard, page first then xclip. */
export async function getClipboard(running: RunningProfile): Promise<string> {
  // Primary: whatever the injected listener captured, on any open tab.
  try {
    for (const page of running.context.pages()) {
      try {
        const text = (await page.evaluate('window.__clipboardText || ""')) as string;
        if (text) return text.slice(0, CLIPBOARD_MAX_READ);
      } catch (err) {
        log.debug(`Clipboard read failed on page: ${String(err)}`);
      }
    }
  } catch (err) {
    log.debug(`Page clipboard read failed: ${String(err)}`);
  }

  // Fallback: an X11 clipboard owner that is not Chrome.
  return readXclip(running.display);
}

function readXclip(display: number): Promise<string> {
  return new Promise((resolve) => {
    const proc = spawn('xclip', ['-selection', 'clipboard', '-o'], {
      env: { ...process.env, DISPLAY: `:${display}` },
      stdio: ['ignore', 'pipe', 'ignore'],
    });

    const chunks: Buffer[] = [];
    let settled = false;
    const done = (value: string) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };

    const timer = setTimeout(() => {
      proc.kill('SIGKILL');
      done('');
    }, 5000);
    timer.unref?.();

    proc.stdout!.on('data', (c: Buffer) => chunks.push(c));
    proc.once('error', () => {
      clearTimeout(timer);
      done('');
    });
    proc.once('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) return done('');
      done(Buffer.concat(chunks).subarray(0, CLIPBOARD_MAX_READ).toString('utf8'));
    });
  });
}

/** Kill any resident xclip processes. Called on shutdown. */
export function cleanupClipboard(): void {
  for (const [display, proc] of xclipProcs) {
    if (proc.exitCode === null) proc.kill('SIGKILL');
    xclipProcs.delete(display);
  }
}
