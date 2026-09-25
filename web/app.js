// Dashboard for the India @ AG2026 tracker.
// The API speaks UTC throughout; every conversion to IST happens here.

const IST_OFFSET_MS = (5 * 60 + 30) * 60 * 1000;
const COUNTRY = "IND";

const el = (id) => document.getElementById(id);
const api = async (path) => {
  const res = await fetch(path, { headers: { Accept: "application/json" } });
  if (!res.ok) throw new Error(`${path} -> ${res.status}`);
  return res.json();
};

/** ISO UTC -> "14:30" IST. */
const istTime = (iso) => new Date(Date.parse(iso) + IST_OFFSET_MS).toISOString().slice(11, 16);
/** Today's competition date in JST, which is the API's calendar. */
const todayJst = () => new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10);

const text = (tag, className, value) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (value !== undefined) node.textContent = value;
  return node;
};

const STATUS_LABEL = {
  scheduled: "Scheduled",
  start_list: "Start list",
  delayed: "Delayed",
  getting_ready: "Starting",
  running: "Live",
  intermediate: "In progress",
  unofficial: "Unofficial",
  provisional: "Provisional",
  official: "Official",
  unknown: "",
};

/**
 * Filter state lives in the URL query, so a filtered view is shareable, survives a
 * refresh, and works with the back button.
 */
const state = { date: todayJst(), sport: "", phase: "all" };

/** The day's sessions, cached so filtering is instant and needs no refetch. */
let daySessions = [];

function readStateFromUrl() {
  const q = new URLSearchParams(location.search);
  state.date = q.get("date") || todayJst();
  state.sport = q.get("sport") || "";
  state.phase = ["live", "upcoming", "done"].includes(q.get("phase")) ? q.get("phase") : "all";
}

function writeStateToUrl() {
  const q = new URLSearchParams();
  if (state.date !== todayJst()) q.set("date", state.date);
  if (state.sport) q.set("sport", state.sport);
  if (state.phase !== "all") q.set("phase", state.phase);
  const search = q.toString();
  history.replaceState(null, "", search ? `?${search}` : location.pathname);
}

/**
 * Which bucket a session falls into. `intermediate` means partial results posted
 * while the session is still under way, so it belongs with live rather than done.
 */
function phaseOf(session) {
  if (session.isLive || session.status === "intermediate") return "live";
  if (["official", "unofficial", "provisional"].includes(session.status)) return "done";
  return "upcoming";
}

// ---------------------------------------------------------------- medal tally

async function renderTally() {
  const data = await api("/api/medals");
  const own = data.own ?? { gold: 0, silver: 0, bronze: 0, total: 0, rankByGold: 0 };

  const root = el("tally");
  root.replaceChildren();

  const counts = text("div", "medal-counts");
  for (const [kind, value] of [["gold", own.gold], ["silver", own.silver], ["bronze", own.bronze]]) {
    const box = text("div", `medal ${kind}`);
    box.append(text("div", "n", String(value ?? 0)), text("div", "l", kind));
    counts.append(box);
  }
  const totalBox = text("div", "medal");
  totalBox.append(text("div", "n", String(own.total ?? 0)), text("div", "l", "total"));
  counts.append(totalBox);
  root.append(counts);

  const rank = text("div", "rank");
  rank.append(
    text("div", "n", own.rankByGold ? `#${own.rankByGold}` : "—"),
    text("div", "l", "rank (by gold)"),
  );
  root.append(rank);

  renderWins(data.wins ?? []);
}

function renderWins(wins) {
  const root = el("wins");
  root.replaceChildren();
  if (wins.length === 0) {
    root.append(text("div", "empty", "No medals recorded yet."));
    return;
  }
  for (const win of wins) {
    const row = text("div", "row win");
    const pill = text("div", `pill ${win.medal}`, win.medal[0].toUpperCase());
    const main = text("div", "main");
    main.append(
      text("div", "ev", win.eventName || win.sportName),
      text("div", "meta", `${win.sportName} · ${win.name} · ${istTime(win.wonAt)} IST`),
    );
    row.append(pill, main);
    root.append(row);
  }
}

// ----------------------------------------------------------------- live tiles

