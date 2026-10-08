let data = { messages: [], tools: [] };
let timelineChart;
let healthTimelineChart;
let sessionDetailChart;

const state = {
  filters: {}, // { [key]: value } — additive across different keys (e.g. project AND sessionId);
  // clicking the same value for a key again clears just that key.
  chartMode: "daily", // "daily" | "cumulative"
  chartUnit: "usd", // "usd" | "tokens" | "turns"
  chartScale: "linear", // "linear" | "symlog" — independent of unit, user-switchable
  sessionDetailMode: "perTurn", // "perTurn" | "cumulative" — the session-detail drill-down chart
  sessionIncludeSubagents: true, // show sidechain (subagent) turns as a dimmed stacked series
  rates: null, // user-editable $/MTok; null = use DEFAULT_RATES (set on load)
  ratesTab: null, // which model's rate table the pricing panel is showing
  healthThresholds: null, // user-editable $/turn cutoffs; null = use DEFAULT_HEALTH_THRESHOLDS
  groupLinkedSessions: true, // collapse fork/resume-linked sessions into one row in tables + charts
  sessionChartLinkMode: "grafted", // "grafted" | "stacked" — how a linked group's turns are drawn in the session-detail chart
  month: null, // null = all time, else "YYYY-MM" — scopes the spend chart only
  groupBy: "sessionId", // mirrors the #groupBySelect <select>
  collapsed: {}, // { [cardId]: true } — which cards are collapsed, see COLLAPSIBLE_CARDS
  sort: {
    group: { col: "cost", dir: "desc" },
    tool: { col: "bytes", dir: "desc" },
    session: { col: "total", dir: "desc" },
  },
};

/**
 * Flat rates in $ per million tokens, per model. Costs on this dashboard are NOT read
 * from the transcripts (which contain only token counts) — they're computed here, so
 * these rates are the single source of truth for every dollar figure on the page.
 *
 * No context-size tiering: an earlier version split each model into a short/long-context
 * rate pair (matching how enterprise agreements can discount long-context cache reads),
 * but that fit only one snapshot of one account's invoice and added a second dimension to
 * every rate in the UI. Dropped in favor of one flat rate per model, editable per model
 * below if your actual terms do have a long-context discount.
 */
const DEFAULT_RATES = {
  // Published list rates for the current lineup, so October data on any of these models
  // is priced without needing edits.
  models: {
    "claude-fable-5-1": { label: "Fable 5.1", input: 10.0, cacheWrite5m: 12.5, cacheWrite1h: 20.0, cacheRead: 0.25, output: 50.0 },
    "claude-opus-5-5": { label: "Opus 5.5", input: 4.0, cacheWrite5m: 5.0, cacheWrite1h: 8.0, cacheRead: 0.2, output: 20.0 },
    "claude-opus-5": { label: "Opus 5", input: 5.0, cacheWrite5m: 6.25, cacheWrite1h: 10.0, cacheRead: 0.5, output: 25.0 },
    "claude-sonnet-5-5": { label: "Sonnet 5.5", input: 2.0, cacheWrite5m: 2.5, cacheWrite1h: 4.0, cacheRead: 0.2, output: 10.0 },
    "claude-sonnet-5": { label: "Sonnet 5", input: 2.0, cacheWrite5m: 2.5, cacheWrite1h: 4.0, cacheRead: 0.2, output: 10.0 },
    "claude-haiku-4-5-20251001": { label: "Haiku 4.5", input: 1.0, cacheWrite5m: 1.25, cacheWrite1h: 2.0, cacheRead: 0.1, output: 5.0 },
  },
};

/** Model id used when a transcript's model has no rate entry of its own. */
const FALLBACK_MODEL = "claude-sonnet-5";
/** Harness-generated turns that were never billed. */
const UNBILLED_MODELS = new Set(["<synthetic>"]);

function currentRates() {
  return state.rates ?? DEFAULT_RATES;
}

/**
 * Context size for a call = the three input partitions (fresh + cache read + cache
 * write). Output is excluded: it isn't part of this call's input context (it only
 * enters the NEXT call's context) — verified against turn-over-turn transcript data.
 */
function contextTokens(t) {
  return t.inputTokens + t.cacheRead + t.cacheWrite5m + t.cacheWrite1h;
}

// A session's first real turn paying for an abnormally large cache write (the dataset's
// median first-turn write is ~28K tokens) usually isn't a cold start — it's a parallel bg
// job dispatched onto a project another session was already working, with its own
// never-before-cached task framing (so no cache hit despite sharing the project). Flag it
// by finding the nearest other session active in the same project within half an hour.
// Unlike the uuid-collision links in collect.ts, this is a guess, not proof — two
// sessions can legitimately start minutes apart in the same project without being related.
const FIRST_WRITE_OUTLIER_TOKENS = 150_000;
const FORK_SIBLING_WINDOW_MS = 30 * 60 * 1000;

function findForkSibling(m) {
  const write = m.tokens.cacheWrite5m + m.tokens.cacheWrite1h;
  if (write <= FIRST_WRITE_OUTLIER_TOKENS) return null;
  const tTime = new Date(m.timestamp).getTime();
  let best = null;
  for (const other of data.messages) {
    if (other.sessionId === m.sessionId || other.project !== m.project) continue;
    const dt = Math.abs(tTime - new Date(other.timestamp).getTime());
    if (dt > FORK_SIBLING_WINDOW_MS) continue;
    if (!best || dt < best.dt) best = { sessionId: other.sessionId, dt };
  }
  return best;
}

const ZERO_COST = { input: 0, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 0, output: 0, total: 0 };

/** Recompute one message's cost breakdown from its raw token counts at current rates. */
function computeCost(tokens, model) {
  if (UNBILLED_MODELS.has(model)) return { ...ZERO_COST };
  const rates = currentRates();
  const r = rates.models[model] ?? rates.models[FALLBACK_MODEL];
  const input = (tokens.inputTokens * r.input) / 1e6;
  const cacheWrite5m = (tokens.cacheWrite5m * r.cacheWrite5m) / 1e6;
  const cacheWrite1h = (tokens.cacheWrite1h * r.cacheWrite1h) / 1e6;
  const cacheRead = (tokens.cacheRead * r.cacheRead) / 1e6;
  const output = (tokens.outputTokens * r.output) / 1e6;
  return {
    input,
    cacheWrite5m,
    cacheWrite1h,
    cacheRead,
    output,
    total: input + cacheWrite5m + cacheWrite1h + cacheRead + output,
  };
}

/**
 * Overwrite every message's server-computed cost with one priced at the current rates.
 * Everything downstream reads `m.cost.*`, so this is the only place rates need applying.
 */
function applyRates() {
  for (const m of data.messages) m.cost = computeCost(m.tokens, m.model);
  computeSessionHealth();
}

/**
 * Per-session health: $/turn, averaged over the session's whole lifetime. $/token
 * (blended effective rate) was tried first but misses the actual problem — a long,
 * never-compacted session is mostly cheap cache reads by volume, so its blended rate
 * stays green even while every turn pays to re-read a huge, ever-growing context and
 * the session burns real money. $/turn surfaces that directly: context growth shows up
 * as cost per call, regardless of how cheap each individual token is. Thresholds are
 * fixed (not percentile-based) per explicit ask; measured against 92 real sessions
 * (median $0.061/turn, p90 $0.124) they split 78 green / 13 orange / 1 red.
 */
const DEFAULT_HEALTH_THRESHOLDS = { green: 0.1, orange: 0.25 }; // $/turn, user-editable in Options
const HEALTH_EMOJI = { green: "🟢", orange: "🟠", red: "🔴" };

function currentHealthThresholds() {
  return state.healthThresholds ?? DEFAULT_HEALTH_THRESHOLDS;
}

// sessionId -> { rate, level, cost, tokens, turns } — cost/tokens/turns are LIFETIME
// totals (all of data.messages, ignoring date/month/other filters), reused by the "Spend
// by" table so a session's $/turn and filtered/lifetime annotation don't recompute a
// second, differently-scoped average of the same session.
let sessionHealth = new Map();

function computeSessionHealth() {
  const thresholds = currentHealthThresholds();
  const bySession = new Map();
  for (const m of data.messages) {
    const g = bySession.get(m.sessionId) ?? { cost: 0, tokens: 0, turns: 0 };
    g.cost += m.cost.total;
    g.tokens += tokenTotal(m);
    g.turns += 1;
    bySession.set(m.sessionId, g);
  }
  sessionHealth = new Map();
  for (const [sid, g] of bySession) {
    const rate = g.turns ? g.cost / g.turns : 0;
    const level = rate < thresholds.green ? "green" : rate < thresholds.orange ? "orange" : "red";
    sessionHealth.set(sid, { rate, level, cost: g.cost, tokens: g.tokens, turns: g.turns });
  }
}

/**
 * Sessions that share verbatim transcript lines — Claude Code writes no cross-session
 * parent-link field for a plain resume/fork (only subagent sidechains carry a usable
 * parentSessionId), so `linkGroups` is detected server-side by transcript-line uuid
 * collision instead (see collect.ts). Every member of a group maps to the same `main`
 * (the member with the most turns, ties broken by earliest start) so tables/charts can
 * roll a group up under one row without re-deriving "main" independently per view.
 *
 * Deliberately proof-only: an earlier version also folded in the `findForkSibling`
 * heuristic (same project, close in time, one side has an anomalous cache write)
 * dataset-wide. Traced against real data, it chained 16 unrelated sessions spanning two
 * months into one group — and the motivating case for trying it turned out to be a user
 * file attachment, not a fork. The heuristic stays a single-turn tooltip hint only.
 */
let sessionGroups = new Map(); // sessionId -> { members: string[], main: string }

