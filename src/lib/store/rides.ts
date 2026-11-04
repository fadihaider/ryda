import type { ParsedRide } from "@/lib/ingest/fit";
import type { AltitudeSource, RideMeta, RideStreams } from "@/lib/analysis/types";

/**
 * Local ride library, in IndexedDB.
 *
 * Rides live on the device by choice, not as a stopgap. A ride file is a record
 * of where someone lives and when they are away from home; keeping it local by
 * default is the correct posture, and it also means the whole app — including
 * multi-ride trends — works with no backend, no account and no cost.
 *
 * The schema deliberately mirrors what a Postgres table would hold, so adding
 * sync later is a transport change rather than a rewrite: a summary row per
 * ride, and the sample streams stored as typed arrays in a separate store so
 * the library list never has to deserialise megabytes to render.
 *
 * IndexedDB stores typed arrays natively via structured clone, so there is no
 * serialisation step and no dependency here.
 */

const DB_NAME = "ryda";
const DB_VERSION = 2;
const RIDES = "rides";
const STREAMS = "streams";
const CURVES = "curves";

/** Row shown in the library and used by the trend chart. Small on purpose. */
export interface RideSummary {
  id: string;
  name: string;
  /** ISO timestamp of the ride start. */
  startedAt: string;
  /** YYYY-MM-DD in local time — the key the training-load calendar joins on. */
  localDate: string;
  sport: string;
  n: number;
  altitudeSource: AltitudeSource;
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
  /** What the device said it cost, when it said anything. */
  reportedCalories: number | null;
  decouplingPercent: number | null;
  confidence: string;
  importedAt: string;
  /** "strava" when the server fetched the samples from Strava; absent or
   *  "file" for anything imported from a file. */
  source?: "file" | "strava";
  /** The matching Strava activity, when there is one. */
  stravaActivityId?: number | null;
}

interface StreamRecord {
  id: string;
  streams: RideStreams;
}

interface CurveRecord {
  id: string;
  /** Local calendar day, so the power page can window by date cheaply. */
  localDate: string;
  /** Best mean power per duration, parallel to CURVE_DURATIONS. */
  watts: Float32Array;
}

export interface DatedCurve {
  id: string;
  localDate: string;
  watts: Float32Array;
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(RIDES)) {
        const store = db.createObjectStore(RIDES, { keyPath: "id" });
        store.createIndex("startedAt", "startedAt");
        store.createIndex("localDate", "localDate");
      }
      if (!db.objectStoreNames.contains(STREAMS)) {
        db.createObjectStore(STREAMS, { keyPath: "id" });
      }
      // Mean-maximal curves live in their own store so the season envelope is
      // an element-wise max over ~1 KB arrays rather than a re-scan of every
      // ride's samples. Recomputing a year of curves from raw streams to draw
      // one line would take seconds; this takes milliseconds.
      if (!db.objectStoreNames.contains(CURVES)) {
        db.createObjectStore(CURVES, { keyPath: "id" });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function tx<T>(
  db: IDBDatabase,
  stores: string[],
  mode: IDBTransactionMode,
  run: (t: IDBTransaction) => Promise<T> | T,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = db.transaction(stores, mode);
    let result: T;
    t.oncomplete = () => resolve(result);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
    Promise.resolve(run(t)).then((r) => {
      result = r;
    }, reject);
  });
}

const wrap = <T>(request: IDBRequest<T>): Promise<T> =>
  new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });

/**
 * Stable identity for a ride.
 *
 * Start time plus duration, rounded to the minute. Re-importing the same
 * activity — which happens every time a bulk export is refreshed — must update
 * the existing row rather than create a duplicate, and the same ride exported
 * as FIT and as GPX must collapse to one entry. Rounding absorbs the small
 * disagreements between formats.
 */
export function rideId(startedAt: string, durationSeconds: number): string {
  const minute = Math.round(Date.parse(startedAt) / 60_000);
  const durationMinutes = Math.round(durationSeconds / 60);
  return `${minute}-${durationMinutes}`;
}

