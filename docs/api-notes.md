# AG2026 Results API — Phase 0 exploration notes

Captured **2026-09-20** (Games day 2) against the live tournament. Every field name
below was read off a real response, not inferred. Fixtures for each endpoint are in
[fixtures/](../fixtures/) with a `_fixture` header recording scope, path and capture time.

---

## 1. Transport: the decoder (the brief's version does not work)

Base URL: `https://back.results.asiangames2026.org/s/AG2026/en/<SCOPE>`

`<SCOPE>` is `ALL` or a 3-letter discipline code. Required headers — the origin lock is
real, and a missing/incorrect `Origin` is rejected:

```
Origin:     https://results.asiangames2026.org
Referer:    https://results.asiangames2026.org/
User-Agent: IndiaAG2026Tracker/0.1 (+contact: <real address>)
```

`access-control-allow-origin` is pinned to `https://results.asiangames2026.org`, so this
can never be called from the browser. All traffic goes through our backend, as planned.

### The double-compression is real, but the inner layer is mojibake-wrapped

The brief's reference decoder **fails** with `Z_DATA_ERROR: incorrect header check`.
Confirmed cause: the outer `content-encoding: br` is stripped by `fetch` as expected, but
the body underneath is not a raw zlib stream. It is a zlib stream that has been passed
through a **latin-1 → UTF-8 re-encoding**. The first bytes off the wire are:

```
78 c2 9c c3 ...      # NOT a zlib header
```

`78` is `x`, then `c2 9c` is U+009C encoded as UTF-8. The original second byte was `9c`.
So the server encoded each byte of the zlib stream as a Unicode codepoint. `Buffer.from(await res.arrayBuffer())`
therefore yields the UTF-8 *expansion* of the stream (23,285 bytes) rather than the stream
itself (15,577 bytes). Recovering it means reading the body as text and mapping each
codepoint back down to one byte:

```ts
import zlib from "node:zlib";

const ROOT = "https://back.results.asiangames2026.org/s/AG2026/en";

export async function fetchAG<T>(path: string, scope = "ALL"): Promise<T> {
  const res = await fetch(`${ROOT}/${scope}${path}`, { headers: H });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);

  const text = await res.text();            // decoded as UTF-8
  const bytes = Buffer.from(text, "latin1"); // codepoint -> byte  <-- the missing step
  const body = bytes[0] === 0x78 ? zlib.inflateSync(bytes) : Buffer.from(text, "utf8");
  return JSON.parse(body.toString("utf8"));
}
```

All codepoints in the mojibake body are <= 0xFF, so the `latin1` round-trip is lossless.
Keep the `0x78` sniff and the non-zlib fallback — a few endpoints may serve plain JSON,
and we must not crash the poller on either shape.

`content-type: application/json; charset=utf-8` is a lie until after the inflate.

### Cache TTL — measured, not guessed

Sampled `/schedule/live-now` every 5s for 3 minutes, watching the `age` header:

```
05:40:17 age=21   05:40:27 age= 1   <- reset
05:40:22 age=26   05:40:32 age= 6
05:40:27 age= 1   ...
05:40:53 age=27   05:40:58 age= 1   <- reset, 31s later
```

`age` climbs to ~27 then resets, on a repeating ~30s cycle. **CDN TTL is 30 seconds.**
This is our polling floor: requests faster than 30s return byte-identical cached data and
buy nothing. Note this contradicts the "live sessions every 15–30s" line in the brief —
**15s is pure waste**; 30s is the fastest useful cadence.

