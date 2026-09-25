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
 * refresh, and works with the back button. `sports` is a Set of discipline codes;
 * an empty Set means "no filter", not "match nothing".
 */
const state = { date: todayJst(), sports: new Set(), phase: "all" };

/** The day's sessions, cached so filtering is instant and needs no refetch. */
let daySessions = [];
/** The current day's sport list, kept so All/None/Clear can rebuild the checkboxes
 * without a refetch. */
let currentSportOptions = [];

function readStateFromUrl() {
  const q = new URLSearchParams(location.search);
  state.date = q.get("date") || todayJst();
  const raw = q.get("sports") || q.get("sport") || ""; // singular kept for old links
  state.sports = new Set(raw.split(",").map((v) => v.trim()).filter(Boolean));
  state.phase = ["live", "upcoming", "done"].includes(q.get("phase")) ? q.get("phase") : "all";
}

function writeStateToUrl() {
  const q = new URLSearchParams();
  if (state.date !== todayJst()) q.set("date", state.date);
  if (state.sports.size > 0) q.set("sports", [...state.sports].join(","));
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

/** Opens the session's own page on the official results site, in a new tab. */
function officialAnchor(session) {
  if (!session.officialUrl) return null;
  const a = text("a", "official", "Results ↗");
  a.href = session.officialUrl;
  a.target = "_blank";
  a.rel = "noopener";
  a.title = "Open this event on results.asiangames2026.org";
  return a;
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
  const official = officialAnchor(session);
  if (official) card.append(official);
  return card;
}

async function renderLive() {
  // Keep the live tiles consistent with the sport filter; showing live cricket
  // while the page is filtered to hockey would just be confusing.
  const query = state.sports.size > 0
    ? `?sports=${encodeURIComponent([...state.sports].join(","))}`
    : "";
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

  const official = officialAnchor(session);
  if (official) row.append(official);
  return row;
}

async function renderSchedule() {
  const root = el("schedule");
  root.replaceChildren(text("div", "empty", "Loading…"));
  try {
    // Fetch the whole day once; the filters then run against the cache.
    const data = await api(`/api/schedule?date=${state.date}`);
    daySessions = data.sessions;
    populateSportFilter(data.sportOptions ?? []);
    applyFilters();
  } catch {
    daySessions = [];
    root.replaceChildren(text("div", "empty", "Could not load the schedule."));
  }
}

/** Rebuilds the sport checkbox list and the summary button label. */
function populateSportFilter(sportOptions) {
  currentSportOptions = sportOptions;
  const validCodes = new Set(sportOptions.map((s) => s.code));
  // Drop any previously-selected sport that has nothing on the newly loaded day,
  // rather than showing a checked box for a sport with zero matches.
  for (const code of [...state.sports]) {
    if (!validCodes.has(code)) state.sports.delete(code);
  }

  const container = el("sport-filter-options");
  container.replaceChildren();
  for (const sport of sportOptions) {
    const label = document.createElement("label");
    label.className = "ms-option";
    label.setAttribute("role", "option");

    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.value = sport.code;
    checkbox.checked = state.sports.has(sport.code);
    checkbox.addEventListener("change", () => {
      if (checkbox.checked) state.sports.add(sport.code);
      else state.sports.delete(sport.code);
      updateSportFilterButton(sportOptions);
      applyFilters();
      renderLive().catch(() => {});
    });

    label.append(checkbox, text("span", null, sport.name), text("span", "count", String(sport.count)));
    container.append(label);
  }

  updateSportFilterButton(sportOptions);
}

/** The dropdown button reads "All sports", "Hockey", or "3 sports". */
function updateSportFilterButton(sportOptions) {
  const button = el("sport-filter-btn");
  const chosen = [...state.sports];

  let label = "All sports";
  if (chosen.length === 1) {
    label = sportOptions.find((s) => s.code === chosen[0])?.name ?? chosen[0];
  } else if (chosen.length > 1) {
    label = `${chosen.length} sports`;
  }
  // The dropdown arrow is a CSS ::after pseudo-element, so overwriting the
  // button's text content does not disturb it.
  button.textContent = label;
  button.classList.toggle("is-on", chosen.length > 0);

  for (const checkbox of document.querySelectorAll("#sport-filter-options input")) {
    checkbox.checked = state.sports.has(checkbox.value);
  }
}

function closeSportFilter() {
  el("sport-filter-panel").hidden = true;
  el("sport-filter-btn").setAttribute("aria-expanded", "false");
}

function toggleSportFilter() {
  const panel = el("sport-filter-panel");
  const opening = panel.hidden;
  panel.hidden = !opening;
  el("sport-filter-btn").setAttribute("aria-expanded", String(opening));
}

function applyFilters() {
  const root = el("schedule");
  const filtered = daySessions.filter(
    (s) => (state.sports.size === 0 || state.sports.has(s.sportCode)) &&
           (state.phase === "all" || phaseOf(s) === state.phase),
  );

  for (const chip of document.querySelectorAll("#phase-chips .chip")) {
    chip.classList.toggle("is-on", chip.dataset.phase === state.phase);
  }
  const filtering = state.sports.size > 0 || state.phase !== "all";
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

  el("sport-filter-btn").addEventListener("click", (e) => {
    e.stopPropagation();
    toggleSportFilter();
  });
  // Keep clicks inside the panel from bubbling to the document listener below,
  // which would otherwise close it on every checkbox tick.
  el("sport-filter-panel").addEventListener("click", (e) => e.stopPropagation());

  document.addEventListener("click", closeSportFilter);
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") closeSportFilter();
  });

  el("sport-filter-panel").querySelector('[data-action="all"]').addEventListener("click", () => {
    const options = [...document.querySelectorAll("#sport-filter-options input")];
    state.sports = new Set(options.map((c) => c.value));
    populateSportFilter(currentSportOptions);
    applyFilters();
    renderLive().catch(() => {});
  });
  el("sport-filter-panel").querySelector('[data-action="none"]').addEventListener("click", () => {
    state.sports = new Set();
    populateSportFilter(currentSportOptions);
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
    state.sports = new Set();
    state.phase = "all";
    populateSportFilter(currentSportOptions);
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