export function toLocalDate(iso: string): string {
  const d = new Date(iso);
  const pad = (v: number) => String(v).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export interface SaveRideInput {
  ride: ParsedRide;
  /**
   * Where the ride came from. Omitted for a file import, which is recorded as
   * "file" while keeping any Strava link the replaced copy had.
   */
  origin?: { source: "file" | "strava"; stravaActivityId: number | null };
  /** Cached mean-maximal power curve for this ride. */
  curve?: Float32Array;
  summary: Omit<
    RideSummary,
    | "id"
    | "name"
    | "startedAt"
    | "localDate"
    | "sport"
    | "n"
    | "altitudeSource"
    | "hasMeasuredPower"
    | "devices"
    | "importedAt"
    | "source"
    | "stravaActivityId"
  >;
}

export interface SaveResult {
  id: string;
  /** True when this replaced an existing ride rather than adding one. */
  replaced: boolean;
}

export async function saveRide({ ride, summary, curve, origin }: SaveRideInput): Promise<SaveResult> {
  const db = await openDb();
  const id = rideId(ride.startedAt, summary.durationSeconds);

  try {
    return await tx(db, [RIDES, STREAMS, CURVES], "readwrite", async (t) => {
      const rides = t.objectStore(RIDES);
      const existing = await wrap<RideSummary | undefined>(rides.get(id));

      const row: RideSummary = {
        ...summary,
        id,
        name: ride.name,
        startedAt: ride.startedAt,
        localDate: toLocalDate(ride.startedAt),
        sport: ride.sport,
        n: ride.meta.n,
        altitudeSource: ride.meta.altitudeSource,
        hasMeasuredPower: ride.hasMeasuredPower,
        devices: ride.devices,
        importedAt: existing?.importedAt ?? new Date().toISOString(),
        source: origin?.source ?? "file",
        stravaActivityId: origin ? origin.stravaActivityId : (existing?.stravaActivityId ?? null),
      };

      rides.put(row);
      t.objectStore(STREAMS).put({ id, streams: ride.streams } satisfies StreamRecord);
      if (curve) {
        t.objectStore(CURVES).put({
          id,
          localDate: row.localDate,
          watts: curve,
        } satisfies CurveRecord);
      }
      return { id, replaced: existing !== undefined };
    });
  } finally {
    db.close();
  }
}

export async function listRides(): Promise<RideSummary[]> {
  const db = await openDb();
  try {
    const rows = await tx(db, [RIDES], "readonly", (t) =>
      wrap<RideSummary[]>(t.objectStore(RIDES).getAll()),
    );
    // Newest first — the library is almost always read from the top.
    return rows.sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  } finally {
    db.close();
  }
}

export async function getStreams(
  id: string,
): Promise<{ streams: RideStreams; meta: RideMeta } | null> {
  const db = await openDb();
  try {
    const [record, summary] = await tx(db, [STREAMS, RIDES], "readonly", async (t) => [
      await wrap<StreamRecord | undefined>(t.objectStore(STREAMS).get(id)),
      await wrap<RideSummary | undefined>(t.objectStore(RIDES).get(id)),
    ]);
    if (!record || !summary) return null;
    return {
      streams: record.streams,
      meta: { n: summary.n, altitudeSource: summary.altitudeSource },
    };
  } finally {
    db.close();
  }
}

/** Every cached curve, for building all-time and windowed envelopes. */
export async function listCurves(): Promise<DatedCurve[]> {
  const db = await openDb();
  try {
    return await tx(db, [CURVES], "readonly", (t) =>
      wrap<DatedCurve[]>(t.objectStore(CURVES).getAll()),
    );
  } finally {
    db.close();
  }
}

/** Change a stored ride's descriptive fields without touching its samples. */
export async function updateRideDetails(
  id: string,
  patch: Partial<Pick<RideSummary, "name" | "stravaActivityId">>,
): Promise<void> {
  const db = await openDb();
  try {
    await tx(db, [RIDES], "readwrite", async (t) => {
      const rides = t.objectStore(RIDES);
      const existing = await wrap<RideSummary | undefined>(rides.get(id));
      if (existing) rides.put({ ...existing, ...patch });
    });
  } finally {
    db.close();
  }
}

export async function deleteRide(id: string): Promise<void> {
  const db = await openDb();
  try {
    await tx(db, [RIDES, STREAMS, CURVES], "readwrite", (t) => {
      t.objectStore(RIDES).delete(id);
      t.objectStore(STREAMS).delete(id);
      t.objectStore(CURVES).delete(id);
    });
  } finally {
    db.close();
  }
}

export async function clearAll(): Promise<void> {
  const db = await openDb();
  try {
    await tx(db, [RIDES, STREAMS, CURVES], "readwrite", (t) => {
      t.objectStore(RIDES).clear();
      t.objectStore(STREAMS).clear();
      t.objectStore(CURVES).clear();
    });
  } finally {
    db.close();
  }
}

/** Rough footprint, so the library can warn before a browser quota error. */
export async function estimateUsage(): Promise<{ usedBytes: number; quotaBytes: number } | null> {
  if (typeof navigator === "undefined" || !navigator.storage?.estimate) return null;
  const { usage = 0, quota = 0 } = await navigator.storage.estimate();
  return { usedBytes: usage, quotaBytes: quota };
}
