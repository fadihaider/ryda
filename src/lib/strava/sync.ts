import { and, asc, desc, eq, inArray, max, ne, sql } from "drizzle-orm";
import { db, schema } from "@/db";
import { estimatePower } from "@/lib/analysis/power";
import { computeRideMetrics } from "@/lib/analysis/metrics";
import { isCycling } from "@/lib/ingest/sport";
import { toProfile, type RiderSettings } from "@/lib/rider-settings";
import { findSameRides, loadRiderSettings, writeRide } from "@/lib/rides/server-store";
import { MIN_ANALYSABLE_METRES } from "@/lib/store/import";
import { rideId } from "@/lib/store/rides";
import {
  NotFoundError,
  RateLimitedError,
  StravaAuthError,
  StravaClient,
  type TokenResponse,
} from "./api";
import {
  localDateFromStrava,
  NoStreamsError,
  sportFromStrava,
  streamsToRide,
  type StravaSummaryActivity,
} from "./convert";

/**
 * Strava → Postgres.
 *
 * The server does this, not the browser, so a ride reaches the phone without
 * the website ever being opened. Browsers and the iOS app then pick rides up
 * through the sync they already do.
 *
 * Three ways in, one queue:
 * - a webhook, seconds after an upload;
 * - a daily job, which catches anything the webhook missed and chips at the
 *   history backfill;
 * - a button, which runs the same batch while the account page is open.
 */

type Connection = typeof schema.stravaConnections.$inferSelect;
type QueueRow = typeof schema.stravaActivities.$inferSelect;

/** How many failures before an activity stops being retried. */
const MAX_ATTEMPTS = 3;
/** Re-list this far behind the newest known activity, for late uploads. */
const RELIST_OVERLAP_SECONDS = 2 * 86_400;

// ---------------------------------------------------------------------------
// Connections
// ---------------------------------------------------------------------------

export async function getConnection(userId: string): Promise<Connection | null> {
  const [row] = await db
    .select()
    .from(schema.stravaConnections)
    .where(eq(schema.stravaConnections.userId, userId))
    .limit(1);
  return row ?? null;
}

export async function saveConnection(userId: string, token: TokenResponse): Promise<void> {
  if (!token.athlete?.id) throw new StravaAuthError("token response carried no athlete");
  const values = {
    userId,
    athleteId: token.athlete.id,
    accessToken: token.access_token,
    refreshToken: token.refresh_token,
    expiresAt: new Date(token.expires_at * 1000),
    scope: token.scope ?? "",
    updatedAt: new Date(),
  };
  // One Strava athlete, one Ryda account: connecting it here releases it from
  // any other account that held it.
  await db
    .delete(schema.stravaConnections)
    .where(
      and(
        eq(schema.stravaConnections.athleteId, token.athlete.id),
        ne(schema.stravaConnections.userId, userId),
      ),
    );
  await db
    .insert(schema.stravaConnections)
    .values(values)
    .onConflictDoUpdate({ target: schema.stravaConnections.userId, set: values });
}

/**
 * Forget the connection. Rides already imported stay: they are the rider's
 * history now, and losing a season because a token was revoked would be worse
 * than any policy question about keeping it.
 */
export async function forgetConnection(userId: string): Promise<void> {
  await db.delete(schema.stravaActivities).where(eq(schema.stravaActivities.userId, userId));
  await db.delete(schema.stravaConnections).where(eq(schema.stravaConnections.userId, userId));
}

// ---------------------------------------------------------------------------
// Listing
// ---------------------------------------------------------------------------

