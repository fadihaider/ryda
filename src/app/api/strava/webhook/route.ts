import { after } from "next/server";
import { handleEvent, type StravaEvent } from "@/lib/strava/sync";

export const maxDuration = 60;

/**
 * Strava's push subscription callback.
 *
 * Strava wants a 200 within two seconds and retries up to three times, so the
 * response goes first and the work runs after it. Events are not signed; what
 * makes a forged one harmless is that it only ever causes a fetch of the real
 * activity, with the rider's own token, from Strava itself.
 */

/** Subscription validation: echo the challenge if the verify token matches. */
export async function GET(request: Request) {
  const params = new URL(request.url).searchParams;
  const expected = process.env.STRAVA_VERIFY_TOKEN;
  if (
    !expected ||
    params.get("hub.mode") !== "subscribe" ||
    params.get("hub.verify_token") !== expected
  ) {
    return Response.json({ error: "verify token mismatch" }, { status: 403 });
  }
  return Response.json({ "hub.challenge": params.get("hub.challenge") });
}

export async function POST(request: Request) {
  let event: StravaEvent;
  try {
    event = (await request.json()) as StravaEvent;
  } catch {
    return Response.json({ error: "body must be JSON" }, { status: 400 });
  }

  const subscription = process.env.STRAVA_SUBSCRIPTION_ID;
  if (subscription && String(event.subscription_id) !== subscription) {
    return Response.json({ ignored: true });
  }

  after(async () => {
    try {
      await handleEvent(event);
    } catch (e) {
      // The daily job re-lists recent activities, so a failure here delays a
      // ride by a day at most. Logged so it is visible in the function logs.
      console.error("strava webhook event failed", event, e);
    }
  });
  return Response.json({ received: true });
}
