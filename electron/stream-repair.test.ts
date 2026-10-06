// The PNG-wrapped segments anikoto's CDN started serving on 1 Oct 2026, built
// to the measured layout: a 70-byte PNG, a 182-byte short packet, then 188-byte
// TS packets (verified on three live segments: zero leftover bytes).
import { describe, expect, it } from 'vitest';
import { detectStreamKind, extractPackets } from './stream-repair';

/** The wrapper exactly as served: the first 70 bytes of a live segment. */
const PNG = Buffer.from(
  '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da6364f8cf500f00038601805a347d6b0000000049454e44ae426082',
  'hex',
);

/** A TS packet whose payload is filled with `fill` and carries its index. */
function packet(index: number, fill = 0xaa): Buffer {
  const p = Buffer.alloc(188, fill);
  p[0] = 0x47;
  p.writeUInt16BE(index, 4);
  return p;
}

function segment(firstIndex: number, count: number): Buffer {
  const short = Buffer.alloc(182, 0xff);
  short[0] = 0x47;
  short[1] = 0x40;
  short[2] = 0x11;
  return Buffer.concat([PNG, short, ...Array.from({ length: count }, (_, i) => packet(firstIndex + i))]);
}

function unwrapAll(data: Buffer, chunkSize: number): Buffer {
  const out: Buffer[] = [];
  let carry = Buffer.alloc(0);
  for (let i = 0; i < data.length; i += chunkSize) {
    const buf = Buffer.concat([carry, data.subarray(i, i + chunkSize)]);
    const { packets, consumed } = extractPackets(buf, false);
    out.push(...packets);
    carry = Buffer.from(buf.subarray(consumed));
  }
  out.push(...extractPackets(carry, true).packets);
  return Buffer.concat(out);
}

/**
 * Byte-for-byte equality, compared as hex. `toEqual` on a Buffer walks it one
 * element at a time through generic deep equality: ~60ms per 15KB comparison,
 * which made these the slowest tests in the suite while the parsing they check
 * took ~2ms. A failure still diffs, at the first differing byte.
 */
const hex = (bytes: Buffer) => bytes.toString('hex');

describe('extractPackets', () => {
  it('keeps every video packet and drops the PNG wrappers and short packets', () => {
    expect(PNG.length).toBe(70);
    const data = Buffer.concat([segment(0, 50), segment(50, 30), segment(80, 7)]);
    const clean = unwrapAll(data, data.length);
    expect(hex(clean)).toBe(hex(Buffer.concat(Array.from({ length: 87 }, (_, i) => packet(i)))));
  });

  it('gives the same result however the file is chunked, including mid-wrapper and mid-signature', () => {
    const data = Buffer.concat([segment(0, 40), segment(40, 40)]);
    const expected = hex(unwrapAll(data, data.length));
    for (const size of [7, 64, 188, 189, 250, 4096]) {
      expect(hex(unwrapAll(data, size)), `chunked every ${size} bytes`).toBe(expected);
    }
  });

  it('passes an ordinary transport stream through unchanged', () => {
    const ts = Buffer.concat(Array.from({ length: 25 }, (_, i) => packet(i, 0x47)));
    expect(hex(unwrapAll(ts, 100))).toBe(hex(ts));
  });
});

describe('detectStreamKind', () => {
  it('tells a wrapped stream, a transport stream and an MP4 apart', () => {
    expect(detectStreamKind(segment(0, 1).subarray(0, 16))).toBe('png-wrapped');
    expect(detectStreamKind(packet(0).subarray(0, 16))).toBe('mpegts');
    expect(detectStreamKind(Buffer.from('000000206674797069736f6d00000200', 'hex'))).toBe('mp4');
  });
});
