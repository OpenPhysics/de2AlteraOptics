import { describe, expect, it } from 'vitest';
import {
  PACKET_DATA_BYTES,
  Packetizer,
  decodePacket,
  encodePacket,
} from '../src/de2/protocol.ts';

// First packet of the real 2026-11-20 capture (A=1498, B=2562, rest 0).
const REAL = Uint8Array.from([
  0x5a,
  0x0b,
  0x00,
  0x00,
  0x00,
  0x02,
  0x14,
  0x00,
  0x00,
  0x00,
  ...new Array<number>(30).fill(0),
]);

describe('decodePacket', () => {
  it('decodes 7-bit little-endian counters from real hardware bytes', () => {
    expect(decodePacket(REAL)).toEqual([1498, 2562, 0, 0, 0, 0, 0, 0]);
  });

  it('round-trips with encodePacket, including values above 2^32', () => {
    const counts = [0, 1, 127, 128, 16_383, 2 ** 31, 2 ** 34 + 5, 12_345];
    const pkt = encodePacket(counts);
    expect(pkt.length).toBe(PACKET_DATA_BYTES + 1);
    expect(pkt.at(-1)).toBe(0xff);
    expect(pkt.slice(0, -1).every((b) => b < 0x80)).toBe(true);
    expect(decodePacket(pkt.slice(0, -1))).toEqual(counts);
  });

  it('rejects wrong-length input', () => {
    expect(() => decodePacket(new Uint8Array(39))).toThrow(RangeError);
  });
});

describe('Packetizer', () => {
  const pkt = (n: number) => encodePacket([n, 2 * n, 0, 0, n % 3, 0, 0, 0]);

  it('discards bytes before the first terminator, then syncs', () => {
    const p = new Packetizer();
    const stream = new Uint8Array([0x12, 0x34, 0xff, ...pkt(5), ...pkt(6)]);
    const out = p.push(stream).map(decodePacket);
    expect(out.map((c) => c[0])).toEqual([5, 6]);
    expect(p.dropped).toBe(0);
  });

  it('reassembles packets split across arbitrary chunks', () => {
    const p = new Packetizer();
    const stream = new Uint8Array([0xff, ...pkt(1), ...pkt(2), ...pkt(3)]);
    const got: number[] = [];
    for (let i = 0; i < stream.length; i += 7) {
      for (const k of p.push(stream.subarray(i, i + 7))) {
        got.push(decodePacket(k)[0] ?? -1);
      }
    }
    expect(got).toEqual([1, 2, 3]);
  });

  it('drops short packets and packets with high-bit bytes, then recovers', () => {
    const p = new Packetizer();
    const bad = pkt(9).slice();
    bad[3] = 0x90;
    const stream = new Uint8Array([0xff, 1, 2, 3, 0xff, ...bad, ...pkt(7)]);
    const out = p.push(stream).map(decodePacket);
    expect(out.map((c) => c[0])).toEqual([7]);
    expect(p.dropped).toBe(2);
  });
});
