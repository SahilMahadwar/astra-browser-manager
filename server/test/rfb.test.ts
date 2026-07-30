/**
 * Ported from backend/tests/test_rfb.py, plus new cases for the stateful
 * filter's frame-reassembly behaviour (the VNC disconnect fix).
 */

import { describe, expect, it } from 'vitest';
import {
  RfbClientFilter,
  buildServerCutText,
  filterRfbClientMessages,
  parseKasmvncClipboard,
  rewritePointerEvent,
  rewriteSetEncodings,
  rfbMsgLength,
} from '../src/rfb.js';

// ── Helpers (mirror the Python test helpers) ────────────────────────────────

function makeKeyEvent(down = 1, key = 0x61): Buffer {
  const b = Buffer.alloc(8);
  b.writeUInt8(4, 0);
  b.writeUInt8(down, 1);
  b.writeUInt32BE(key, 4);
  return b;
}

function makePointerEvent(mask = 0, x = 100, y = 200): Buffer {
  const b = Buffer.alloc(6);
  b.writeUInt8(5, 0);
  b.writeUInt8(mask, 1);
  b.writeUInt16BE(x, 2);
  b.writeUInt16BE(y, 4);
  return b;
}

function makeFbUpdateRequest(x = 0, y = 0, w = 1920, h = 1080, incr = 1): Buffer {
  const b = Buffer.alloc(10);
  b.writeUInt8(3, 0);
  b.writeUInt8(incr, 1);
  b.writeUInt16BE(x, 2);
  b.writeUInt16BE(y, 4);
  b.writeUInt16BE(w, 6);
  b.writeUInt16BE(h, 8);
  return b;
}

function makeSetEncodings(encodings: number[]): Buffer {
  const b = Buffer.alloc(4 + encodings.length * 4);
  b.writeUInt8(2, 0);
  b.writeUInt16BE(encodings.length, 2);
  encodings.forEach((e, i) => b.writeInt32BE(e, 4 + i * 4));
  return b;
}

function makeClientCutText(text: string): Buffer {
  const textBytes = Buffer.from(text, 'latin1');
  const head = Buffer.alloc(8);
  head.writeUInt8(6, 0);
  head.writeUInt32BE(textBytes.length, 4);
  return Buffer.concat([head, textBytes]);
}

function makeExtension150(): Buffer {
  const b = Buffer.alloc(10);
  b.writeUInt8(150, 0);
  b.writeUInt8(1, 1);
  b.writeUInt16BE(0, 2);
  b.writeUInt16BE(0, 4);
  b.writeUInt16BE(1920, 6);
  b.writeUInt16BE(1080, 8);
  return b;
}

function makeKasmvncClipboard(mime: string, data: string): Buffer {
  const mimeBytes = Buffer.from(mime, 'latin1');
  const dataBytes = Buffer.from(data, 'utf8');
  const lenBuf = Buffer.alloc(4);
  lenBuf.writeUInt32BE(dataBytes.length, 0);
  return Buffer.concat([
    Buffer.from([180, 0, 0, 0, 0, 0]), // type + action + flags(4)
    Buffer.from([mimeBytes.length]),
    mimeBytes,
    lenBuf,
    dataBytes,
  ]);
}

// ── parseKasmvncClipboard ───────────────────────────────────────────────────

describe('parseKasmvncClipboard', () => {
  it('extracts text/plain', () => {
    expect(parseKasmvncClipboard(makeKasmvncClipboard('text/plain', 'hello'))).toBe('hello');
  });

  it('returns null when there is no text/plain entry', () => {
    expect(parseKasmvncClipboard(makeKasmvncClipboard('image/png', 'binary'))).toBeNull();
  });

  it('returns null when too short', () => {
    expect(parseKasmvncClipboard(Buffer.from([0xb4, 0x00, 0x00]))).toBeNull();
  });

  it('handles empty text', () => {
    expect(parseKasmvncClipboard(makeKasmvncClipboard('text/plain', ''))).toBe('');
  });

  it('finds text/plain after a non-matching mime', () => {
    const mime1 = Buffer.from('image/png', 'latin1');
    const mime2 = Buffer.from('text/plain', 'latin1');
    const len1 = Buffer.alloc(4);
    len1.writeUInt32BE(3, 0);
    const len2 = Buffer.alloc(4);
    len2.writeUInt32BE(5, 0);
    const buf = Buffer.concat([
      Buffer.from([180, 0, 0, 0, 0, 0]),
      Buffer.from([mime1.length]), mime1, len1, Buffer.from('PNG'),
      Buffer.from([mime2.length]), mime2, len2, Buffer.from('world'),
    ]);
    expect(parseKasmvncClipboard(buf)).toBe('world');
  });
});

