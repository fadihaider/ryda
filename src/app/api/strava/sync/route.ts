import { requireUser } from "@/lib/auth";
import { runBatch } from "@/lib/strava/sync";

export const maxDuration = 60;

/**
 * Run one batch now: list anything new, continue the backfill, import.
 *
 * Bounded well inside maxDuration. The account page calls this repeatedly
 * while it is open, so a long history moves faster than the nightly job alone.
 */
export async function POST(request: Request) {
  const user = await requireUser(request);
  if (!user) return Response.json({ error: "sign in first" }, { status: 401 });

  const progress = await runBatch(user.id, 45_000);
  if (!progress) return Response.json({ error: "Strava is not connected" }, { status: 404 });
  return Response.json({ progress });
}