function computeSessionGroups() {
  const stats = new Map(); // sessionId -> { turns, firstTs }
  for (const m of data.messages) {
    const s = stats.get(m.sessionId) ?? { turns: 0, firstTs: m.timestamp };
    s.turns += 1;
    if (m.timestamp < s.firstTs) s.firstTs = m.timestamp;
    stats.set(m.sessionId, s);
  }
  sessionGroups = new Map();
  for (const group of data.linkGroups ?? []) {
    let main = group[0];
    for (const sid of group) {
      const a = stats.get(sid) ?? { turns: 0, firstTs: "" };
      const b = stats.get(main) ?? { turns: 0, firstTs: "" };
      if (a.turns > b.turns || (a.turns === b.turns && a.firstTs < b.firstTs)) main = sid;
    }
    for (const sid of group) sessionGroups.set(sid, { members: group, main });
  }
}

/** Colored dot for a session's health, everywhere a session is identified. */
function healthBadge(sessionId, { html = true } = {}) {
  const h = sessionHealth.get(sessionId);
  if (!h) return "";
  const emoji = HEALTH_EMOJI[h.level];
  return html
    ? `<span title="${h.level} usage — ${fmtUsd(h.rate)}/turn average">${emoji}</span>`
    : emoji;
}

/** 🔗 marker for a session that shares transcript history with others (fork/resume copy). */
function linkBadge(sessionId, { html = true } = {}) {
  const info = sessionGroups.get(sessionId);
  if (!info) return "";
  const role = sessionId === info.main ? "main" : "dependant";
  return html
    ? `<span title="${role} of a linked group — ${info.members.length - 1} other linked session(s)">🔗</span>`
    : "🔗";
}

// Persist every control (filters, toggles, sort, month, group-by) across page refreshes.
// Not versioned — this is a single-user local tool; a shape change just means an old
// saved state gets ignored the first time a key it expects is missing.
const STATE_STORAGE_KEY = "claude-usage-dashboard-state";

function persistState() {
  localStorage.setItem(STATE_STORAGE_KEY, JSON.stringify(state));
  syncUrlFromState();
}

function restoreState() {
  try {
    const saved = JSON.parse(localStorage.getItem(STATE_STORAGE_KEY) ?? "null");
    if (saved) Object.assign(state, saved);
  } catch {
    // corrupt/old-shape localStorage value — ignore and keep defaults
  }
  applyUrlToState(); // a shared URL's filters/month/groupBy win over local defaults
}

// Addressable view: filters, month, and groupBy round-trip through the URL hash, so a
// link to "session X" or "project Y in September" reproduces that exact view for anyone
// who opens it (no server-side state — everything needed already lives in state).
function syncUrlFromState() {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(state.filters)) params.append("f", `${k}=${v}`);
  if (state.month) params.set("month", state.month);
  if (state.groupBy !== "sessionId") params.set("groupBy", state.groupBy);
  const hash = params.toString();
  history.replaceState(null, "", hash ? `#${hash}` : location.pathname + location.search);
}

function applyUrlToState() {
  if (!location.hash) return;
  const params = new URLSearchParams(location.hash.slice(1));
  const filters = {};
  for (const f of params.getAll("f")) {
    const eq = f.indexOf("=");
    if (eq === -1) continue;
    filters[f.slice(0, eq)] = f.slice(eq + 1);
  }
  if (Object.keys(filters).length) state.filters = filters;
  if (params.has("month")) state.month = params.get("month");
  if (params.has("groupBy")) state.groupBy = params.get("groupBy");
}

// Sync the actual DOM controls (button active classes, <select> values) to whatever
// was just restored — restoring `state` alone doesn't move the UI, since button
// active-ness lives in a CSS class, not read from `state` at render time.
function syncControlsFromState() {
  document.getElementById("modeDaily").classList.toggle("active", state.chartMode === "daily");
  document
    .getElementById("modeCumulative")
    .classList.toggle("active", state.chartMode === "cumulative");
  syncUnitButtons();
  document.getElementById("scaleLinear").classList.toggle("active", state.chartScale === "linear");
  document.getElementById("scaleSymlog").classList.toggle("active", state.chartScale === "symlog");
  document
    .getElementById("sessionDetailPerTurn")
    .classList.toggle("active", state.sessionDetailMode === "perTurn");
  document
    .getElementById("sessionDetailCumulative")
    .classList.toggle("active", state.sessionDetailMode === "cumulative");
  document
    .getElementById("sessionThreadAll")
    .classList.toggle("active", state.sessionIncludeSubagents);
  document
    .getElementById("sessionThreadMain")
    .classList.toggle("active", !state.sessionIncludeSubagents);
  document.getElementById("groupBySelect").value = state.groupBy;
  document.getElementById("groupLinkedOn").classList.toggle("active", state.groupLinkedSessions);
  document.getElementById("groupLinkedOff").classList.toggle("active", !state.groupLinkedSessions);
  document
    .getElementById("sessionLinkGrafted")
    .classList.toggle("active", state.sessionChartLinkMode === "grafted");
  document
    .getElementById("sessionLinkStacked")
    .classList.toggle("active", state.sessionChartLinkMode === "stacked");
  COLLAPSIBLE_CARDS.forEach(applyCollapse);
}

// Every card body that can be individually collapsed, independent of filters/month.
const COLLAPSIBLE_CARDS = ["timeline", "healthTimeline", "sessionDetail", "group", "tool", "session"];

function applyCollapse(id) {
  const collapsed = !!state.collapsed[id];
  const body = document.querySelector(`[data-body="${id}"]`);
  const btn = document.querySelector(`[data-collapse="${id}"]`);
  if (body) body.style.display = collapsed ? "none" : "";
  if (btn) btn.textContent = collapsed ? "▸" : "▾";
}

function toggleCollapse(id) {
  state.collapsed[id] = !state.collapsed[id];
  persistState();
  applyCollapse(id);
}

document.querySelectorAll(".collapse-btn").forEach((btn) => {
  btn.addEventListener("click", () => toggleCollapse(btn.dataset.collapse));
});

/**
 * Unit used by the session-detail chart. It shares `state.chartUnit` with the main
 * chart, but "turns" is meaningless there (every point IS one turn), so it falls back
 * to USD in that case.
 */
function sessionChartUnit() {
  return state.chartUnit === "turns" ? "usd" : state.chartUnit;
}

/** Keep both copies of the unit toggle (main chart + session card) in sync. */
function syncUnitButtons() {
  for (const [id, u] of [
    ["unitUsd", "usd"],
    ["unitTokens", "tokens"],
    ["unitTurns", "turns"],
  ]) {
    document.getElementById(id).classList.toggle("active", u === state.chartUnit);
  }
  for (const [id, u] of [
    ["sessionUnitUsd", "usd"],
    ["sessionUnitTokens", "tokens"],
  ]) {
    document.getElementById(id).classList.toggle("active", u === sessionChartUnit());
  }
}

// Generic sort for the [key, groupObj] entry arrays every table builds. `getters` maps
// a th's data-col value to a (key, g) => comparable-value function; "key" always means
// the row's own label/id column (string), which every table supports.
function sortEntries(entries, getters, col, dir) {
  const get = getters[col] ?? getters.key;
  const sorted = [...entries].sort(([ka, ga], [kb, gb]) => {
    const va = get(ka, ga);
    const vb = get(kb, gb);
    return typeof va === "string" ? va.localeCompare(vb) : va - vb;
  });
  if (dir === "desc") sorted.reverse();
  return sorted;
}

function updateSortIndicators(tableId, sortState) {
  for (const th of document.querySelectorAll(`#${tableId} thead th[data-col]`)) {
    th.textContent = th.textContent.replace(/ [▲▼]$/, "");
    th.classList.remove("sorted");
    if (th.dataset.col === sortState.col) {
      th.textContent += sortState.dir === "asc" ? " ▲" : " ▼";
      th.classList.add("sorted");
    }
  }
}

function wireSortable(tableId, sortKey, rerender) {
  document.querySelector(`#${tableId} thead`).addEventListener("click", (e) => {
    const th = e.target.closest("th[data-col]");
    if (!th) return;
    const s = state.sort[sortKey];
    const col = th.dataset.col;
    if (s.col === col) s.dir = s.dir === "asc" ? "desc" : "asc";
    else {
      s.col = col;
      s.dir = th.dataset.defaultDir || "desc";
    }
    persistState();
    rerender();
  });
}

const fmtUsd = (n) => `$${n.toFixed(2)}`;
const fmtNum = (n) => n.toLocaleString();

// Short K/M/G suffixed formatting — used for anything that can get into the millions
// (token counts, byte counts), where a full comma-separated number is unreadable.
function fmtShort(n) {
  const sign = n < 0 ? "-" : "";
  const abs = Math.abs(n);
  if (abs >= 1e9) return `${sign}${(abs / 1e9).toFixed(2)}G`;
  if (abs >= 1e6) return `${sign}${(abs / 1e6).toFixed(2)}M`;
  if (abs >= 1e3) return `${sign}${(abs / 1e3).toFixed(1)}K`;
  return `${sign}${Math.round(abs)}`;
}

/**
 * Bytes per token for tool-result payloads, measured from this dataset rather than
 * assumed: for 1,989 turns whose only new context was a single tool result, comparing
 * the result's byte size against that turn's cache-write tokens (minus the previous
 * turn's output) gives a median of 2.18 bytes/token (p25 1.91, p75 2.44). Denser than
 * the usual ~4 chars/token prose rule because tool output is code/JSON/logs and the
 * current tokenizer splits those finely. Tool-result token counts are never reported
 * per-call by the API, so anything derived from this is an estimate.
 */
