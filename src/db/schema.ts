import {
  bigint,
  boolean,
  customType,
  doublePrecision,
  index,
  integer,
  jsonb,
  foreignKey,
  pgTable,
  primaryKey,
  real,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";

/**
 * Schema.
 *
 * Deliberately mirrors the local IndexedDB store, because the device copy stays
 * authoritative for a rider's own data and this is a sync target rather than a
 * replacement. Same split too: a small summary row per ride, and sample streams
 * in a separate table so listing a season never deserialises millions of points.
 */

/** Postgres bytea <-> Uint8Array, so typed arrays round-trip without JSON. */
const bytea = customType<{ data: Uint8Array; driverData: Buffer }>({
  dataType: () => "bytea",
  toDriver: (value) => Buffer.from(value),
  fromDriver: (value) => new Uint8Array(value),
});

// ---------------------------------------------------------------------------
// Better Auth tables. Names and columns are fixed by its Drizzle adapter.
// ---------------------------------------------------------------------------

export const user = pgTable("user", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  email: text("email").notNull().unique(),
  emailVerified: boolean("email_verified").notNull().default(false),
  image: text("image"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export const session = pgTable("session", {
  id: text("id").primaryKey(),
  expiresAt: timestamp("expires_at").notNull(),
  token: text("token").notNull().unique(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
  ipAddress: text("ip_address"),
  userAgent: text("user_agent"),
  userId: text("user_id")
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),
});

export const account = pgTable("account", {
  id: text("id").primaryKey(),
  accountId: text("account_id").notNull(),
  providerId: text("provider_id").notNull(),
  userId: text("user_id")
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),
  accessToken: text("access_token"),
  refreshToken: text("refresh_token"),
  idToken: text("id_token"),
  accessTokenExpiresAt: timestamp("access_token_expires_at"),
  refreshTokenExpiresAt: timestamp("refresh_token_expires_at"),
  scope: text("scope"),
  password: text("password"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export const verification = pgTable("verification", {
  id: text("id").primaryKey(),
  identifier: text("identifier").notNull(),
  value: text("value").notNull(),
  expiresAt: timestamp("expires_at").notNull(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

// ---------------------------------------------------------------------------
// Application tables
// ---------------------------------------------------------------------------

export const riderSettings = pgTable("rider_settings", {
  userId: text("user_id")
    .primaryKey()
    .references(() => user.id, { onDelete: "cascade" }),
  riderKg: real("rider_kg").notNull(),
  bikeKg: real("bike_kg").notNull(),
  positionId: text("position_id").notNull(),
  surfaceId: text("surface_id").notNull(),
  ftp: integer("ftp").notNull(),
  /** Lactate threshold heart rate, bpm. Zero means the rider has not set one,
   *  and heart-rate zones stay hidden rather than being anchored on a guess. */
  lthr: integer("lthr").notNull().default(0),
  configured: boolean("configured").notNull().default(false),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export const rides = pgTable(
  "rides",
  {
    /**
     * Derived from start minute and duration, so re-importing the same file is
     * idempotent. NOT unique on its own: two friends riding together start
     * within the same minute and finish the same route, so their ids collide.
     * The primary key is (userId, id) for that reason — with `id` alone, the
     * second upload silently reassigned the first rider's ride to the second
     * account and the first lost it.
     */
    id: text("id").notNull(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),

    name: text("name").notNull(),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull(),
    /** Local calendar day. The training-load calendar joins on this, and it
     *  must be the rider's local date rather than UTC — an evening ride would
     *  otherwise land on tomorrow and shift the whole curve. */
    localDate: text("local_date").notNull(),
    sport: text("sport").notNull().default("cycling"),

    sampleCount: integer("sample_count").notNull(),
    altitudeSource: text("altitude_source").notNull(),
    /** True when speed was integrated from positions rather than measured.
     *  The estimator smooths derived speed far harder, so losing this on a
     *  round trip would quietly reintroduce a device-dependent bias in every
     *  synced ride. */
    speedIsDerived: boolean("speed_is_derived").notNull().default(false),
    hasMeasuredPower: boolean("has_measured_power").notNull().default(false),
    devices: jsonb("devices").$type<string[]>().notNull().default([]),

    durationSeconds: integer("duration_seconds").notNull(),
    movingSeconds: integer("moving_seconds").notNull(),
    distanceMeters: doublePrecision("distance_meters").notNull(),
    elevationGainMeters: doublePrecision("elevation_gain_meters").notNull(),

    meanPower: real("mean_power").notNull(),
    weightedPower: real("weighted_power").notNull(),
    load: real("load").notNull(),
    meanHeartRate: real("mean_heart_rate"),
    /** Calories the recording device computed, when the file carried one.
     *  Null means nothing was recorded and the figure has to be derived from
     *  mechanical work — a different and consistently smaller quantity. */
    reportedCalories: real("reported_calories"),
    decouplingPercent: real("decoupling_percent"),
    confidence: text("confidence").notNull(),

    /** Pathname of the original file in the private Blob store, when kept. */
    blobPath: text("blob_path"),

    /**
     * Where the samples came from: "file" for an imported .fit/.gpx/.tcx,
     * "strava" for streams fetched from the Strava API.
     *
     * The file always wins. A head unit's file carries its own barometric
     * altitude and true 1 Hz sampling; the API returns Strava's rendering of
     * it. So a Strava-sourced ride is replaced the moment the file arrives,
     * and nothing Strava does — an edit, a delete — may destroy a file ride.
     */
    source: text("source").notNull().default("file"),
    /** The Strava activity this ride corresponds to, whichever source supplied
     *  the samples. Drives "View on Strava" and lets renames and deletes find
     *  the ride. */
    stravaActivityId: bigint("strava_activity_id", { mode: "number" }),

    importedAt: timestamp("imported_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.userId, t.id] }),
    // The library and trend both read a user's rides newest-first.
    index("rides_user_started_idx").on(t.userId, t.startedAt),
    index("rides_user_date_idx").on(t.userId, t.localDate),
    uniqueIndex("rides_user_strava_idx").on(t.userId, t.stravaActivityId),
  ],
);

/**
 * Sample streams, one row per ride.
 *
 * Each channel is a raw typed-array buffer rather than a row per sample. A
 * three-hour ride is ~11k samples across eight channels; row-per-sample would
 * exhaust Neon's 0.5 GB free tier within a season and make every read a join
 * over millions of rows.
 */
export const rideStreams = pgTable(
  "ride_streams",
  {
  rideId: text("ride_id").notNull(),
  userId: text("user_id")
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),
  sampleCount: integer("sample_count").notNull(),

  time: bytea("time").notNull(),
  distance: bytea("distance").notNull(),
  altitude: bytea("altitude").notNull(),
  latlng: bytea("latlng"),
  speed: bytea("speed"),
  heartrate: bytea("heartrate"),
  cadence: bytea("cadence"),
  power: bytea("power"),
  temperature: bytea("temperature"),
  paused: bytea("paused"),
  },
  (t) => [
    primaryKey({ columns: [t.userId, t.rideId] }),
    foreignKey({
      columns: [t.userId, t.rideId],
      foreignColumns: [rides.userId, rides.id],
    }).onDelete("cascade"),
  ],
);

/**
 * Read-only share links.
 *
 * A token rather than a guessable id, and revocable, because sharing a ride
 * means sharing a GPS trace of where someone lives.
 */
export const shareLinks = pgTable(
  "share_links",
  {
    token: text("token").primaryKey(),
    rideId: text("ride_id").notNull(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    /** Trim the start and end of the trace, so home doesn't ship with the link. */
    privacyRadiusMeters: integer("privacy_radius_meters").notNull().default(0),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    expiresAt: timestamp("expires_at"),
    revokedAt: timestamp("revoked_at"),
  },
  (t) => [
    index("share_links_ride_idx").on(t.rideId),
    foreignKey({
      columns: [t.userId, t.rideId],
      foreignColumns: [rides.userId, rides.id],
    }).onDelete("cascade"),
  ],
);

// ---------------------------------------------------------------------------
// Strava
// ---------------------------------------------------------------------------

/**
 * One rider's Strava authorisation.
 *
 * Tokens are stored as Strava issues them. Refreshing returns a new refresh
 * token and invalidates the old one immediately, so the row must be rewritten
 * on every refresh or the connection is lost at the next one.
 */
export const stravaConnections = pgTable("strava_connections", {
  userId: text("user_id")
    .primaryKey()
    .references(() => user.id, { onDelete: "cascade" }),
  athleteId: bigint("athlete_id", { mode: "number" }).notNull().unique(),
  accessToken: text("access_token").notNull(),
  refreshToken: text("refresh_token").notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  scope: text("scope").notNull(),
  /** Next page of the athlete's activity list to read during backfill. */
  listPage: integer("list_page").notNull().default(1),
  /** True once the whole history has been listed (not necessarily imported). */
  listComplete: boolean("list_complete").notNull().default(false),
  /** Set after a 429 or when the read budget is spent; work waits until then. */
  pausedUntil: timestamp("paused_until", { withTimezone: true }),
  lastRunAt: timestamp("last_run_at", { withTimezone: true }),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

/**
 * Every Strava activity seen for a rider, and what became of it.
 *
 * Listing is cheap — two hundred activities per request — and fetching streams
 * is one request per ride, so the history is listed in full first and this
 * table becomes the work queue. It is also what makes progress reportable as
 * "312 of 540" rather than a spinner.
 *
 * state: pending | imported | linked (a file ride already covered it) |
 *        skipped (not cycling, or nothing analysable) | failed
 */
export const stravaActivities = pgTable(
  "strava_activities",
  {
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    activityId: bigint("activity_id", { mode: "number" }).notNull(),
    name: text("name").notNull(),
    sportType: text("sport_type").notNull(),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull(),
    /** Strava's local wall-clock date, YYYY-MM-DD. */
    localDate: text("local_date").notNull(),
    elapsedSeconds: integer("elapsed_seconds").notNull(),
    deviceName: text("device_name"),
    /** From a power meter, rather than Strava's own estimate. */
    deviceWatts: boolean("device_watts").notNull().default(false),
    /** New rides jump the backfill queue, so today's ride is not stuck behind 2019. */
    priority: integer("priority").notNull().default(0),
    state: text("state").notNull().default("pending"),
    attempts: integer("attempts").notNull().default(0),
    error: text("error"),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.userId, t.activityId] }),
    index("strava_activities_queue_idx").on(t.userId, t.state, t.priority, t.startedAt),
  ],
);
