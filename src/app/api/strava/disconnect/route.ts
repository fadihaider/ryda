import { requireUser } from "@/lib/auth";
import { revoke } from "@/lib/strava/api";
import { forgetConnection, getConnection } from "@/lib/strava/sync";

/** Revoke Strava's tokens and stop syncing. Imported rides are kept. */
export async function POST(request: Request) {
  const user = await requireUser(request);
  if (!user) return Response.json({ error: "sign in first" }, { status: 401 });

  const connection = await getConnection(user.id);
  if (connection) {
    // Best effort: forgetting locally matters more than Strava hearing about it.
    await revoke(connection.accessToken).catch(() => undefined);
    await forgetConnection(user.id);
  }
  return Response.json({ disconnected: true });
}