const BYTES_PER_TOKEN = 2.18;
const estTokens = (bytes) => bytes / BYTES_PER_TOKEN;

const SERIES_COLORS = {
  cacheRead: "#3fb950",
  cacheWrite1h: "#d29922",
  cacheWrite5m: "#e3b341",
  output: "#f85149",
  input: "#58a6ff",
  turns: "#58a6ff",
};
// Fixed stacking/legend/tooltip order — input first (typically smallest), output next,
// then cache writes, then cache read at the top (typically largest).
const STACK_ORDER = ["input", "output", "cacheWrite5m", "cacheWrite1h", "cacheRead", "turns"];
// One color per member in a linked-session group's "stacked" chart mode (main first).
const MEMBER_COLORS = ["#58a6ff", "#f85149", "#3fb950", "#d29922", "#bc8cff", "#39c5cf"];

// Per unit: which per-message getters to sum into which stacked series, and how to
// format. The y-scale (linear vs. symlog) is a separate, user-switchable toggle
// (state.chartScale) that applies to whichever unit is selected — see SymLogScale below.
const UNIT_DEFS = {
  usd: {
    axisLabel: "USD",
    fmt: fmtUsd,
    series: {
      cacheRead: (m) => m.cost.cacheRead,
      cacheWrite1h: (m) => m.cost.cacheWrite1h,
      cacheWrite5m: (m) => m.cost.cacheWrite5m,
      output: (m) => m.cost.output,
      input: (m) => m.cost.input,
    },
  },
  tokens: {
    axisLabel: "tokens",
    fmt: fmtShort,
    series: {
      cacheRead: (m) => m.tokens.cacheRead,
      cacheWrite1h: (m) => m.tokens.cacheWrite1h,
      cacheWrite5m: (m) => m.tokens.cacheWrite5m,
      output: (m) => m.tokens.outputTokens,
      input: (m) => m.tokens.inputTokens,
    },
  },
  turns: {
    axisLabel: "turns",
    fmt: fmtNum,
    series: { turns: () => 1 },
  },
};

// --- Custom Chart.js scale: symmetric log (linear below `linthresh`, log10 beyond it).
// Reuses LinearScale's stacking-aware min/max detection (via determineDataLimits) and
// only overrides the value<->pixel mapping and tick placement.
const SYMLOG_THRESH = 1000;
function symlogForward(v, t) {
  const sign = v < 0 ? -1 : 1;
  return sign * Math.log10(1 + Math.abs(v) / t);
}
function symlogInverse(t, thresh) {
  const sign = t < 0 ? -1 : 1;
  return sign * thresh * (10 ** Math.abs(t) - 1);
}
class SymLogScale extends Chart.LinearScale {
  getPixelForValue(value) {
    const t = this.options.linthresh ?? SYMLOG_THRESH;
    const tMin = symlogForward(this.min, t);
    const tMax = symlogForward(this.max, t);
    const decimal = (symlogForward(value, t) - tMin) / (tMax - tMin || 1);
    return this.getPixelForDecimal(decimal);
  }
  getValueForPixel(pixel) {
    const t = this.options.linthresh ?? SYMLOG_THRESH;
    const decimal = this.getDecimalForPixel(pixel);
    const tMin = symlogForward(this.min, t);
    const tMax = symlogForward(this.max, t);
    return symlogInverse(tMin + decimal * (tMax - tMin), t);
  }
  buildTicks() {
    const t = this.options.linthresh ?? SYMLOG_THRESH;
    const values = [0];
    for (let v = t; v < this.max; v *= 10) values.push(v);
    values.push(this.max);
    return values.map((value) => ({ value }));
  }
}
SymLogScale.id = "symlog";
SymLogScale.defaults = { ...Chart.LinearScale.defaults, linthresh: SYMLOG_THRESH, min: 0 };
Chart.register(SymLogScale);

function tokenTotal(m) {
  return (
    m.tokens.inputTokens +
    m.tokens.cacheRead +
    m.tokens.cacheWrite5m +
    m.tokens.cacheWrite1h +
    m.tokens.outputTokens
  );
}

async function load() {
  restoreState();
  const res = await fetch("/api/data");
  data = await res.json();
  applyRates(); // price every turn at the user's rates before anything reads m.cost
  computeSessionGroups(); // static per fetch, unlike health — doesn't depend on rates
  populateMonthSelect(); // also reconciles state.month against the now-known month list
  syncControlsFromState();
  syncUrlFromState(); // normalize URL in case populateMonthSelect reset an invalid ?month
  renderRatesPanel();
  syncHealthThresholdInputs();
  render();
}

/** Push current rate values into the input fields (used on load and on reset). */
const RATE_ROWS = [
  ["input", "input"],
  ["cacheWrite5m", "cache write 5m"],
  ["cacheWrite1h", "cache write 1h"],
  ["cacheRead", "cache read"],
  ["output", "output"],
];

/**
 * Render one editable rate table per model. Data-driven so adding a model to
 * DEFAULT_RATES is all it takes; models actually seen in the loaded transcripts are
 * annotated with their turn count so it's obvious which rates actually matter.
 */
function renderRatesPanel() {
  const rates = currentRates();
  const turnsByModel = {};
  for (const m of data.messages) turnsByModel[m.model] = (turnsByModel[m.model] ?? 0) + 1;

  const modelIds = Object.keys(rates.models);
  // Default to whichever priced model actually dominates the data.
  if (!modelIds.includes(state.ratesTab)) {
    state.ratesTab =
      modelIds
        .filter((id) => turnsByModel[id])
        .sort((a, b) => turnsByModel[b] - turnsByModel[a])[0] ?? modelIds[0];
  }

  const tabs = modelIds
    .map((id) => {
      const seen = turnsByModel[id];
      const dot = seen ? `<span style="color:#3fb950;">●</span> ` : "";
      return `<button data-rates-tab="${id}" class="${id === state.ratesTab ? "active" : ""}" title="${
        seen ? `${fmtNum(seen)} turns in data` : "not present in data"
      }">${dot}${rates.models[id].label}</button>`;
    })
    .join("");

  const mr = rates.models[state.ratesTab];
  const seen = turnsByModel[state.ratesTab];
  const rows = RATE_ROWS.map(
    ([key, label]) => `<tr><td>${label}</td>
      <td class="num"><input type="number" step="0.0001" min="0" data-rate="${state.ratesTab}|${key}" /></td></tr>`,
  ).join("");

  // Models in the data with no rate entry — priced with the fallback, so say so.
  const unpriced = Object.keys(turnsByModel).filter(
    (id) => !rates.models[id] && !UNBILLED_MODELS.has(id),
  );
  const note = unpriced.length
    ? `<p style="color:#d29922;font-size:12px;margin:0 0 10px;">No rate entry for ${unpriced.join(", ")} — priced using ${rates.models[FALLBACK_MODEL].label} rates.</p>`
    : "";

  document.getElementById("ratesTables").innerHTML = `
    ${note}
    <span class="toggle" id="ratesTabs" style="margin-left:0;flex-wrap:wrap;">${tabs}</span>
    <div style="margin-top:10px;color:#8b949e;font-size:12px;">
      ${mr.label} — ${seen ? `${fmtNum(seen)} turns in loaded data` : "not present in loaded data"}
    </div>
    <table style="width:auto;margin-top:4px;">
      <thead><tr><th style="cursor:default;">rate</th><th class="num" style="cursor:default;">$/MTok</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>`;
  syncRateInputs();
}

function rateAt(rates, path) {
  const [modelId, key] = path.split("|");
  return rates.models[modelId]?.[key];
}

function syncRateInputs() {
  const rates = currentRates();
  for (const input of document.querySelectorAll("#ratesCard input[data-rate]")) {
    const value = rateAt(rates, input.dataset.rate);
    if (value === undefined) continue;
    input.value = value;
    input.classList.toggle(
      "modified",
      Number(value) !== Number(rateAt(DEFAULT_RATES, input.dataset.rate)),
    );
  }
  updateRatesSummary();
}

function updateRatesSummary() {
  const custom = JSON.stringify(currentRates()) !== JSON.stringify(DEFAULT_RATES);
  const healthCustom = JSON.stringify(currentHealthThresholds()) !== JSON.stringify(DEFAULT_HEALTH_THRESHOLDS);
  document.getElementById("ratesSummary").textContent =
    custom || healthCustom ? "— custom options" : "— defaults";
}

/** Read one edited rate field back into state, re-price everything, re-render. */
function onRateInput(input) {
  const value = Number(input.value);
  if (!Number.isFinite(value) || value < 0) return;
  // Clone defaults on first edit so we never mutate DEFAULT_RATES.
  state.rates = state.rates ?? structuredClone(DEFAULT_RATES);
  const [modelId, key] = input.dataset.rate.split("|");
  state.rates.models[modelId][key] = value;
  persistState();
  applyRates();
  syncRateInputs();
  render();
}

/** Read one edited health-threshold field back into state, recompute badges, re-render. */
function onHealthThresholdInput(input) {
  const value = Number(input.value);
  if (!Number.isFinite(value) || value < 0) return;
  state.healthThresholds = state.healthThresholds ?? { ...DEFAULT_HEALTH_THRESHOLDS };
  state.healthThresholds[input.dataset.health] = value;
  persistState();
  computeSessionHealth();
  syncHealthThresholdInputs();
  render();
}

function syncHealthThresholdInputs() {
  const thresholds = currentHealthThresholds();
  for (const input of document.querySelectorAll("#ratesCard input[data-health]")) {
    const value = thresholds[input.dataset.health];
    input.value = value;
    input.classList.toggle("modified", value !== DEFAULT_HEALTH_THRESHOLDS[input.dataset.health]);
  }
  updateRatesSummary();
}