`robots.txt` returns **404** (the SPA's catch-all HTML, not a real policy). There is no
crawl directive to honour, so the 30s TTL plus a low request volume is our self-imposed limit.

---

## 2. Endpoint surface

The frontend bundle (`/assets/index.DakvqExU.js`) builds every request from one template,
`/s/${champ}/${lang}/${disc}/<resource>`. Extracting those templates gives the complete
surface — **57 endpoints**, no guessing required. The complete inventory is in the
appendix; the ones that matter to us:

| Endpoint | Scope | Returns |
|---|---|---|
| `/schedule/day/<YYYY-MM-DD>` | `ALL` only | All 254 units for the day. **No participant info.** |
| `/schedule/daily/<YYYY-MM-DD>` | discipline only | That sport's units for the day, **with `Orgs`** |
| `/schedule/live-now` | `ALL` | Units currently RUNNING, with `Orgs` + full `Home`/`Away` state |
| `/schedule/up-next` | `ALL` | Next scheduled units |
| `/schedule/unit/<ResCode>` | discipline | `{phase, prev, next}` — navigation context |
| `/results/<ResCode>` | discipline | `{Info, Results, Competitors, Legends}` — the result payload |
| `/medals/standings` | `ALL` | Full medal table |
| `/medals/org/IND` | `ALL` | Every India medal, with team `Members` |
| `/medals/latest` | `ALL` | Recent medal events, newest first |
| `/entries/org/IND` | `ALL` | Contingent summary: per-discipline head counts |
| `/entries/org/IND` | discipline | India's roster for that sport, by event |
| `/disc/data` | `ALL` | 59 disciplines with competition `Days`, `Locations`, `Events` |
| `/entries/orgs/info` | `ALL` | All 46 participating nations |

**Scope is not interchangeable.** The two schedule routes are disjoint and easy to confuse:

- `ALL/schedule/day/<date>` → 254 units. `ALL/schedule/daily/<date>` → **empty array**.
- `HOC/schedule/daily/<date>` → 6 units with `Orgs`. `HOC/schedule/day/<date>` → **404**.

`/events` and `/entries/count` 404 under `ALL` and need a discipline. A wrong scope returns
`{"code":404,"message":"This service does not exist"}` with an HTTP 404, so the poller can
distinguish "bad route" from "no data" (`200` + `[]`).

---

## 3. How India is tagged

Confirmed: **`Org: "IND"`**, with `OrgDesc: "India"`. The code appears identically on
schedule units (`Orgs: string[]`), medal records, competitors and entries — one filter
works everywhere. India's `Reg` ids embed it too (`SHOWARTW-------IND01`, `CKTWTEAM-------IND01`).

### The India filter for `sessions_of_interest`

This is the one thing Phase 2 depends on, and the answer is not the endpoint the brief assumed.
`ALL/schedule/day/<date>` carries no participant data at all, so it **cannot** be filtered.
The per-discipline route can:

```
GET /<DISC>/schedule/daily/<YYYY-MM-DD>   ->   [{ Orgs: ["BAN","IND"], ResCode, Status, ... }]
```

Measured coverage for 2026-09-20 — every unit that exists carries `Orgs`, 100%:

```
HOC  units=  6  withOrgs=  6  IND= 2
SHO  units=  3  withOrgs=  3  IND= 3
BDM  units=  3  withOrgs=  3  IND= 1
CKT  units=  2  withOrgs=  2  IND= 1
TTE  units= 34  withOrgs= 34  IND= 4
SWM  units= 26  withOrgs= 26  IND= 3
ATH/KAB/WRE/BOX/ARC/TEN: 0 units (not competing today)
```

So building the table costs **one request per discipline per day** — 59 requests to cover a
full day, ~944 for all 16 days. Well inside budget, and it only needs redoing when the
schedule shifts. India had **14 sessions across 6 sports** on 2026-09-20.

Cheaper narrowing: India is entered in only **37 of 59** disciplines, so 22 sports can be
skipped outright. From `ALL/entries/org/IND`:

```
ARC GAR ATH BDM BOX CSL CSP CKT CTR EQU ELS FEN GLF HOC JUD KAB KTE KUR MMA
ROW RU7 SAL SPK SHO TST CLB SQU SRF SWM TTE TKW TEN TEQ VVO WLF WRE WSU
```

Contingent: **499 athletes** (267 M / 232 W). Largest squads — ATH 79, HOC 36, CKT 30,
SHO 30, KAB 24, ROW 22, SPK 21, BDM 20, FEN 20, WRE 16.

---

## 4. Real response samples

### 4.1 Schedule unit — `SHO/schedule/daily/2026-09-20`

The core schedulable record. `ResCode` is the primary key across every other endpoint.

```json
{
  "Orgs": ["BAN", "IND"],
  "ResCode": "W.TEAM--------------.SFNL.000200--",
  "Key": "W.TEAM--------------.SFNL.000200--",
  "Disc": "CKT", "DiscDesc": "Cricket",
  "Type": "T", "isH2H": true, "Medal": "0",
  "Status": "RUNNING", "StatusDesc": "Running", "IsLive": true,
  "DateTimeRaw": "2026-09-20T14:00:00+09:00",
  "Estimated": false, "EstText": "",
  "Venue": "KAP", "VenueDesc": "Korogi Athletic Park",
  "Loc": "KAP", "LocDesc": "Korogi Athletic Park",
  "Event": "W.TEAM--------------", "EventDesc": "Women",
  "Phase": "W.TEAM--------------.SFNL", "PhaseOrder": 2, "PhaseDesc": "Women's Semifinals",
  "UnitDesc": "Women's Semifinal 2", "UnitDescS": "Semifinal 2", "UnitDescA": "Semifinal 2",
  "UnitNum": "6", "IsPhase": false, "ShowResults": true, "ShowLink": true
}
```

`ResCode` is a fixed-width composite: `<EVENT>.<PHASE>.<UNIT>`, dash-padded. Treat it as an
**opaque string** — do not parse or trim it. The dashes are significant and the codes are
reused verbatim in every other route.

Vocabularies observed across all 254 units today (assume these can grow — log and skip unknowns):

- `Status`: `SCHEDULED` · `START_LIST` · `DELAYED` · `GETTING_READY` · `RUNNING` ·
  `INTERMEDIATE` · `UNOFFICIAL` · `PROVISIONAL` · `OFFICIAL`
  - `IsLive: true` ⇔ `RUNNING`. Only `OFFICIAL` is final — `UNOFFICIAL` and
    `PROVISIONAL` mean finished-but-not-confirmed and can still change, and
    `INTERMEDIATE` means partial results posted while the session is still under way.
  - **`PROVISIONAL` and `INTERMEDIATE` were not in this day's capture.** They surfaced
    only once the poller had been running against the live Games for a few minutes
    (`PROVISIONAL` 616 times in the first sweep). This is exactly the drift the brief
    anticipated: the adapter logged and degraded them to `unknown` rather than
    crashing, and they were then added to the vocabulary. `DELAYED` then turned up
    separately on 23 Sep, three days later again. Treat the list above as
    "seen so far", never as closed.
- `Type`: `A` (athlete) · `T` (team) · `D` (doubles/pair)
- `Medal`: `"0"` (no medal) · `"1"` · `"2"` — a **string**, and `""` also appears. It flags
  that medals are decided in this unit, not which medal was won.

`DateTimeRaw` is ISO-8601 with a **`+09:00`** offset (JST), never UTC. Parse to UTC on
ingest, render as IST — a naive string slice yields the wrong day for late-evening sessions.

### 4.2 Live match state — `ALL/schedule/live-now`

Superset of the schedule unit. Adds `Periods[]` plus `Home`/`Away` for head-to-head sports:

```json
{
  "Orgs": ["MAS", "UZB"],
  "ResCode": "M.TEAM11------------.GPB-.000200--",
  "Disc": "HOC", "Status": "RUNNING", "IsLive": true,
  "Periods": [
    { "Order": 1, "Desc": "First Quarter", "DescS": "1ST" },
    { "Order": 2, "Desc": "Halftime",      "DescS": "2ND" },
    { "Order": 3, "Desc": "Third Quarter", "DescS": "3RD" },
    { "Order": 4, "Desc": "Full Time",     "DescS": "4TH" }
  ],
  "Home": {
    "Org": "MAS", "Reg": "HOCMTEAM11-----MAS01", "Name": "Malaysia",
    "Result": "5", "Winner": false, "HasData": true, "Medal": "",
    "Members": [
      { "Org": "MAS", "Bib": "6", "Name": "JALIL Marhan",
        "FuncDesc": "Athlete", "PosDesc": "Defender" }
    ]
  }
}
```

`Home`/`Away` are present only when `isH2H: true`. For non-H2H sports (swimming heats,
shooting finals) the live scoreboard has to come from `/results/<ResCode>` instead — the
adapter must handle both, keyed on `isH2H`.

At capture: 16 units live across the Games, all 16 carrying `Orgs`, 2 of them India
(Cricket Women's SF2, Shooting 10m Air Rifle Women Final).

### 4.3 Result payload — `CKT/results/<ResCode>`

`{ Info, Results, Competitors, Legends }`. `Info` repeats the schedule-unit shape.
`Competitors[]` is the scoreboard and is uniform across sports:

```json
{
  "Reg": "CKTWTEAM-------BAN01",
  "Org": "BAN", "OrgDesc": "Bangladesh", "Name": "Bangladesh",
  "Bib": "", "StartOrder": "1", "StartSortOrder": 1,
  "Rk": "", "RkEq": false, "RkPo": 0,
  "Result": "0 - 0", "ResDetail": "0 - 0", "ResInfo": "",
  "IRM": "OK", "Qualified": "", "Lane": "", "Diff": "", "Medal": "",
  "Stats": {
    "ST_TEAM_WICKETS": "0", "ST_TEAM_OVERS": "0", "ST_TEAM_RR": "0.00"
  },
  "Splits": [ { "Rk": "", "Result": "0 - 0", "Stats": { } } ],
  "Members": [ ],
  "Extensions": []
}
```

Notes for the adapter:

- `Rk` is a **string** (`"1"`, `""`, and ties flagged by `RkEq`); `RkPo` is the numeric sort
  position. Rank on `RkPo`, display `Rk`.
- Every scalar is a string, including numerics — `Result`, `Stats.*`, `Medal`. Do not assume numbers.
- `Stats` keys are **sport-specific** (`ST_TEAM_WICKETS` for cricket, different everywhere
  else). Store as an opaque `jsonb` blob; do not model per-sport columns.
- `IRM` is the irregular-result marker (`OK`, and DNS/DNF/DSQ variants). A competitor with a
  non-`OK` `IRM` has no meaningful `Result`.
- `Extensions[]` appears on most objects as `{Type, Code, Pos, Value, Extensions}` — a
  generic key-value escape hatch. Keep it as raw JSON; it is where schema drift will land.

### 4.4 Medals — `ALL/medals/org/IND`

India's first medal of these Games, captured live:

```json
{
  "Medal": "ME_SILVER", "Order": 1,
  "Org": "IND", "OrgDesc": "India",
  "Reg": "SHOWARTW-------IND01", "Type": "T",
  "DateRaw": "2026-09-20T13:18:00+09:00",
  "Name": "India", "Bib": "", "Gender": "W",
  "Disc": "SHO", "DiscDesc": "Shooting",
  "Event": "W.ARTW--------------.----", "EventDesc": "10m Air Rifle Women Team",
  "Members": [
    { "Reg": "12640502", "Bib": "1088", "Org": "IND",
      "Name": "VALARIVAN Elavenil", "Order": 1, "BirthDate": "1999-08-02" },
    { "Reg": "12901175", "Bib": "1093", "Org": "IND",
      "Name": "KOCHALUMKAL VINOD Vidarsa", "Order": 2, "BirthDate": "1999-06-20" },
    { "Reg": "6510298", "Bib": "1106", "Org": "IND",
      "Name": "MASKAR Sonam Uttam", "Order": 3, "BirthDate": "2002-09-18" }
  ]
}
```

Medal codes: `ME_GOLD` · `ME_SILVER` · `ME_BRONZE`. `Members` is present for team events only.
Note `Event` here carries a trailing `.----` that the schedule's `Event` field does not —
another reason to treat these codes as opaque per-endpoint strings rather than joining on them.

### 4.5 Medal table — `ALL/medals/standings`

```json
{
  "Enabled": true, "Championship": "AG2026", "Discipline": "ALL",
  "Org": "CHN", "OrgDesc": "People's Republic of China",
  "Count": {
    "ME_GOLD":   { "M": 0, "W": 2, "X": 0, "total": 2 },
    "ME_SILVER": { "M": 1, "W": 3, "X": 0, "total": 4 },
    "ME_BRONZE": { "M": 0, "W": 1, "X": 0, "total": 1 },
    "total":     { "M": 1, "W": 6, "X": 0, "total": 7 }
  },
  "Rk": "1", "RkPo": 1, "RkEq": false,
  "RkTotal": "1", "RkPoTotal": 1, "RkEqTotal": false,
  "id": null
}
```

Two parallel rankings ship in every row: `Rk`/`RkPo` ranks by **gold-first precedence**,
`RkTotal`/`RkPoTotal` ranks by **total medals**. They diverge — Macao is `Rk: "3"` but
`RkTotal: "5"`. Pick one for the UI and label it; do not mix them.
Gender split `M`/`W`/`X` is per medal type. Only nations with medals appear (16 rows at capture).

### 4.6 India roster — `SHO/entries/org/IND`

`{Org, OrgDesc, Disc, DiscDesc, Events[]}`, each event holding `Partics[]`:

```json
{
  "Disc": "SHO", "EvKey": "M.ARM---------------",
  "EvDesc": "10m Air Rifle Men Individual", "Order": 1,
  "Partics": [
    {
      "Reg": "12403803", "Org": "IND", "OrgDesc": "India",
      "Type": "A", "Gender": "M", "hasMembers": false,
      "Name": "PATIL Rudrankksh Balasaheb", "NameS": "PATIL RB",
      "GivenName": "Rudrankksh Balasaheb", "FamilyName": "PATIL",
      "BirthDateRaw": "2003-12-16", "IFId": "SHINDM1612200301",
      "MedClass": "", "Height": 0,
      "Extensions": [ { "Type": "ENTRY", "Code": "STANCE", "Value": "Regular", "Pos": 0 } ]
    }
  ]
}
```

`Reg` is the stable participant id and is our `Participant` primary key — but note it is
numeric-looking for individuals (`12403803`) and a composite code for teams
(`SHOWARTW-------IND01`). Keep it a string. `Name` is `FAMILY Given` order.

---

## 5. Consequences for Phases 1–2

1. **Decoder** — the brief's snippet is wrong; use the `latin1` round-trip above. This is the
   single highest-value thing to unit-test against the saved fixtures.
2. **Polling floor is 30s**, measured. Drop the brief's 15s tier.
3. **`sessions_of_interest` is built from `/<DISC>/schedule/daily/<date>`**, not
   `ALL/schedule/day/<date>` — the latter has no participant data. Restrict to the 37
   disciplines India entered: 37 requests/day to refresh the whole India schedule.
4. **Live state has two shapes.** `isH2H: true` → `Home`/`Away` in `/schedule/live-now`
   (one `ALL` request covers every live India unit at once — the cheapest live tier by far).
   `isH2H: false` → poll `/results/<ResCode>` per unit.
5. **Store times as UTC from a `+09:00` source**, render IST. The offset is fixed; Japan has
   no DST during the Games.
6. **Everything is a string and `Stats`/`Extensions` are open-ended.** Normalize aggressively
   into our own schema, keep the raw blob in `jsonb`, log-and-skip unknown enum values.
7. Treat `Status` as provisional until `OFFICIAL` — `UNOFFICIAL` results can still change,
   which matters for the medal tally.

---

## Appendix — all 57 endpoint templates

Extracted from the frontend bundle, which builds every call as
`/s/${champ}/${lang}/${disc}/<resource>` (`champ` = `AG2026`, `lang` = `en`,
`disc` = `ALL` or a discipline code). `${r}`/`${o}` are path parameters — usually a
`ResCode`, date, org code or event key. Untested ones are listed for completeness;
scope requirements vary and a wrong scope returns HTTP 404.

```
/actions/${r}/${o}        /entries/count/${r}       /news
/brackets/${r}            /entries/event/${r}       /news/${r}
/cmtv-memb/${r}           /entries/list             /phases
/cmtv-memb/${r}/${o}      /entries/org/${r}         /phases/${r}
/cmtv-tops/${r}           /entries/orgs/info        /photo-finish/${r}
/cmtv/${r}                /events                   /records-v2/broken
/communication/${r}       /events/phases            /records-v2/initial
/communications           /events/phases/units      /records/broken
/current-v2/${r}          /final-rank/${r}          /records/initial
/current/${r}             /groups-v2/${r}           /reports/all
/disc/data                /groups/${r}              /reports/disc
/entries                  /image/${o}/${r}          /reports/disc-info
/entries/bio-info/${r}    /medals/discipline        /reports/event/${r}
/entries/bio/${r}         /medals/latest            /reports/just-unit/${r}
/entries/count            /medals/org/${r}          /reports/result-book
                          /medals/params            /reports/unit/${r}
/medals/standings         /results/${r}             /schedule/daily/${r}
/schedule/days            /schedule/event/${r}      /schedule/landing
/schedule/live-now        /schedule/mega/${r}       /schedule/unit/${r}
/schedule/up-next
```

Also present but not in the `${disc}` template: `/s/${champ}/${lang}/labels` and
`/s/${champ}/${lang}/labels?for=${s}` — the UI's i18n string table.

Endpoints confirmed non-functional as probed: `ALL/schedule/days` → `[]`,
`ALL/schedule/mega/<date>` → `{units:[], stats:…}`, `ALL/medals/discipline` → `[]`,
`<DISC>/current/<ResCode>` → `null`. These likely need a different parameter form
(`mega`/`daily` appear to accept a date only under a discipline scope) and are worth
a second look only if we need something they uniquely provide.

## Appendix — fixtures

| File | Scope + path |
|---|---|
| `schedule-day-all.json` | `ALL/schedule/day/2026-09-20` (254 units) |
| `schedule-daily-ckt.json` | `CKT/schedule/daily/2026-09-20` |
| `schedule-daily-sho.json` | `SHO/schedule/daily/2026-09-20` |
| `schedule-live-now.json` | `ALL/schedule/live-now` (16 live) |
| `schedule-up-next.json` | `ALL/schedule/up-next` |
| `medals-standings.json` | `ALL/medals/standings` |
| `medals-org-ind.json` | `ALL/medals/org/IND` |
| `medals-latest.json` | `ALL/medals/latest` |
| `disc-data.json` | `ALL/disc/data` (59 disciplines) |
| `entries-org-ind-all.json` | `ALL/entries/org/IND` (499 athletes) |
| `entries-org-ind-sho.json` | `SHO/entries/org/IND` |
| `results-ckt-wsf2.json` | `CKT/results/W.TEAM--------------.SFNL.000200--` |
| `events-phases-sho.json` | `SHO/events/phases` |
| `entries-orgs-info.json` | `ALL/entries/orgs/info` (46 nations) |

Each file wraps the payload as `{ _fixture: { scope, path, url, capturedAt }, data }`.
