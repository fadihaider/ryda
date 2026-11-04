# Ryda

Ride analysis for people without a power meter.

Strava is where the rides live and where the social layer is. Ryda is the analysis
layer that should sit on top of them: estimated power modelled from physics,
training load that survives scrutiny, a route you can scrub, and a fitness curve
built from your whole history.

It reads your files, and it syncs from the Strava API. The API sync breaks
Strava's API Policy, and that was decided knowingly for a private, single-user
deployment — see [Strava: files, and the API](#strava-files-and-the-api).

---

## Status

**Working**

- Import `.fit`, `.gpx` and `.tcx`, gzipped or not, straight from a Strava bulk export
- Strava sync on the server — a webhook for new rides, a daily job and an account-page button for the history backfill. A file always replaces Strava's copy of the same ride
- Ride screen — route map coloured by any channel, synchronised charts, scrub, drag-select a range and every statistic recomputes for it
- Time in power and heart-rate zones, and a W′ balance trace
- Library — bulk import, deduplication, delete, recompute
- Trend — fitness / fatigue / form, ramp rate, consistency
- Power — mean-maximal curve, best efforts, FTP estimate, critical power and W′
- Accounts, and two-way sync between the browser and Postgres
- A JSON API with bearer-token auth, including a single-request summary endpoint for a native widget
- Light and dark themes

**Built but not wired up**

- Share links exist in the schema, not in the app.
- The private blob store is provisioned but no original files are kept in it — only the parsed streams are stored.
- Wind correction is implemented and tested but has no data source in the app; only `scripts/audit-power.ts` feeds it, from a Strava export's weather columns.

**Known to be wrong**

- The power model has no absolute calibration and cannot get one without a
  meter. It is now internally consistent — the same rider on the same roads
  scores the same regardless of which device recorded the ride — but the whole
  scale could still be off. See [Calibration](#calibration-the-open-problem).

---

## Getting started

Requires Node 20.9+ (developed on 26).

```bash
npm install
npm run dev
```

Open <http://localhost:3000> and drop a ride file on it. Nothing is uploaded —
parsing happens in your browser and rides are stored in IndexedDB on your device.

No environment variables are needed for the analysis features. `DATABASE_URL`
and `BETTER_AUTH_SECRET` are only required once sync and authentication are
wired up.

| script | |
|---|---|
| `npm run dev` | dev server |
| `npm test` | unit tests (118) |
| `npm run audit:power -- <strava-export-dir>` | cross-check the estimator against Strava's own |
| `npm run db:migrate` | apply migrations (reads `.env.local`) |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run build` | production build |
| `npm run shoot -- /power` | screenshot a route in both themes |
| `node scripts/capture.mjs /ride --upload ride.fit --wait mapIdle` | drive a real file through the real UI |
| `node scripts/inspect-fit.mjs ride.fit` | dump which fields a device actually writes |

---

## Strava: files, and the API

Ryda started file-only, because Strava's API Policy (effective 1 June 2026)
forbids what this app does with API data. It now also syncs from the API
anyway. This section records the decision and what it costs.

| clause | text | what the sync does |
|---|---|---|
| §6.2 | "You may not retain Strava Data in your cache for longer than seven (7) days." | Keeps rides permanently. |
| §5.5 | "You may not bulk-export Strava Data, including by accumulating Strava Data through repeated authorized API calls into a corpus, dataset, archive, or database…" | Backfills the whole history into Postgres. |
| §5.4 | "You may not process … Strava Data … for the purposes of analytics, analyses…" | It is an analysis app. |

A Strava subscription doesn't change any of this. It is a *requirement* for
Standard Tier API access (§3.3), not an exemption, and none of the clauses
above has a subscriber exception.

**Why do it anyway:** this is a private deployment for one rider, reading that
rider's own activities. **The risk:** Strava can revoke the application's API
access. If that happens, rides already stored stay, and the file path below
still works — the sync only adds to it.

**Files still win.** A `.fit` from a head unit carries barometric altitude, true
1 Hz sampling and cadence; the API returns Strava's rendering of it (its speed
is a smoothed series, labelled derived here). So:

- a ride imported from a file is never overwritten by Strava's copy, and
  importing the file later replaces the copy;
- nothing that happens on Strava — a delete, a retag to Walk — removes a file
  ride. Renames do carry over, and Strava's name is adopted when a file ride is
  first matched to its activity;
- matching is by start time and duration within two minutes, not by id, because
  the two sources round either side of a minute boundary often enough to matter.

The bulk export (§6.6: "Each Strava user has the right to access and export the
user's own Strava data, free of charge…") remains the policy-clean way in.

[intervals.icu](https://intervals.icu) was evaluated as an alternative source and
rejected on two counts, both from its author: it does not estimate power for
rides without a meter, and Strava-sourced activities are not served through its
API at all.

### How the sync runs

```
Strava ──webhook──▶ /api/strava/webhook ─┐
daily cron ───────▶ /api/cron/strava ────┼─▶ strava_activities (queue) ─▶ streams ─▶ rides + ride_streams
account page ─────▶ /api/strava/sync ────┘                                               │
                                                     browsers and the iOS app ◀── existing sync
```

Reads are capped at 100 per 15 minutes and 1,000 a day. Listing costs one
request per 200 activities and each ride costs one more for its streams, so the
history is listed in full first and `strava_activities` becomes the work queue.
Walks are settled at listing time and never cost a request. The client stops a
few requests short of each limit and records when it may resume; new rides jump
the backfill queue. The daily job (Hobby crons run once a day) does about 90
rides a night; the account page's button runs batches back to back while it is
open.

---

## The power model

No power meter, so power is modelled:

```
P = (1/η) · [ m·g·(sinθ + Crr·cosθ) + ½·ρ·CdA·(v + w)² + m_eff·a ] · v
```

Grade error dominates everything else — GPS altitude carries roughly 2.6% RMSE
against 0.5% for barometric, and at 80 kg and 8 m/s a 2.6% error in grade is
~163 W of power that does not exist. So elevation is smoothed with a
Savitzky-Golay filter *before* differentiation, and grade is computed over a
distance window rather than a time window (a time window divides by zero when
you stop).

Things this does that a naive estimator does not:

- **Coasting is detected from force balance.** A bike is freewheeling when the
  resistive forces alone account for its motion. Reading it off the cadence
  channel instead is worse than it sounds: checked against physics, a real head
  unit's cadence zeros matched freewheeling exactly on descents (measured
  −0.034 vs predicted −0.023 m/s²) and not at all on the flat (−0.056 measured
  where a freewheeling bike must lose 0.197). The sensor was dropping out while
  the rider pedalled on, and believing it deleted 19% of that ride's mean power
  — on the two rides out of thirteen that had a sensor paired at all.
- **Stopped time is excluded from every average.** A head unit with auto-pause
  stops writing records; a phone records straight through the red light. Both
  riders are sitting still. Deciding from the pause flag alone made average
  power 8–13% lower on the phone files, so the distance channel decides instead.
- **Wind is corrected for, when there is a source for it.** Drag is quadratic,
  so an out-and-back in wind costs strictly more than still air — at 8 m/s into
  a 3 m/s headwind drag is 1.9×, with it behind you 0.4×, and the mean of those
  is 1.15, not 1. Ignoring wind is not noise that cancels; it is a systematic
  under-estimate on windy days that reads as a bad day rather than a windy one.
  Headwind is resolved per sample from GPS heading, with the reported speed
  scaled from the 10 m anemometer down to rider height by the log wind profile.
- **Acceleration is differentiated over seven seconds, not one.** Over a ride
  starting and ending at rest, net kinetic work is zero — but negative power is
  clamped away, so symmetric noise in acceleration is a one-way ratchet that
  only adds watts. The size of that bias depends on how noisy the speed channel
  is, which is a property of the *device*, not the rider: the same rider on the
  same roads scored ~40% higher recording on a phone than on a head unit.
- **Physical bounds, not tuning knobs.** Speed above 30 m/s, acceleration above
  2.5 m/s², and estimated power above 2000 W are measurement errors and are
  treated as such.
- **Confidence is reported.** Wind and drafting cannot be recovered from a GPS
  trace, so every ride carries a confidence level and the reasons behind it.

**Estimated power is not reported below five minutes.** Short efforts are
dominated by the acceleration term and by fast descents — with no cadence sensor
there is no way to tell a sprint from freewheeling, and drag at 60 km/h computes
to ~850 W either way. On one real library that produced a "best 5 seconds" of
13.3 W/kg for a rider whose threshold is 1.9 W/kg. That number is not uncertain,
it is fictional, so it is not shown. With a real power meter the full curve
appears.

Expect roughly ±30–40 W even in good conditions.

### Calibration, the open problem

The model is anchored on rider mass, drag area and rolling resistance, and only
mass is known with confidence. Without a meter there is no ground truth to fit
against, so the goal is not an absolutely correct number — it is a number that
means the same thing every ride, because a fitness curve is nothing but a
comparison between rides.

That is what `scripts/audit-power.ts` is for. It runs the estimator over a
Strava bulk export and puts the result beside Strava's own estimate, which is
derived from the same files by different code:

```bash
npm run audit:power -- ~/Downloads/export_XXXXXXX
```

The column that matters is **efficiency factor** — weighted power over average
heart rate. Heart rate does not care which device wrote the file, so for one
rider over a few weeks EF should be nearly flat, and whatever spread it shows is
the estimator's own inconsistency. Grouping that spread by how the file recorded
speed says whether the fault is in the rider's legs or in this code. On one real
library that gap was 16% between head-unit and phone recordings; it is 5% now.

The absolute scale is still open, and a single ride with a borrowed power meter
would close it by fitting CdA and Crr by least squares against measured watts.

---

## Metric names

The algorithms here are the published ones. The names are deliberately not.
"Normalized Power" (US reg. 4450847) and "Training Stress Score" are live
TrainingPeaks trademarks. The mathematics is free to implement; the names are
not. GoldenCheetah renamed its equivalent to *IsoPower* despite being GPL.

| computed | shipped as |
|---|---|
| 30 s rolling mean → 4th power → mean → 4th root | Weighted Power |
| Weighted Power ÷ FTP | Intensity |
| `hours × Intensity² × 100` | Load |
| 42-day and 7-day EWMA of Load, and their difference | Fitness / Fatigue / Form |

---

## Architecture

```
browser ──▶ parse (FIT / GPX / TCX)  ──▶ normalise to 1 Hz  ──▶ estimate power
                                                                     │
                                          IndexedDB ◀── metrics + mean-max curve
```

**Analysis runs on the device.** A ride file records where you live and when you
are away from home, so local-by-default is the correct posture — and it means
multi-ride analysis works with no backend, no account and no cost. An account is
additive: it keeps a copy on the server so a cleared browser does not lose a
season, and it is what a native app reads.

```
browser  ──push summary + streams──▶  Postgres  ──▶  GET /api/summary  ──▶  iOS widget
   ▲                                     │  ▲
   └──────────pull, then re-analyse──────┘  └── Strava sync (server-side)
```

Rides the server fetched from Strava are the server's to manage: a browser
never uploads one back, and drops its copy when the server no longer has it.

Rides pulled down are re-analysed locally rather than trusted from the wire: the
rider's mass and threshold live on the device, and the model itself changes.
Streams travel as base64 of their raw buffers, because 20,000 samples as JSON
text is roughly six times the bytes and parses one token at a time.

**Ride ids are only unique within an account.** An id is derived from start
minute and duration so that re-importing the same file is idempotent — which
means two friends who ride together collide. The primary key is `(userId, id)`
throughout; with `id` alone the second rider's upload silently reassigned the
first rider's ride to the second account.

Notable decisions:

- **Metrics are denormalised at import.** A season is tens of millions of
  samples; the library and trend never touch them.
- **Mean-maximal curves are cached per ride.** The season envelope is an
  element-wise max over ~1 KB arrays, not a re-scan of raw streams.
- **Sample channels are typed arrays**, stored as `bytea` in Postgres. One row
  per sample would exhaust Neon's free tier within a season.
- **Scrub position lives outside React.** Pointer moves update the map marker and
  chart readouts imperatively, so hovering a 7,000-sample ride does not re-render
  the tree.
- **Rides only.** Nearly half a real Strava export was walks, and bicycle physics
  applied to a walk produces a meaningless number that lands on the fitness
  curve. Non-cycling activities are rejected at import.

### Stack

Next.js 16 · MapLibre GL v6 with [OpenFreeMap](https://openfreemap.org) tiles
(no API key, no request cap) · uPlot · Drizzle + Neon · Better Auth · Vitest.

MapLibre v6 resolves its worker relative to `import.meta.url`, which after
bundling points inside `/_next/static/chunks/` — Next answers that 404 with HTML,
the module worker rejects the MIME type, and the map silently never loads.
`scripts/sync-maplibre-worker.mjs` copies the worker into `public/` and
`setWorkerUrl` points at it. That script runs on `postinstall`, `predev` and
`prebuild`.

---

## Testing

```bash
npm test
```

118 tests. The interesting ones are regressions pinning bugs that failed
*silently* and produced plausible numbers:

- Raw altitude summing reports 770 m of climbing on a ride with 22 m of relief
- Fitness must decay across a rest week (iterating activities instead of calendar days makes it only ever rise)
- Zero-mean speed jitter must not raise average power
- A GPS fix implying 350 kW must not reach the power curve
- Resuming after a pause must not invent a sprint

Tests that need a real ride file are skipped when absent — ride files are
gitignored, since a GPS trace is a home address.

---

## The API

Every route takes either a session cookie or `Authorization: Bearer <token>`.
Both resolve to the same session row, so revoking a session logs out the browser
and the phone together. Sign-in returns the bearer token.

| route | |
|---|---|
| `POST /api/auth/sign-in/email` | returns `{ token, user }` |
| `GET /api/rides` | summaries, newest first |
| `POST /api/rides` | store one ride; idempotent on its id |
| `DELETE /api/rides?id=` | 404s if it isn't yours |
| `GET /api/rides/:id/streams` | base64 sample channels |
| `GET /api/summary` | fitness, fatigue, form, ramp rate, last ride |
| `GET /api/strava/connect` | start Strava authorisation (browser redirect) |
| `GET /api/strava/status` | connection and backfill progress |
| `POST /api/strava/sync` | run one batch now (≤45 s) |
| `POST /api/strava/disconnect` | revoke tokens; stored rides are kept |
| `GET,POST /api/strava/webhook` | Strava's push subscription callback (no auth) |
| `GET /api/cron/strava` | daily job; `Authorization: Bearer $CRON_SECRET` |

`/api/summary` exists because a widget is woken by the OS on a budget, cannot
page through endpoints, and has no room for a spinner. It is also why the
analysis belongs on the server as well as the client: a native app
re-implementing the power model in Swift would be a second implementation to
keep in step, and the two would disagree within a month.

Ownership is checked in each handler next to the query, never in middleware —
middleware matches a path pattern, and a path pattern is the wrong unit for
"does this person own this ride".

## Deployment

Deployed on Vercel. `DATABASE_URL` and `BLOB_READ_WRITE_TOKEN` come from the
Neon and Blob integrations. Authentication additionally needs:

```bash
vercel env add BETTER_AUTH_SECRET production   # openssl rand -base64 32
vercel env add BETTER_AUTH_URL production      # https://<your-domain>
npm run db:migrate
```

Strava sync additionally needs an API application from
<https://www.strava.com/settings/api>, with its Authorization Callback Domain
set to the production domain (`localhost` is always allowed), and:

```bash
vercel env add STRAVA_CLIENT_ID production
vercel env add STRAVA_CLIENT_SECRET production
vercel env add STRAVA_VERIFY_TOKEN production    # openssl rand -hex 16
vercel env add CRON_SECRET production            # openssl rand -hex 16
# after deploying, once:
node --env-file=.env.local scripts/strava-subscribe.mjs https://<your-domain>
vercel env add STRAVA_SUBSCRIPTION_ID production # the id it printed
```

The webhook must be reachable without authentication, so deployment protection
has to stay off. Every ride route still requires a session.

---

## Licence

[AGPL-3.0](LICENSE).

This is a network service, and AGPL is the only common licence whose
share-alike survives someone running a modified copy as a website without ever
distributing a binary. The dependency choice was already made with this in mind:
`@garmin/fitsdk` is the reference FIT implementation but its licence forbids
redistribution under any licence requiring source disclosure, so this uses the
MIT-licensed `fit-file-parser` instead. GoldenCheetah, the closest thing to a
peer, is GPL.

Copyright stays with the author, so relicensing later remains possible — that
option only closes once outside contributions are accepted under AGPL.