// ── buildServerCutText ──────────────────────────────────────────────────────

describe('buildServerCutText', () => {
  it('builds a basic message', () => {
    const r = buildServerCutText('hi');
    expect(r[0]).toBe(3);
    expect(r.readUInt32BE(4)).toBe(2);
    expect(r.subarray(8).toString()).toBe('hi');
  });

  it('handles empty text', () => {
    const r = buildServerCutText('');
    expect(r[0]).toBe(3);
    expect(r.readUInt32BE(4)).toBe(0);
    expect(r.length).toBe(8);
  });

  it('replaces non-Latin-1 characters with ?', () => {
    const r = buildServerCutText('hello 日本');
    const textBytes = r.subarray(8);
    expect(textBytes.includes(0x3f)).toBe(true);
    expect(textBytes.subarray(0, 6).toString()).toBe('hello ');
  });

  it('emits one ? per astral code point, matching Python', () => {
    const r = buildServerCutText('\u{1F600}'); // emoji, one code point
    expect(r.readUInt32BE(4)).toBe(1);
    expect(r.subarray(8).toString()).toBe('?');
  });
});

// ── rfbMsgLength ────────────────────────────────────────────────────────────

describe('rfbMsgLength', () => {
  it('SetPixelFormat is 20', () => {
    expect(rfbMsgLength(Buffer.alloc(20), 0)).toBe(20);
  });
  it('FramebufferUpdateRequest is 10', () => {
    expect(rfbMsgLength(makeFbUpdateRequest(), 0)).toBe(10);
  });
  it('KeyEvent is 8', () => {
    expect(rfbMsgLength(makeKeyEvent(), 0)).toBe(8);
  });
  it('PointerEvent is 6', () => {
    expect(rfbMsgLength(makePointerEvent(), 0)).toBe(6);
  });
  it('SetEncodings is 4 + n*4', () => {
    expect(rfbMsgLength(makeSetEncodings([0, 1, 2]), 0)).toBe(16);
  });
  it('ClientCutText is 8 + length', () => {
    expect(rfbMsgLength(makeClientCutText('hello world'), 0)).toBe(19);
  });
  it('extension 150 is 10', () => {
    expect(rfbMsgLength(makeExtension150(), 0)).toBe(10);
  });
  it('unknown type returns null', () => {
    expect(rfbMsgLength(Buffer.from([99]), 0)).toBeNull();
  });
  it('works at a non-zero offset', () => {
    const data = Buffer.concat([Buffer.alloc(10), makeKeyEvent()]);
    expect(rfbMsgLength(data, 10)).toBe(8);
  });
});

// ── rewriteSetEncodings ─────────────────────────────────────────────────────

describe('rewriteSetEncodings', () => {
  it('passes through when all encodings are allowed', () => {
    const data = makeSetEncodings([0, 1, 2, 5, 7]);
    expect(rewriteSetEncodings(data, 0, data.length).equals(data)).toBe(true);
  });

  it('strips disallowed encodings', () => {
    const data = makeSetEncodings([0, 1, -260, -307]);
    const r = rewriteSetEncodings(data, 0, data.length);
    expect(r.readUInt16BE(2)).toBe(2);
    expect(r.readInt32BE(4)).toBe(0);
    expect(r.readInt32BE(8)).toBe(1);
  });

  it('works at a non-zero offset', () => {
    const data = makeSetEncodings([0, -260]);
    const full = Buffer.concat([Buffer.alloc(8, 0xff), data]);
    const r = rewriteSetEncodings(full, 8, data.length);
    expect(r.readUInt16BE(2)).toBe(1);
  });
});