// Delegated: the per-model table is re-rendered on every tab switch, so listeners
// can't be attached per-element.
document.getElementById("ratesCard").addEventListener("change", (e) => {
  const rateInput = e.target.closest("input[data-rate]");
  if (rateInput) return onRateInput(rateInput);
  const healthInput = e.target.closest("input[data-health]");
  if (healthInput) return onHealthThresholdInput(healthInput);
});

document.getElementById("ratesCard").addEventListener("click", (e) => {
  const tab = e.target.closest("button[data-rates-tab]");
  if (!tab) return;
  state.ratesTab = tab.dataset.ratesTab;
  persistState();
  renderRatesPanel();
});

document.getElementById("ratesReset").addEventListener("click", () => {
  state.rates = null; // fall back to DEFAULT_RATES
  state.healthThresholds = null; // fall back to DEFAULT_HEALTH_THRESHOLDS
  persistState();
  applyRates();
  renderRatesPanel();
  syncHealthThresholdInputs();
  render();
});

function monthLabel(ym) {
  const [y, m] = ym.split("-").map(Number);
  return new Date(y, m - 1, 1).toLocaleDateString(undefined, { month: "long", year: "numeric" });
}

// Every "YYYY-MM-DD" in a calendar month (UTC, matching how dates are bucketed everywhere else).
function daysInMonth(ym) {
  const [y, m] = ym.split("-").map(Number);
  const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return Array.from({ length: lastDay }, (_, i) => `${ym}-${String(i + 1).padStart(2, "0")}`);
}

// Every "YYYY-MM-DD" from the earliest to the latest message date, inclusive — fills
// gaps (days with zero activity) so a category-scale chart doesn't space distant dates
// as if they were adjacent.
function dateRange(messages) {
  if (messages.length === 0) return [];
  const sorted = messages.map((m) => m.date).sort();
  const out = [];
  const cur = new Date(sorted[0] + "T00:00:00Z");
  const end = new Date(sorted[sorted.length - 1] + "T00:00:00Z");
  while (cur <= end) {
    out.push(cur.toISOString().slice(0, 10));
    cur.setUTCDate(cur.getUTCDate() + 1);
  }
  return out;
}

// Month list is a property of the loaded dataset (independent of session/project
// filters) — rebuilt only on load/refresh, not on every render().
function populateMonthSelect() {
  const months = [...new Set(data.messages.map((m) => m.date.slice(0, 7)))].sort().reverse();
  const select = document.getElementById("monthSelect");
  const keep = state.month;
  select.innerHTML =
    `<option value="">All time</option>` +
    months.map((ym) => `<option value="${ym}">${monthLabel(ym)}</option>`).join("");
  if (keep && months.includes(keep)) select.value = keep;
  else state.month = null;
}

function toggleFilter(key, value) {
  if (state.filters[key] === value) delete state.filters[key];
  else state.filters[key] = value;
  persistState();
  render();
}

function clearFilter(key) {
  if (key) delete state.filters[key];
  else {
    state.filters = {};
    state.month = null;
    document.getElementById("monthSelect").value = "";
  }
  persistState();
  render();
}

function activeFilters() {
  return Object.entries(state.filters);
}

// The month picker scopes the tables (via filteredMessages/filteredTools/monthScoped)
// exactly like an extra additive filter, on top of whatever project/session/etc.
// filters are active — but it does NOT touch the header stats, which always summarize
// the whole loaded dataset.
function inSelectedMonth(dateStr) {
  return !state.month || dateStr.startsWith(state.month);
}

function filteredMessages() {
  const entries = activeFilters();
  return data.messages.filter(
    (m) => inSelectedMonth(m.date) && entries.every(([k, v]) => m[k] === v),
  );
}

function filteredTools() {
  // ToolUsageRecord only carries sessionId/project/date — dimensions that live on
  // messages only (effort, model, sessionKind) don't apply here.
  const entries = activeFilters().filter(
    ([k]) => k === "sessionId" || k === "project" || k === "date",
  );
  return data.tools.filter((t) => inSelectedMonth(t.date) && entries.every(([k, v]) => t[k] === v));
}

// Session table ignores only the `sessionId` filter (so clicking a session doesn't
// collapse the ranking to itself, and you can always click a different one), but
// honors the month picker and every other active filter (date, project, effort, ...)
// — e.g. clicking a day's bar on the chart narrows this to that day's actual sessions.
function monthScopedMessages() {
  const entries = activeFilters().filter(([k]) => k !== "sessionId");
  return data.messages.filter(
    (m) => inSelectedMonth(m.date) && entries.every(([k, v]) => m[k] === v),
  );
}

function render() {
  const { messages, scannedFiles, generatedAt } = data;
  // Header stats follow the selected period (month / all time) but deliberately ignore
  // the dimension filters — the filter bar below already reports the filtered total, so
  // the header stays the "what does this period cost in total" reference.
  const inPeriod = state.month ? messages.filter((m) => inSelectedMonth(m.date)) : messages;
  const totalCost = inPeriod.reduce((s, m) => s + m.cost.total, 0);
  const sessions = new Set(inPeriod.map((m) => m.sessionId));
  document.getElementById("statPeriod").textContent = state.month
    ? monthLabel(state.month)
    : "all time";
  document.getElementById("statTotal").textContent = fmtUsd(totalCost);
  document.getElementById("statMessages").textContent = fmtNum(inPeriod.length);
  document.getElementById("statSessions").textContent = fmtNum(sessions.size);
  document.getElementById("statAsOf").textContent =
    `${scannedFiles} files · as of ${new Date(generatedAt).toLocaleString()}`;

  renderSpendChart(messages, filteredMessages()); // full date range always, values scoped to the filter
  renderHealthTimelineChart(messages, filteredMessages());
  renderFilterBar(); // lives between the chart and the tables
  renderSessionDetailChart(); // only visible when exactly one session is selected
  renderGroupTable(filteredMessages(), state.groupBy);
  renderToolTable(filteredTools());
  renderSessionTable(monthScopedMessages()); // full ranking (ignores project/session filters), but honors the month picker
}

function renderFilterBar() {
  const bar = document.getElementById("filterBar");
  const entries = activeFilters();
  if (entries.length === 0 && !state.month) {
    bar.style.display = "none";
    return;
  }
  bar.style.display = "flex";
  const scoped = filteredMessages();
  const total = scoped.reduce((s, m) => s + m.cost.total, 0);
  const monthChip = state.month
    ? `<span class="chip">month = ${escapeAttr(monthLabel(state.month))} <button data-clear-key="__month">×</button></span> `
    : "";
  const chips = entries
    .map(
      ([k, v]) =>
        `<span class="chip">${k === "sessionId" ? healthBadge(v) + " " + linkBadge(v) + " " : ""}${k} = ${escapeAttr(String(v))} <button data-clear-key="${k}">×</button></span>`,
    )
    .join(" ");
  document.getElementById("filterChips").innerHTML = monthChip + chips;
  document.getElementById("filterSummary").textContent =
    `${fmtUsd(total)} across ${fmtNum(scoped.length)} turns`;
}

// One merged chart: daily-resolution buckets (always — a single session's turn-by-turn
// noise doesn't need finer granularity), scoped to the current filter, with an
// independent mode toggle (daily bars vs. cumulative running total) and unit toggle
// (USD / tokens / turns). Date axis spans the full unfiltered range (or the selected
// month, if one is picked) so selecting a session/group doesn't collapse the x-axis
// down to just the days it touched. Picking a month also resets the cumulative running
// total to 0 at the start of that month, rather than carrying over prior history.
function renderSpendChart(allMessages, messages) {
  // The x-axis must be every calendar day in range, not just days that happen to have
  // data — otherwise a category-scale chart spaces "Jul 1" and "Jul 17" as adjacent
  // labels, silently erasing the 16 empty days between them.
  const dates = state.month ? daysInMonth(state.month) : dateRange(allMessages);

  if (state.month) {
    allMessages = allMessages.filter((m) => m.date.startsWith(state.month));
    messages = messages.filter((m) => m.date.startsWith(state.month));
  }

  const subtitle = document.getElementById("timelineSubtitle");
  const ctx = document.getElementById("timelineChart");
  const unit = UNIT_DEFS[state.chartUnit];
  const cumulative = state.chartMode === "cumulative";
  const allKeys = Object.keys(unit.series);

  const byDate = new Map(dates.map((d) => [d, Object.fromEntries(allKeys.map((k) => [k, 0]))]));
  for (const m of messages) {
    const bucket = byDate.get(m.date);
    if (!bucket) continue; // shouldn't happen — allMessages is a superset of messages
    for (const k of allKeys) bucket[k] += unit.series[k](m);
  }

  // Fixed stack order (not data-dependent): input, output, cache writes, cache read —
  // roughly smallest to largest in practice, but kept constant across days/modes/units
  // so the stack order, legend order, and tooltip order never shuffle around.
  const keys = STACK_ORDER.filter((k) => allKeys.includes(k));

  const series = {};
  for (const k of keys) {
    const perDay = dates.map((d) => byDate.get(d)[k]);
    if (cumulative) {
      let running = 0;
      series[k] = perDay.map((v) => (running += v));
    } else {
      series[k] = perDay;
    }
  }

  // Active filters/month are already shown as chips in the filter bar below — no need
  // to repeat them here too.
  subtitle.textContent = `— ${fmtNum(messages.length)} turns, ${unit.axisLabel}, ${cumulative ? "cumulative" : "daily"} view`;

  // Cumulative is drawn as a filled, stacked area (a rising total) — a "line" chart.
  // Daily is drawn as a stacked bar per day — a different chart TYPE, so the two
  // views can never look alike by coincidence. All three units stay stacked and use
  // the same chart type for consistency; the y-scale (linear/symlog) is independently switchable.
  if (timelineChart) timelineChart.destroy();
  timelineChart = new Chart(ctx, {
    type: cumulative ? "line" : "bar",
    data: {
      labels: dates,
      datasets: keys.map((k) => ({
        label: k,
        data: series[k],
        // Same solid, full-opacity color everywhere (bar/area fill, border, legend
        // swatch, tooltip swatch) — no separate translucent variant, so nothing looks
        // dimmer/higher-contrast than its counterpart elsewhere in the UI. Stacked
        // bands don't overlap, so opacity was never doing real work visually anyway.
        borderColor: SERIES_COLORS[k],
        backgroundColor: SERIES_COLORS[k],
        pointRadius: 0,
        borderWidth: 1.5,
        fill: cumulative,
        stack: "s",
      })),
    },
    options: {
      responsive: true,
      animation: false,
      interaction: { mode: "index", intersect: false }, // one combined tooltip listing every series
      // Click any day's bar/point to add it as a `date` filter — same additive filter
      // used by table rows, so the session/tool/group tables below instantly scope to
      // exactly that day (click again to clear it).
      onClick: (evt, _elements, chart) => {
        const points = chart.getElementsAtEventForMode(evt, "index", { intersect: false }, true);
        if (points.length === 0) return;
        toggleFilter("date", chart.data.labels[points[0].index]);
      },
      onHover: (evt, elements) => {
        evt.native.target.style.cursor = elements.length ? "pointer" : "default";
      },
      scales: {
        x: { stacked: true },
        y: {
          stacked: true,
          type: state.chartScale,
          ...(state.chartScale === "symlog" ? { linthresh: SYMLOG_THRESH } : {}),
          title: { display: true, text: unit.axisLabel },
          ticks: { callback: (v) => unit.fmt(v) },
        },
      },
      plugins: {
        legend: { position: "bottom", labels: { color: "#e6edf3" } },
        tooltip: {
          mode: "index",
          intersect: false,
          // List tooltip rows top-down matching the VISUAL stack (largest/topmost band
          // first, e.g. cacheRead, down to the smallest/bottom band, e.g. input) — the
          // way a human's eye actually scans the chart — rather than bottom-up dataset
          // array order. Verified against real rendered pixel positions (Chart.js
          // element .y), not assumed: descending datasetIndex == descending on-screen
          // position for this stack.
          itemSort: (a, b) => b.datasetIndex - a.datasetIndex,
          callbacks: {
            label: (ctx) => `${ctx.dataset.label}: ${unit.fmt(ctx.parsed.y)}`,
          },
        },
      },
    },
  });
}

