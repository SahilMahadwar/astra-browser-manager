/**
 * RFB protocol translation between noVNC 1.4 and KasmVNC 1.3.3.
 *
 * Ported from backend/main.py. The two ends disagree on the wire format:
 * noVNC sends extension message types KasmVNC crashes on, and KasmVNC uses a
 * non-standard 11-byte PointerEvent and a proprietary clipboard message.
 *
 * The encoding whitelist and extension sizes here are empirical — they were
 * derived by watching KasmVNC drop connections. Do not "clean them up" without
 * a packet capture proving the change is safe.
 */

/** Client→server message sizes. `null` means the message encodes its own length. */
const RFB_MSG_SIZE: Record<number, number | null> = {
  0: 20, // SetPixelFormat
  2: null, // SetEncodings — 4 + numEncodings*4
  3: 10, // FramebufferUpdateRequest
  4: 8, // KeyEvent
  5: 6, // PointerEvent
  6: null, // ClientCutText — 8 + length
};

/**
 * Extension types noVNC sends that KasmVNC does not support. We need their
 * sizes so we can skip past them rather than giving up on the rest of the frame.
 */
const RFB_EXTENSION_SIZE: Record<number, number> = {
  150: 10, // EnableContinuousUpdates
  248: 10, // QEMU-like key event (observed from noVNC 1.4.0)
  252: 4, // xvp
  255: 4, // QEMU audio control
};

/**
 * Encodings safe to forward to KasmVNC. This is a whitelist rather than a
 * blocklist deliberately: blocklisting problematic pseudo-encodings was tried
 * and got the numbers wrong. Anything not listed is stripped from SetEncodings.
 */
const ALLOWED_ENCODINGS: ReadonlySet<number> = new Set<number>([
  // Framebuffer encodings (standard RFB)
  0, // Raw
  1, // CopyRect
  2, // RRE
  5, // Hextile
  7, // Tight
  16, // ZRLE
  // Safe pseudo-encodings
  -239, // Cursor (0xFFFFFF11)
  -224, // LastRect (0xFFFFFF20)
  // Tight quality levels 0-9 and compress levels 0-9 — just hints
  ...Array.from({ length: 10 }, (_, i) => -32 + i),
  ...Array.from({ length: 10 }, (_, i) => -256 + i),
]);

export const _ALLOWED_ENCODINGS = ALLOWED_ENCODINGS;

/**
 * Total length of the RFB message at `offset`, or null if the type is
 * unrecognized. Returns null (not a partial length) when the buffer is too
 * short to even read a self-encoded length — callers treat that as "need more".
 */
export function rfbMsgLength(data: Buffer, offset: number): number | null {
  if (offset >= data.length) return null;
  const msgType = data[offset];

  const fixed = RFB_MSG_SIZE[msgType];
  if (fixed !== undefined && fixed !== null) return fixed;

  const remaining = data.length - offset;
  if (msgType === 2 && remaining >= 4) {
    // SetEncodings
    const numEnc = data.readUInt16BE(offset + 2);
    return 4 + numEnc * 4;
  }
  if (msgType === 6 && remaining >= 8) {
    // ClientCutText
    const length = data.readUInt32BE(offset + 4);
    return 8 + length;
  }

  const extSize = RFB_EXTENSION_SIZE[msgType];
  if (extSize !== undefined) return extSize;

  return null; // truly unknown type
}

/** Keep only whitelisted encodings in a SetEncodings message. */
export function rewriteSetEncodings(
  data: Buffer,
  offset: number,
  msgLen: number
): Buffer {
  const numEnc = data.readUInt16BE(offset + 2);
  const kept: number[] = [];
  let strippedCount = 0;

  for (let i = 0; i < numEnc; i++) {
    const enc = data.readInt32BE(offset + 4 + i * 4);
    if (ALLOWED_ENCODINGS.has(enc)) kept.push(enc);
    else strippedCount++;
  }

  if (strippedCount === 0) return data.subarray(offset, offset + msgLen);

  const out = Buffer.alloc(4 + kept.length * 4);
  out.writeUInt8(2, 0);
  out.writeUInt8(0, 1); // padding
  out.writeUInt16BE(kept.length, 2);
  kept.forEach((enc, i) => out.writeInt32BE(enc, 4 + i * 4));
  return out;
}

