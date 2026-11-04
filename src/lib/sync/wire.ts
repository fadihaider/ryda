import type { AltitudeSource, RideMeta, RideStreams } from "@/lib/analysis/types";

/**
 * How a ride crosses the wire.
 *
 * Sample streams are typed arrays, and JSON has no way to carry one — an array
 * of 20,000 numbers as text is roughly six times the bytes and has to be parsed
 * one token at a time on arrival. Each channel travels as base64 of its raw
 * buffer instead, which is 4/3 of the binary size and decodes in one call.
 *
 * Measured on a real library: 52 bytes per sample raw, 18 gzipped, so a 1000
 * hour season is about 62 MB compressed. That is small enough that the streams
 * live in Postgres next to the metadata rather than in object storage, and it
 * is why syncing a whole history is a few minutes rather than an afternoon.
 */

/** Channels that travel as base64, and the constructor each one decodes to. */
const CHANNELS = {
  time: Float64Array,
  distance: Float64Array,
  altitude: Float64Array,
  latlng: Float64Array,
  speed: Float32Array,
  heartrate: Float32Array,
  cadence: Float32Array,
  power: Float32Array,
  temperature: Float32Array,
  paused: Uint8Array,
} as const;

export type ChannelName = keyof typeof CHANNELS;

export interface WireStreams {
  sampleCount: number;
  altitudeSource: AltitudeSource;
  speedIsDerived: boolean;
  /** base64 per channel; absent channels are simply missing. */
  channels: Partial<Record<ChannelName, string>>;
}

export interface WireRide {
  id: string;
  name: string;
  startedAt: string;
  localDate: string;
  sport: string;
  hasMeasuredPower: boolean;
  devices: string[];
  durationSeconds: number;
  movingSeconds: number;
  distanceMeters: number;
  elevationGainMeters: number;
  meanPower: number;
  weightedPower: number;
  load: number;
  meanHeartRate: number | null;
  /** Calories the recording device computed, null when it recorded none. */
  reportedCalories?: number | null;
  decouplingPercent: number | null;
  confidence: string;
  sampleCount: number;
  altitudeSource: string;
  /** Mechanical work, derived from mean power and moving time. */
  kilojoules?: number;
  /** Dietary calories, from that work and a gross-efficiency assumption. */
  calories?: number;
  /** "file" or "strava" — where the samples came from. Set by the server. */
  source?: string;
  /** The matching Strava activity, when there is one. Set by the server. */
  stravaActivityId?: number | null;
}

function toBase64(view: ArrayBufferView): string {
  const bytes = new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
  if (typeof Buffer !== "undefined") return Buffer.from(bytes).toString("base64");
  // Chunked, because String.fromCharCode(...bytes) on a megabyte of samples
  // blows the argument limit and throws.
  let binary = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

function fromBase64(b64: string): Uint8Array {
  if (typeof Buffer !== "undefined") return new Uint8Array(Buffer.from(b64, "base64"));
  const binary = atob(b64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

export function encodeStreams(streams: RideStreams, meta: RideMeta): WireStreams {
  const channels: Partial<Record<ChannelName, string>> = {};
  for (const name of Object.keys(CHANNELS) as ChannelName[]) {
    const view = streams[name];
    if (view) channels[name] = toBase64(view);
  }
  return {
    sampleCount: meta.n,
    altitudeSource: meta.altitudeSource,
    speedIsDerived: streams.speedIsDerived === true,
    channels,
  };
}

/** Column names on `ride_streams`, which differ from the wire names in no case. */
type StreamRow = { sampleCount: number } & Partial<Record<ChannelName, Uint8Array | null>>;

/**
 * Turn stored `bytea` columns back into typed arrays, for analysis on the server.
 *
 * The copy into a fresh ArrayBuffer is not defensive tidiness. Postgres drivers
 * hand back buffers that are views into a pooled allocation, so `byteOffset` is
 * rarely a multiple of 8, and `new Float64Array(buf.buffer, buf.byteOffset, n)`
 * throws `RangeError: start offset must be a multiple of 8`. It will not
 * reproduce on a small fixture and will fire on real rides.
 */
export function decodeStoredStreams(
  row: StreamRow,
  altitudeSource: RideMeta["altitudeSource"],
  speedIsDerived: boolean,
): { streams: RideStreams; meta: RideMeta } {
  const out: Record<string, unknown> = {};
  for (const name of Object.keys(CHANNELS) as ChannelName[]) {
    const bytes = row[name];
    if (!bytes) continue;
    const Ctor = CHANNELS[name];
    const aligned = new ArrayBuffer(bytes.byteLength);
    new Uint8Array(aligned).set(bytes);
    out[name] = new Ctor(aligned);
  }
  out.speedIsDerived = speedIsDerived;
  return {
    streams: out as unknown as RideStreams,
    meta: { n: row.sampleCount, altitudeSource },
  };
}

/** base64 of a typed array, for channels that are computed rather than stored. */
export function encodeChannel(view: ArrayBufferView): string {
  return toBase64(view);
}

export function decodeStreams(wire: WireStreams): { streams: RideStreams; meta: RideMeta } {
  const out: Record<string, unknown> = {};
  for (const name of Object.keys(CHANNELS) as ChannelName[]) {
    const b64 = wire.channels[name];
    if (!b64) continue;
    const bytes = fromBase64(b64);
    const Ctor = CHANNELS[name];
    // Copy into a fresh buffer: base64 decoding gives no alignment guarantee,
    // and a Float64Array view onto an odd byte offset throws.
    const aligned = new ArrayBuffer(bytes.byteLength);
    new Uint8Array(aligned).set(bytes);
    out[name] = new Ctor(aligned);
  }
  out.speedIsDerived = wire.speedIsDerived;

  return {
    streams: out as unknown as RideStreams,
    meta: { n: wire.sampleCount, altitudeSource: wire.altitudeSource },
  };
}