// ── rewritePointerEvent ─────────────────────────────────────────────────────

describe('rewritePointerEvent', () => {
  it('expands 6-byte standard to 11-byte KasmVNC format', () => {
    const r = rewritePointerEvent(makePointerEvent(1, 100, 200), 0);
    expect(r.length).toBe(11);
    expect(r[0]).toBe(5);
    expect(r.readUInt16BE(1)).toBe(1);
    expect(r.readUInt16BE(3)).toBe(100);
    expect(r.readUInt16BE(5)).toBe(200);
    expect(r.readInt16BE(7)).toBe(0);
    expect(r.readInt16BE(9)).toBe(0);
  });

  it('expands a u8 mask of 0xFF to u16 0x00FF', () => {
    const r = rewritePointerEvent(makePointerEvent(0xff, 0, 0), 0);
    expect(r.readUInt16BE(1)).toBe(0x00ff);
  });

  it('works at a non-zero offset', () => {
    const full = Buffer.concat([Buffer.alloc(4), makePointerEvent(2, 50, 75)]);
    const r = rewritePointerEvent(full, 4);
    expect(r.length).toBe(11);
    expect(r.readUInt16BE(1)).toBe(2);
  });
});

// ── filterRfbClientMessages (stateless parity with Python) ──────────────────

describe('filterRfbClientMessages', () => {
  it('keeps standard types', () => {
    const key = makeKeyEvent();
    const fb = makeFbUpdateRequest();
    const r = filterRfbClientMessages(Buffer.concat([key, fb]));
    expect(r.length).toBe(18);
    expect(r.subarray(0, 8).equals(key)).toBe(true);
    expect(r.subarray(8).equals(fb)).toBe(true);
  });

  it('strips extension 150 but keeps surrounding messages', () => {
    const k1 = makeKeyEvent(1, 0x61);
    const k2 = makeKeyEvent(0, 0x61);
    const r = filterRfbClientMessages(Buffer.concat([k1, makeExtension150(), k2]));
    expect(r.length).toBe(16);
    expect(r.subarray(0, 8).equals(k1)).toBe(true);
    expect(r.subarray(8).equals(k2)).toBe(true);
  });

  it('drops from an unknown type onward', () => {
    const key = makeKeyEvent();
    const r = filterRfbClientMessages(
      Buffer.concat([key, Buffer.from([99, 0, 0, 0, 0])])
    );
    expect(r.equals(key)).toBe(true);
  });

  it('drops an incomplete message', () => {
    expect(filterRfbClientMessages(makeKeyEvent().subarray(0, 4)).length).toBe(0);
  });

  it('rewrites PointerEvent 6→11', () => {
    const r = filterRfbClientMessages(makePointerEvent(1, 100, 200));
    expect(r.length).toBe(11);
    expect(r[0]).toBe(5);
  });

  it('strips disallowed encodings from SetEncodings', () => {
    const r = filterRfbClientMessages(makeSetEncodings([0, 1, -260]));
    expect(r.readUInt16BE(2)).toBe(2);
  });

  it('handles a realistic mixed frame', () => {
    const data = Buffer.concat([
      makeKeyEvent(), // 8, kept
      makeExtension150(), // 10, stripped
      makePointerEvent(), // 6 → 11, rewritten
      makeClientCutText('hi'), // 10, kept
    ]);
    const r = filterRfbClientMessages(data);
    expect(r.length).toBe(29);
    expect(r[0]).toBe(4);
    expect(r[8]).toBe(5);
    expect(r[19]).toBe(6);
  });

  it('handles empty input', () => {
    expect(filterRfbClientMessages(Buffer.alloc(0)).length).toBe(0);
  });
});

// ── RfbClientFilter — the disconnect-bug fix ────────────────────────────────