/**
 * Convert a standard 6-byte PointerEvent to KasmVNC's 11-byte format.
 *
 *   Standard RFB:  [5:u8][mask:u8][x:u16][y:u16]                    = 6
 *   KasmVNC:       [5:u8][mask:u16][x:u16][y:u16][sx:s16][sy:s16]   = 11
 *
 * Scroll deltas are zero because noVNC encodes scroll as button-mask bits
 * (3=up, 4=down, 5=left, 6=right), which pass through in the mask. KasmVNC
 * accepts mask-bit scroll on its extended format, so explicit deltas are
 * unnecessary.
 */
export function rewritePointerEvent(data: Buffer, offset: number): Buffer {
  const mask = data[offset + 1];
  const x = data.readUInt16BE(offset + 2);
  const y = data.readUInt16BE(offset + 4);

  const out = Buffer.alloc(11);
  out.writeUInt8(5, 0);
  out.writeUInt16BE(mask, 1); // expand u8 → u16
  out.writeUInt16BE(x, 3);
  out.writeUInt16BE(y, 5);
  out.writeInt16BE(0, 7); // scroll x
  out.writeInt16BE(0, 9); // scroll y
  return out;
}

/**
 * Extract text/plain from a KasmVNC BinaryClipboard message (type 180).
 *
 * Format: type(1) + action(1) + flags(4) + entries...
 * Each entry: mime_len(u8) + mime(N) + data_len(u32 BE) + data(M)
 */
export function parseKasmvncClipboard(data: Buffer): string | null {
  if (data.length < 7) return null;

  let offset = 6; // skip type(1) + action(1) + flags(4)
  while (offset < data.length) {
    if (offset + 1 > data.length) break;
    const mimeLen = data[offset];
    offset += 1;

    if (offset + mimeLen > data.length) break;
    const mimeType = data.subarray(offset, offset + mimeLen).toString('latin1');
    offset += mimeLen;

    if (offset + 4 > data.length) break;
    const dataLen = data.readUInt32BE(offset);
    offset += 4;

    if (mimeType === 'text/plain') {
      const end = Math.min(offset + dataLen, data.length);
      return data.subarray(offset, end).toString('utf8');
    }
    offset += dataLen;
  }
  return null;
}

/**
 * Build a standard RFB ServerCutText (type 3) message.
 *
 * The RFB spec mandates Latin-1 for ServerCutText. Characters outside Latin-1
 * (CJK, emoji, …) become '?', matching Python's `encode("latin-1", "replace")`.
 * Iterating code points (not UTF-16 units) keeps astral characters at one '?'.
 */
export function buildServerCutText(text: string): Buffer {
  const bytes = Buffer.from(
    [...text].map((ch) => {
      const cp = ch.codePointAt(0)!;
      return cp <= 0xff ? cp : 0x3f; // '?'
    })
  );

  const header = Buffer.alloc(8);
  header.writeUInt8(3, 0);
  // bytes 1-3 are padding
  header.writeUInt32BE(bytes.length, 4);
  return Buffer.concat([header, bytes]);
}

export interface RfbFilterStats {
  /** Frames that produced no forwardable output. */
  dropped: number;
  /** Times an unknown message type forced an accumulator reset. */
  desyncs: number;
  /** Bytes currently held waiting for the rest of a split message. */
  buffered: number;
}

/**
 * Cap on the accumulator. ClientCutText is bounded by the 1 MB clipboard limit;
 * anything beyond this means a corrupt length field, so we reset rather than
 * grow without bound.
 */
const MAX_BUFFER = 4 * 1024 * 1024;

/**
 * Stateful, per-connection RFB client-message filter.
 *
 * Why stateful: nothing guarantees an RFB message lands wholly inside one
 * WebSocket frame. noVNC batches messages and a batch can split at any byte.
 * The original Python filter discarded the partial tail, which silently lost a
 * message and desynchronized KasmVNC — it then closed the connection, which
 * surfaced to the user as the VNC view dropping. Large pastes (ClientCutText)
 * and long SetEncodings hit this most.
 *
 * One instance per connection; never share between connections.
 */
