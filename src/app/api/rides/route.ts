import { and, desc, eq } from "drizzle-orm";
import { db, schema } from "@/db";
import { requireUser } from "@/lib/auth";
import { decodeStreams, type WireRide, type WireStreams } from "@/lib/sync/wire";
import { energyFor, kilojoulesFrom } from "@/lib/analysis/metrics";
import { supersedeStravaCopies, writeRide } from "@/lib/rides/server-store";

/**
 * A rider's rides.
 *
 * GET returns summaries only. The library, the trend chart and an iOS widget
 * all want the same thing — a few hundred bytes per ride — and none of them
 * want twenty thousand samples. Streams are a separate request per ride.
 */
export async function GET(request: Request) {
  const user = await requireUser(request);
  if (!user) return unauthorized();

  const rows = await db
    .select()
    .from(schema.rides)
    .where(eq(schema.rides.userId, user.id))
    .orderBy(desc(schema.rides.startedAt));

  return Response.json({ rides: rows.map(toWire) });
}

interface PushBody {
  ride: WireRide;
  /**
   * Omit to update an existing ride's summary without re-sending its samples.
   *
   * Streams are immutable once recorded; the numbers derived from them are not.
   * The model changes, the rider's mass changes, and a re-import picks up a
   * field the parser did not used to read. Requiring the streams to correct any
   * of that would mean pushing a megabyte per ride to change six floats.
   */
  streams?: WireStreams;
}

/**
 * Store one ride.
 *
 * Idempotent on the ride id, which is derived from start time and duration, so
 * re-syncing a library or re-importing the same export replaces rather than
 * duplicates. That matters more than it sounds: a Strava bulk export is
 * re-downloaded every few months and overlaps everything already stored.
 */
export async function POST(request: Request) {
  const user = await requireUser(request);
  if (!user) return unauthorized();

  let body: PushBody;
  try {
    body = (await request.json()) as PushBody;
  } catch {
    return Response.json({ error: "body must be JSON" }, { status: 400 });
  }

  const { ride, streams } = body ?? {};
  if (!ride?.id) {
    return Response.json({ error: "expected { ride }" }, { status: 400 });
  }

  // Summary-only update. Deliberately cannot create a ride: without streams
  // there would be nothing to analyse, and a row that exists but has no samples
  // is worse than no row.
  if (!streams?.channels) {
    const updated = await db
      .update(schema.rides)
      .set(summaryOnly(ride))
      .where(and(eq(schema.rides.id, ride.id), eq(schema.rides.userId, user.id)))
      .returning({ id: schema.rides.id });
    if (updated.length === 0) {
      return Response.json({ error: "not found — send streams to create it" }, { status: 404 });
    }
    return Response.json({ id: ride.id, updated: "summary" });
  }

  // Decode before writing, so a malformed payload fails here rather than
  // becoming a row that every later read has to defend against.
  let decoded;
  try {
    decoded = decodeStreams(streams);
  } catch {
    return Response.json({ error: "streams could not be decoded" }, { status: 400 });
  }
  if (decoded.meta.n !== decoded.streams.time.length) {
    return Response.json({ error: "sampleCount does not match the time channel" }, { status: 400 });
  }

  const values = {
    id: ride.id,
    userId: user.id,
    name: ride.name,
    startedAt: new Date(ride.startedAt),
    localDate: ride.localDate,
    sport: ride.sport,
    sampleCount: decoded.meta.n,
    altitudeSource: decoded.meta.altitudeSource,
    speedIsDerived: streams.speedIsDerived === true,
    hasMeasuredPower: ride.hasMeasuredPower,
    devices: ride.devices ?? [],
    durationSeconds: Math.round(ride.durationSeconds),
    movingSeconds: Math.round(ride.movingSeconds),
    distanceMeters: ride.distanceMeters,
    elevationGainMeters: ride.elevationGainMeters,
    meanPower: ride.meanPower,
    weightedPower: ride.weightedPower,
    load: ride.load,
    meanHeartRate: ride.meanHeartRate,
    reportedCalories: ride.reportedCalories ?? null,
    decouplingPercent: ride.decouplingPercent,
    confidence: ride.confidence,
    // Anything uploaded with samples came from a file on a device. Strava
    // copies are only ever written by the server itself.
    source: "file",
    updatedAt: new Date(),
  };

  await writeRide(values, decoded.streams);

  // A file has arrived. If sync already stored Strava's copy of this ride under
  // a neighbouring id, it goes now; the file is the better record of it.
  await supersedeStravaCopies(user.id, {
    id: values.id,
    startedAt: values.startedAt,
    durationSeconds: values.durationSeconds,
  });

  return Response.json({ id: ride.id }, { status: 200 });
}