const HEALTH_LEVELS = ["green", "orange", "red"];
const HEALTH_COLORS = { green: "#3fb950", orange: "#d29922", red: "#f85149" };
const HEALTH_TIER_LABELS = { green: "healthy", orange: "elevated", red: "high" };

// Same date-axis/stacked-bar shape as renderSpendChart, but counting distinct sessions
// per day instead of summing token/cost series — one session active across N days
// contributes to N day-buckets, always under its one lifetime health tier. There's no
// cumulative mode here (unlike the spend chart): summing a repeating session's daily
// count across days wouldn't add up to "total unique sessions", so daily-only avoids a
// number that looks like a running total but isn't one.
function renderHealthTimelineChart(allMessages, messages) {
  const dates = state.month ? daysInMonth(state.month) : dateRange(allMessages);
  if (state.month) messages = messages.filter((m) => m.date.startsWith(state.month));

  const sessionsByDate = new Map(dates.map((d) => [d, new Set()]));
  for (const m of messages) {
    sessionsByDate.get(m.date)?.add(m.sessionId);
  }

  const series = Object.fromEntries(HEALTH_LEVELS.map((lvl) => [lvl, dates.map(() => 0)]));
  for (let i = 0; i < dates.length; i++) {
    for (const sid of sessionsByDate.get(dates[i])) {
      const level = sessionHealth.get(sid)?.level ?? "green";
      series[level][i] += 1;
    }
  }

  const totalSessions = new Set(messages.map((m) => m.sessionId)).size;
  document.getElementById("healthTimelineSubtitle").textContent =
    `— ${fmtNum(totalSessions)} sessions, daily view`;

  if (healthTimelineChart) healthTimelineChart.destroy();
  healthTimelineChart = new Chart(document.getElementById("healthTimelineChart"), {
    type: "bar",
    data: {
      labels: dates,
      datasets: HEALTH_LEVELS.map((lvl) => ({
        label: HEALTH_TIER_LABELS[lvl],
        data: series[lvl],
        borderColor: HEALTH_COLORS[lvl],
        backgroundColor: HEALTH_COLORS[lvl],
        borderWidth: 1.5,
        stack: "s",
      })),
    },
    options: {
      responsive: true,
      animation: false,
      interaction: { mode: "index", intersect: false },
      // Same click-to-filter-by-date behavior as the spend chart above.
      onClick: (evt, _elements, chart) => {
        const points = chart.getElementsAtEventForMode(evt, "index", { intersect: false }, true);
        if (points.length === 0) return;
        toggleFilter("date", chart.data.labels[points[0].index]);
      },
      onHover: (evt, elements) => {
        evt.native.target.style.cursor = elements.length ? "pointer" : "default";
      },
      scales: {
        x: { stacked: true },
        y: { stacked: true, title: { display: true, text: "sessions" }, ticks: { precision: 0 } },
      },
      plugins: {
        legend: { position: "bottom", labels: { color: "#e6edf3" } },
        tooltip: {
          mode: "index",
          intersect: false,
          itemSort: (a, b) => b.datasetIndex - a.datasetIndex,
          callbacks: {
            label: (ctx) => `${ctx.dataset.label}: ${fmtNum(ctx.parsed.y)}`,
          },
        },
      },
    },
  });
}

const GROUP_SORT_GETTERS = {
  key: (k) => String(k),
  cost: (k, g) => g.cost,
  tokens: (k, g) => g.tokens,
  turns: (k, g) => g.turns,
  perTurn: (k, g) => g.cost / g.turns,
};

