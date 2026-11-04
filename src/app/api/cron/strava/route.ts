import { runDaily } from "@/lib/strava/sync";

export const maxDuration = 300;

/**
 * The daily safety net: picks up anything the webhook missed and continues the
 * history backfill. Vercel sends CRON_SECRET as a bearer token.
 */
export async function GET(request: Request) {
  const secret = process.env.CRON_SECRET;
  if (!secret || request.headers.get("authorization") !== `Bearer ${secret}`) {
    return new Response("Unauthorized", { status: 401 });
  }
  const results = await runDaily(270_000);
  return Response.json({ results });
}
