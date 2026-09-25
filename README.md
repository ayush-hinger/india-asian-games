# India @ Asian Games 2026 — live tracker

Near-real-time tracker for India's contingent at the Aichi-Nagoya 2026 Asian Games
(19 Sep – 4 Oct 2026): schedule, live scores and medal tally, filtered to India.

Polls the official results backend server-side, normalizes it into a schema of our
own, stores only what actually changed, and pushes live updates to the browser over
Server-Sent Events.

---

## Run it

Needs **Node 24+** and nothing else. TypeScript runs directly (native type
stripping), and storage defaults to Node's built-in SQLite.

```bash
npm install                 # dev-only: typescript + @types/node
cp .env.example .env        # then set AG_CONTACT to a real address
npm start
```

Open **http://localhost:8080**.

The poller primes itself on boot — catalogue, three days of schedule, medals and
live state — which takes about 15 seconds, after which the dashboard is populated.

```
npm test          # 41 tests: decoder, adapters, store (all against saved fixtures)
npm run typecheck # tsc --noEmit
```

### Configuration

| Variable            | Default             | Purpose                                                             |
| ------------------- | ------------------- | ------------------------------------------------------------------- |
| `AG_CONTACT`        | —                   | Real address embedded in the `User-Agent` on every upstream request |
| `PORT`              | `8080`              | HTTP port for the API and dashboard                                 |
| `STORE`             | `sqlite`            | `sqlite` or `postgres`                                              |
| `SQLITE_PATH`       | `./data/tracker.db` | SQLite file                                                         |
| `DATABASE_URL`      | —                   | Required when `STORE=postgres`                                      |
| `REDIS_URL`         | —                   | Redis for SSE fan-out. Omitted → in-process bus (fine for one node) |
| `COUNTRY`           | `IND`               | Country code to track                                               |
| `REDDIT_ENABLED`    | `1`                 | `0` removes the community discussion panel                          |
| `REDDIT_SUBREDDIT`  | `IndianSports`      | Subreddit to pull the megathread from                               |
| `REDDIT_THREAD_URL` | —                   | Pin one thread instead of auto-discovering it                       |
| `POLLER_ENABLED`    | `1`                 | `0` serves stored data without polling upstream                     |
| `LOG_LEVEL`         | `info`              | `debug` to see every request and tier tick                          |

### Postgres

SQLite is the default so the tracker runs with no external services. To use
Postgres instead:

```bash
npm install pg
psql "$DATABASE_URL" -f sql/schema.sql
STORE=postgres DATABASE_URL=postgres://localhost/ag2026 npm start
```

`pg` is an optional peer dependency; nothing else changes.

---

## Ways to access it

### Dashboard

`http://localhost:8080` — today's India schedule, live tiles with running scores, the
medal tally and India's medals, plus a day picker for any date in the Games. All
times render in IST. Updates arrive over SSE; there is no polling from the browser
beyond a 60-second safety refresh.

Filter the schedule by **sport** (multi-select dropdown - pick any combination) and
by **phase** (All / Live / Upcoming / Finished). The sport list is built from the
sessions actually on that day, so it never offers a sport with nothing on it.
Filters run against the already-fetched day, so switching is instant, and they are
mirrored into the URL — `?sports=HOC,SHO&phase=live` is shareable, survives a
refresh and works with the back button. The sport filter also narrows the live
tiles, so the page stays internally consistent.

### REST API

All responses are JSON, `no-store`, and every instant is **ISO-8601 UTC**. Conversion
to IST happens in the UI, so the API has exactly one time convention.

Every session also carries `officialUrl`, its own page on results.asiangames2026.org
(`/#/discipline/<DISC>/results/<ResCode>`). The dashboard links each event there.