// Drill-down for a single selected session: one point per assistant turn (API call),
// in order, instead of per calendar day. This is what explains "why is this session
// $0.11/turn while that one is $0.06/turn" — the per-turn shape shows whether the cost
// is a steadily-growing cache read (context that keeps expanding), a few huge spikes
// (one enormous tool result or file read), or verbose output on every turn.
function renderSessionDetailChart() {
  const card = document.getElementById("sessionDetailCard");
  const sessionId = state.filters.sessionId;

  if (sessionDetailChart) {
    sessionDetailChart.destroy();
    sessionDetailChart = undefined;
  }
  if (!sessionId) {
    card.style.display = "none";
    return;
  }
  card.style.display = "";

  // A linked (forked/resumed) session broadens scope to every member of its group —
  // collect.ts already resolves each shared transcript line to exactly one owning
  // session, so summing across members here can't double-count a shared turn.
  const group = state.groupLinkedSessions ? sessionGroups.get(sessionId) : undefined;
  const linkMode = group ? state.sessionChartLinkMode : null;
  document.getElementById("sessionLinkModeToggle").style.display = group ? "" : "none";
  const idSet = group ? new Set(group.members) : new Set([sessionId]);

  // Scope to the SAME month/filters as the tables (minus the sessionId filter itself,
  // which idSet now covers) — otherwise a session that ran mostly in another month shows
  // its whole lifetime here while the table shows only the in-scope turns, and the two
  // disagree.
  const scopeEntries = activeFilters().filter(([k]) => k !== "sessionId");
  const scoped = data.messages.filter(
    (m) => idSet.has(m.sessionId) && inSelectedMonth(m.date) && scopeEntries.every(([k, v]) => m[k] === v),
  );
  const allTurns = [...scoped].sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  // Subagent (sidechain) turns run their own small, independent context. Interleaving
  // them with main-thread turns on one axis makes the main thread's context look like
  // it collapses and then "skyrockets" when control returns — so they're drawn as a
  // separate, dimmed series stacked on top of the main one (they bill into the same
  // total), or excluded entirely via the thread toggle.
  const msgs = state.sessionIncludeSubagents ? allTurns : allTurns.filter((m) => !m.isSidechain);
  const lifetimeTurns = data.messages.filter((m) => idSet.has(m.sessionId)).length;
  if (msgs.length === 0) {
    card.style.display = "none";
    return;
  }
  const subagentTurns = msgs.filter((m) => m.isSidechain).length;

  const unit = UNIT_DEFS[sessionChartUnit()];
  const cumulative = state.sessionDetailMode === "cumulative";
  const keys = STACK_ORDER.filter((k) => k in unit.series);

  // Each turn belongs to exactly one thread, so the other thread's series is 0 there;
  // stacked, the two still sum to the session's true per-turn (or cumulative) total.
  const runningSum = (arr) => {
    let running = 0;
    return arr.map((v) => (running += v));
  };

  // "Grafted" mode (default): idSet already widened `msgs` to the whole lineage, time-
  // sorted, so turn # just continues across it — everything below is otherwise identical
  // to a plain single-session render, split only by subagent vs. main thread.
  // "Stacked" mode: split by group MEMBER instead, one series per session so you can see
  // which member in the lineage is driving cost — at the cost of the input/cache/output
  // breakdown, collapsed here to one number per turn per member.
  let datasets;
  if (linkMode === "stacked") {
    const unitTotal = (m) => keys.reduce((s, k) => s + unit.series[k](m), 0);
    const members = [group.main, ...group.members.filter((sid) => sid !== group.main)];
    datasets = members.map((sid, i) => {
      const raw = msgs.map((m) => (m.sessionId === sid ? unitTotal(m) : 0));
      const color = MEMBER_COLORS[i % MEMBER_COLORS.length];
      return {
        label: `${sid === group.main ? "main" : "dependant"} · ${sid.slice(0, 8)}`,
        data: cumulative ? runningSum(raw) : raw,
        borderColor: color,
        backgroundColor: sid === group.main ? color : color + "99",
        pointRadius: 0,
        borderWidth: 1.5,
        fill: cumulative,
        stack: "s",
      };
    });
  } else {
    const series = {};
    const subSeries = {};
    for (const k of keys) {
      const main = msgs.map((m) => (m.isSidechain ? 0 : unit.series[k](m)));
      const sub = msgs.map((m) => (m.isSidechain ? unit.series[k](m) : 0));
      series[k] = cumulative ? runningSum(main) : main;
      subSeries[k] = cumulative ? runningSum(sub) : sub;
    }
    datasets = [
      ...keys.map((k) => ({
        label: k,
        data: series[k],
        borderColor: SERIES_COLORS[k],
        backgroundColor: SERIES_COLORS[k],
        pointRadius: 0,
        borderWidth: 1.5,
        fill: cumulative,
        stack: "s",
      })),
      // Same stack id, so subagent spend sits on top of the main thread's and the
      // column totals stay true; dimmed (alpha) so the two threads read apart.
      ...(subagentTurns
        ? keys.map((k) => ({
            label: `${k} (subagent)`,
            data: subSeries[k],
            borderColor: SERIES_COLORS[k] + "55",
            backgroundColor: SERIES_COLORS[k] + "55",
            pointRadius: 0,
            borderWidth: 1.5,
            fill: cumulative,
            stack: "s",
          }))
        : []),
    ];
  }

  const total = msgs.reduce((s, m) => s + m.cost.total, 0);
  // Make the scoping visible: a session can span months, and the current month/filters
  // may be showing only part of its life.
  const scopeNote =
    msgs.length < lifetimeTurns
      ? ` · showing ${fmtNum(msgs.length)} of ${fmtNum(lifetimeTurns)} lifetime turns`
      : "";
  const subNote = subagentTurns
    ? ` · ${fmtNum(subagentTurns)} subagent turns (dimmed)`
    : state.sessionIncludeSubagents
      ? ""
      : " · main thread only";
  const groupNote = group ? ` · ${fmtNum(group.members.length)} linked sessions (${linkMode})` : "";
  // sessionId itself isn't repeated here — the filter chip above already shows it in full.
  document.getElementById("sessionDetailSubtitle").textContent =
    `${healthBadge(sessionId, { html: false })} ${linkBadge(sessionId, { html: false })} — ${fmtNum(msgs.length)} turns · ${fmtUsd(total)} total · ${fmtUsd(total / msgs.length)}/turn${scopeNote}${subNote}${groupNote}`;

  // Idle gaps >=1h between turns are where prompt caches expire and the next turn pays
  // to rewrite most of its context — mark the boundary so a cost spike lines up visibly
  // with the gap that caused it. Drawn as a canvas overlay (not a dataset) since the x
  // axis is a category scale indexed by turn #, not time.
  const GAP_THRESHOLD_MS = 60 * 60 * 1000;
  const gaps = [];
  for (let i = 1; i < msgs.length; i++) {
    const gapMs = new Date(msgs[i].timestamp) - new Date(msgs[i - 1].timestamp);
    if (gapMs >= GAP_THRESHOLD_MS) gaps.push({ afterIndex: i - 1, hours: gapMs / 3_600_000 });
  }

  // A turn whose cache-read dwarfs anything this session has shown before it didn't build
  // that cache itself — Anthropic's prompt cache is keyed by exact content, not session id,
  // so an identical prefix built by a DIFFERENT, concurrently-active session is a free read
  // here. Token counts for an identical prefix match almost exactly, so look for another
  // session with a turn shortly before this one whose total context is within ~0.5% of this
  // turn's cache-read — a coincidental match at that precision is effectively impossible.
  const DONOR_WINDOW_MS = 65 * 60 * 1000; // covers the 1h cache TTL
  const donors = new Map();
  for (let i = 0; i < msgs.length; i++) {
    const m = msgs[i];
    const priorMax = Math.max(0, ...msgs.slice(0, i).map((x) => x.tokens.cacheRead));
    if (m.tokens.cacheRead < 50_000 || m.tokens.cacheRead < priorMax * 1.5) continue;
    const target = m.tokens.cacheRead;
    const tTime = new Date(m.timestamp).getTime();
    let best = null;
    for (const other of data.messages) {
      if (other.sessionId === m.sessionId) continue;
      const ctx = other.tokens.cacheRead + other.tokens.cacheWrite5m + other.tokens.cacheWrite1h;
      if (Math.abs(ctx - target) > Math.max(50, target * 0.005)) continue;
      const dt = tTime - new Date(other.timestamp).getTime();
      if (dt < 0 || dt > DONOR_WINDOW_MS) continue;
      if (!best || dt < best.dt) best = { sessionId: other.sessionId, dt };
    }
    if (best) donors.set(i, best);
  }

  const forkSiblings = new Map();
  const firstRealIdx = msgs.findIndex((m) => !m.isSidechain && contextTokens(m.tokens) > 0);
  if (firstRealIdx !== -1) {
    const best = findForkSibling(msgs[firstRealIdx]);
    if (best) forkSiblings.set(firstRealIdx, best);
  }

  const gapLinePlugin = {
    id: "gapLines",
    afterDraw(chart) {
      if (!gaps.length) return;
      const { ctx, chartArea, scales } = chart;
      ctx.save();
      ctx.strokeStyle = "#ffa657";
      ctx.setLineDash([3, 3]);
      ctx.lineWidth = 1;
      for (const g of gaps) {
        const x =
          (scales.x.getPixelForValue(g.afterIndex) + scales.x.getPixelForValue(g.afterIndex + 1)) /
          2;
        ctx.beginPath();
        ctx.moveTo(x, chartArea.top);
        ctx.lineTo(x, chartArea.bottom);
        ctx.stroke();
      }
      ctx.restore();
    },
  };

  sessionDetailChart = new Chart(document.getElementById("sessionDetailChart"), {
    plugins: [gapLinePlugin],
    type: cumulative ? "line" : "bar",
    data: {
      labels: msgs.map((_, i) => i + 1),
      datasets,
    },
    options: {
      responsive: true,
      animation: false,
      interaction: { mode: "index", intersect: false },
      scales: {
        x: {
          stacked: true,
          title: { display: true, text: "turn #" },
          ticks: { maxTicksLimit: 20 },
        },
        y: {
          stacked: true,
          type: state.chartScale,
          ...(state.chartScale === "symlog" ? { linthresh: SYMLOG_THRESH } : {}),
          title: { display: true, text: unit.axisLabel },
          ticks: { callback: (v) => unit.fmt(v) },
        },
      },
      plugins: {
        legend: {
          position: "bottom",
          labels: {
            color: "#e6edf3",
            // The subagent copies reuse the same five colours (dimmed), so showing them
            // would just double the legend — the subtitle explains the dimming instead.
            filter: (item) => !item.text.endsWith("(subagent)"),
          },
        },
        tooltip: {
          mode: "index",
          intersect: false,
          itemSort: (a, b) => b.datasetIndex - a.datasetIndex,
          // Drop whichever thread is zero on this turn — except keep one placeholder item
          // (datasetIndex 0) on an all-zero turn that starts a gap, e.g. a $0 synthetic
          // marker turn, so the gap note in the footer still has a tooltip to attach to
          // instead of silently showing nothing on hover.
          filter: (item) =>
            item.parsed.y !== 0 ||
            (item.datasetIndex === 0 && gaps.some((g) => g.afterIndex + 1 === item.dataIndex)),
          callbacks: {
            // Each point is one action — show when it happened and what it did.
            title: (items) => {
              const m = msgs[items[0].dataIndex];
              const thread = m.isSidechain ? "subagent" : "main";
              const sessionNote = group ? ` · session ${m.sessionId.slice(0, 8)}` : "";
              return `turn ${items[0].dataIndex + 1} · ${thread}${sessionNote} · ${m.timestamp.slice(0, 19).replace("T", " ")}`;
            },
            label: (ctx) =>
              `${ctx.dataset.label.replace(" (subagent)", "")}: ${unit.fmt(ctx.parsed.y)}`,
            footer: (items) => {
              const idx = items[0].dataIndex;
              const m = msgs[idx];
              const tools = m.toolNames.length ? m.toolNames.join(", ") : "(no tool call)";
              const gap = gaps.find((g) => g.afterIndex + 1 === idx);
              const gapLine = gap
                ? `\n${gap.hours >= 24 ? `${(gap.hours / 24).toFixed(1)}d` : `${gap.hours.toFixed(1)}h`} idle gap before this turn`
                : "";
              const donor = donors.get(idx);
              const donorLine = donor
                ? `\ncache likely warmed by session ${donor.sessionId.slice(0, 8)} (${Math.round(donor.dt / 60_000)}m earlier)`
                : "";
              const fork = forkSiblings.get(idx);
              const forkLine = fork
                ? `\nlarge first-turn write — possible parallel session ${fork.sessionId.slice(0, 8)} in same project (${Math.round(fork.dt / 60_000)}m apart)`
                : "";
              return `${fmtUsd(m.cost.total)} this turn · effort ${m.effort}\ntools: ${tools}${gapLine}${donorLine}${forkLine}`;
            },
          },
        },
      },
    },
  });
}

