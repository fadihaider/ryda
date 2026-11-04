import { requireUser } from "@/lib/auth";
import { getProgress } from "@/lib/strava/sync";

export async function GET(request: Request) {
  const user = await requireUser(request);
  if (!user) return Response.json({ error: "sign in first" }, { status: 401 });

  const configured = Boolean(process.env.STRAVA_CLIENT_ID && process.env.STRAVA_CLIENT_SECRET);
  const progress = configured ? await getProgress(user.id) : null;
  return Response.json({ configured, connected: progress !== null, progress });
}
