# Deploying to Render

The tracker is a single Node service that serves the dashboard and API **and** runs
the poller in-process. There is no build step and no runtime dependencies, so the
deploy is unusually simple — the interesting decisions are about the plan.

---

## Read this first: the free plan stops polling

Render spins a free web service down after **15 minutes without inbound traffic**,
and spin-up takes about a minute. While it is down, nothing polls. For a live
tracker that matters more than it would for a normal web app:

| | Free | Paid (`0.5c-512mb` and up) |
|---|---|---|
| Polls continuously | **No** — only while someone has the page open | Yes |
| First load after idle | ~1 min cold start, then ~15s to re-prime | Instant |
| Filesystem | Wiped on every deploy, restart and spin-down | Wiped unless you attach a disk |
| Persistent disk | Not available | Available |

The damage is smaller than it looks, because the poller re-primes itself from
upstream on boot in about 15 seconds. A cold visitor waits, then sees correct
current data. What you actually lose is **result history** — the append-only record
of how scores changed — and any live update that happened while nobody was watching.

**Pick free** to try it out, or if you only open it during events you care about.
**Pick a paid instance** if you want the medal tally and history to be continuously
correct for the rest of the Games. Everything below works on both; the paid extras
are marked.

---

## 1. Push the repo

Render deploys from a Git remote, and the project is already a local git repo with
an initial commit. Create an empty repo on GitHub, then:

```bash
cd /Users/work-ayush/repos/asian-games
git remote add origin git@github.com:<you>/india-ag2026-tracker.git
git push -u origin main
```

`.gitignore` already keeps `node_modules/`, `data/` and `.env` out. Verify nothing
sensitive is tracked before pushing:

```bash
git ls-files | grep -E '^(data/|\.env$)'   # should print nothing
```

## 2. Create the service

The repo contains [`render.yaml`](../render.yaml), so use a Blueprint rather than
clicking through the form:

1. Render Dashboard → **New** → **Blueprint**
2. Connect the GitHub repo
3. Render reads `render.yaml` and proposes one web service
4. It will prompt for **`AG_CONTACT`** — this is marked `sync: false` so it is not
   stored in git. Put a real address there; it goes out in the `User-Agent` on every
   upstream request and is how the source operator reaches you.
5. **Apply**

First deploy takes a couple of minutes. Watch the logs for:

```
{"msg":"store ready","driver":"sqlite"}
{"msg":"http listening","port":10000}
{"msg":"catalogue synced","sports":59,"trackedSports":37}
{"msg":"poller primed"}
```

Once `poller primed` appears, the dashboard at `https://<service>.onrender.com` is
populated.

### Doing it without the blueprint

If you would rather create the service by hand: **New → Web Service**, connect the
repo, then set

| Field | Value |
|---|---|
| Runtime | Node |
| Build command | `npm ci --omit=dev` |
| Start command | `npm start` |
| Health check path | `/api/health` |
| Region | `singapore` (closest to India) |

and add the environment variables listed in `render.yaml` by hand.

## 3. Node version

Render's default is already Node 24, and `.node-version` pins `24.21.0` on top of
that. This matters: the service runs TypeScript directly via Node's native type
stripping and uses the built-in `node:sqlite`, neither of which exists before Node 22.
If you ever see `ERR_UNKNOWN_FILE_EXTENSION` or `Cannot find module 'node:sqlite'`,
the Node version is wrong — check `.node-version` survived the push.

`package.json` declares `"node": ">=24.0.0 <25"`. Keep the upper bound; Render warns
that an unbounded range silently follows new majors.

---

## Keeping data across restarts (paid)

### Option A — SQLite on a persistent disk

Simplest, and no code change. Add to `render.yaml`:

```yaml
    plan: 0.5c-512mb        # disks need a paid instance
    disk:
      name: tracker-data
      mountPath: /var/data
      sizeGB: 1
```

and change the env var:

```yaml
      - key: SQLITE_PATH
        value: /var/data/tracker.db
```

1 GB is far more than this needs. Note a disk pins the service to one instance —
you cannot scale past one copy, which is fine here since the poller must not run
twice anyway.

### Option B — Render Postgres

Use this if you want backups, or to query the history from outside. The code already
supports it; `pg` is an optional peer dependency.

1. Add `pg` as a real dependency so the build installs it:
   ```bash
   npm install pg && git commit -am "add pg driver" && git push
   ```
2. In `render.yaml`, add the database and point the service at it:
   ```yaml
   databases:
     - name: ag2026-db
       plan: free

   services:
     - type: web
       # ...
       envVars:
         - key: STORE
           value: postgres
         - key: DATABASE_URL
           fromDatabase:
             name: ag2026-db
             property: connectionString
   ```
3. Apply the schema once, using the External Connection String from the dashboard:
   ```bash
   psql "$DATABASE_URL" -f sql/schema.sql
   ```
   (The service also applies `sql/schema.sql` on boot, so this is belt-and-braces.)

**Free Postgres expires 30 days after creation** and has no backups. Created today,
that comfortably outlasts the Games on 4 October — but do not leave anything you
care about on it afterwards.

---

## Optional: Redis for SSE fan-out

Not needed. The service falls back to an in-process event bus when `REDIS_URL` is
unset, which is correct for a single instance — and a single instance is what you
want, because two copies would both poll.

Only add Render Key Value if you later split the API across several instances with a
separate poller. If you do, note that free Key Value is in-memory only and loses
everything on restart; for pub/sub that is harmless, since messages are transient.

---

## After deploying

Check the service is healthy and actually tracking:

```bash
BASE=https://<service>.onrender.com

curl -s $BASE/api/health | jq
curl -s $BASE/api/medals | jq '.own'
curl -s $BASE/api/schedule | jq '.count'
curl -N  $BASE/api/events            # live stream; Ctrl-C to stop
```

Render's health check hits `/api/health`, which returns `200` as soon as the HTTP
server is up — deliberately before the poller has primed, so a slow upstream cannot
fail the deploy. `catalogueSyncedAt` in that response tells you whether priming has
finished.

### Watching for source drift

The upstream changes shape mid-Games without notice. This has already happened three
times during development — `PROVISIONAL` and `INTERMEDIATE` on 20 Sep, `DELAYED` on
23 Sep. The poller logs and skips rather than crashing, so drift is silent unless you
look for it:

```bash
# In the Render log stream
schema drift
```

If a status you care about is showing as `unknown` in the UI, that is the cause —
add it to `STATUS` in `src/adapters/common.ts` and to `SessionStatus` in
`src/domain/types.ts`.

### Cost of running it

One request per 30s to the live endpoint while something of India's is in progress,
37 requests per schedule sweep, and a handful for medals. Well within any sensible
courtesy limit, and the adaptive tiers go quiet overnight when nothing is on.

---

## Troubleshooting

| Symptom | Cause |
|---|---|
| Deploy fails on `npm ci` | `package-lock.json` out of sync — run `npm install` locally and commit it |
| `ERR_UNKNOWN_FILE_EXTENSION` for `.ts` | Node < 24. Check `.node-version` was pushed |
| Service starts but the dashboard is empty | Priming not finished; wait ~15s and check for `poller primed` in the logs |
| Dashboard empty after a cold start on free | Expected — the filesystem was wiped; it re-primes itself |
| `STORE=postgres requires the 'pg' package` | `pg` is still a peer dep; `npm install pg` and commit |
| Medal tally frozen | Check the logs for `tier failed`; the poller keeps running after a failed tick |