// Each sort column ranks groups differently (verified against real data: sorting 92
// sessions by cost vs. $/turn overlaps only 17/25 in the top slice) — so the cap below
// is re-applied AFTER a fresh full sort on every click, not a frozen subset. Still, a
// cap this far below the session table's 30-row limit let fewer-clicked columns hide
// sessions the "Top sessions" table showed, reading as "sorting does nothing" — raised
// to comfortably exceed that and made explicit via the note below instead of silent.
const GROUP_TABLE_LIMIT = 50;

// Which cumulative (fork-linked) rows are expanded in the group table — ephemeral, not
// persisted: it's a view detail of the current table, not a filter or chart setting.
let expandedGroups = new Set();

/** "12/84" style cell when the filter is hiding part of a session's lifetime; otherwise
 * just the plain value — only shows the split when there's actually something to split. */
function scopedStat(filtered, lifetime) {
  const partial = filtered.turns < lifetime.turns;
  return {
    turns: partial ? `${fmtNum(filtered.turns)}/${fmtNum(lifetime.turns)}` : fmtNum(filtered.turns),
    cost: partial ? `${fmtUsd(filtered.cost)}/${fmtUsd(lifetime.cost)}` : fmtUsd(filtered.cost),
    tokens: partial ? `${fmtShort(filtered.tokens)}/${fmtShort(lifetime.tokens)}` : fmtShort(filtered.tokens),
  };
}

function renderGroupTable(messages, key) {
  const grouping = key === "sessionId" && state.groupLinkedSessions;
  const groups = new Map();
  for (const m of messages) {
    const raw = m[key] ?? "(none)";
    const info = grouping ? sessionGroups.get(raw) : undefined;
    const k = info ? info.main : raw;
    const g = groups.get(k) ?? { cost: 0, tokens: 0, turns: 0, members: info ? new Map() : null };
    g.cost += m.cost.total;
    g.tokens += tokenTotal(m);
    g.turns += 1;
    if (info) {
      const mg = g.members.get(raw) ?? { cost: 0, tokens: 0, turns: 0, inScope: true };
      mg.cost += m.cost.total;
      mg.tokens += tokenTotal(m);
      mg.turns += 1;
      g.members.set(raw, mg);
    }
    groups.set(k, g);
  }

  // A linked session with no turns inside the current date/month filter would otherwise
  // vanish from its own group instead of showing as dimmed zero — backfill it (zero
  // filtered stats; its lifetime stats come from sessionHealth at render time) so the
  // link stays visible regardless of which filter you're looking through. Not folded
  // into the cumulative row's totals above, which stay scoped to the current filter.
  if (grouping) {
    for (const g of groups.values()) {
      if (!g.members) continue;
      const { members } = sessionGroups.get([...g.members.keys()][0]);
      for (const sid of members) {
        if (!g.members.has(sid)) g.members.set(sid, { cost: 0, tokens: 0, turns: 0, inScope: false });
      }
    }
  }

  const s = state.sort.group;
  const sorted = sortEntries([...groups.entries()], GROUP_SORT_GETTERS, s.col, s.dir);
  const rows = sorted.slice(0, GROUP_TABLE_LIMIT);
  document.getElementById("groupTableNote").textContent =
    sorted.length > GROUP_TABLE_LIMIT ? `— showing top ${GROUP_TABLE_LIMIT} of ${fmtNum(sorted.length)}` : "";
  updateSortIndicators("groupTable", s);
  const tbody = document.querySelector("#groupTable tbody");
  tbody.innerHTML = rows
    .map(([k, g]) => {
      const selected = state.filters[key] === k ? "selected" : "";
      // Only worth a copy button for long opaque values (session IDs, project paths),
      // not short labels like "high" or "bg".
      const copyable = key === "sessionId" || key === "project";
      const badge = key === "sessionId" ? healthBadge(String(k)) + " " : "";
      if (!g.members) {
        // A chunk of filtered turns averaged on its own is a misleading $/turn — 3 turns
        // from a one-off spike reads nothing like the session's real behavior. $/turn is
        // always the LIFETIME average (sessionHealth, same number the badge uses); the
        // other columns show "in filter/lifetime" when the filter is hiding activity.
        const lifetime = key === "sessionId" ? sessionHealth.get(k) : undefined;
        const cells = lifetime ? scopedStat(g, lifetime) : scopedStat(g, g);
        const perTurn = lifetime?.turns ? fmtUsd(lifetime.cost / lifetime.turns) : fmtUsd(g.cost / g.turns);
        return `<tr data-key="${key}" data-value="${escapeAttr(k)}" class="${selected}"><td title="${escapeAttr(k)}">${badge}${shorten(String(k))}${copyable ? copyButton(String(k), `Copy ${key}`) : ""}</td><td class="num">${cells.cost}</td><td class="num">${cells.tokens}</td><td class="num">${cells.turns}</td><td class="num">${perTurn}</td></tr>`;
      }
      // Fork/resume-linked group: one cumulative row summing every member, expandable
      // into each member's own (already non-double-counted — collect.ts resolves each
      // transcript line to exactly one owning session) individual stats.
      const expanded = expandedGroups.has(k);
      const groupLifetime = [...g.members.keys()].reduce(
        (acc, sid) => {
          const h = sessionHealth.get(sid);
          if (h) {
            acc.cost += h.cost;
            acc.tokens += h.tokens;
            acc.turns += h.turns;
          }
          return acc;
        },
        { cost: 0, tokens: 0, turns: 0 },
      );
      const groupCells = scopedStat(g, groupLifetime);
      const groupPerTurn = groupLifetime.turns
        ? fmtUsd(groupLifetime.cost / groupLifetime.turns)
        : fmtUsd(g.cost / g.turns);
      const mainRow = `<tr data-key="${key}" data-value="${escapeAttr(k)}" class="${selected}"><td title="${escapeAttr(k)}"><button data-expand="${escapeAttr(k)}" title="${expanded ? "Collapse" : "Expand"} ${g.members.size} linked sessions">${expanded ? "▾" : "▸"}</button> ${badge}${shorten(String(k))} <span title="Sessions linked by a shared transcript (resume/fork copy) — summed here, individually below">🔗×${g.members.size}</span>${copyable ? copyButton(String(k), `Copy ${key}`) : ""}</td><td class="num">${groupCells.cost}</td><td class="num">${groupCells.tokens}</td><td class="num">${groupCells.turns}</td><td class="num">${groupPerTurn}</td></tr>`;
      if (!expanded) return mainRow;
      const memberRows = [...g.members.entries()]
        .sort((a, b) => b[1].cost - a[1].cost)
        .map(([sid, mg]) => {
          const role = sid === k ? "main" : "↳ dependant";
          const memberSelected = state.filters.sessionId === sid ? "selected" : "";
          const dim = mg.inScope === false;
          const lifetime = sessionHealth.get(sid) ?? { cost: 0, tokens: 0, turns: 0 };
          const cells = scopedStat(mg, lifetime);
          const perTurn = lifetime.turns ? fmtUsd(lifetime.cost / lifetime.turns) : "–";
          const scopeNote = dim
            ? ` <span title="No turns in the current date/month filter — showing its lifetime stats instead">(outside filter)</span>`
            : "";
          return `<tr data-key="sessionId" data-value="${escapeAttr(sid)}" class="${memberSelected}" style="${dim ? "opacity:0.55;" : ""}"><td title="${escapeAttr(sid)}" style="padding-left:28px;">${healthBadge(sid)} ${role} · ${shorten(sid)}${scopeNote}${copyButton(sid, "Copy session ID")}</td><td class="num">${cells.cost}</td><td class="num">${cells.tokens}</td><td class="num">${cells.turns}</td><td class="num">${perTurn}</td></tr>`;
        })
        .join("");
      return mainRow + memberRows;
    })
    .join("");
}

const TOOL_SORT_GETTERS = {
  key: (name) => name,
  calls: (name, g) => g.calls,
  bytes: (name, g) => g.bytes,
  tokens: (name, g) => estTokens(g.bytes),
  avgTokens: (name, g) => estTokens(g.bytes) / g.calls,
};

function renderToolTable(tools) {
  const groups = new Map();
  for (const t of tools) {
    const g = groups.get(t.toolName) ?? { calls: 0, bytes: 0 };
    g.calls += 1;
    g.bytes += t.bytes;
    groups.set(t.toolName, g);
  }
  const s = state.sort.tool;
  const rows = sortEntries([...groups.entries()], TOOL_SORT_GETTERS, s.col, s.dir).slice(0, 25);
  updateSortIndicators("toolTable", s);
  const tbody = document.querySelector("#toolTable tbody");
  tbody.innerHTML = rows
    .map(
      ([name, g]) =>
        `<tr><td>${name}</td><td class="num">${fmtNum(g.calls)}</td><td class="num">${fmtShort(g.bytes)}</td><td class="num">${fmtShort(estTokens(g.bytes))}</td><td class="num">${fmtShort(estTokens(g.bytes) / g.calls)}</td></tr>`,
    )
    .join("");
}

const dayCount = (a, b) => Math.round((new Date(b) - new Date(a)) / 86400000) + 1;
const SESSION_SORT_GETTERS = {
  key: (id) => id,
  project: (id, g) => g.project,
  turns: (id, g) => g.turns,
  tokens: (id, g) => g.tokens,
  tokensPerTurn: (id, g) => g.tokens / g.turns,
  days: (id, g) => dayCount(g.minDate, g.maxDate),
  input: (id, g) => g.input,
  cacheWrite: (id, g) => g.cacheWrite,
  cacheRead: (id, g) => g.cacheRead,
  output: (id, g) => g.output,
  total: (id, g) => g.total,
};

