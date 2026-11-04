import { randomBytes } from "node:crypto";
import { requireUser } from "@/lib/auth";
import { authorizeUrl, STATE_COOKIE } from "@/lib/strava/api";

/**
 * Start the Strava authorisation.
 *
 * The state value round-trips through a short-lived cookie, so a callback can
 * only complete an authorisation this browser started.
 */
export async function GET(request: Request) {
  const origin = new URL(request.url).origin;
  const user = await requireUser(request);
  if (!user) return Response.redirect(`${origin}/account`, 303);

  const state = randomBytes(16).toString("hex");
  const secure = process.env.NODE_ENV === "production" ? "; Secure" : "";
  return new Response(null, {
    status: 303,
    headers: {
      location: authorizeUrl(`${origin}/api/strava/callback`, state),
      "set-cookie": `${STATE_COOKIE}=${state}; Path=/api/strava; Max-Age=600; HttpOnly; SameSite=Lax${secure}`,
    },
  });
}
