import { estimatePower } from "@/lib/analysis/power";
import { computeRideMetrics } from "@/lib/analysis/metrics";
import { buildPowerCurve } from "@/lib/analysis/curve";
import { isCycling } from "@/lib/ingest/sport";
import type { ParsedRide } from "@/lib/ingest/fit";
import { toProfile, type RiderSettings } from "@/lib/rider-settings";
import { saveRide, type SaveResult } from "./rides";

/**
 * Turn a parsed file into a stored ride.
 *
 * Metrics are computed once at import and denormalised onto the summary row so
 * the library and the trend chart never touch the sample streams. A season of
 * rides is tens of millions of samples; recomputing them to draw one line is
 * the difference between an instant chart and a spinner.
 */
export async function importRide(
  ride: ParsedRide,
  settings: RiderSettings,
): Promise<SaveResult> {
  const profile = toProfile(settings);

  // This is a ride analyser. Nearly half a real Strava export turned out to be
  // walks, and every one of them would otherwise be run through bicycle
  // physics and folded into the fitness curve as a meaningless number.
  if (!isCycling(ride.sport)) {
    throw new NotARideError(ride.sport);
  }

  const { watts, confidence } = estimatePower(ride.streams, ride.meta, profile);

  const metrics = computeRideMetrics({
    watts,
    time: ride.streams.time,
    distance: ride.streams.distance,
    altitude: ride.streams.altitude,
    heartrate: ride.streams.heartrate,
    paused: ride.streams.paused,
    ftp: profile.ftp,
  });

  // A file can be a valid, correctly-typed ride and still contain nothing
  // analysable — a TCX recorded with a heart-rate strap alone has timestamps
  // and beats but no distance at all. Storing it puts a row of zeros in the
  // library and a zero-load day on the fitness curve.
  if (metrics.distanceMeters < MIN_ANALYSABLE_METRES) {
    throw new NoRideDataError(ride.name);
  }

  // Cache the mean-maximal curve now so the power page is an element-wise max
  // over small arrays instead of a re-scan of every ride's samples.
  const curve = buildPowerCurve(watts).watts;

  return saveRide({
    ride,
    curve,
    summary: {
      durationSeconds: metrics.durationSeconds,
      movingSeconds: metrics.movingSeconds,
      distanceMeters: metrics.distanceMeters,
      elevationGainMeters: metrics.elevationGainMeters,
      meanPower: metrics.meanPower,
      weightedPower: metrics.weightedPower,
      load: metrics.load,
      meanHeartRate: metrics.meanHeartRate,
      // The device's own figure when the file carried one. It models metabolic
      // cost from heart rate; everything derivable here is mechanical work.
      reportedCalories: ride.reported.calories ?? null,
      decouplingPercent: metrics.decoupling?.percent ?? null,
      confidence: confidence.level,
    },
  });
}

/**
 * Recompute every stored ride's metrics from its saved streams.
 *
 * Summaries are denormalised at import so the library and trend never touch
 * sample data — which means they go stale whenever the power model or the
 * rider's settings change. Re-importing the original files would work, but the
 * streams are already here, so asking someone to hunt down a year of .fit files
 * to pick up a bug fix would be absurd.
 */
export async function recomputeAll(
  settings: RiderSettings,
  onProgress?: (done: number, total: number) => void,
): Promise<{ updated: number; failed: number }> {
  const { listRides, getStreams, saveRide } = await import("./rides");
  const rides = await listRides();
  const profile = toProfile(settings);
  let updated = 0;
  let failed = 0;

  for (let i = 0; i < rides.length; i++) {
    const summary = rides[i];
    onProgress?.(i + 1, rides.length);
    try {
      const stored = await getStreams(summary.id);
      if (!stored) {
        failed++;
        continue;
      }
      const { watts, confidence } = estimatePower(stored.streams, stored.meta, profile);
      const metrics = computeRideMetrics({
        watts,
        time: stored.streams.time,
        distance: stored.streams.distance,
        altitude: stored.streams.altitude,
        heartrate: stored.streams.heartrate,
        paused: stored.streams.paused,
        ftp: profile.ftp,
      });

      const curve = buildPowerCurve(watts).watts;
      await saveRide({
        curve,
        // Re-deriving numbers must not change where the samples came from.
        origin: {
          source: summary.source ?? "file",
          stravaActivityId: summary.stravaActivityId ?? null,
        },
        ride: {
          streams: stored.streams,
          meta: stored.meta,
          name: summary.name,
          startedAt: summary.startedAt,
          sport: summary.sport,
          hasMeasuredPower: summary.hasMeasuredPower,
          devices: summary.devices,
          gapSeconds: 0,
          reported: {},
        },
        summary: {
          durationSeconds: metrics.durationSeconds,
          movingSeconds: metrics.movingSeconds,
          distanceMeters: metrics.distanceMeters,
          elevationGainMeters: metrics.elevationGainMeters,
          meanPower: metrics.meanPower,
          weightedPower: metrics.weightedPower,
          load: metrics.load,
          meanHeartRate: metrics.meanHeartRate,
          reportedCalories: summary.reportedCalories,
          decouplingPercent: metrics.decoupling?.percent ?? null,
          confidence: confidence.level,
        },
      });
      updated++;
    } catch {
      failed++;
    }
    await new Promise((r) => setTimeout(r, 0));
  }

  return { updated, failed };
}