| Endpoint                                         | Description                                                                                                                                                                           |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /api/health`                                | Liveness, store driver, SSE client count, last catalogue sync                                                                                                                         |
| `GET /api/schedule?date=&sports=&status=&live=1` | India's sessions for a competition day (JST calendar). Defaults to today. `sports` takes one or more comma-separated discipline codes (`sport` singular still works). Filters compose |
| `GET /api/live?sports=SHO,HOC`                   | Sessions in progress, each with its current scoreboard. Same `sports` filter                                                                                                          |
| `GET /api/upcoming?withinMinutes=240`            | Sessions starting soon                                                                                                                                                                |
| `GET /api/medals`                                | India's tally and every India medal, plus the full standings                                                                                                                          |
| `GET /api/sports`                                | Sports India has entered                                                                                                                                                              |
| `GET /api/sport?code=SHO`                        | Per-sport drill-down: sessions and roster                                                                                                                                             |
| `GET /api/session?id=<ResCode>`                  | One session with its full result set                                                                                                                                                  |
| `GET /api/contingent`                            | Athlete counts by sport                                                                                                                                                               |
| `GET /api/discussion`                            | The current r/IndianSports megathread (permalink + frameable embed URL)                                                                                                               |

```bash
curl localhost:8080/api/live | jq
curl "localhost:8080/api/schedule?date=2026-09-22" | jq '.sessions[].title'
curl "localhost:8080/api/schedule?sports=HOC,SHO&live=1" | jq     # filters compose, multiple sports
curl "localhost:8080/api/schedule?status=official,running" | jq '.count'
curl localhost:8080/api/medals | jq '.own'
```

`/api/schedule` also returns `totalForDay` and a `sportOptions` array (each with a
count), so a client can render a filter without a second request.

### Live stream (SSE)

```bash
curl -N localhost:8080/api/events
```

Event types: `live.updated`, `results.updated`, `session.updated`, `medals.updated`,
`medal.won`, `discussion.updated`. Each frame's `data` is the JSON payload. Events fire only when a
record's content hash actually changes, so an idle feed is genuinely idle.

```js
const es = new EventSource("/api/events");
es.addEventListener("medal.won", (e) => console.log(JSON.parse(e.data).win));
```

### Community discussion panel

The dashboard embeds r/IndianSports' daily Asian Games megathread, discovered
automatically so it rolls over from Day 1 to Day 2 on its own.

**What is actually possible here** (verified against Reddit, not assumed):

|                                  |                                                                                         |
| -------------------------------- | --------------------------------------------------------------------------------------- |
| `www.reddit.com` in an iframe    | **Blocked** — `x-frame-options: SAMEORIGIN`                                             |
| Unauthenticated JSON API         | **Blocked** — 403 from a server IP whatever UA is sent; `old.reddit` redirects to login |
| `embed.reddit.com` in an iframe  | **Works** — `frame-ancestors *`, no XFO, no auth, honest UA accepted                    |
| Embedding the **comment thread** | **Not possible** — the embed renders the post only                                      |
| Reddit live chat                 | **Does not exist** — Reddit retired live threads; Reddit Chat is not embeddable         |

So the panel shows the megathread post, and replies open on Reddit via the
call-to-action link. The iframe is loaded only when clicked (~350 KB), is sandboxed,
and is sent `referrerPolicy="no-referrer"`.

Discovery reads `embed.reddit.com/r/<sub>` server-side and takes the first post in
**feed document order** whose slug matches the megathread pattern. Document order is
the only trustworthy recency signal: the embed carries no timestamps, and post ids
sort by creation rather than by which day a megathread covers — the subreddit
currently has a stray `day_2` post that is older than its `day_1` one, so ordering by
the day number picks the wrong thread. `GET /api/discussion` returns the current one.

---

## How it works

```
upstream  ->  src/source     decode + fetch (the double-compression is handled here)
          ->  src/adapters   raw -> normalized, one adapter per endpoint
          ->  src/domain     the internal model + content hashing
          ->  src/store      persist only what changed
          ->  src/bus        Redis pub/sub (or in-process)
          ->  src/api        REST + SSE
          ->  web/           dashboard
```

### The decoder

The upstream body is compressed twice. `content-encoding: br` is stripped by `fetch`,
but underneath is a zlib stream that has been latin-1 → UTF-8 re-encoded, so the raw
bytes read `78 c2 9c` instead of the `78 9c` zlib header. Reading the body as text
and mapping codepoints back to bytes recovers it — see [src/source/decode.ts](src/source/decode.ts)
and section 1 of [docs/api-notes.md](docs/api-notes.md).

### Finding India's sessions

The all-sports day route carries no participant data and cannot be filtered. The
per-discipline route (`/<DISC>/schedule/daily/<date>`) carries an `Orgs` array on
every unit, and India is entered in 37 of the 59 sports — so one sweep of 37 requests
builds the whole India schedule for a day. That set is the brief's
`sessions_of_interest`, modelled as a partial index on `sessions` rather than a
copied table so it cannot drift from the schedule it derives from.

### Polling

Four tiers, each re-arming only after its previous run finishes, so a slow upstream
stretches the cadence instead of stacking requests:

| Tier         | Interval | Work                                                                               | Skipped when                                      |
| ------------ | -------- | ---------------------------------------------------------------------------------- | ------------------------------------------------- |
| `live`       | 30s      | One `live-now` call for the whole Games, plus per-session results for field sports | Nothing of ours is live or starting within 15 min |
| `imminent`   | 5 min    | Today's schedule refresh, plus results for anything not yet official               | Nothing of ours starts within the hour            |
| `medals`     | 5 min    | Tally and India's medals                                                           | —                                                 |
| `background` | 12h      | Catalogue, roster, and three days of schedule                                      | —                                                 |

**30 seconds is the floor.** The CDN's TTL was measured at 30s (the `age` header
climbs to ~27 then resets); polling faster returns byte-identical bytes. Head-to-head
sports carry their score inline in `live-now`, so a live hockey or cricket match
costs no request of its own.

Every record is content-hashed. Unchanged polls write nothing and emit nothing.

### Schema drift

The upstream can change shape mid-Games, so unknown enum values degrade to
`"unknown"` and are logged rather than throwing, a malformed record is dropped
without taking down its batch, and sport-specific `Stats` are stored as an opaque
blob. This is not hypothetical: the first live run surfaced two session statuses
(`PROVISIONAL`, `INTERMEDIATE`) that the Phase 0 capture did not contain. The poller
kept running, logged them, and they were then added to the vocabulary.

Watch for it with:

```bash
LOG_LEVEL=debug npm start 2>&1 | grep 'schema drift'
```

---

## Deploying

See [docs/deploy-render.md](docs/deploy-render.md) for Render, including the free-plan
spin-down caveat (a free service stops polling after 15 minutes of no traffic) and the
persistent-storage options. The repo carries a `render.yaml` blueprint, so the deploy
is: push to GitHub → New → Blueprint → set `AG_CONTACT` → Apply.

## Source notes

[docs/api-notes.md](docs/api-notes.md) documents the upstream API: the transport, the
57-endpoint surface (extracted from the site's own bundle rather than guessed), real
response samples with actual field names, the measured cache TTL, and how India is
tagged. [fixtures/](fixtures/) holds 14 captured responses; the whole test suite runs
against them, which is what makes the adapters safe to change while the Games are on.

## Conduct

Requests carry a real contact address in the `User-Agent`, never go faster than the
measured cache TTL, and only touch the 37 sports India is entered in. The upstream
pins CORS to its own origin, so the browser never talks to it — everything is proxied
through this backend, which is also why the dashboard is same-origin.

Results here are unofficial and provisional until marked official. For anything that
matters, see [results.asiangames2026.org](https://results.asiangames2026.org).
