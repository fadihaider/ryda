/**
 * The x axis the ride charts draw against, with stops squeezed out.
 *
 * A head unit with auto-pause stops writing records while the bike is still,
 * and normalising to 1 Hz fills that time with samples flagged `paused`. The
 * metrics already ignore them; the charts drew them, as flat lines holding the
 * last heart rate and altitude. On a ride with a long lunch that was hours of
 * nothing taking most of the chart's width.
 *
 * So on the time axis each stop of a minute or more becomes a narrow band of
 * fixed width, labelled with its length, and shorter stops — lights,
 * junctions — close up entirely. The axis then reads as riding time.
 *
 * Every sample keeps its index. Filler is hidden (drawn as a gap) and given an
 * x inside its band, so the map marker, the shared cursor and range selection
 * all keep addressing samples exactly as before.
 */

/** Stops shorter than this close up with no marker. */
export const MARKED_STOP_SECONDS = 60;
/** Width of a marked stop on the time axis, in axis seconds. */
export const STOP_BAND_SECONDS = 120;

export interface StopMark {
  /** Where the stop begins on the axis. */
  x: number;
  /** Axis width of the band; 0 on the distance axis, where it is drawn as a sliver. */
  width: number;
  /** How long the rider was actually stopped. */
  seconds: number;
}

export interface PauseAxis {
  x: Float64Array;
  /** 1 where the sample is pause filler, to be drawn as a gap. Null when none. */
  hidden: Uint8Array | null;
  stops: StopMark[];
  /** Length of the stop each hidden sample belongs to, for the hover readout. */
  stopSeconds: Float32Array | null;
  /** Axis value back to riding time, for tick labels on the time axis. */
  toRiding: (x: number) => number;
}

interface Run {
  start: number;
  length: number;
}

function pauseRuns(paused: Uint8Array): Run[] {
  const runs: Run[] = [];
  let start = -1;
  for (let i = 0; i <= paused.length; i++) {
    const p = i < paused.length && paused[i] === 1;
    if (p && start < 0) start = i;
    if (!p && start >= 0) {
      runs.push({ start, length: i - start });
      start = -1;
    }
  }
  return runs;
}

export function buildPauseAxis(
  base: Float64Array,
  paused: Uint8Array | undefined,
  xIsDistance: boolean,
): PauseAxis {
  const runs = paused ? pauseRuns(paused) : [];
  if (!paused || runs.length === 0) {
    return { x: base, hidden: null, stops: [], stopSeconds: null, toRiding: (v) => v };
  }

  const n = base.length;
  const stopSeconds = new Float32Array(n);
  for (const r of runs) stopSeconds.fill(r.length, r.start, r.start + r.length);
  const marked = runs.filter((r) => r.length >= MARKED_STOP_SECONDS);

  // Distance does not advance while stopped, so that axis is already
  // collapsed. It only needs the filler hidden and the stops marked.
  if (xIsDistance) {
    return {
      x: base,
      hidden: paused,
      stops: marked.map((r) => ({ x: base[r.start], width: 0, seconds: r.length })),
      stopSeconds,
      toRiding: (v) => v,
    };
  }

  const markedStarts = new Set(marked.map((r) => r.start));
  const x = new Float64Array(n);
  const stops: StopMark[] = [];
  let t = 0;
  let i = 0;
  for (const r of runs) {
    for (; i < r.start; i++) x[i] = t++;
    const width = markedStarts.has(r.start) ? STOP_BAND_SECONDS : 0;
    if (width > 0) stops.push({ x: t, width, seconds: r.length });
    for (let k = 0; k < r.length; k++, i++) x[i] = t + (width * k) / r.length;
    t += width;
  }
  for (; i < n; i++) x[i] = t++;

  // Bands add axis length that is not riding time; take it back out.
  const toRiding = (v: number) => {
    let out = v;
    for (const s of stops) {
      if (v >= s.x + s.width) out -= s.width;
      else if (v > s.x) out -= v - s.x;
    }
    return out;
  };

  return { x, hidden: paused, stops, stopSeconds, toRiding };
}

/** "7 min", "1h05". */
export function formatStop(seconds: number): string {
  const m = Math.round(seconds / 60);
  return m >= 60 ? `${Math.floor(m / 60)}h${String(m % 60).padStart(2, "0")}` : `${m} min`;
}