async function recordActivities(
  userId: string,
  activities: StravaSummaryActivity[],
  priority: number,
): Promise<void> {
  if (activities.length === 0) return;
  const rows = activities.map((a) => ({
    userId,
    activityId: a.id,
    name: a.name,
    sportType: a.sport_type,
    startedAt: new Date(a.start_date),
    localDate: localDateFromStrava(a.start_date_local),
    elapsedSeconds: a.elapsed_time,
    deviceName: a.device_name ?? null,
    deviceWatts: a.device_watts === true,
    priority,
    // Walks never cost a streams request: they are settled the moment they
    // are listed. Nearly half a real history is not cycling.
    state: isCycling(sportFromStrava(a.sport_type)) ? "pending" : "skipped",
    updatedAt: new Date(),
  }));
  await db
    .insert(schema.stravaActivities)
    .values(rows)
    .onConflictDoUpdate({
      target: [schema.stravaActivities.userId, schema.stravaActivities.activityId],
      // Metadata refreshes; the outcome does not. Re-listing must not send an
      // imported ride back through the queue.
      set: {
        name: sql`excluded.name`,
        sportType: sql`excluded.sport_type`,
        startedAt: sql`excluded.started_at`,
        localDate: sql`excluded.local_date`,
        elapsedSeconds: sql`excluded.elapsed_seconds`,
        deviceName: sql`excluded.device_name`,
        deviceWatts: sql`excluded.device_watts`,
        updatedAt: sql`excluded.updated_at`,
      },
    });
}

/** Page through the whole history, resuming from wherever the last run stopped. */
async function listHistory(client: StravaClient, connection: Connection, deadline: number) {
  let page = connection.listPage;
  while (Date.now() < deadline) {
    const activities = await client.listActivities({ page });
    if (activities.length === 0) {
      await db
        .update(schema.stravaConnections)
        .set({ listComplete: true, updatedAt: new Date() })
        .where(eq(schema.stravaConnections.userId, connection.userId));
      return;
    }
    await recordActivities(connection.userId, activities, 0);
    page++;
    await db
      .update(schema.stravaConnections)
      .set({ listPage: page, updatedAt: new Date() })
      .where(eq(schema.stravaConnections.userId, connection.userId));
  }
}

/** Anything uploaded since the newest activity already known. */
async function listRecent(client: StravaClient, userId: string) {
  const [{ newest }] = await db
    .select({ newest: max(schema.stravaActivities.startedAt) })
    .from(schema.stravaActivities)
    .where(eq(schema.stravaActivities.userId, userId));
  if (!newest) return;
  const after = Math.floor(newest.getTime() / 1000) - RELIST_OVERLAP_SECONDS;
  for (let page = 1; ; page++) {
    const activities = await client.listActivities({ after, page });
    if (activities.length === 0) return;
    await recordActivities(userId, activities, 1);
  }
}

// ---------------------------------------------------------------------------
// Importing one activity
// ---------------------------------------------------------------------------

type Outcome = "imported" | "linked" | "skipped";

function asSummary(row: QueueRow): StravaSummaryActivity {
  return {
    id: row.activityId,
    name: row.name,
    sport_type: row.sportType,
    start_date: row.startedAt.toISOString(),
    start_date_local: `${row.localDate}T00:00:00Z`,
    elapsed_time: row.elapsedSeconds,
    device_watts: row.deviceWatts,
    device_name: row.deviceName ?? undefined,
  };
}