describe('RfbClientFilter (stateful)', () => {
  it('matches the stateless filter for whole frames', () => {
    const data = Buffer.concat([
      makeKeyEvent(),
      makeExtension150(),
      makePointerEvent(),
      makeClientCutText('hi'),
    ]);
    const f = new RfbClientFilter();
    expect(f.push(data).equals(filterRfbClientMessages(data))).toBe(true);
  });

  it('reassembles a KeyEvent split across two frames', () => {
    const key = makeKeyEvent(1, 0x41);
    const f = new RfbClientFilter();

    const first = f.push(key.subarray(0, 3));
    expect(first.length).toBe(0); // held, not dropped
    expect(f.pending).toBe(3);

    const second = f.push(key.subarray(3));
    expect(second.equals(key)).toBe(true);
    expect(f.pending).toBe(0);
  });

  it('reassembles a large ClientCutText split mid-payload (the paste case)', () => {
    // This is the exact scenario that desynced KasmVNC and dropped the session.
    const text = 'x'.repeat(50_000);
    const cut = makeClientCutText(text);
    const f = new RfbClientFilter();

    const out: Buffer[] = [];
    const CHUNK = 4096;
    for (let i = 0; i < cut.length; i += CHUNK) {
      out.push(f.push(cut.subarray(i, i + CHUNK)));
    }

    const joined = Buffer.concat(out);
    expect(joined.equals(cut)).toBe(true);
    expect(f.pending).toBe(0);
  });

  it('reassembles a SetEncodings split across frames and still strips', () => {
    const enc = makeSetEncodings([0, 1, -260, 7]);
    const f = new RfbClientFilter();

    expect(f.push(enc.subarray(0, 6)).length).toBe(0);
    const r = f.push(enc.subarray(6));

    expect(r.readUInt16BE(2)).toBe(3); // -260 stripped, 0/1/7 kept
  });

  it('carries a partial tail into the next frame alongside complete messages', () => {
    const key = makeKeyEvent();
    const ptr = makePointerEvent(1, 10, 20);
    // frame 1: full KeyEvent + first 2 bytes of PointerEvent
    const f = new RfbClientFilter();

    const r1 = f.push(Buffer.concat([key, ptr.subarray(0, 2)]));
    expect(r1.equals(key)).toBe(true);
    expect(f.pending).toBe(2);

    const r2 = f.push(ptr.subarray(2));
    expect(r2.length).toBe(11); // rewritten PointerEvent
    expect(r2[0]).toBe(5);
  });

  it('resets and warns on a truly unknown type (cannot resync)', () => {
    const warnings: string[] = [];
    const f = new RfbClientFilter((m) => warnings.push(m));

    const key = makeKeyEvent();
    const r = f.push(Buffer.concat([key, Buffer.from([99, 1, 2, 3])]));

    expect(r.equals(key)).toBe(true);
    expect(f.pending).toBe(0); // junk discarded, not wedged
    expect(warnings.some((w) => w.includes('unknown message type=99'))).toBe(true);
    expect(f.getStats().desyncs).toBe(1);
  });

  it('waits rather than desyncing when a length header is itself split', () => {
    const warnings: string[] = [];
    const f = new RfbClientFilter((m) => warnings.push(m));

    // ClientCutText type byte alone — length field has not arrived yet.
    expect(f.push(Buffer.from([6])).length).toBe(0);
    expect(warnings).toHaveLength(0); // must NOT be treated as unknown
    expect(f.pending).toBe(1);

    const rest = makeClientCutText('ok').subarray(1);
    expect(f.push(rest).equals(makeClientCutText('ok'))).toBe(true);
  });

  it('resets instead of growing without bound on a corrupt length', () => {
    const warnings: string[] = [];
    const f = new RfbClientFilter((m) => warnings.push(m));

    // ClientCutText claiming ~4 GB of payload.
    const bogus = Buffer.alloc(8);
    bogus.writeUInt8(6, 0);
    bogus.writeUInt32BE(0xffffffff, 4);
    f.push(bogus);

    // Feed 5 MB; the accumulator must reset rather than buffer it all.
    f.push(Buffer.alloc(5 * 1024 * 1024));

    expect(f.pending).toBe(0);
    expect(warnings.some((w) => w.includes('accumulator exceeded'))).toBe(true);
  });

  it('keeps instances independent', () => {
    const a = new RfbClientFilter();
    const b = new RfbClientFilter();
    a.push(makeKeyEvent().subarray(0, 3));
    expect(a.pending).toBe(3);
    expect(b.pending).toBe(0);
  });
});
