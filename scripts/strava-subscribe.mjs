#!/usr/bin/env node
/**
 * Manage the Strava webhook subscription.
 *
 * Strava allows one push subscription per application, created once, pointing
 * at the deployed webhook route. Creating it makes Strava call the route with a
 * challenge first, so the deployment must already have STRAVA_VERIFY_TOKEN.
 *
 *   node --env-file=.env.local scripts/strava-subscribe.mjs https://ryda-nine.vercel.app
 *   node --env-file=.env.local scripts/strava-subscribe.mjs --list
 *   node --env-file=.env.local scripts/strava-subscribe.mjs --delete <id>
 *
 * The id printed on creation goes into STRAVA_SUBSCRIPTION_ID, so the webhook
 * ignores events that do not name it.
 */

const ENDPOINT = "https://www.strava.com/api/v3/push_subscriptions";

const { STRAVA_CLIENT_ID: clientId, STRAVA_CLIENT_SECRET: clientSecret, STRAVA_VERIFY_TOKEN: verifyToken } =
  process.env;
if (!clientId || !clientSecret) {
  console.error("STRAVA_CLIENT_ID and STRAVA_CLIENT_SECRET must be set.");
  process.exit(1);
}

const [arg, value] = process.argv.slice(2);
const auth = new URLSearchParams({ client_id: clientId, client_secret: clientSecret });

async function report(res) {
  const text = await res.text();
  console.log(res.status, text || "(no body)");
  if (!res.ok) process.exit(1);
}

if (arg === "--list") {
  await report(await fetch(`${ENDPOINT}?${auth}`));
} else if (arg === "--delete" && value) {
  await report(await fetch(`${ENDPOINT}/${value}?${auth}`, { method: "DELETE" }));
} else if (arg?.startsWith("https://")) {
  if (!verifyToken) {
    console.error("STRAVA_VERIFY_TOKEN must be set, and match the deployment's.");
    process.exit(1);
  }
  const body = new URLSearchParams(auth);
  body.set("callback_url", `${arg.replace(/\/$/, "")}/api/strava/webhook`);
  body.set("verify_token", verifyToken);
  await report(await fetch(ENDPOINT, { method: "POST", body }));
} else {
  console.error("usage: strava-subscribe.mjs <https://origin> | --list | --delete <id>");
  process.exit(1);
}