export async function importActivity(
  client: StravaClient,
  settings: RiderSettings,
  row: QueueRow,
): Promise<Outcome> {
  const userId = row.userId;
  if (!isCycling(sportFromStrava(row.sportType))) return "skipped";

  // The file always wins. If one is already stored for this ride, link it to
  // the activity and spend no request on samples that would be worse.
  const same = await findSameRides(userId, {
    startedAt: row.startedAt,
    durationSeconds: row.elapsedSeconds,
  });
  const file = same.find((r) => r.source === "file");
  if (file) {
    await linkFileRide(userId, file.id, row);
    return "linked";
  }

  let parsed;
  try {
    parsed = streamsToRide(asSummary(row), await client.getStreams(row.activityId));
  } catch (e) {
    if (e instanceof NoStreamsError) return "skipped";
    throw e;
  }

  const profile = toProfile(settings);
  const { watts, confidence } = estimatePower(parsed.streams, parsed.meta, profile);
  const metrics = computeRideMetrics({
    watts,
    time: parsed.streams.time,
    distance: parsed.streams.distance,
    altitude: parsed.streams.altitude,
    heartrate: parsed.streams.heartrate,
    paused: parsed.streams.paused,
    ftp: profile.ftp,
  });
  if (metrics.distanceMeters < MIN_ANALYSABLE_METRES) return "skipped";

  const id = rideId(parsed.startedAt, metrics.durationSeconds);

  // A re-import can land on a different id if Strava's trimming changed the
  // duration. The old copy would otherwise keep the activity id to itself.
  await db
    .delete(schema.rides)
    .where(
      and(
        eq(schema.rides.userId, userId),
        eq(schema.rides.stravaActivityId, row.activityId),
        eq(schema.rides.source, "strava"),
        ne(schema.rides.id, id),
      ),
    );

  await writeRide(
    {
      id,
      userId,
      name: row.name,
      startedAt: new Date(parsed.startedAt),
      localDate: row.localDate,
      sport: parsed.sport,
      sampleCount: parsed.meta.n,
      altitudeSource: parsed.meta.altitudeSource,
      speedIsDerived: parsed.streams.speedIsDerived === true,
      hasMeasuredPower: parsed.hasMeasuredPower,
      devices: parsed.devices,
      durationSeconds: Math.round(metrics.durationSeconds),
      movingSeconds: Math.round(metrics.movingSeconds),
      distanceMeters: metrics.distanceMeters,
      elevationGainMeters: metrics.elevationGainMeters,
      meanPower: metrics.meanPower,
      weightedPower: metrics.weightedPower,
      load: metrics.load,
      meanHeartRate: metrics.meanHeartRate,
      reportedCalories: null,
      decouplingPercent: metrics.decoupling?.percent ?? null,
      confidence: confidence.level,
      source: "strava",
      stravaActivityId: row.activityId,
      updatedAt: new Date(),
    },
    parsed.streams,
  );
  return "imported";
}

/** Point a file ride at its Strava activity, and take Strava's name for it. */
async function linkFileRide(userId: string, rideIdToLink: string, row: QueueRow) {
  // The activity id is unique per rider; free it from any stale holder first.
  await db
    .delete(schema.rides)
    .where(
      and(
        eq(schema.rides.userId, userId),
        eq(schema.rides.stravaActivityId, row.activityId),
        eq(schema.rides.source, "strava"),
      ),
    );
  await db
    .update(schema.rides)
    .set({ stravaActivityId: null })
    .where(
      and(
        eq(schema.rides.userId, userId),
        eq(schema.rides.stravaActivityId, row.activityId),
        ne(schema.rides.id, rideIdToLink),
      ),
    );
  await db
    .update(schema.rides)
    .set({ stravaActivityId: row.activityId, name: row.name, updatedAt: new Date() })
    .where(and(eq(schema.rides.userId, userId), eq(schema.rides.id, rideIdToLink)));
}

async function setState(row: QueueRow, state: string, error: string | null = null, attempts = row.attempts) {
  await db
    .update(schema.stravaActivities)
    .set({ state, error, attempts, updatedAt: new Date() })
    .where(
      and(
        eq(schema.stravaActivities.userId, row.userId),
        eq(schema.stravaActivities.activityId, row.activityId),
      ),
    );
}

/**
 * Import one queued activity and record what happened.
 *
 * Rate limits and auth failures propagate — they stop the whole batch, and the
 * activity stays pending for the next one. Anything else is that activity's
 * problem and is retried a few times on later runs.
 */
async function processRow(client: StravaClient, settings: RiderSettings, row: QueueRow) {
  try {
    await setState(row, await importActivity(client, settings, row));
  } catch (e) {
    if (e instanceof RateLimitedError || e instanceof StravaAuthError) throw e;
    if (e instanceof NotFoundError) return setState(row, "skipped", "no longer on Strava");
    const attempts = row.attempts + 1;
    const reason = e instanceof Error ? e.message : String(e);
    await setState(row, attempts >= MAX_ATTEMPTS ? "failed" : "retry", reason, attempts);
  }
}

