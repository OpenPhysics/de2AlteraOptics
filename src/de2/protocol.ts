/**
 * DE2 coincidence-counter serial protocol (verified on hardware 2026-11-20).
 *
 * 19200 baud, 8N1. Every ~100 ms the FPGA sends one 41-byte packet:
 *   8 counters x 5 bytes, then a 0xFF terminator.
 * Each counter is little-endian in 7-bit groups (bit 7 of every data byte is
 * 0), so 0xFF can never appear inside the data and always marks a boundary.
 */

export const COUNTERS_PER_PACKET = 8;
export const BYTES_PER_COUNTER = 5;
export const PACKET_DATA_BYTES = COUNTERS_PER_PACKET * BYTES_PER_COUNTER;
export const TERMINATOR = 0xff;
export const DEFAULT_BAUD = 19200;
/** Nominal gate period of one packet, in seconds. */
export const DEFAULT_PACKET_PERIOD_S = 0.1;

/** Decode the 40 data bytes of one packet into 8 counter values. */
export function decodePacket(data: Uint8Array): number[] {
  if (data.length !== PACKET_DATA_BYTES) {
    throw new RangeError(
      `Expected ${PACKET_DATA_BYTES} bytes, got ${data.length}`
    );
  }
  const counts: number[] = [];
  for (let i = 0; i < COUNTERS_PER_PACKET; i++) {
    let value = 0;
    for (let k = BYTES_PER_COUNTER - 1; k >= 0; k--) {
      // 35-bit values exceed 32-bit shifts; use multiplication.
      value = value * 128 + ((data[i * BYTES_PER_COUNTER + k] ?? 0) & 0x7f);
    }
    counts.push(value);
  }
  return counts;
}

/** Encode counter values into a full 41-byte packet (used by the simulator). */
export function encodePacket(counts: readonly number[]): Uint8Array {
  const out = new Uint8Array(PACKET_DATA_BYTES + 1);
  for (let i = 0; i < COUNTERS_PER_PACKET; i++) {
    let value = Math.max(0, Math.floor(counts[i] ?? 0));
    for (let k = 0; k < BYTES_PER_COUNTER; k++) {
      out[i * BYTES_PER_COUNTER + k] = value % 128;
      value = Math.floor(value / 128);
    }
  }
  out[PACKET_DATA_BYTES] = TERMINATOR;
  return out;
}

/**
 * Splits an arbitrary byte stream into packets. Data before the first
 * terminator is discarded (we may have joined mid-packet); malformed packets
 * (wrong length or a byte with bit 7 set) are counted in `dropped`.
 */
export class Packetizer {
  private readonly buf = new Uint8Array(PACKET_DATA_BYTES);
  private len = 0;
  private synced = false;
  private bad = false;
  dropped = 0;
  accepted = 0;

  push(chunk: Uint8Array): Uint8Array[] {
    const packets: Uint8Array[] = [];
    for (const byte of chunk) {
      if (byte === TERMINATOR) {
        if (this.synced) {
          if (!this.bad && this.len === PACKET_DATA_BYTES) {
            packets.push(this.buf.slice());
            this.accepted++;
          } else {
            this.dropped++;
          }
        }
        this.synced = true;
        this.len = 0;
        this.bad = false;
      } else if (this.synced) {
        if (byte & 0x80 || this.len >= PACKET_DATA_BYTES) {
          this.bad = true;
        } else {
          this.buf[this.len++] = byte;
        }
      }
    }
    return packets;
  }

  reset(): void {
    this.len = 0;
    this.synced = false;
    this.bad = false;
  }
}

export function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join(' ');
}