function renderSessionTable(messages) {
  const groups = new Map();
  for (const m of messages) {
    const g = groups.get(m.sessionId) ?? {
      project: m.project,
      turns: 0,
      tokens: 0,
      minDate: m.date,
      maxDate: m.date,
      input: 0,
      cacheWrite: 0,
      cacheRead: 0,
      output: 0,
      total: 0,
    };
    g.turns += 1;
    g.tokens += tokenTotal(m);
    if (m.date < g.minDate) g.minDate = m.date;
    if (m.date > g.maxDate) g.maxDate = m.date;
    g.input += m.cost.input;
    g.cacheWrite += m.cost.cacheWrite1h + m.cost.cacheWrite5m;
    g.cacheRead += m.cost.cacheRead;
    g.output += m.cost.output;
    g.total += m.cost.total;
    groups.set(m.sessionId, g);
  }
  const s = state.sort.session;
  const rows = sortEntries([...groups.entries()], SESSION_SORT_GETTERS, s.col, s.dir).slice(0, 30);
  updateSortIndicators("sessionTable", s);
  const tbody = document.querySelector("#sessionTable tbody");
  tbody.innerHTML = rows
    .map(([id, g]) => {
      const selected = state.filters.sessionId === id ? "selected" : "";
      return `<tr data-key="sessionId" data-value="${escapeAttr(id)}" class="${selected}"><td title="${id}">${healthBadge(id)} ${linkBadge(id)} ${id.slice(0, 8)}${copyButton(id, "Copy session ID")}</td><td title="${escapeAttr(g.project)}">${shorten(g.project, 40)}</td><td class="num">${fmtNum(g.turns)}</td><td class="num">${fmtShort(g.tokens)}</td><td class="num">${fmtShort(g.tokens / g.turns)}</td><td class="num">${dayCount(g.minDate, g.maxDate)}</td><td class="num">${fmtUsd(g.input)}</td><td class="num">${fmtUsd(g.cacheWrite)}</td><td class="num">${fmtUsd(g.cacheRead)}</td><td class="num">${fmtUsd(g.output)}</td><td class="num"><b>${fmtUsd(g.total)}</b></td></tr>`;
    })
    .join("");
}

function shorten(s, n = 28) {
  return s.length > n ? `…${s.slice(-n)}` : s;
}

/** Small inline copy-to-clipboard button; handled by the tables' click delegation. */
function copyButton(value, title) {
  return `<button class="copy-btn" data-copy="${escapeAttr(value)}" title="${escapeAttr(title)}">⧉</button>`;
}

/**
 * Clipboard write with a fallback: navigator.clipboard is the normal path (localhost
 * is a secure context), but it can be denied in some embedded/automated browsers —
 * fall back to a hidden textarea + execCommand so the button never silently throws.
 */
async function copyToClipboard(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    try {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand("copy");
      ta.remove();
      return ok;
    } catch {
      return false;
    }
  }
}

function escapeAttr(s) {
  return String(s).replace(/"/g, "&quot;");
}

// Event delegation: any row with data-key/data-value toggles that dimension's filter.
// Filters are additive across different keys (project AND sessionId can both be set);
// clicking the same value again for the same key clears just that key.
for (const id of ["sessionTable", "groupTable"]) {
  document.getElementById(id).addEventListener("click", async (e) => {
    // Copy button sits inside a filterable row — handle it first and swallow the
    // click, otherwise copying would also toggle the row's filter.
    const copyBtn = e.target.closest("button[data-copy]");
    if (copyBtn) {
      e.stopPropagation();
      const ok = await copyToClipboard(copyBtn.dataset.copy);
      const original = copyBtn.textContent;
      copyBtn.textContent = ok ? "✓" : "✗";
      setTimeout(() => (copyBtn.textContent = original), 1000);
      return;
    }
    const expandBtn = e.target.closest("button[data-expand]");
    if (expandBtn) {
      e.stopPropagation();
      const k = expandBtn.dataset.expand;
      if (expandedGroups.has(k)) expandedGroups.delete(k);
      else expandedGroups.add(k);
      renderGroupTable(filteredMessages(), state.groupBy);
      return;
    }
    const row = e.target.closest("tbody tr[data-key]");
    if (!row) return;
    toggleFilter(row.dataset.key, row.dataset.value);
  });
}

wireSortable("groupTable", "group", () => renderGroupTable(filteredMessages(), state.groupBy));
wireSortable("toolTable", "tool", () => renderToolTable(filteredTools()));
wireSortable("sessionTable", "session", () => renderSessionTable(monthScopedMessages()));

document.getElementById("filterBar").addEventListener("click", (e) => {
  const clearBtn = e.target.closest("button[data-clear-key]");
  if (clearBtn) {
    if (clearBtn.dataset.clearKey === "__month") {
      state.month = null;
      document.getElementById("monthSelect").value = "";
      persistState();
      render();
    } else {
      clearFilter(clearBtn.dataset.clearKey);
    }
    return;
  }
  if (e.target.id === "clearAllBtn") clearFilter();
});

document.getElementById("groupBySelect").addEventListener("change", (e) => {
  state.groupBy = e.target.value;
  persistState();
  renderGroupTable(filteredMessages(), state.groupBy);
});

function setGroupLinkedSessions(grouped) {
  state.groupLinkedSessions = grouped;
  document.getElementById("groupLinkedOn").classList.toggle("active", grouped);
  document.getElementById("groupLinkedOff").classList.toggle("active", !grouped);
  persistState();
  renderGroupTable(filteredMessages(), state.groupBy);
  renderSessionDetailChart();
}
document.getElementById("groupLinkedOn").addEventListener("click", () => setGroupLinkedSessions(true));
document
  .getElementById("groupLinkedOff")
  .addEventListener("click", () => setGroupLinkedSessions(false));

function setSessionLinkMode(mode) {
  state.sessionChartLinkMode = mode;
  document.getElementById("sessionLinkGrafted").classList.toggle("active", mode === "grafted");
  document.getElementById("sessionLinkStacked").classList.toggle("active", mode === "stacked");
  persistState();
  renderSessionDetailChart();
}
document
  .getElementById("sessionLinkGrafted")
  .addEventListener("click", () => setSessionLinkMode("grafted"));
document
  .getElementById("sessionLinkStacked")
  .addEventListener("click", () => setSessionLinkMode("stacked"));

function rerenderSpendChart() {
  renderSpendChart(data.messages, filteredMessages());
}

function setChartMode(mode) {
  state.chartMode = mode;
  document.getElementById("modeDaily").classList.toggle("active", mode === "daily");
  document.getElementById("modeCumulative").classList.toggle("active", mode === "cumulative");
  persistState();
  rerenderSpendChart();
}

function setChartUnit(unit) {
  state.chartUnit = unit;
  syncUnitButtons();
  persistState();
  rerenderSpendChart();
  renderSessionDetailChart(); // shares the unit toggle
}

function setChartScale(scale) {
  state.chartScale = scale;
  document.getElementById("scaleLinear").classList.toggle("active", scale === "linear");
  document.getElementById("scaleSymlog").classList.toggle("active", scale === "symlog");
  persistState();
  rerenderSpendChart();
  renderSessionDetailChart(); // shares the scale toggle
}

function setSessionDetailMode(mode) {
  state.sessionDetailMode = mode;
  document.getElementById("sessionDetailPerTurn").classList.toggle("active", mode === "perTurn");
  document
    .getElementById("sessionDetailCumulative")
    .classList.toggle("active", mode === "cumulative");
  persistState();
  renderSessionDetailChart();
}

document
  .getElementById("sessionDetailPerTurn")
  .addEventListener("click", () => setSessionDetailMode("perTurn"));
document
  .getElementById("sessionDetailCumulative")
  .addEventListener("click", () => setSessionDetailMode("cumulative"));

function setSessionThread(includeSubagents) {
  state.sessionIncludeSubagents = includeSubagents;
  document.getElementById("sessionThreadAll").classList.toggle("active", includeSubagents);
  document.getElementById("sessionThreadMain").classList.toggle("active", !includeSubagents);
  persistState();
  renderSessionDetailChart();
}

document.getElementById("sessionThreadAll").addEventListener("click", () => setSessionThread(true));
document
  .getElementById("sessionThreadMain")
  .addEventListener("click", () => setSessionThread(false));
// Session-card unit buttons drive the same shared state as the main chart's toggle.
document.getElementById("sessionUnitUsd").addEventListener("click", () => setChartUnit("usd"));
document
  .getElementById("sessionUnitTokens")
  .addEventListener("click", () => setChartUnit("tokens"));

document.getElementById("scaleLinear").addEventListener("click", () => setChartScale("linear"));
document.getElementById("scaleSymlog").addEventListener("click", () => setChartScale("symlog"));

document.getElementById("monthSelect").addEventListener("change", (e) => {
  state.month = e.target.value || null;
  persistState();
  render(); // month now scopes the tables too, not just the chart
});
document.getElementById("modeDaily").addEventListener("click", () => setChartMode("daily"));
document
  .getElementById("modeCumulative")
  .addEventListener("click", () => setChartMode("cumulative"));
document.getElementById("unitUsd").addEventListener("click", () => setChartUnit("usd"));
document.getElementById("unitTokens").addEventListener("click", () => setChartUnit("tokens"));
document.getElementById("unitTurns").addEventListener("click", () => setChartUnit("turns"));

document.getElementById("copyLinkBtn").addEventListener("click", async () => {
  const btn = document.getElementById("copyLinkBtn");
  const ok = await copyToClipboard(location.href);
  const original = btn.textContent;
  btn.textContent = ok ? "✓ Copied" : "✗ Failed";
  setTimeout(() => (btn.textContent = original), 1000);
});

document.getElementById("refreshBtn").addEventListener("click", async () => {
  document.getElementById("refreshBtn").textContent = "Scanning…";
  await fetch("/api/refresh", { method: "POST" });
  await load();
  document.getElementById("refreshBtn").textContent = "Refresh data";
});

load();