async function processQueue(client: StravaClient, settings: RiderSettings, deadline: number) {
  while (Date.now() < deadline) {
    const rows = await db
      .select()
      .from(schema.stravaActivities)
      .where(
        and(
          eq(schema.stravaActivities.userId, client.userId),
          eq(schema.stravaActivities.state, "pending"),
        ),
      )
      // New rides first, then the history oldest-first.
      .orderBy(desc(schema.stravaActivities.priority), asc(schema.stravaActivities.startedAt))
      .limit(10);
    if (rows.length === 0) return;
    for (const row of rows) {
      if (Date.now() >= deadline) return;
      await processRow(client, settings, row);
    }
  }
}

// ---------------------------------------------------------------------------
// Batches
// ---------------------------------------------------------------------------

export interface StravaProgress {
  athleteId: number;
  listComplete: boolean;
  /** Cycling activities found on Strava. */
  rides: number;
  /** Of those, settled: imported, linked to a file, or given up on. */
  done: number;
  imported: number;
  linked: number;
  failed: number;
  /** Not cycling, or nothing analysable in it. */
  skipped: number;
  pausedUntil: string | null;
  lastRunAt: string | null;
  error?: string;
}

export async function getProgress(userId: string): Promise<StravaProgress | null> {
  const connection = await getConnection(userId);
  if (!connection) return null;
  const counts = await db
    .select({ state: schema.stravaActivities.state, n: sql<number>`count(*)::int` })
    .from(schema.stravaActivities)
    .where(eq(schema.stravaActivities.userId, userId))
    .groupBy(schema.stravaActivities.state);
  const of = (state: string) => counts.find((c) => c.state === state)?.n ?? 0;
  const imported = of("imported");
  const linked = of("linked");
  const failed = of("failed");
  const done = imported + linked + failed;
  return {
    athleteId: connection.athleteId,
    listComplete: connection.listComplete,
    rides: done + of("pending") + of("retry"),
    done,
    imported,
    linked,
    failed,
    skipped: of("skipped"),
    pausedUntil: connection.pausedUntil?.toISOString() ?? null,
    lastRunAt: connection.lastRunAt?.toISOString() ?? null,
  };
}

/**
 * List what is new, continue the backfill, and import until the deadline or
 * the read budget runs out — whichever comes first.
 */
export async function runBatch(userId: string, budgetMs: number): Promise<StravaProgress | null> {
  const deadline = Date.now() + budgetMs;
  const connection = await getConnection(userId);
  if (!connection) return null;

  const now = new Date();
  if (connection.pausedUntil && connection.pausedUntil > now) return getProgress(userId);

  const client = new StravaClient(connection);
  const settings = await loadRiderSettings(userId);
  let error: string | undefined;
  let pausedUntil: Date | null = null;

  try {
    if (connection.listComplete) await listRecent(client, userId);
    else await listHistory(client, connection, deadline);
    await processQueue(client, settings, deadline);
  } catch (e) {
    if (e instanceof RateLimitedError) pausedUntil = e.until;
    else error = e instanceof Error ? e.message : String(e);
  }

  await db
    .update(schema.stravaConnections)
    .set({ pausedUntil, lastRunAt: new Date(), updatedAt: new Date() })
    .where(eq(schema.stravaConnections.userId, userId));

  const progress = await getProgress(userId);
  return progress && error ? { ...progress, error } : progress;
}

/** The daily job: give transient failures another go, then run a batch. */
export async function runDaily(budgetMs: number): Promise<{ userId: string; progress: StravaProgress | null }[]> {
  await db
    .update(schema.stravaActivities)
    .set({ state: "pending" })
    .where(eq(schema.stravaActivities.state, "retry"));

  const connections = await db.select().from(schema.stravaConnections);
  const share = budgetMs / Math.max(1, connections.length);
  const results = [];
  for (const c of connections) {
    results.push({ userId: c.userId, progress: await runBatch(c.userId, share) });
  }
  return results;
}

