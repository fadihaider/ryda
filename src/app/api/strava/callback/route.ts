import { after } from "next/server";
import { requireUser } from "@/lib/auth";
import { exchangeCode, STATE_COOKIE } from "@/lib/strava/api";
import { runBatch, saveConnection } from "@/lib/strava/sync";

export const maxDuration = 60;

/** Where Strava sends the rider back, with a code to exchange for tokens. */
export async function GET(request: Request) {
  const url = new URL(request.url);
  const back = (outcome: string) =>
    new Response(null, {
      status: 303,
      headers: {
        location: `${url.origin}/account?strava=${encodeURIComponent(outcome)}`,
        "set-cookie": `${STATE_COOKIE}=; Path=/api/strava; Max-Age=0`,
      },
    });

  const user = await requireUser(request);
  if (!user) return back("signed-out");

  const expected = request.headers
    .get("cookie")
    ?.split(/;\s*/)
    .find((c) => c.startsWith(`${STATE_COOKIE}=`))
    ?.slice(STATE_COOKIE.length + 1);
  if (!expected || url.searchParams.get("state") !== expected) return back("state-mismatch");

  if (url.searchParams.get("error")) return back("denied");
  const code = url.searchParams.get("code");
  if (!code) return back("no-code");

  // The rider can untick scopes on Strava's consent screen. Without
  // activity:read there is nothing to sync at all.
  const granted = url.searchParams.get("scope") ?? "";
  if (!granted.split(",").some((s) => s === "activity:read" || s === "activity:read_all")) {
    return back("scope-missing");
  }

  try {
    await saveConnection(user.id, await exchangeCode(code));
  } catch {
    return back("exchange-failed");
  }

  // Start listing the history straight away rather than waiting for the
  // nightly job; the account page shows progress as it lands.
  after(() => runBatch(user.id, 50_000));
  return back("connected");
}