export interface ImportProgress {
  file: string;
  index: number;
  total: number;
}

export interface ImportOutcome {
  added: number;
  replaced: number;
  /** Activities that parsed fine but are not rides. */
  skipped: { file: string; sport: string }[];
  failed: { file: string; reason: string }[];
}

/** Below this a file has no ride in it, whatever its headers claim. */
export const MIN_ANALYSABLE_METRES = 300;

/** Thrown when a ride carries no usable distance — e.g. a strap-only recording. */
export class NoRideDataError extends Error {
  constructor(readonly rideName: string) {
    super("no distance recorded");
    this.name = "NoRideDataError";
  }
}

/** Thrown when a file parses but is not a bike ride. */
export class NotARideError extends Error {
  constructor(readonly sport: string) {
    super(`not a ride (${sport})`);
    this.name = "NotARideError";
  }
}

/**
 * Import many files, continuing past failures.
 *
 * A bulk export is thousands of files and some of them will be corrupt, or a
 * sport this app doesn't model. Aborting the whole import on the first bad file
 * would make the feature useless, so failures are collected and reported.
 */
export async function importFiles(
  files: File[],
  settings: RiderSettings,
  onProgress?: (progress: ImportProgress) => void,
): Promise<ImportOutcome> {
  const outcome: ImportOutcome = { added: 0, replaced: 0, skipped: [], failed: [] };

  for (let i = 0; i < files.length; i++) {
    const file = files[i];
    onProgress?.({ file: file.name, index: i, total: files.length });
    try {
      const parsed = await parseFile(file);
      const result = await importRide(parsed, settings);
      if (result.replaced) outcome.replaced++;
      else outcome.added++;
    } catch (e) {
      if (e instanceof NotARideError) {
        outcome.skipped.push({ file: file.name, sport: e.sport });
      } else if (e instanceof NoRideDataError) {
        outcome.skipped.push({ file: file.name, sport: "no distance" });
      } else {
        outcome.failed.push({
          file: file.name,
          reason: e instanceof Error ? e.message : "could not be read",
        });
      }
    }
    // Yield to the event loop so the progress UI can actually paint.
    await new Promise((r) => setTimeout(r, 0));
  }

  return outcome;
}

/**
 * Strava exports every activity gzipped, so .gz support is not optional —
 * without it most of a real export is unreadable. DecompressionStream is a web
 * standard, so this costs no dependency.
 */
async function gunzip(buffer: ArrayBuffer): Promise<ArrayBuffer> {
  const stream = new Blob([buffer]).stream().pipeThrough(new DecompressionStream("gzip"));
  return new Response(stream).arrayBuffer();
}

export async function parseFile(file: File): Promise<ParsedRide> {
  let name = file.name.toLowerCase();
  let buffer = await file.arrayBuffer();

  if (name.endsWith(".gz")) {
    buffer = await gunzip(buffer);
    name = name.slice(0, -3);
  }

  if (name.endsWith(".fit")) {
    const { parseFit } = await import("@/lib/ingest/fit");
    return parseFit(buffer);
  }
  const text = new TextDecoder().decode(buffer);
  if (name.endsWith(".gpx")) {
    const { parseGpx } = await import("@/lib/ingest/gpx");
    return parseGpx(text);
  }
  if (name.endsWith(".tcx")) {
    const { parseTcx } = await import("@/lib/ingest/tcx");
    return parseTcx(text);
  }
  throw new Error("not a .fit, .gpx or .tcx file");
}
