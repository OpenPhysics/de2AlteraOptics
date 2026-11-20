# DE2 coincidence-counter serial protocol

Verified on hardware 2026-11-20 (PL2303TA USB-RS232 adapter on the DE2 DB9 port).

- **19200 baud, 8 data bits, no parity, 1 stop bit**, no flow control.
- One packet every **~100 ms** (99 packets in 10 s).
- Packet = **41 bytes**: 8 counters × 5 bytes, then terminator `0xFF`.
- Each counter is little-endian in **7-bit groups**: `value = Σ b[k] · 128^k`, k = 0..4.
  Bit 7 of every data byte is 0, so `0xFF` only ever marks a packet boundary.
- Counts are per gate (not cumulative).

Example (first packet of the capture):

```
5a 0b 00 00 00 | 02 14 00 00 00 | 00 … 00 | ff
 → counter0 = 0x5a + 0x0b·128 = 1498     counter1 = 2 + 20·128 = 2562
```

## Counter → channel map

| Counter | Channel | Status |
|---|---|---|
| 0 | A | confirmed (~15 k/s with A connected) |
| 1 | B | confirmed (~25.6 k/s with B connected) |
| 2 | C | assumed (input unused, reads 0) |
| 3 | D | assumed (input unused, reads 0) |
| 4 | AB | likely (~0.5 /s ≈ accidentals for Δt ≈ 1.3 ns) |
| 5 | AC | assumed |
| 6 | BC | assumed |
| 7 | ABC | assumed |

Check the assumed rows by connecting a detector to C and blocking inputs one at a
time; fix the map in the page under **Raw counters & channel mapping**.