export async function DELETE(request: Request) {
  const user = await requireUser(request);
  if (!user) return unauthorized();

  const id = new URL(request.url).searchParams.get("id");
  if (!id) return Response.json({ error: "id is required" }, { status: 400 });

  // Scoped by user id as well as ride id — the ride id alone is derived from a
  // timestamp, so two accounts can hold the same one.
  const deleted = await db
    .delete(schema.rides)
    .where(and(eq(schema.rides.id, id), eq(schema.rides.userId, user.id)))
    .returning({ id: schema.rides.id });

  // Reporting success for a ride that was never touched hides both a caller bug
  // and a probe for someone else's ride behind the same cheerful 200.
  if (deleted.length === 0) return Response.json({ error: "not found" }, { status: 404 });

  return Response.json({ deleted: id });
}

/**
 * The fields a re-analysis can legitimately change.
 *
 * Deliberately excludes sampleCount, altitudeSource and speedIsDerived: those
 * describe the recording, not the interpretation, and are only knowable from
 * the streams themselves. Letting a summary-only push rewrite them would let a
 * client quietly claim a ride was recorded differently than it was.
 */
function summaryOnly(ride: WireRide) {
  return {
    name: ride.name,
    localDate: ride.localDate,
    durationSeconds: Math.round(ride.durationSeconds),
    movingSeconds: Math.round(ride.movingSeconds),
    distanceMeters: ride.distanceMeters,
    elevationGainMeters: ride.elevationGainMeters,
    meanPower: ride.meanPower,
    weightedPower: ride.weightedPower,
    load: ride.load,
    meanHeartRate: ride.meanHeartRate,
    reportedCalories: ride.reportedCalories ?? null,
    decouplingPercent: ride.decouplingPercent,
    confidence: ride.confidence,
    updatedAt: new Date(),
  };
}

export function toWire(row: typeof schema.rides.$inferSelect): WireRide {
  return {
    id: row.id,
    name: row.name,
    startedAt: row.startedAt.toISOString(),
    localDate: row.localDate,
    sport: row.sport,
    hasMeasuredPower: row.hasMeasuredPower,
    devices: row.devices,
    durationSeconds: row.durationSeconds,
    movingSeconds: row.movingSeconds,
    distanceMeters: row.distanceMeters,
    elevationGainMeters: row.elevationGainMeters,
    meanPower: row.meanPower,
    weightedPower: row.weightedPower,
    load: row.load,
    meanHeartRate: row.meanHeartRate,
    decouplingPercent: row.decouplingPercent,
    confidence: row.confidence,
    sampleCount: row.sampleCount,
    altitudeSource: row.altitudeSource,
    // Mechanical work is always derived; the calorie figure prefers whatever
    // the recording device wrote, and says which it used.
    kilojoules: kilojoulesFrom(row.meanPower, row.movingSeconds),
    ...energyFor(row.reportedCalories, row.meanPower, row.movingSeconds),
    // Echoed back, not just consumed. A client diffs its local copy against
    // this to decide what to push; a field the server accepts but never returns
    // reads as permanently unsynced, and every sync re-uploads it forever.
    reportedCalories: row.reportedCalories,
    source: row.source,
    stravaActivityId: row.stravaActivityId,
  };
}

function unauthorized() {
  return Response.json({ error: "sign in first" }, { status: 401 });
}