function liveCard({ session, results }) {
  const card = text("div", "card");
  card.dataset.sessionId = session.id;
  card.append(
    text("div", "sport", session.sportName),
    text("div", "title", session.title || session.eventName),
  );

  const score = text("div", "score");
  const ranked = [...results].sort((a, b) => (a.rankSort || 99) - (b.rankSort || 99));

  if (session.isHeadToHead && ranked.length > 0) {
    for (const entry of ranked) {
      const side = text("div", `side${entry.orgCode === COUNTRY ? " ind" : ""}`);
      side.append(text("span", null, entry.name || entry.orgCode), text("span", "pts", entry.result || "–"));
      score.append(side);
    }
  } else if (ranked.length > 0) {
    // Field sports: show the leaders plus our own athletes wherever they sit.
    const top = ranked.slice(0, 3);
    const ours = ranked.filter((r) => r.orgCode === COUNTRY && !top.includes(r));
    for (const entry of [...top, ...ours]) {
      const line = text("div", `standing${entry.orgCode === COUNTRY ? " ind" : ""}`);
      line.append(
        text("span", "pos", entry.rank || "–"),
        text("span", null, `${entry.name} (${entry.orgCode})`),
        text("span", "res", entry.result || ""),
      );
      score.append(line);
    }
  } else {
    score.append(text("div", "meta", "Awaiting first result…"));
  }

  card.append(score);
  return card;
}

async function renderLive() {
  // Keep the live tiles consistent with the sport filter; showing live cricket
  // while the page is filtered to hockey would just be confusing.
  const query = state.sport ? `?sport=${encodeURIComponent(state.sport)}` : "";
  const data = await api(`/api/live${query}`);
  const section = el("live-section");
  const root = el("live");
  root.replaceChildren();

  if (data.count === 0) {
    section.hidden = true;
    return;
  }
  section.hidden = false;
  for (const item of data.live) root.append(liveCard(item));
}

// ------------------------------------------------------------------ schedule

function scheduleRow(session) {
  const row = text("div", "row");
  row.append(text("div", "time", istTime(session.startsAt)));

  const main = text("div", "main");
  main.append(text("div", "ev", session.title || session.eventName));

  const opponents = (session.orgs ?? []).filter((o) => o !== COUNTRY);
  const meta = [session.sportName, session.venueName].filter(Boolean).join(" · ");
  main.append(text("div", "meta", meta));
  if (opponents.length > 0 && opponents.length <= 3) {
    main.append(text("div", "opp", `vs ${opponents.join(", ")}`));
  }
  row.append(main);

  if (session.isMedalSession) row.append(text("span", "badge medal", "medal"));

  const label = STATUS_LABEL[session.status] ?? "";
  if (label) {
    const cls = session.isLive ? "badge live" : session.status === "official" ? "badge official" : "badge";
    row.append(text("span", cls, label));
  }
  return row;
}

async function renderSchedule() {
  const root = el("schedule");
  root.replaceChildren(text("div", "empty", "Loading…"));
  try {
    // Fetch the whole day once; the filters then run against the cache.
    const data = await api(`/api/schedule?date=${state.date}`);
    daySessions = data.sessions;
    populateSportFilter(data.sports ?? []);
    applyFilters();
  } catch {
    daySessions = [];
    root.replaceChildren(text("div", "empty", "Could not load the schedule."));
  }
}

function populateSportFilter(sports) {
  const select = el("sport");
  const previous = state.sport;

  select.replaceChildren();
  const all = document.createElement("option");
  all.value = "";
  all.textContent = `All sports (${daySessions.length})`;
  select.append(all);

  for (const sport of sports) {
    const option = document.createElement("option");
    option.value = sport.code;
    option.textContent = `${sport.name} (${sport.count})`;
    select.append(option);
  }

  // Keep the chosen sport if it still has sessions on the newly loaded day;
  // otherwise fall back to all rather than showing an empty list with no cause.
  const stillValid = sports.some((s) => s.code === previous);
  state.sport = stillValid ? previous : "";
  select.value = state.sport;
}

function applyFilters() {
  const root = el("schedule");
  const filtered = daySessions.filter(
    (s) => (!state.sport || s.sportCode === state.sport) &&
           (state.phase === "all" || phaseOf(s) === state.phase),
  );

  for (const chip of document.querySelectorAll("#phase-chips .chip")) {
    chip.classList.toggle("is-on", chip.dataset.phase === state.phase);
  }
  const filtering = state.sport !== "" || state.phase !== "all";
  el("clear-filters").hidden = !filtering;

  const liveToday = daySessions.filter((s) => phaseOf(s) === "live").length;
  el("filter-count").textContent = daySessions.length === 0
    ? ""
    : filtering
      ? `Showing ${filtered.length} of ${daySessions.length} sessions`
      : `${daySessions.length} sessions${liveToday ? ` · ${liveToday} live now` : ""}`;

  root.replaceChildren();
  if (filtered.length === 0) {
    root.append(text("div", "empty", daySessions.length === 0
      ? "No India sessions scheduled on this day."
      : "No sessions match these filters."));
    return;
  }
  for (const session of filtered) root.append(scheduleRow(session));
  writeStateToUrl();
}

