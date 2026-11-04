import { eq } from "drizzle-orm";
import { db, schema } from "@/db";
import { nextUtcMidnight, nextWindow, parsePair } from "./rate-limit";
import {
  STREAM_KEYS,
  type StravaStreamSet,
  type StravaSummaryActivity,
} from "./convert";

/**
 * The Strava API, as this app uses it.
 *
 * Reads are rate limited per application: 100 per 15 minutes and 1,000 per day
 * by default (developers.strava.com/docs/rate-limits). Every response reports
 * usage in `X-ReadRateLimit-Usage`, so the client stops itself a little short
 * of the limit rather than discovering it through a 429 — a 429 still counts.
 */

const API = "https://www.strava.com/api/v3";
const OAUTH = "https://www.strava.com/oauth";

/** Requests left unspent in each window, for the webhook path and the button. */
const RESERVE_PER_WINDOW = 5;
const RESERVE_PER_DAY = 20;
/** Refresh this long before expiry, so a token never lapses mid-batch. */
const REFRESH_MARGIN_MS = 5 * 60_000;

export const SCOPES = "read,activity:read_all";

/** Holds the OAuth state between /connect and /callback. */
export const STATE_COOKIE = "ryda_strava_state";

export function stravaCredentials(): { clientId: string; clientSecret: string } {
  const clientId = process.env.STRAVA_CLIENT_ID;
  const clientSecret = process.env.STRAVA_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    throw new Error(
      "STRAVA_CLIENT_ID and STRAVA_CLIENT_SECRET are not set. Add them from strava.com/settings/api.",
    );
  }
  return { clientId, clientSecret };
}

export function authorizeUrl(redirectUri: string, state: string): string {
  const { clientId } = stravaCredentials();
  const url = new URL(`${OAUTH}/authorize`);
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("approval_prompt", "auto");
  url.searchParams.set("scope", SCOPES);
  url.searchParams.set("state", state);
  return url.toString();
}

export interface TokenResponse {
  access_token: string;
  refresh_token: string;
  /** Epoch seconds. */
  expires_at: number;
  scope?: string;
  athlete?: { id: number };
}

async function tokenRequest(params: Record<string, string>): Promise<TokenResponse> {
  const { clientId, clientSecret } = stravaCredentials();
  const res = await fetch(`${OAUTH}/token`, {
    method: "POST",
    body: new URLSearchParams({ client_id: clientId, client_secret: clientSecret, ...params }),
  });
  if (!res.ok) throw new StravaAuthError(`token request failed (${res.status})`);
  return (await res.json()) as TokenResponse;
}

export function exchangeCode(code: string): Promise<TokenResponse> {
  return tokenRequest({ code, grant_type: "authorization_code" });
}

/** Revoke every token this app holds for the athlete. Best effort. */
export async function revoke(accessToken: string): Promise<void> {
  const { clientId, clientSecret } = stravaCredentials();
  await fetch(`${OAUTH}/revoke`, {
    method: "POST",
    headers: {
      authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString("base64")}`,
    },
    body: new URLSearchParams({ token: accessToken }),
  });
}

export class StravaAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StravaAuthError";
  }
}

export class RateLimitedError extends Error {
  constructor(readonly until: Date) {
    super(`Strava read limit reached; resumes ${until.toISOString()}`);
    this.name = "RateLimitedError";
  }
}

export class NotFoundError extends Error {
  constructor(path: string) {
    super(`not found on Strava: ${path}`);
    this.name = "NotFoundError";
  }
}

type Connection = typeof schema.stravaConnections.$inferSelect;

/**
 * One rider's authenticated client.
 *
 * Holds the connection row so a refreshed token is written straight back:
 * Strava invalidates the old refresh token the moment it issues a new one, so
 * a refresh that is not persisted disconnects the rider at the next one.
 */
export class StravaClient {
  private exhaustedUntil: Date | null = null;

  constructor(private connection: Connection) {}

  get userId(): string {
    return this.connection.userId;
  }

  private async token(): Promise<string> {
    if (this.connection.expiresAt.getTime() - Date.now() > REFRESH_MARGIN_MS) {
      return this.connection.accessToken;
    }
    const fresh = await tokenRequest({
      grant_type: "refresh_token",
      refresh_token: this.connection.refreshToken,
    });
    const values = {
      accessToken: fresh.access_token,
      refreshToken: fresh.refresh_token,
      expiresAt: new Date(fresh.expires_at * 1000),
      updatedAt: new Date(),
    };
    await db
      .update(schema.stravaConnections)
      .set(values)
      .where(eq(schema.stravaConnections.userId, this.connection.userId));
    this.connection = { ...this.connection, ...values };
    return fresh.access_token;
  }

  private async get<T>(path: string, params: Record<string, string> = {}): Promise<T> {
    if (this.exhaustedUntil && this.exhaustedUntil > new Date()) {
      throw new RateLimitedError(this.exhaustedUntil);
    }
    const url = new URL(`${API}${path}`);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);

    const res = await fetch(url, {
      headers: { authorization: `Bearer ${await this.token()}` },
    });
    this.noteUsage(res);

    if (res.status === 429) throw new RateLimitedError(this.exhaustedUntil ?? nextWindow(new Date()));
    if (res.status === 401) throw new StravaAuthError("Strava rejected the token (401)");
    if (res.status === 404) throw new NotFoundError(path);
    if (!res.ok) throw new Error(`Strava said ${res.status} for ${path}`);
    return (await res.json()) as T;
  }

  private noteUsage(res: Response): void {
    const usage = parsePair(res.headers.get("x-readratelimit-usage"));
    const limit = parsePair(res.headers.get("x-readratelimit-limit"));
    if (!usage || !limit) return;
    const now = new Date();
    if (usage[1] >= limit[1] - RESERVE_PER_DAY) this.exhaustedUntil = nextUtcMidnight(now);
    else if (usage[0] >= limit[0] - RESERVE_PER_WINDOW) this.exhaustedUntil = nextWindow(now);
  }

  /** One page of the athlete's activities. */
  listActivities(params: { page?: number; after?: number; perPage?: number }) {
    const query: Record<string, string> = { per_page: String(params.perPage ?? 200) };
    if (params.page) query.page = String(params.page);
    if (params.after) query.after = String(params.after);
    return this.get<StravaSummaryActivity[]>("/athlete/activities", query);
  }

  getActivity(id: number) {
    return this.get<StravaSummaryActivity>(`/activities/${id}`);
  }

  getStreams(id: number) {
    return this.get<StravaStreamSet>(`/activities/${id}/streams`, {
      keys: STREAM_KEYS.join(","),
      key_by_type: "true",
    });
  }
}