export class RfbClientFilter {
  private acc: Buffer = Buffer.alloc(0);
  private stats: RfbFilterStats = { dropped: 0, desyncs: 0, buffered: 0 };

  constructor(
    private readonly onWarn: (msg: string) => void = () => {}
  ) {}

  /**
   * Feed one WebSocket frame; returns the bytes safe to forward to KasmVNC
   * (possibly empty while waiting for the rest of a split message).
   */
  push(chunk: Buffer): Buffer {
    this.acc = this.acc.length === 0 ? chunk : Buffer.concat([this.acc, chunk]);

    if (this.acc.length > MAX_BUFFER) {
      this.onWarn(
        `RFB filter: accumulator exceeded ${MAX_BUFFER} bytes (${this.acc.length}) — ` +
          `corrupt length field, resetting stream`
      );
      this.acc = Buffer.alloc(0);
      this.stats.desyncs++;
      this.stats.buffered = 0;
      return Buffer.alloc(0);
    }

    const out: Buffer[] = [];
    let offset = 0;

    while (offset < this.acc.length) {
      const msgType = this.acc[offset];
      const msgLen = rfbMsgLength(this.acc, offset);

      if (msgLen === null) {
        if (this.isPotentiallyKnown(msgType)) {
          // A self-encoding-length type whose header hasn't arrived yet.
          break;
        }
        // Truly unknown type — we cannot find the next boundary, so there is
        // no way to resync. Drop everything buffered; keeping it would wedge
        // the connection permanently.
        this.onWarn(
          `RFB filter: unknown message type=${msgType} at offset ${offset}/${this.acc.length} — ` +
            `cannot resync, dropping ${this.acc.length - offset} trailing bytes`
        );
        this.stats.desyncs++;
        offset = this.acc.length;
        break;
      }

      if (offset + msgLen > this.acc.length) {
        // Incomplete message. Keep it buffered for the next frame — this is the
        // fix for the disconnect bug; the old code dropped it here.
        break;
      }

      if (msgType in RFB_MSG_SIZE) {
        if (msgType === 2) {
          out.push(rewriteSetEncodings(this.acc, offset, msgLen));
        } else if (msgType === 5) {
          out.push(rewritePointerEvent(this.acc, offset));
        } else {
          out.push(Buffer.from(this.acc.subarray(offset, offset + msgLen)));
        }
      }
      // else: known extension type — skip it, but keep parsing the frame.

      offset += msgLen;
    }

    this.acc = offset >= this.acc.length
      ? Buffer.alloc(0)
      : Buffer.from(this.acc.subarray(offset));
    this.stats.buffered = this.acc.length;

    const result = out.length === 0 ? Buffer.alloc(0) : Buffer.concat(out);
    if (result.length === 0) this.stats.dropped++;
    return result;
  }

  /**
   * True when the type is one whose length is self-encoded and the header may
   * simply not have arrived yet — so we should wait rather than declare desync.
   */
  private isPotentiallyKnown(msgType: number): boolean {
    return RFB_MSG_SIZE[msgType] === null;
  }

  getStats(): Readonly<RfbFilterStats> {
    return { ...this.stats };
  }

  /** Bytes held pending the rest of a split message. */
  get pending(): number {
    return this.acc.length;
  }
}

/**
 * Stateless single-frame filter, preserved for parity with the Python
 * implementation and its test suite. Prefer {@link RfbClientFilter} in the
 * proxy — this variant cannot reassemble messages split across frames.
 */
export function filterRfbClientMessages(data: Buffer): Buffer {
  const out: Buffer[] = [];
  let offset = 0;

  while (offset < data.length) {
    const msgType = data[offset];
    const msgLen = rfbMsgLength(data, offset);
    if (msgLen === null) break;
    if (offset + msgLen > data.length) break;

    if (msgType in RFB_MSG_SIZE) {
      if (msgType === 2) out.push(rewriteSetEncodings(data, offset, msgLen));
      else if (msgType === 5) out.push(rewritePointerEvent(data, offset));
      else out.push(Buffer.from(data.subarray(offset, offset + msgLen)));
    }
    offset += msgLen;
  }

  return out.length === 0 ? Buffer.alloc(0) : Buffer.concat(out);
}