// --------------------------------------------------------- community thread

let loadedThreadId = null;

/**
 * Reddit's own embed host allows framing; www.reddit.com does not. The embed
 * renders the post, not its comments, so the call-to-action link matters as much
 * as the frame itself.
 */
async function renderDiscussion() {
  const section = el("discussion-section");
  let data;
  try {
    data = await api("/api/discussion");
  } catch {
    section.hidden = true;
    return;
  }

  const thread = data.thread;
  if (!data.enabled || !thread) {
    section.hidden = true;
    return;
  }
  section.hidden = false;
  el("discussion-link").href = thread.permalink;

  // Leave an already-loaded frame alone; replacing it would scroll-jump and
  // re-download the embed for no reason.
  if (loadedThreadId === thread.id) return;

  const root = el("discussion");
  const button = document.createElement("button");
  button.type = "button";
  button.className = "discussion-load";
  button.append(
    text("span", "dt", thread.title),
    text("span", "dh", "Tap to load the Reddit megathread (~350 KB)"),
  );
  button.addEventListener("click", () => {
    const frame = document.createElement("iframe");
    frame.src = thread.embedUrl;
    frame.title = thread.title;
    frame.loading = "lazy";
    // The frame is third-party content: deny it everything it does not need.
    frame.referrerPolicy = "no-referrer";
    frame.sandbox = "allow-scripts allow-same-origin allow-popups";
    root.replaceChildren(frame);
    loadedThreadId = thread.id;
  }, { once: true });

  root.replaceChildren(button);
}

// ---------------------------------------------------------------------- live

function connect() {
  const source = new EventSource("/api/events");
  const conn = el("conn");
  const label = el("conn-label");

  source.addEventListener("hello", () => {
    conn.className = "conn up";
    label.textContent = "live";
  });

  // Refreshes are coalesced: several events in a burst cause one re-render.
  let pending = null;
  const refresh = (fn) => {
    clearTimeout(pending);
    pending = setTimeout(fn, 300);
  };

  source.addEventListener("live.updated", () => refresh(renderLive));
  source.addEventListener("results.updated", () => refresh(renderLive));
  source.addEventListener("session.updated", () => refresh(() => {
    renderLive();
    if (state.date === todayJst()) renderSchedule();
  }));
  source.addEventListener("medals.updated", () => refresh(renderTally));
  source.addEventListener("medal.won", () => refresh(renderTally));
  source.addEventListener("discussion.updated", () => refresh(renderDiscussion));

  source.onerror = () => {
    conn.className = "conn down";
    label.textContent = "reconnecting";
    // EventSource reconnects on its own using the server's `retry` hint.
  };
}

// --------------------------------------------------------------------- setup

function shiftDay(days) {
  const next = new Date(Date.parse(`${state.date}T00:00:00Z`) + days * 86400000);
  state.date = next.toISOString().slice(0, 10);
  el("date").value = state.date;
  renderSchedule();
}

function init() {
  readStateFromUrl();
  el("date").value = state.date;
  el("date").addEventListener("change", (e) => {
    state.date = e.target.value || todayJst();
    renderSchedule();
  });
  el("prev-day").addEventListener("click", () => shiftDay(-1));
  el("next-day").addEventListener("click", () => shiftDay(1));

  el("sport").addEventListener("change", (e) => {
    state.sport = e.target.value;
    applyFilters();
    renderLive().catch(() => {});
  });

  for (const chip of document.querySelectorAll("#phase-chips .chip")) {
    chip.addEventListener("click", () => {
      state.phase = chip.dataset.phase;
      applyFilters();
    });
  }

  el("clear-filters").addEventListener("click", () => {
    state.sport = "";
    state.phase = "all";
    el("sport").value = "";
    applyFilters();
    renderLive().catch(() => {});
  });

  renderTally().catch(() => {});
  renderLive().catch(() => {});
  renderSchedule();
  renderDiscussion().catch(() => {});
  connect();

  // Safety net: SSE carries the updates, this catches anything missed while the
  // tab was backgrounded or the connection was down.
  setInterval(() => {
    renderLive().catch(() => {});
    renderTally().catch(() => {});
  }, 60000);
}

init();
