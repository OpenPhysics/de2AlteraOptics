/**
 * Logical channels and their mapping onto the 8 hardware counters.
 *
 * Counters 0 (A), 1 (B) and 4 (AB) are confirmed by the 2026-11-20 capture
 * (A ~15 k/s, B ~25 k/s, AB ~ accidentals). The C-related indices are an
 * assumption until a third detector is wired to the C input; the map is
 * editable in the UI.
 */

export const CHANNELS = ['A', 'B', 'C', 'D', 'AB', 'AC', 'BC', 'ABC'] as const;
export type Channel = (typeof CHANNELS)[number];

export type ChannelMap = Record<Channel, number>;

export const DEFAULT_CHANNEL_MAP: Readonly<ChannelMap> = {
  A: 0,
  B: 1,
  C: 2,
  D: 3,
  AB: 4,
  AC: 5,
  BC: 6,
  ABC: 7,
};

/** Channels shown in the default two-detector view. */
export const TWO_DETECTOR: readonly Channel[] = ['A', 'B', 'AB'];
/** Extra channels shown when the three-detector toggle is on. */
export const THREE_DETECTOR_EXTRA: readonly Channel[] = [
  'C',
  'AC',
  'BC',
  'ABC',
];

export function isCoincidence(ch: Channel): boolean {
  return ch.length > 1;
}

/** Pick logical channel values out of a raw 8-counter array. */
export function mapCounts(
  raw: readonly number[],
  map: Readonly<ChannelMap>
): Record<Channel, number> {
  const out = {} as Record<Channel, number>;
  for (const ch of CHANNELS) out[ch] = raw[map[ch]] ?? 0;
  return out;
}