// ---------------------------------------------------------------------------
// Webhook events
// ---------------------------------------------------------------------------

export interface StravaEvent {
  object_type: "activity" | "athlete";
  object_id: number;
  aspect_type: "create" | "update" | "delete";
  owner_id: number;
  subscription_id: number;
  event_time: number;
  updates?: Record<string, string>;
}

/**
 * Act on one webhook event.
 *
 * Events carry ids only, so a create costs a request to fetch the activity and
 * one for its streams. Renames do not: the new title is in the event.
 */
export async function handleEvent(event: StravaEvent): Promise<void> {
  const [connection] = await db
    .select()
    .from(schema.stravaConnections)
    .where(eq(schema.stravaConnections.athleteId, event.owner_id))
    .limit(1);
  if (!connection) return;
  const userId = connection.userId;

  if (event.object_type === "athlete") {
    if (event.updates?.authorized === "false") await forgetConnection(userId);
    return;
  }

  const activityId = event.object_id;

  if (event.aspect_type === "delete") {
    await removeStravaCopy(userId, activityId);
    // A file ride survives, but its link would now lead nowhere.
    await db
      .update(schema.rides)
      .set({ stravaActivityId: null, updatedAt: new Date() })
      .where(and(eq(schema.rides.userId, userId), eq(schema.rides.stravaActivityId, activityId)));
    await db
      .delete(schema.stravaActivities)
      .where(
        and(
          eq(schema.stravaActivities.userId, userId),
          eq(schema.stravaActivities.activityId, activityId),
        ),
      );
    return;
  }

  const client = new StravaClient(connection);

  if (event.aspect_type === "update" && event.updates && !("type" in event.updates)) {
    const title = event.updates.title;
    if (title !== undefined) await rename(userId, activityId, title);
    return;
  }

  // A create, or a change of type. Either way the activity's sport has to be
  // read fresh, and the outcome decided again.
  const activity = await client.getActivity(activityId);
  await recordActivities(userId, [activity], 1);
  await rename(userId, activityId, activity.name);

  if (!isCycling(sportFromStrava(activity.sport_type))) {
    await removeStravaCopy(userId, activityId);
    return;
  }

  const [row] = await db
    .select()
    .from(schema.stravaActivities)
    .where(
      and(
        eq(schema.stravaActivities.userId, userId),
        eq(schema.stravaActivities.activityId, activityId),
      ),
    )
    .limit(1);
  if (!row || row.state === "imported" || row.state === "linked") return;

  try {
    await processRow(client, await loadRiderSettings(userId), { ...row, state: "pending" });
  } catch (e) {
    // Left pending; the daily job or the button picks it up.
    if (e instanceof RateLimitedError) return;
    throw e;
  }
}

async function rename(userId: string, activityId: number, name: string) {
  await db
    .update(schema.rides)
    .set({ name, updatedAt: new Date() })
    .where(and(eq(schema.rides.userId, userId), eq(schema.rides.stravaActivityId, activityId)));
}

/**
 * Remove a ride that came from Strava. Only ever a Strava copy: nothing that
 * happens on Strava may destroy a ride imported from a file.
 */
async function removeStravaCopy(userId: string, activityId: number) {
  await db
    .delete(schema.rides)
    .where(
      and(
        eq(schema.rides.userId, userId),
        eq(schema.rides.stravaActivityId, activityId),
        eq(schema.rides.source, "strava"),
      ),
    );
  await db
    .update(schema.stravaActivities)
    .set({ state: "skipped", updatedAt: new Date() })
    .where(
      and(
        eq(schema.stravaActivities.userId, userId),
        eq(schema.stravaActivities.activityId, activityId),
        inArray(schema.stravaActivities.state, ["pending", "retry", "imported"]),
      ),
    );
}
