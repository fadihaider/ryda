import { and, eq, gte, lte } from "drizzle-orm";
import { db, schema } from "@/db";
import type { RideStreams } from "@/lib/analysis/types";
import { DEFAULT_SETTINGS, sanitise, type RiderSettings } from "@/lib/rider-settings";
import { isSameRide, MATCH_TOLERANCE_SECONDS, type RideTiming } from "./match";

/**
 * Writing rides on the server, shared by the upload endpoint and Strava sync.
 *
 * Both paths have to agree on one rule — a file ride is never displaced by a
 * Strava copy, and a Strava copy is always displaced by the file — so the
 * writes and the matching live in one place rather than two.
 */

export type RideRow = typeof schema.rides.$inferInsert;

export async function writeRide(row: RideRow, streams: RideStreams): Promise<void> {
  // Left out of the update when absent, so re-uploading a file over a ride
  // that Strava already linked keeps the link instead of nulling it.
  const { stravaActivityId, ...rest } = row;
  const set = stravaActivityId == null ? rest : row;

  // Conflict target is the composite key: a ride id is only unique within an
  // account, so targeting id alone would let one rider's upload overwrite
  // another's ride when they rode together.
  await db
    .insert(schema.rides)
    .values(row)
    .onConflictDoUpdate({ target: [schema.rides.userId, schema.rides.id], set });

  const buffers = {
    rideId: row.id,
    userId: row.userId,
    sampleCount: row.sampleCount,
    time: toBuffer(streams.time)!,
    distance: toBuffer(streams.distance)!,
    altitude: toBuffer(streams.altitude)!,
    latlng: toBuffer(streams.latlng),
    speed: toBuffer(streams.speed),
    heartrate: toBuffer(streams.heartrate),
    cadence: toBuffer(streams.cadence),
    power: toBuffer(streams.power),
    temperature: toBuffer(streams.temperature),
    paused: toBuffer(streams.paused),
  };

  await db
    .insert(schema.rideStreams)
    .values(buffers)
    .onConflictDoUpdate({
      target: [schema.rideStreams.userId, schema.rideStreams.rideId],
      set: buffers,
    });
}

export interface NearbyRide {
  id: string;
  name: string;
  source: string;
  stravaActivityId: number | null;
}

/** Stored rides that are the same ride as `timing`, by tolerance rather than id. */
export async function findSameRides(userId: string, timing: RideTiming): Promise<NearbyRide[]> {
  const start = new Date(timing.startedAt).getTime();
  const window = MATCH_TOLERANCE_SECONDS * 1000;
  const rows = await db
    .select({
      id: schema.rides.id,
      name: schema.rides.name,
      source: schema.rides.source,
      stravaActivityId: schema.rides.stravaActivityId,
      startedAt: schema.rides.startedAt,
      durationSeconds: schema.rides.durationSeconds,
    })
    .from(schema.rides)
    .where(
      and(
        eq(schema.rides.userId, userId),
        gte(schema.rides.startedAt, new Date(start - window)),
        lte(schema.rides.startedAt, new Date(start + window)),
      ),
    );
  return rows
    .filter((r) => isSameRide(r, timing))
    .map(({ id, name, source, stravaActivityId }) => ({ id, name, source, stravaActivityId }));
}

/**
 * A file ride has just been stored: remove any Strava copy of the same ride.
 *
 * The copy's activity id moves onto the file ride, so "View on Strava" and
 * later renames still find it. Deleted before the id is moved, because the
 * activity id is unique per rider and two rows cannot hold it at once.
 */
export async function supersedeStravaCopies(
  userId: string,
  kept: RideTiming & { id: string },
): Promise<void> {
  const copies = (await findSameRides(userId, kept)).filter(
    (r) => r.id !== kept.id && r.source === "strava",
  );
  if (copies.length === 0) return;

  for (const copy of copies) {
    await db
      .delete(schema.rides)
      .where(and(eq(schema.rides.userId, userId), eq(schema.rides.id, copy.id)));
  }

  const activityId = copies.find((c) => c.stravaActivityId != null)?.stravaActivityId;
  if (activityId == null) return;
  await db
    .update(schema.rides)
    .set({ stravaActivityId: activityId, updatedAt: new Date() })
    .where(
      and(
        eq(schema.rides.userId, userId),
        eq(schema.rides.id, kept.id),
      ),
    );
}

/** The rider's saved numbers, or the defaults when they have saved none. */
export async function loadRiderSettings(userId: string): Promise<RiderSettings> {
  const [saved] = await db
    .select()
    .from(schema.riderSettings)
    .where(eq(schema.riderSettings.userId, userId))
    .limit(1);
  if (!saved) return DEFAULT_SETTINGS;
  return sanitise({
    riderKg: saved.riderKg,
    bikeKg: saved.bikeKg,
    positionId: saved.positionId,
    surfaceId: saved.surfaceId,
    ftp: saved.ftp,
    lthr: saved.lthr,
    configured: saved.configured,
  });
}

function toBuffer(view: ArrayBufferView | undefined): Uint8Array | null {
  if (!view) return null;
  return new Uint8Array(view.buffer as ArrayBuffer, view.byteOffset, view.byteLength);
}
