import { useState, useEffect, useMemo } from "react";
import {
  AreaChart, Area, XAxis, YAxis, Tooltip, CartesianGrid,
  ResponsiveContainer, ReferenceLine,
} from "recharts";
import {
  Plus, Trash2, Pencil, AlertTriangle, Sparkles, Zap,
  RotateCcw, X, Flame, Snowflake, Wallet, PartyPopper,
  Banknote, Receipt, ClipboardList, Gavel, Repeat, ChevronDown,
  ScrollText, Download, Upload, Copy, CheckCheck, FlaskConical,
} from "lucide-react";

/* ────────────────────────── palette & type ────────────────────────── */
const C = {
  bg: "#120b10",
  card: "#1a1016",
  card2: "#150d12",
  line: "#332132",
  line2: "#241622",
  text: "#f3e9ee",
  mut: "#9b8391",
  faint: "#6b5564",
  rose: "#fb7185",
  roseDeep: "#a14060",
  roseDim: "#2e1a23",
  cel: "#7ed4b2",
  celDim: "#16241f",
  gold: "#e0b15e",
  goldDim: "#2a2014",
  ink: "#140b10",
};
const serif = { fontFamily: "'Iowan Old Style','Palatino Linotype',Palatino,Georgia,serif" };
const mono = { fontFamily: "ui-monospace,'SF Mono',Menlo,Consolas,monospace", fontVariantNumeric: "tabular-nums" };

/* ────────────────────────── constants ────────────────────────── */
const KEY = "sophie-debt-zero-v4";
const OLD_KEYS = ["sophie-debt-zero-v3", "sophie-debt-zero-v2", "sophie-debt-zero-v1"];
const CURRENCIES = ["PHP", "USD", "JPY", "EUR", "GBP", "SGD", "AUD", "KRW", "INR"];
const ATTACK_APR = 12;
const TABS = [
  { id: "now", jp: "今", en: "Now" },
  { id: "road", jp: "道", en: "Road" },
  { id: "ledger", jp: "帳", en: "Ledger" },
];

const DEFAULT_STATE = {
  currency: "PHP",
  payMode: "monthly",
  income: 40000,
  incomeA: 20000,
  incomeB: 20000,
  expenses: [],
  strategy: "avalanche",
  savingsSplit: 25,
  fundSplit: 100,
  previewMonths: 6,
  emergencyFirst: true,
  emergencyTarget: 50000,
  currentSavings: 0,
  receipts: {},
  actuals: {},
  debts: [],
  events: [],
};

const SAMPLE = {
  income: 45000, incomeA: 22500, incomeB: 22500,
  expenses: [
    { name: "Rent", amount: 12000, cutoff: "2" },
    { name: "Food", amount: 9000, cutoff: "split" },
    { name: "Utilities + net", amount: 3500, cutoff: "1" },
    { name: "Transport", amount: 2500, cutoff: "split" },
  ],
  debts: [
    { name: "Credit card", balance: 85000, apr: 42, minPayment: 4500, dueDay: 20, oneTime: false },
    { name: "Personal loan", balance: 120000, apr: 18, minPayment: 5600, dueDay: 5, oneTime: false },
    { name: "Owe Migs (one-time)", balance: 8000, apr: 0, minPayment: 0, dueDay: 25, oneTime: true },
  ],
};

/* ────────────────────────── helpers ────────────────────────── */
const uid = () =>
  typeof crypto !== "undefined" && crypto.randomUUID
    ? crypto.randomUUID()
    : Math.random().toString(36).slice(2) + Date.now().toString(36);

const r2 = (x) => Math.round(x * 100) / 100;
const pos = (v) => { const n = parseFloat(v); return Number.isFinite(n) && n > 0 ? n : 0; };
const nn = (v) => { const n = parseFloat(v); return Number.isFinite(n) && n >= 0 ? n : 0; };
const ord = (n) => { const s = ["th", "st", "nd", "rd"], v = n % 100; return n + (s[(v - 20) % 10] || s[v] || s[0]); };

const monthName = (offset) => {
  const d = new Date();
  const t = new Date(d.getFullYear(), d.getMonth() + offset, 1);
  return `${t.toLocaleString("en", { month: "short" })} ’${String(t.getFullYear()).slice(2)}`;
};
const monthLabel = (offset) => (offset === 0 ? "Now" : monthName(offset));

// mandatory due this month: recurring → its minimum; deadlined one-time → the whole thing,
// paid before the savings split. One-time debts WITHOUT a deadline have no due — the attack pool settles those.
const minOf = (d) => (d.oneTime ? (d.dueDay ? d.balance : 0) : Math.min(d.minPayment, d.balance));

// attack priority: deadlined one-time bills jump the queue, then strategy order
const attackCmp = (strategy, balKey = "balance") => (a, b) => {
  const ap = a.oneTime && a.dueDay ? 0 : 1;
  const bp = b.oneTime && b.dueDay ? 0 : 1;
  if (ap !== bp) return ap - bp;
  if (ap === 0) return (a.dueDay - b.dueDay) || (a[balKey] - b[balKey]);
  return strategy === "avalanche"
    ? (b.apr - a.apr) || (a[balKey] - b[balKey])
    : (a[balKey] - b[balKey]) || (b.apr - a.apr);
};

// stable identifier for the current pay cycle of a given cutoff (0 = monthly)
const cycleKeyFor = (cut) => {
  const n = new Date();
  const y = n.getFullYear(), m = n.getMonth(), day = n.getDate();
  if (cut === 0) return `m:${y}-${m}`;
  if (cut === 1) {
    const d = day <= 15 ? new Date(y, m, 15) : new Date(y, m + 1, 15);
    return `c1:${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
  }
  const last = new Date(y, m + 1, 0).getDate();
  return `c2:${y}-${m}-${last}`;
};

/* ────────────────────────── simulation (long road) ────────────────────────── */
function simulate(state, budget, shift = 0, firstBudget = null, prePaid = {}) {
  const debts = state.debts.map((d) => ({
    id: d.id, name: d.name, apr: d.apr, oneTime: !!d.oneTime, dueDay: d.dueDay || null,
    min: minOf(d), bal: d.balance, interest: 0, payoffMonth: null,
  }));
  let sav = state.currentSavings;
  let savAtFree = state.currentSavings;
  let totalInterest = 0;
  let debtFreeMonth = debts.length === 0 ? 0 : null;
  let efMonth = state.emergencyTarget > 0 && sav >= state.emergencyTarget ? 0 : null;
  const rows = [{ m: 0, label: "Now", debt: Math.round(debts.reduce((s, d) => s + d.bal, 0)), savings: Math.round(sav) }];
  const schedule = [];
  const MAX = 600;

  for (let m = 1; m <= MAX; m++) {
    if (debtFreeMonth !== null && m > debtFreeMonth + 12) break;
    const active = () => debts.filter((d) => d.bal > 0.005);

    const intM = {};
    for (const d of active()) {
      const i = (d.bal * d.apr) / 1200;
      d.bal += i; d.interest += i; totalInterest += i;
      if (i > 0.005) intM[d.id] = i;
    }

    const minM = {};
    const extraM = {};
    let pool = m === 1 && firstBudget != null ? firstBudget : budget;
    for (const d of active()) {
      const due = m === 1 && !d.oneTime ? Math.max(0, d.min - (prePaid[d.id] || 0)) : d.min;
      const pay = Math.min(due, d.bal, pool);
      d.bal -= pay; pool -= pay;
      if (pay > 0.005) minM[d.id] = (minM[d.id] || 0) + pay;
    }

    let toSav = 0, attack = 0;
    if (active().length === 0) {
      toSav = pool;
    } else if (state.emergencyFirst && sav < state.emergencyTarget) {
      const fs = state.fundSplit == null ? 100 : state.fundSplit;
      toSav = Math.min((pool * fs) / 100, state.emergencyTarget - sav);
      attack = pool - toSav;
    } else {
      toSav = (pool * state.savingsSplit) / 100;
      attack = pool - toSav;
    }

    const order = active().sort(attackCmp(state.strategy, "bal"));
    for (const d of order) {
      if (attack <= 0.005) break;
      const pay = Math.min(attack, d.bal);
      d.bal -= pay; attack -= pay;
      if (pay > 0.005) extraM[d.id] = (extraM[d.id] || 0) + pay;
    }
    toSav += attack;
    sav += toSav;

    for (const d of debts) {
      if (d.bal <= 0.005 && d.payoffMonth === null) { d.bal = 0; d.payoffMonth = m; }
    }
    const totalDebt = debts.reduce((s, d) => s + d.bal, 0);
    if (totalDebt <= 0.005 && debtFreeMonth === null) { debtFreeMonth = m; savAtFree = sav; }
    if (efMonth === null && state.emergencyTarget > 0 && sav >= state.emergencyTarget) efMonth = m;
    rows.push({ m, label: monthName(m - shift), debt: Math.round(totalDebt), savings: Math.round(sav) });
    schedule.push({
      m, label: monthName(m - shift),
      pays: debts
        .filter((d) => (minM[d.id] || 0) + (extraM[d.id] || 0) > 0.005)
        .map((d) => ({
          id: d.id, name: d.name, oneTime: d.oneTime,
          min: r2(minM[d.id] || 0), extra: r2(extraM[d.id] || 0),
          amount: r2((minM[d.id] || 0) + (extraM[d.id] || 0)),
          interest: r2(intM[d.id] || 0), after: r2(Math.max(0, d.bal)),
        })),
      intTotal: r2(Object.values(intM).reduce((s, x) => s + x, 0)),
      toSav: r2(toSav),
      savAfter: r2(sav),
      payoffs: debts.filter((d) => d.payoffMonth === m).map((d) => d.name),
    });
  }
  return { rows, schedule, debts, debtFreeMonth, totalInterest, finalSavings: sav, savAtFree, efMonth };
}

function baselineMinOnly(state) {
  const debts = state.debts.map((d) => ({ bal: d.balance, apr: d.apr, min: minOf(d) }));
  let interest = 0;
  for (let m = 1; m <= 600; m++) {
    const act = debts.filter((d) => d.bal > 0.005);
    if (!act.length) return { months: m - 1, interest };
    for (const d of act) {
      const i = (d.bal * d.apr) / 1200;
      d.bal += i; interest += i;
      const pay = Math.min(d.min, d.bal);
      d.bal -= pay;
    }
  }
  return { months: null, interest };
}

/* ────────────────────────── the scroll: markdown import ────────────────────────── */
function parseScroll(text) {
  const lower = (s) => String(s || "").toLowerCase();
  const lines = String(text || "").split(/\r?\n/);
  const sections = {};
  let cur = "_pre";
  for (const ln of lines) {
    const h = ln.match(/^##\s+(.+?)\s*$/);
    if (h) { cur = lower(h[1]).replace(/\(read-only\)/g, "").trim(); sections[cur] = sections[cur] || []; continue; }
    (sections[cur] = sections[cur] || []).push(ln);
  }
  const tableRows = (sec) => {
    const out = [];
    for (const ln of sec || []) {
      const t = ln.trim();
      if (!t.startsWith("|")) continue;
      if (/^\|[\s\-:|]+\|?$/.test(t)) continue;
      out.push(t.split("|").slice(1, -1).map((c) => c.trim()));
    }
    return out.slice(1);
  };
  const numCell = (c) => {
    const cleaned = String(c == null ? "" : c).replace(/[^0-9.\-]/g, "");
    if (cleaned === "" || cleaned === "-") return null;
    const n = parseFloat(cleaned);
    return Number.isFinite(n) ? n : null;
  };

  const patch = {};
  const found = [];

  const setRows = tableRows(sections["settings"]);
  if (setRows.length) {
    for (const r of setRows) {
      const key = lower(r[0]), v = r[1];
      if (!key) continue;
      if (key.includes("currency")) { const c = String(v || "").toUpperCase().trim(); if (CURRENCIES.includes(c)) patch.currency = c; }
      else if (key.includes("pay mode")) patch.payMode = lower(v).includes("semi") ? "semi" : "monthly";
      else if (key.includes("15th")) { const n = numCell(v); if (n !== null) patch.incomeA = n; }
      else if (key.includes("30th")) { const n = numCell(v); if (n !== null) patch.incomeB = n; }
      else if (key.includes("income")) { const n = numCell(v); if (n !== null) patch.income = n; }
      else if (key.includes("current savings")) { const n = numCell(v); if (n !== null) patch.currentSavings = n; }
      else if (key.includes("strategy")) patch.strategy = lower(v).includes("snow") ? "snowball" : "avalanche";
      else if (key.includes("fund-building") || key.includes("fund split")) { const n = numCell(v); if (n !== null) patch.fundSplit = Math.max(0, Math.min(100, n)); }
      else if (key.includes("split")) { const n = numCell(v); if (n !== null) patch.savingsSplit = Math.max(0, Math.min(100, n)); }
      else if (key.includes("fund first")) patch.emergencyFirst = /yes|true|on|1/.test(lower(v));
      else if (key.includes("target")) { const n = numCell(v); if (n !== null) patch.emergencyTarget = n; }
      else if (key.includes("preview")) { const n = numCell(v); if (n !== null) patch.previewMonths = Math.max(1, Math.min(24, Math.round(n))); }
    }
    found.push("settings");
  }

  if (sections["living expenses"]) {
    patch.expenses = tableRows(sections["living expenses"])
      .filter((r) => r[0] && r[0] !== "—")
      .map((r) => ({
        id: uid(), name: r[0], amount: numCell(r[1]) || 0,
        cutoff: lower(r[2]).includes("15") ? "1" : lower(r[2]).includes("30") ? "2" : "split",
      }));
    found.push(`${patch.expenses.length} expenses`);
  }

  if (sections["debts"]) {
    patch.debts = tableRows(sections["debts"])
      .filter((r) => r[0] && r[0] !== "—")
      .map((r) => {
        const oneTime = lower(r[1]).includes("one");
        const balance = numCell(r[2]) || 0;
        const orig = numCell(r[3]);
        const dd = numCell(r[6]);
        return {
          id: uid(), name: r[0], oneTime,
          balance, startBalance: Math.max(orig || balance, balance),
          apr: numCell(r[4]) || 0,
          minPayment: oneTime ? 0 : (numCell(r[5]) || 0),
          dueDay: dd !== null && dd >= 1 && dd <= 31 ? Math.round(dd) : null,
        };
      })
      .filter((d) => d.balance > 0);
    found.push(`${patch.debts.length} debts`);
  }

  if (sections["history"]) {
    const evs = [];
    for (const ln of sections["history"]) {
      const m = ln.match(/^\s*-\s*(\d{4}-\d{2}-\d{2})\s*[—-]+\s*(.+)$/);
      if (m) evs.push({ id: uid(), ts: Date.parse(m[1]) || Date.now(), text: m[2].trim() });
    }
    if (evs.length) { patch.events = evs.slice(0, 30); found.push(`${evs.length} history lines`); }
  }

  if (!found.length) return { error: "No Settings / Living expenses / Debts tables in that. Is this even my scroll, oniichan?" };
  return { patch, summary: found.join(", ") };
}

/* ────────────────────────── tiny UI atoms ────────────────────────── */
const Eyebrow = ({ jp, en }) => (
  <div className="flex items-baseline gap-2 mb-3">
    <span className="text-sm" style={{ ...serif, color: C.rose }}>{jp}</span>
    <span className="text-xs uppercase" style={{ color: C.faint, letterSpacing: "0.2em" }}>{en}</span>
  </div>
);

const Card = ({ children, dashed, accent }) => (
  <div
    className="rounded-2xl p-4"
    style={{ background: C.card, border: `1px ${dashed ? "dashed" : "solid"} ${accent || C.line}` }}
  >
    {children}
  </div>
);

const FieldLabel = ({ children }) => (
  <div className="text-xs uppercase mb-1" style={{ color: C.faint, letterSpacing: "0.15em" }}>{children}</div>
);

const Chip = ({ children, color }) => (
  <span className="rounded-full px-2 text-xs" style={{ border: `1px solid ${C.line}`, color: color || C.mut, background: C.card2, paddingTop: 1, paddingBottom: 1 }}>
    {children}
  </span>
);

const inputStyle = {
  background: C.bg, border: `1px solid ${C.line}`, color: C.text,
  borderRadius: "10px", padding: "8px 10px", fontSize: "14px", width: "100%",
};

/* ────────────────────────── main app ────────────────────────── */
export default function App() {
  const [state, setState] = useState(DEFAULT_STATE);
  const [loaded, setLoaded] = useState(false);
  const [view, setView] = useState("now");
  const [form, setForm] = useState({ id: null, name: "", balance: "", apr: "", min: "", dueDay: "", oneTime: false });
  const [formErr, setFormErr] = useState("");
  const [panel, setPanel] = useState(null);
  const [evt, setEvt] = useState({ amount: "", dest: "smart", note: "", coverDebt: true, income: "", incomeB: "" });
  const [confirmReset, setConfirmReset] = useState(false);
  const [done, setDone] = useState({});
  const [openMonths, setOpenMonths] = useState({ 1: true });
  const [whatIfExtra, setWhatIfExtra] = useState(2000);
  const [scroll, setScroll] = useState(null);
  const [scrollText, setScrollText] = useState("");
  const [scrollMsg, setScrollMsg] = useState("");

  /* ── persistence + migration chain ── */
  useEffect(() => {
    (async () => {
      try {
        if (typeof window !== "undefined" && window.storage) {
          let parsed = null;
          for (const k of [KEY, ...OLD_KEYS]) {
            try {
              const r = await window.storage.get(k);
              if (r && r.value) { parsed = JSON.parse(r.value); break; }
            } catch (e) { /* keep looking */ }
          }
          if (parsed) {
            const income = parsed.income ?? parsed.monthlyBudget ?? DEFAULT_STATE.income;
            setState((s) => ({
              ...DEFAULT_STATE, ...parsed,
              income,
              payMode: parsed.payMode || "monthly",
              incomeA: parsed.incomeA ?? Math.round(income / 2),
              incomeB: parsed.incomeB ?? income - Math.round(income / 2),
              expenses: (parsed.expenses || []).map((x) => ({ id: x.id || uid(), cutoff: x.cutoff || "split", ...x })),
              debts: (parsed.debts || []).map((d) => ({
                startBalance: d.balance, oneTime: false, dueDay: null, ...d,
              })),
            }));
          }
        }
      } catch (e) { /* fresh start */ }
      setLoaded(true);
    })();
  }, []);

  useEffect(() => {
    if (!loaded) return;
    const t = setTimeout(async () => {
      try {
        if (typeof window !== "undefined" && window.storage) {
          await window.storage.set(KEY, JSON.stringify(state));
        }
      } catch (e) { console.error("save failed", e); }
    }, 600);
    return () => clearTimeout(t);
  }, [state, loaded]);

  /* ── formatting ── */
  const fmt = (n) =>
    new Intl.NumberFormat("en", { style: "currency", currency: state.currency, maximumFractionDigits: 0 })
      .format(Math.round(n || 0));
  const fmtCompact = (n) =>
    new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 }).format(n);

  /* ── the money waterfall ── */
  const semi = state.payMode === "semi";
  const livingTotal = state.expenses.reduce((s, x) => s + (x.amount || 0), 0);
  const expFor = (cut) =>
    state.expenses.reduce((s, x) => {
      const c = x.cutoff || "split";
      if (c === cut) return s + (x.amount || 0);
      if (c === "split") return s + (x.amount || 0) / 2;
      return s;
    }, 0);
  const exp1 = semi ? expFor("1") : 0;
  const exp2 = semi ? expFor("2") : 0;
  const incomeTotal = semi ? state.incomeA + state.incomeB : state.income;
  const avail1 = semi ? Math.max(0, state.incomeA - exp1) : 0;
  const avail2 = semi ? Math.max(0, state.incomeB - exp2) : 0;
  const available = semi ? avail1 + avail2 : Math.max(0, state.income - livingTotal);
  const overspending = incomeTotal - livingTotal < -0.005;
  const cutOver1 = semi && state.incomeA - exp1 < -0.005;
  const cutOver2 = semi && state.incomeB - exp2 < -0.005;

  /* ── derived plans ── */
  // money already deployed this cycle (frozen receipts) shouldn't be double-counted in month 1
  const recValidNow = (cut) => { const r = state.receipts && state.receipts[cut]; return !!(r && r.key === cycleKeyFor(cut)); };
  const prePaidNow = useMemo(() => {
    const map = {};
    [0, 1, 2].forEach((c) => {
      const r = state.receipts && state.receipts[c];
      if (r && r.key === cycleKeyFor(c)) Object.entries(r.paid || {}).forEach(([id, amt]) => { map[id] = r2((map[id] || 0) + amt); });
    });
    return map;
  }, [state.receipts]);
  const remainingThisCycle = semi
    ? (recValidNow(1) ? 0 : avail1) + (recValidNow(2) ? 0 : avail2)
    : (recValidNow(0) ? 0 : available);
  const sim = useMemo(
    () => simulate(state, available, semi ? 1 : 0, remainingThisCycle, prePaidNow),
    [state, available, semi, remainingThisCycle, prePaidNow]
  );
  const mLabel = (m) => monthName(m - (semi ? 1 : 0));
  const base = useMemo(() => baselineMinOnly(state), [state]);

  const minSum = state.debts.reduce((s, d) => s + minOf(d), 0);
  const underfunded = minSum > available + 0.005;
  const spirals = state.debts.filter((d) => !d.oneTime && d.minPayment < (d.balance * d.apr) / 1200 - 0.005);
  const totalDebtNow = state.debts.reduce((s, d) => s + d.balance, 0);
  const totalStartNow = state.debts.reduce((s, d) => s + (d.startBalance || d.balance), 0);
  const destroyedPct = totalStartNow > 0 ? Math.min(100, Math.max(0, Math.round((1 - totalDebtNow / totalStartNow) * 100))) : 0;

  const fundFirstActive = state.emergencyFirst && state.currentSavings < state.emergencyTarget;

  /* ── pay-cycle receipts & actual salaries ── */
  const receiptFor = (cut) => {
    const r = state.receipts && state.receipts[cut];
    return r && r.key === cycleKeyFor(cut) ? r : null;
  };
  const actualFor = (cut) => {
    const a = state.actuals && state.actuals[cut];
    return a && a.key === cycleKeyFor(cut) && a.amount > 0 ? a.amount : null;
  };
  const setActual = (cut, val) =>
    setState((s) => {
      const next = { ...s, actuals: { ...(s.actuals || {}) } };
      const n = parseFloat(val);
      if (val === "" || !Number.isFinite(n) || n < 0) delete next.actuals[cut];
      else next.actuals[cut] = { key: cycleKeyFor(cut), amount: n };
      return next;
    });

  /* ── this month's concrete orders ── */
  const orders = useMemo(() => {
    const active = state.debts.filter((d) => d.balance > 0);
    const cmp = attackCmp(state.strategy);
    const lines = [];
    const minPaid = {};
    let shortLate = 0;
    let shortTotal = 0;
    let pool1, pool2;

    // receipts freeze applied paydays; actuals override planned salary for this cycle
    const rec0 = receiptFor(0), rec1 = receiptFor(1), rec2 = receiptFor(2);
    const prePaid = {};
    [rec0, rec1, rec2].forEach((r) => {
      if (!r) return;
      Object.entries(r.paid || {}).forEach(([id, amt]) => { prePaid[id] = r2((prePaid[id] || 0) + amt); });
    });
    // remaining mandatory due this cycle (one-time dues are balance-driven, already reduced by payments)
    const dueLeft = (d) => (d.oneTime ? minOf(d) : Math.max(0, minOf(d) - (prePaid[d.id] || 0)));
    const oAvail0 = !semi ? Math.max(0, (actualFor(0) ?? state.income) - livingTotal) : 0;
    const oAvail1 = semi ? Math.max(0, (actualFor(1) ?? state.incomeA) - exp1) : 0;
    const oAvail2 = semi ? Math.max(0, (actualFor(2) ?? state.incomeB) - exp2) : 0;

    const push = (d, amount, cutoff, kind) => {
      if (amount <= 0.005) return;
      const ex = lines.find((l) => l.id === d.id && l.cutoff === cutoff && l.kind === kind);
      if (ex) ex.amount = r2(ex.amount + amount);
      else lines.push({ key: `${d.id}:${cutoff}:${kind}`, id: d.id, name: d.name, cutoff, kind, amount: r2(amount), dueDay: d.dueDay || null, oneTime: !!d.oneTime });
    };

    if (!semi) {
      pool1 = rec0 ? 0 : oAvail0; pool2 = 0;
      for (const d of [...active].sort(cmp)) {
        const want = dueLeft(d);
        if (want <= 0) continue;
        const pay = Math.min(want, Math.max(0, pool1));
        minPaid[d.id] = pay;
        push(d, pay, 0, "min");
        pool1 -= want;
      }
      if (pool1 < 0) { shortTotal = -pool1; pool1 = 0; }
    } else {
      pool1 = rec1 ? 0 : oAvail1; pool2 = rec2 ? 0 : oAvail2;
      const need1 = [], need2 = [], flex = [];
      for (const d of active) {
        const w = dueLeft(d);
        if (w <= 0) continue;
        if (!d.dueDay) flex.push({ d, w });
        else if (d.dueDay >= 16) need1.push({ d, w });
        else need2.push({ d, w });
      }
      for (const { d, w } of need1) {
        const pay = Math.min(w, pool1);
        pool1 -= pay; minPaid[d.id] = (minPaid[d.id] || 0) + pay;
        push(d, pay, 1, "min");
        if (w - pay > 0.005) shortLate += w - pay;
      }
      for (const { d, w } of need2) {
        let rem = w;
        const p2 = Math.min(rem, pool2); pool2 -= p2; rem -= p2; push(d, p2, 2, "min");
        if (rem > 0.005) {
          const e = Math.min(rem, pool1); pool1 -= e; rem -= e; push(d, e, 1, "min-early");
        }
        minPaid[d.id] = (minPaid[d.id] || 0) + (w - rem);
        if (rem > 0.005) shortTotal += rem;
      }
      for (const { d, w } of flex) {
        let rem = w;
        const order = pool1 >= pool2 ? [1, 2] : [2, 1];
        for (const c of order) {
          if (rem <= 0.005) break;
          const take = Math.min(rem, c === 1 ? pool1 : pool2);
          if (c === 1) pool1 -= take; else pool2 -= take;
          rem -= take; push(d, take, c, "min");
        }
        minPaid[d.id] = (minPaid[d.id] || 0) + (w - rem);
        if (rem > 0.005) shortTotal += rem;
      }
    }

    let extraTotal = pool1 + pool2;
    let toSav = 0, attack = 0;
    if (active.length === 0) {
      toSav = extraTotal;
    } else if (fundFirstActive) {
      const fs = state.fundSplit == null ? 100 : state.fundSplit;
      toSav = Math.min((extraTotal * fs) / 100, state.emergencyTarget - state.currentSavings);
      attack = extraTotal - toSav;
    } else {
      toSav = (extraTotal * state.savingsSplit) / 100;
      attack = extraTotal - toSav;
    }

    const extras = [];
    let a = attack;
    for (const d of [...active].sort(cmp)) {
      if (a <= 0.005) break;
      const room = d.balance - (minPaid[d.id] || 0);
      const pay = Math.min(a, Math.max(0, room));
      if (pay > 0.005) { extras.push({ d, amt: pay }); a -= pay; }
    }
    toSav += a;

    for (const { d, amt } of extras) {
      let rem = amt;
      const t1 = Math.min(rem, pool1);
      if (t1 > 0.005) { pool1 -= t1; rem -= t1; push(d, t1, semi ? 1 : 0, d.oneTime ? "one-time" : "attack"); }
      if (rem > 0.005 && semi) {
        const t2 = Math.min(rem, pool2);
        if (t2 > 0.005) { pool2 -= t2; rem -= t2; push(d, t2, 2, d.oneTime ? "one-time" : "attack"); }
      }
    }

    const sav1 = r2(pool1);
    const sav2 = r2(semi ? pool2 : 0);
    const paidTotal = {};
    for (const l of lines) paidTotal[l.id] = r2((paidTotal[l.id] || 0) + l.amount);
    const finishes = {};
    for (const d of active) finishes[d.id] = (paidTotal[d.id] || 0) >= d.balance - 0.005;

    return { lines, sav1, sav2, toSav: r2(sav1 + sav2), shortLate: r2(shortLate), shortTotal: r2(shortTotal), finishes, oAvail0: r2(oAvail0), oAvail1: r2(oAvail1), oAvail2: r2(oAvail2) };
  }, [state, available, avail1, avail2, semi, fundFirstActive]);

  /* ── Sophie's verdict ── */
  const verdict = useMemo(() => {
    if (livingTotal <= 0) {
      return { ready: false, text: "Enter your living expenses first — I can’t judge your life without seeing it. (Ledger tab.)" };
    }
    const starter = Math.max(Math.ceil(livingTotal / 1000) * 1000, 1000);
    const full = starter * 3;
    const worst = [...state.debts].sort((a, b) => b.apr - a.apr)[0];

    if (state.debts.length === 0) {
      return {
        ready: true,
        title: "All savings. Obviously.",
        text: `No debts to destroy, so everything goes to the fund — park ${fmt(full)} (≈3 months of living) before you get ideas.`,
        rec: { emergencyFirst: true, emergencyTarget: full, fundSplit: 100, savingsSplit: 100 },
      };
    }
    if (state.currentSavings < starter) {
      if (worst && worst.apr >= 24) {
        const cushion = Math.max(Math.ceil(livingTotal / 4 / 1000) * 1000, 1000);
        return {
          ready: true,
          title: "Small cushion, then slaughter.",
          text: `“${worst.name}” charges ${worst.apr}% — every peso parked in a big fund keeps bleeding ~${(worst.apr / 12).toFixed(1)}%/mo in card interest while it sits. Keep a ${fmt(cushion)} cushion (≈1 week of living), build it with half the extra while the other half already attacks; once cushioned, ~85% attacks. The full ${fmt(starter)} fund comes after the cards are dead — cleared credit limits are your backstop until then. Thinner cushion = less interest but less cash buffer; that trade is yours to set.`,
          rec: { emergencyFirst: true, emergencyTarget: cushion, fundSplit: 50, savingsSplit: 15 },
        };
      }
      return {
        ready: true,
        title: "Fund first. No arguments.",
        text: `You have ${fmt(state.currentSavings)} saved and life costs ${fmt(livingTotal)}/mo — one bad month and you’re borrowing again. Park ${fmt(starter)} (≈1 month of living) first; the plan auto-switches to attack mode the moment it’s full.`,
        rec: { emergencyFirst: true, emergencyTarget: starter, fundSplit: 100, savingsSplit: 15 },
      };
    }
    if (worst && worst.apr >= ATTACK_APR) {
      return {
        ready: true,
        title: "Starter fund’s done — attack.",
        text: `“${worst.name}” at ${worst.apr}% APR bleeds you faster than any savings account pays. Keep the ${fmt(starter)} cushion, send ~85% of the extra at the debt. If savings ever dip below the cushion, the plan refills it first automatically.`,
        rec: { emergencyFirst: true, emergencyTarget: starter, fundSplit: 100, savingsSplit: 15 },
      };
    }
    return {
      ready: true,
      title: "Cheap debt. Split it.",
      text: `Nothing above ${ATTACK_APR}% APR — that’s cheap money, no need to panic-pay. Split the extra about half-half: chip the debt while building toward ${fmt(full)} (≈3 months of living).`,
      rec: { emergencyFirst: true, emergencyTarget: starter, fundSplit: 100, savingsSplit: 50 },
    };
  }, [state, livingTotal]);

  const verdictMatched =
    verdict.ready && verdict.rec &&
    state.emergencyFirst === verdict.rec.emergencyFirst &&
    Math.abs(state.emergencyTarget - verdict.rec.emergencyTarget) < 1 &&
    Math.abs(state.savingsSplit - verdict.rec.savingsSplit) <= 5 &&
    Math.abs((state.fundSplit == null ? 100 : state.fundSplit) - (verdict.rec.fundSplit == null ? 100 : verdict.rec.fundSplit)) <= 5;

  const applyVerdict = () => {
    if (!verdict.rec) return;
    setState((s) => logEvent(`Followed Sophie’s verdict: “${verdict.title}”`, { ...s, ...verdict.rec }));
  };

  /* ── hero numbers ── */
  const dfm = sim.debtFreeMonth;
  const monthsSaved = base.months !== null && dfm !== null && dfm > 0 ? base.months - dfm : null;
  const interestSaved = base.months !== null ? base.interest - sim.totalInterest : null;
  const dfRowLabel = dfm !== null && dfm > 0 ? (sim.rows.find((r) => r.m === dfm) || {}).label : null;

  const milestones = useMemo(() => {
    const arr = [];
    if (sim.efMonth !== null && sim.efMonth > 0) arr.push({ m: sim.efMonth, kind: "sav", text: "Emergency fund full" });
    sim.debts.filter((d) => d.payoffMonth).forEach((d) => arr.push({ m: d.payoffMonth, kind: "debt", text: `${d.name} destroyed` }));
    if (dfm !== null && dfm > 0) arr.push({ m: dfm, kind: "free", text: "DEBT-FREE" });
    return arr.sort((a, b) => a.m - b.m);
  }, [sim, dfm]);

  /* ── preview window sums ── */
  const previewRows = sim.schedule.slice(0, state.previewMonths);
  const previewSum = previewRows.reduce(
    (a, row) => ({
      debt: a.debt + row.pays.reduce((s, p) => s + p.amount, 0),
      int: a.int + (row.intTotal || 0),
      sav: a.sav + row.toSav,
      killed: a.killed + row.payoffs.length,
    }),
    { debt: 0, int: 0, sav: 0, killed: 0 }
  );
  const previewEndSav = previewRows.length ? previewRows[previewRows.length - 1].savAfter : state.currentSavings;

  /* ── payday clock ── */
  const payInfo = useMemo(() => {
    const now = new Date();
    const y = now.getFullYear(), m = now.getMonth(), day = now.getDate();
    const lastDay = (yy, mm) => new Date(yy, mm + 1, 0).getDate();
    const mk = (yy, mm, dd) => new Date(yy, mm, dd);
    let first, second;
    if (day <= 15) {
      first = { cut: 1, date: mk(y, m, 15) };
      second = { cut: 2, date: mk(y, m, lastDay(y, m)) };
    } else {
      first = { cut: 2, date: mk(y, m, lastDay(y, m)) };
      second = { cut: 1, date: mk(y, m + 1, 15) };
    }
    const fmtD = (d) => d.toLocaleDateString("en", { month: "short", day: "numeric" });
    const rel = (d) => {
      const days = Math.round((mk(d.getFullYear(), d.getMonth(), d.getDate()) - mk(y, m, day)) / 86400000);
      return days <= 0 ? "today ♡" : days === 1 ? "tomorrow" : `in ${days} days`;
    };
    return { first, second, fmtD, rel };
  }, []);

  /* ── what-if lab ── */
  const whatIf = useMemo(() => {
    if (!state.debts.length || available <= 0 || whatIfExtra <= 0) return null;
    return simulate(state, available + whatIfExtra, semi ? 1 : 0);
  }, [state, available, whatIfExtra, semi]);
  const otherStrategy = state.strategy === "avalanche" ? "snowball" : "avalanche";
  const altStrat = useMemo(() => {
    if (!state.debts.length || available <= 0) return null;
    return simulate({ ...state, strategy: otherStrategy }, available, semi ? 1 : 0);
  }, [state, available, semi, otherStrategy]);

  /* ── mutators ── */
  function logEvent(text, s) {
    return { ...s, events: [{ id: uid(), ts: Date.now(), text }, ...s.events].slice(0, 30) };
  }

  const setMode = (m) =>
    setState((s) => {
      if (m === "semi" && s.payMode !== "semi" && !s.incomeA && !s.incomeB) {
        const half = Math.round(s.income / 2);
        return { ...s, payMode: m, incomeA: half, incomeB: s.income - half };
      }
      if (m === "monthly" && s.payMode !== "monthly") {
        return { ...s, payMode: m, income: (s.incomeA + s.incomeB) || s.income };
      }
      return { ...s, payMode: m };
    });

  const submitDebt = () => {
    const b = pos(form.balance), a = nn(form.apr), mp = form.oneTime ? 0 : nn(form.min);
    const dd = (() => { const n = parseInt(form.dueDay, 10); return Number.isFinite(n) && n >= 1 && n <= 31 ? n : null; })();
    if (!form.name.trim() || b <= 0) { setFormErr("A name and a real balance. It’s not hard, oniichan."); return; }
    setFormErr("");
    setState((s) => {
      if (form.id) {
        return logEvent(`Updated “${form.name.trim()}”`, {
          ...s,
          debts: s.debts.map((d) =>
            d.id === form.id
              ? { ...d, name: form.name.trim(), balance: b, startBalance: Math.max(d.startBalance || b, b), apr: a, minPayment: mp, dueDay: dd, oneTime: form.oneTime }
              : d
          ),
        });
      }
      return logEvent(`New ${form.oneTime ? "one-time " : ""}debt: “${form.name.trim()}” ${fmt(b)}`, {
        ...s,
        debts: [...s.debts, { id: uid(), name: form.name.trim(), balance: b, startBalance: b, apr: a, minPayment: mp, dueDay: dd, oneTime: form.oneTime }],
      });
    });
    setForm({ id: null, name: "", balance: "", apr: "", min: "", dueDay: "", oneTime: false });
  };

  const editDebt = (d) => { setForm({ id: d.id, name: d.name, balance: String(d.balance), apr: String(d.apr), min: String(d.minPayment), dueDay: d.dueDay ? String(d.dueDay) : "", oneTime: !!d.oneTime }); setView("ledger"); };
  const removeDebt = (d) => setState((s) => logEvent(`Removed “${d.name}”`, { ...s, debts: s.debts.filter((x) => x.id !== d.id) }));
  const commitBalance = (id, val) => {
    const b = nn(val);
    setState((s) => ({
      ...s,
      debts: s.debts.map((d) => (d.id === id ? { ...d, balance: b, startBalance: Math.max(d.startBalance || b, b) } : d)),
    }));
  };

  const addExpense = () => setState((s) => ({ ...s, expenses: [...s.expenses, { id: uid(), name: "", amount: 0, cutoff: "split" }] }));
  const setExpense = (id, patch) =>
    setState((s) => ({ ...s, expenses: s.expenses.map((x) => (x.id === id ? { ...x, ...patch } : x)) }));
  const removeExpense = (id) => setState((s) => ({ ...s, expenses: s.expenses.filter((x) => x.id !== id) }));

  const loadSample = () =>
    setState((s) =>
      logEvent("Loaded sample data — replace it with your real mess ♡", {
        ...s,
        income: SAMPLE.income, incomeA: SAMPLE.incomeA, incomeB: SAMPLE.incomeB,
        expenses: SAMPLE.expenses.map((x) => ({ ...x, id: uid() })),
        debts: SAMPLE.debts.map((d) => ({ ...d, id: uid(), startBalance: d.balance })),
      })
    );

  const applyWindfall = () => {
    const amt = pos(evt.amount); if (!amt) return;
    setState((s) => {
      const next = { ...s, debts: s.debts.map((d) => ({ ...d })) };
      let text;
      const anyDebt = next.debts.some((d) => d.balance > 0);
      if (evt.dest === "savings" || !anyDebt) {
        next.currentSavings = r2(s.currentSavings + amt);
        text = `Windfall +${fmt(amt)} → savings`;
      } else {
        let target = null;
        if (evt.dest === "smart") {
          target = next.debts.filter((d) => d.balance > 0).sort(attackCmp(s.strategy))[0];
        } else {
          target = next.debts.find((d) => d.id === evt.dest && d.balance > 0) || null;
        }
        if (!target) {
          next.currentSavings = r2(s.currentSavings + amt);
          text = `Windfall +${fmt(amt)} → savings`;
        } else {
          const pay = Math.min(amt, target.balance);
          target.balance = r2(target.balance - pay);
          const leftover = r2(amt - pay);
          if (leftover > 0) next.currentSavings = r2(next.currentSavings + leftover);
          text = `Windfall +${fmt(amt)} → smashed into “${target.name}”${leftover > 0 ? `, ${fmt(leftover)} spillover to savings` : ""}`;
        }
      }
      return logEvent(text, next);
    });
    setEvt((e) => ({ ...e, amount: "" })); setPanel(null);
  };

  const applyExpense = () => {
    const amt = pos(evt.amount); if (!amt) return;
    const note = evt.note.trim() || "surprise expense";
    setState((s) => {
      const next = { ...s, debts: s.debts.map((d) => ({ ...d })) };
      const fromSav = Math.min(amt, s.currentSavings);
      next.currentSavings = r2(s.currentSavings - fromSav);
      const short = r2(amt - fromSav);
      let text = `“${note}”: −${fmt(fromSav)} from savings`;
      if (short > 0) {
        if (evt.coverDebt) {
          next.debts = [...next.debts, {
            id: uid(), name: `Emergency: ${note}`, balance: short, startBalance: short,
            apr: 0, minPayment: 0, dueDay: null, oneTime: true,
          }];
          text += ` · ${fmt(short)} added as a one-time 0% debt`;
        } else {
          text += ` · ${fmt(short)} uncovered (savings ran dry)`;
        }
      }
      return logEvent(text, next);
    });
    setEvt((e) => ({ ...e, amount: "", note: "" })); setPanel(null);
  };

  const applyIncome = () => {
    if (!semi) {
      const b = pos(evt.income); if (!b) return;
      setState((s) => logEvent(`Income ${fmt(s.income)} → ${fmt(b)}`, { ...s, income: b }));
    } else {
      const a = evt.income !== "" ? pos(evt.income) : 0;
      const b = evt.incomeB !== "" ? pos(evt.incomeB) : 0;
      if (!a && !b) return;
      setState((s) => logEvent(
        `Income ${fmt(s.incomeA)}+${fmt(s.incomeB)} → ${fmt(a || s.incomeA)}+${fmt(b || s.incomeB)}`,
        { ...s, incomeA: a || s.incomeA, incomeB: b || s.incomeB }
      ));
    }
    setEvt((e) => ({ ...e, income: "", incomeB: "" })); setPanel(null);
  };

  // mark a payday's (or the whole month's) orders as paid → applies them and freezes a receipt
  const applyOrders = (cut) => {
    const ls = orders.lines.filter((l) => (cut === 0 ? true : l.cutoff === cut));
    const sav = cut === 0 ? orders.toSav : cut === 1 ? orders.sav1 : orders.sav2;
    if (!ls.length && sav <= 0.5) return;
    const payObj = cut === 0 ? null : (payInfo.first.cut === cut ? payInfo.first : payInfo.second);
    const payLabel = cut === 0 ? `${mLabel(1)} orders` : `${payInfo.fmtD(payObj.date)} payday`;
    const paid = {};
    ls.forEach((l) => { paid[l.id] = r2((paid[l.id] || 0) + l.amount); });
    const receipt = {
      key: cycleKeyFor(cut), ts: Date.now(), payLabel,
      payDate: payObj
        ? `${payObj.date.getFullYear()}-${String(payObj.date.getMonth() + 1).padStart(2, "0")}-${String(payObj.date.getDate()).padStart(2, "0")}`
        : null,
      lines: ls.map((l) => ({ name: l.name, amount: l.amount, note: kindNote(l) })),
      paid, sav: r2(sav), total: r2(ls.reduce((s, l) => s + l.amount, 0) + sav),
    };
    setState((s) => {
      const next = { ...s, debts: s.debts.map((d) => ({ ...d })), receipts: { ...(s.receipts || {}), [cut]: receipt } };
      let paidTotal = 0;
      for (const l of ls) {
        const d = next.debts.find((x) => x.id === l.id);
        if (d) { d.balance = r2(Math.max(0, d.balance - l.amount)); paidTotal = r2(paidTotal + l.amount); }
      }
      next.currentSavings = r2(next.currentSavings + sav);
      return logEvent(`Applied ${payLabel}: ${fmt(paidTotal)} to debts · ${fmt(sav)} to savings`, next);
    });
    setDone({});
  };

  const undoOrders = (cut) => {
    const r = state.receipts && state.receipts[cut];
    if (!r) return;
    setState((s) => {
      const next = { ...s, debts: s.debts.map((d) => ({ ...d })), receipts: { ...(s.receipts || {}) } };
      Object.entries(r.paid || {}).forEach(([id, amt]) => {
        const d = next.debts.find((x) => x.id === id);
        if (d) d.balance = r2(d.balance + amt);
      });
      next.currentSavings = r2(Math.max(0, next.currentSavings - (r.sav || 0)));
      delete next.receipts[cut];
      return logEvent(`Undid ${r.payLabel} apply`, next);
    });
  };

  const doReset = async () => {
    try {
      if (typeof window !== "undefined" && window.storage) {
        await window.storage.delete(KEY);
        for (const k of OLD_KEYS) { try { await window.storage.delete(k); } catch (e) {} }
      }
    } catch (e) {}
    setState(DEFAULT_STATE);
    setForm({ id: null, name: "", balance: "", apr: "", min: "", dueDay: "", oneTime: false });
    setDone({});
    setConfirmReset(false);
  };

  /* ── chart tooltip ── */
  const Tip = ({ active, payload, label }) => {
    if (!active || !payload || !payload.length) return null;
    return (
      <div className="rounded-lg px-3 py-2 text-xs" style={{ background: C.card2, border: `1px solid ${C.line}` }}>
        <div className="mb-1" style={{ color: C.faint }}>{label}</div>
        {payload.map((p) => (
          <div key={p.dataKey} style={{ ...mono, color: p.color }}>{p.name}: {fmt(p.value)}</div>
        ))}
      </div>
    );
  };

  const heroSentence = () => {
    if (state.debts.length === 0) {
      return (
        <>Nothing to destroy. Add your debts in the Ledger… <span style={{ color: C.mut }}>or just watch savings grow, I guess.</span></>
      );
    }
    if (overspending || available <= 0) {
      return (
        <>Your living costs eat your <span style={{ color: C.rose }}>entire income</span>.{" "}
          <span style={{ color: C.mut }}>There’s nothing left to plan with — cut something, oniichan.</span></>
      );
    }
    if (dfm === null) {
      return (
        <>At this pace you’ll <span style={{ color: C.rose }}>never</span> be debt-free.{" "}
          <span style={{ color: C.mut }}>Earn more or spend less. Pick one. Now.</span></>
      );
    }
    return (
      <>You’re debt-free by <span style={{ color: C.rose, whiteSpace: "nowrap" }}>{mLabel(dfm)}</span>
        {monthsSaved !== null && monthsSaved > 0 && (
          <span style={{ color: C.mut }}> — {monthsSaved} months sooner than coasting on minimums</span>
        )}
        {base.months === null && (
          <span style={{ color: C.mut }}> — minimums alone would never get you there</span>
        )}
        .
      </>
    );
  };

  if (!loaded) {
    return (
      <div className="min-h-screen flex items-center justify-center text-sm" style={{ background: C.bg, color: C.faint }}>
        (￣^￣) …loading your financial mess
      </div>
    );
  }

  const eyeStyle = { color: C.faint, letterSpacing: "0.15em" };

  const kindNote = (l) => {
    const due = l.dueDay ? `due the ${ord(l.dueDay)}` : null;
    if (l.oneTime) {
      if (l.kind === "min-early") return ["one-time · paid early", due].filter(Boolean).join(" — ");
      if (l.kind === "min") return ["one-time · in full", due].filter(Boolean).join(" · ");
      return ["one-time", due].filter(Boolean).join(" · ");
    }
    if (l.kind === "min") return ["minimum", due].filter(Boolean).join(" · ");
    if (l.kind === "min-early") return [`minimum · paid early`, due].filter(Boolean).join(" — ");
    return "attack";
  };

  const OrderRow = ({ l }) => (
    <label className="flex items-center gap-3 rounded-xl px-3 py-2 cursor-pointer"
      style={{
        background: C.card2,
        border: `1px solid ${l.oneTime || l.kind === "attack" ? C.roseDeep : C.line2}`,
        opacity: done[l.key] ? 0.45 : 1,
      }}>
      <input type="checkbox" checked={!!done[l.key]} onChange={() => setDone((d) => ({ ...d, [l.key]: !d[l.key] }))} />
      <div className="flex-1 text-sm" style={{ textDecoration: done[l.key] ? "line-through" : "none" }}>
        Pay <span className="font-medium">“{l.name}”</span>
        <span className="text-xs ml-2" style={{ color: l.kind === "min-early" ? C.gold : C.faint }}>{kindNote(l)}</span>
        {(l.oneTime || l.kind === "attack") && <Flame size={12} style={{ color: C.rose, display: "inline", marginLeft: 6, verticalAlign: "-2px" }} />}
        {orders.finishes[l.id] && <span className="text-xs ml-2" style={{ color: C.rose }}>finishes it ♡</span>}
      </div>
      <div className="text-sm" style={{ ...mono, color: l.oneTime || l.kind === "attack" ? C.rose : C.text }}>{fmt(l.amount)}</div>
    </label>
  );

  const SavRow = ({ amount, cutKey }) => (
    amount > 0.5 ? (
      <label className="flex items-center gap-3 rounded-xl px-3 py-2 cursor-pointer"
        style={{ background: C.card2, border: `1px solid ${C.line2}`, opacity: done[cutKey] ? 0.45 : 1 }}>
        <input type="checkbox" checked={!!done[cutKey]} onChange={() => setDone((d) => ({ ...d, [cutKey]: !d[cutKey] }))} />
        <div className="flex-1 text-sm" style={{ textDecoration: done[cutKey] ? "line-through" : "none" }}>
          Transfer to savings
          <span className="text-xs ml-2" style={{ color: C.faint }}>
            {fundFirstActive ? "emergency fund — priority" : `${state.savingsSplit}% of the extra`}
          </span>
        </div>
        <div className="text-sm" style={{ ...mono, color: C.cel }}>{fmt(amount)}</div>
      </label>
    ) : null
  );

  const ApplyBtn = ({ cut }) => (
    <button onClick={() => applyOrders(cut)}
      className="hoverable rounded-xl px-3 py-2 text-xs font-semibold w-full flex items-center justify-center gap-1"
      style={{ background: C.rose, color: C.ink, border: "none" }}>
      <CheckCheck size={13} />
      Mark paid & apply to balances
    </button>
  );

  const receiptBlock = (r, cut) => {
    const early = r.payDate ? new Date(r.ts).toISOString().slice(0, 10) < r.payDate : false;
    return (
      <div className="rounded-xl p-3" style={{ background: C.celDim, border: `1px solid ${C.cel}` }}>
        <div className="flex items-center justify-between mb-1 text-xs">
          <span className="flex items-center gap-1" style={{ color: C.cel }}>
            <CheckCheck size={13} />
            Paid {new Date(r.ts).toLocaleDateString(undefined, { month: "short", day: "numeric" })}{early ? " · early ♡" : " ♡"}
          </span>
          <span style={{ ...mono, color: C.cel }}>{fmt(r.total)}</span>
        </div>
        {r.lines.map((l, i) => (
          <div key={i} className="flex justify-between gap-3 text-xs py-1" style={{ color: C.mut }}>
            <span style={{ textDecoration: "line-through" }}>“{l.name}” <span style={{ color: C.faint }}>{l.note}</span></span>
            <span style={mono}>{fmt(l.amount)}</span>
          </div>
        ))}
        {r.sav > 0.5 && (
          <div className="flex justify-between gap-3 text-xs py-1">
            <span style={{ color: C.cel, textDecoration: "line-through" }}>savings transfer</span>
            <span style={{ ...mono, color: C.cel }}>{fmt(r.sav)}</span>
          </div>
        )}
        <div className="text-xs mt-1" style={{ color: C.faint }}>Locked in for this cycle — the rest of the plan calculates around it. Unlocks automatically next payday.</div>
        <button onClick={() => undoOrders(cut)} className="ghost rounded-lg px-3 py-1 mt-2 text-xs"
          style={{ border: `1px solid ${C.line}`, color: C.faint }}>
          Undo (restores balances)
        </button>
      </div>
    );
  };

  const actualField = (cut, planned) => {
    const a = actualFor(cut);
    return (
      <div className="flex items-center gap-2 mb-1 flex-wrap">
        <span className="text-xs uppercase" style={eyeStyle}>actual received</span>
        <input type="number" min="0" placeholder={String(planned)} value={a == null ? "" : a}
          onChange={(e) => setActual(cut, e.target.value)}
          className="fld" style={{ ...inputStyle, ...mono, width: "7.5rem", padding: "4px 8px", fontSize: "12px" }}
          aria-label="Actual salary received this payday" />
        {a != null && Math.abs(a - planned) > 0.5 && (
          <Chip color={a > planned ? C.cel : C.gold}>{a > planned ? "+" : "−"}{fmt(Math.abs(a - planned))} vs plan</Chip>
        )}
      </div>
    );
  };

  const cutoffGroup = (pay, isNext) => {
    const cut = pay.cut;
    const isK1 = cut === 1;
    const jp = isK1 ? "十五日" : "晦日";
    const label = isK1 ? "kinsenas — covers dues on the 16th–31st" : "katapusan — covers dues on the 1st–15th";
    const avail = isK1 ? orders.oAvail1 : orders.oAvail2;
    const planned = isK1 ? state.incomeA : state.incomeB;
    const sav = isK1 ? orders.sav1 : orders.sav2;
    const rcpt = receiptFor(cut);
    const ls = orders.lines.filter((l) => l.cutoff === cut);
    const debtPaid = ls.reduce((s, l) => s + l.amount, 0);
    return (
      <div key={cut} className="rounded-xl p-3" style={{ border: `1px solid ${rcpt ? C.cel : isNext ? C.roseDeep : C.line2}` }}>
        <div className="flex items-baseline justify-between mb-1">
          <div className="flex items-baseline gap-2 flex-wrap">
            <span className="text-sm" style={{ ...serif, color: rcpt ? C.cel : isNext ? C.rose : C.gold }}>{jp}</span>
            <span className="text-sm font-medium">{payInfo.fmtD(pay.date)}</span>
            {rcpt
              ? <Chip color={C.cel}>done ♡</Chip>
              : <Chip color={isNext ? C.rose : undefined}>{isNext ? `next payday · ${payInfo.rel(pay.date)}` : payInfo.rel(pay.date)}</Chip>}
          </div>
          {!rcpt && <span className="text-xs" style={{ ...mono, color: C.faint }}>{fmt(avail)} in hand</span>}
        </div>
        <div className="text-xs uppercase mb-2" style={eyeStyle}>{label}</div>
        {rcpt ? receiptBlock(rcpt, cut) : (
          <div className="space-y-2">
            {actualField(cut, planned)}
            {ls.map((l) => <OrderRow key={l.key} l={l} />)}
            <SavRow amount={sav} cutKey={`sav:${cut}`} />
            {ls.length === 0 && sav <= 0.5 && (
              <div className="text-xs px-3 py-2" style={{ color: C.faint }}>Nothing assigned to this payday.</div>
            )}
            <div className="flex items-center justify-between px-3 text-xs" style={{ color: C.faint }}>
              <span>debt {fmt(debtPaid)} · savings {fmt(sav)}</span>
              <span style={mono}>of {fmt(avail)}</span>
            </div>
            {(ls.length > 0 || sav > 0.5) && <ApplyBtn cut={cut} />}
          </div>
        )}
      </div>
    );
  };

  /* ── the scroll: markdown export ── */
  const buildMarkdown = () => {
    const L = [];
    const cell = (s) => String(s == null ? "" : s).replace(/\|/g, "∣").trim();
    const yn = (b) => (b ? "yes" : "no");
    const payday = (c) => (c === "1" ? "15th" : c === "2" ? "30th" : "both");
    const today = new Date().toISOString().slice(0, 10);

    L.push(`# Sophie's Debt-Zero Plan ♡`);
    L.push(``);
    L.push(`> Exported ${today} · a scroll for the terminal imouto. The **Settings / Living expenses / Debts** tables are canonical — edit them (raw numbers, no symbols) and import this file back. Read-only sections are regenerated.`);
    L.push(``);

    L.push(`## Summary`);
    if (state.debts.length === 0) L.push(`- No debts — savings-only mode.`);
    else if (dfm === null) L.push(`- **Never debt-free at this pace.** Income or expenses need to change.`);
    else L.push(`- Debt-free by **${mLabel(dfm)}** (${dfm} months)${monthsSaved !== null && monthsSaved > 0 ? ` — ${monthsSaved} months sooner than minimums-only` : ""}.`);
    L.push(`- Total debt today: ${fmt(totalDebtNow)} · Savings today: ${fmt(state.currentSavings)}${dfm !== null && dfm > 0 ? ` → ${fmt(sim.savAtFree)} at debt-free` : ""}.`);
    L.push(`- Interest ahead: ${fmt(sim.totalInterest)}${interestSaved !== null && interestSaved > 0.5 ? ` (${fmt(interestSaved)} dodged vs minimums-only)` : ""}.`);
    L.push(`- Monthly for the plan: ${fmt(available)} (income ${fmt(incomeTotal)} − living ${fmt(livingTotal)}).`);
    if (verdict.ready && verdict.title) L.push(`- Sophie's verdict: **“${verdict.title}”** ${verdict.text}`);
    L.push(``);

    L.push(`## Settings`);
    L.push(`| Setting | Value |`);
    L.push(`|---|---|`);
    L.push(`| Currency | ${state.currency} |`);
    L.push(`| Pay mode | ${state.payMode} |`);
    L.push(`| Income (monthly) | ${state.income} |`);
    L.push(`| Income — 15th cutoff | ${state.incomeA} |`);
    L.push(`| Income — 30th cutoff | ${state.incomeB} |`);
    L.push(`| Current savings | ${state.currentSavings} |`);
    L.push(`| Strategy | ${state.strategy} |`);
    L.push(`| Savings split % | ${state.savingsSplit} |`);
    L.push(`| Emergency fund first | ${yn(state.emergencyFirst)} |`);
    L.push(`| Emergency fund target | ${state.emergencyTarget} |`);
    L.push(`| Fund-building split % | ${state.fundSplit == null ? 100 : state.fundSplit} |`);
    L.push(`| Preview months | ${state.previewMonths} |`);
    L.push(``);

    L.push(`## Living expenses`);
    if (!state.expenses.length) L.push(`_None listed._`);
    else {
      L.push(`| Name | Amount | Payday |`);
      L.push(`|---|---|---|`);
      state.expenses.forEach((x) => L.push(`| ${cell(x.name) || "—"} | ${x.amount || 0} | ${payday(x.cutoff || "split")} |`));
    }
    L.push(``);

    L.push(`## Debts`);
    if (!state.debts.length) L.push(`_None. Sus._`);
    else {
      L.push(`| Name | Type | Balance | Original | APR % | Min /mo | Due day |`);
      L.push(`|---|---|---|---|---|---|---|`);
      state.debts.forEach((d) =>
        L.push(`| ${cell(d.name)} | ${d.oneTime ? "one-time" : "recurring"} | ${d.balance} | ${d.startBalance || d.balance} | ${d.apr} | ${d.oneTime ? "—" : d.minPayment} | ${d.dueDay || "—"} |`)
      );
    }
    L.push(``);

    L.push(`## ${semi ? "Next paydays" : `Orders for ${mLabel(1)}`} (read-only)`);
    if (available <= 0) L.push(`_Nothing to deploy._`);
    else if (semi) {
      [payInfo.first, payInfo.second].forEach((p) => {
        const isK1 = p.cut === 1;
        L.push(`### ${payInfo.fmtD(p.date)} — ${isK1 ? "kinsenas (covers dues 16th–31st)" : "katapusan (covers dues 1st–15th)"}`);
        const rcpt = receiptFor(p.cut);
        if (rcpt) {
          rcpt.lines.forEach((l) => L.push(`- [x] Paid “${cell(l.name)}” — ${l.note} — ${fmt(l.amount)}`));
          if (rcpt.sav > 0.5) L.push(`- [x] Transferred to savings — ${fmt(rcpt.sav)}`);
          L.push(`- _Applied ${new Date(rcpt.ts).toISOString().slice(0, 10)} ♡_`);
        } else {
          const ls = orders.lines.filter((l) => l.cutoff === p.cut);
          ls.forEach((l) => L.push(`- [ ] Pay “${cell(l.name)}” — ${kindNote(l)} — ${fmt(l.amount)}${orders.finishes[l.id] ? " · finishes it ♡" : ""}`));
          const sv = isK1 ? orders.sav1 : orders.sav2;
          if (sv > 0.5) L.push(`- [ ] Transfer to savings — ${fmt(sv)}`);
          if (!ls.length && sv <= 0.5) L.push(`- _Nothing assigned._`);
        }
        L.push(``);
      });
    } else if (receiptFor(0)) {
      const rcpt = receiptFor(0);
      rcpt.lines.forEach((l) => L.push(`- [x] Paid “${cell(l.name)}” — ${l.note} — ${fmt(l.amount)}`));
      if (rcpt.sav > 0.5) L.push(`- [x] Transferred to savings — ${fmt(rcpt.sav)}`);
      L.push(`- _Applied ${new Date(rcpt.ts).toISOString().slice(0, 10)} ♡_`);
      L.push(``);
    } else {
      orders.lines.forEach((l) => L.push(`- [ ] Pay “${cell(l.name)}” — ${kindNote(l)} — ${fmt(l.amount)}${orders.finishes[l.id] ? " · finishes it ♡" : ""}`));
      if (orders.toSav > 0.5) L.push(`- [ ] Transfer to savings — ${fmt(orders.toSav)}`);
      L.push(``);
    }

    L.push(`## Payment preview — next ${previewRows.length} months (read-only)`);
    if (!previewRows.length || available <= 0) L.push(`_Nothing scheduled._`);
    else {
      previewRows.forEach((row) => {
        const total = row.pays.reduce((s, p) => s + p.amount, 0) + row.toSav;
        L.push(``);
        L.push(`### ${row.label} — total ${fmt(total)}${row.payoffs.length ? ` · ${row.payoffs.join(", ")} gone ♡` : ""}`);
        L.push(`| Item | Payment | Min | Attack | Interest | Left after |`);
        L.push(`|---|---|---|---|---|---|`);
        row.pays.forEach((p) =>
          L.push(`| ${cell(p.name)} | ${fmt(p.amount)} | ${p.min > 0.005 ? fmt(p.min) : "—"} | ${p.extra > 0.005 ? fmt(p.extra) : "—"} | ${p.interest > 0.5 ? fmt(p.interest) : "—"} | ${p.after <= 0.005 ? "gone ♡" : fmt(p.after)} |`)
        );
        L.push(`| Savings | ${row.toSav > 0.5 ? "+" + fmt(row.toSav) : "—"} |  |  |  | ${fmt(row.savAfter)}${state.emergencyTarget > 0 ? (row.savAfter >= state.emergencyTarget ? " (fund full ♡)" : ` (${Math.round((row.savAfter / state.emergencyTarget) * 100)}% of fund)`) : ""} |`);
      });
      L.push(``);
      L.push(`**Window:** ${fmt(previewSum.debt)} to debt · ${fmt(previewSum.int)} eaten by interest · ${fmt(previewSum.sav)} saved → ${fmt(previewEndSav)}${previewSum.killed ? ` · ${previewSum.killed} destroyed ♡` : ""}`);
    }
    L.push(``);

    if (milestones.length) {
      L.push(`## Milestones (read-only)`);
      milestones.forEach((ms) => L.push(`- ${mLabel(ms.m)} — ${ms.text}`));
      L.push(``);
    }

    if (state.events.length) {
      L.push(`## History`);
      state.events.forEach((e) => L.push(`- ${new Date(e.ts).toISOString().slice(0, 10)} — ${e.text}`));
      L.push(``);
    }

    L.push(`---`);
    L.push(`_Generated by Sophie. Projections assume monthly compounding and steady income — a planning sketch, not financial advice, baka._`);
    return L.join("\n");
  };

  const downloadScroll = () => {
    try {
      const blob = new Blob([scrollText || buildMarkdown()], { type: "text/markdown" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `sophie-debt-zero-${new Date().toISOString().slice(0, 10)}.md`;
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      setScrollMsg("Downloaded ♡ (if the browser blocked it, copy from the box)");
    } catch (e) { setScrollMsg("Download blocked here — copy from the box instead."); }
  };

  const copyScroll = async () => {
    try { await navigator.clipboard.writeText(scrollText || buildMarkdown()); setScrollMsg("Copied ♡"); }
    catch (e) { setScrollMsg("Clipboard blocked — select the box and copy manually."); }
  };

  const applyImport = (text) => {
    const res = parseScroll(text);
    if (res.error) { setScrollMsg(res.error); return; }
    setState((s) => {
      const merged = { ...s, ...res.patch, receipts: {}, actuals: {} };
      const note = { id: uid(), ts: Date.now(), text: `Imported scroll (${res.summary})` };
      merged.events = [note, ...(res.patch.events || s.events)].slice(0, 30);
      return merged;
    });
    setScrollMsg(`Loaded: ${res.summary} ♡`);
    setScroll(null);
    setScrollText("");
  };

  /* ── warnings block (shown in Now + Ledger) ── */
  const Warn = ({ tone, children }) => (
    <div className="flex items-start gap-2 rounded-xl px-4 py-3 mb-3 text-sm"
      style={tone === "gold"
        ? { background: C.goldDim, border: `1px solid ${C.gold}` }
        : { background: C.roseDim, border: `1px solid ${C.roseDeep}` }}>
      <AlertTriangle size={16} style={{ color: tone === "gold" ? C.gold : C.rose, marginTop: 2 }} />
      <div>{children}</div>
    </div>
  );

  const WarningsBlock = () => (
    <>
      {overspending && (
        <Warn>Living costs ({fmt(livingTotal)}) exceed income ({fmt(incomeTotal)}) by {fmt(livingTotal - incomeTotal)}/mo. No plan survives that — trim the expenses list in the Ledger.</Warn>
      )}
      {!overspending && (cutOver1 || cutOver2) && (
        <Warn tone="gold">
          {cutOver1 && <>The 15th cutoff overspends by {fmt(exp1 - state.incomeA)}. </>}
          {cutOver2 && <>The 30th cutoff overspends by {fmt(exp2 - state.incomeB)}. </>}
          Shift some expenses to the other payday in the Ledger.
        </Warn>
      )}
      {!overspending && underfunded && state.debts.length > 0 && (
        <Warn>After living costs you have {fmt(available)}/mo, but this month’s dues (minimums + deadlined one-times) need {fmt(minSum)}. Short {fmt(minSum - available)} — the orders pay the most urgent first, but fix this.</Warn>
      )}
      {semi && orders.shortLate > 0.5 && (
        <Warn>{fmt(orders.shortLate)} of dues falling on the 16th–31st can’t be covered by the 15th check — the 30th check arrives too late for them. Move expenses off the 1st cutoff or these go overdue.</Warn>
      )}
      {spirals.length > 0 && (
        <Warn>{spirals.map((d) => `“${d.name}”`).join(", ")}: the minimum doesn’t beat the interest, so it grows on its own. The plan throws extra at it — don’t skip months.</Warn>
      )}
    </>
  );

  /* ────────────────────────── views ────────────────────────── */
  const NowView = () => (
    <>
      <WarningsBlock />

      {/* orders */}
      <div className="rounded-2xl p-4 mb-4" style={{ background: C.card, border: `1px solid ${C.roseDeep}` }}>
        <div className="flex items-center justify-between mb-3">
          <Eyebrow
            jp={semi ? "次の給料日" : "今月の命令"}
            en={semi
              ? `Next payday ${payInfo.fmtD(payInfo.first.date)} (${payInfo.rel(payInfo.first.date)}) — do these`
              : `Orders for ${mLabel(1)} — do these`}
          />
          <ClipboardList size={16} style={{ color: C.rose }} />
        </div>

        {available <= 0 ? (
          <div className="text-sm" style={{ color: C.mut }}>Nothing to deploy. Fix the income/expenses situation in the Ledger, then I’ll order you around properly.</div>
        ) : orders.lines.length === 0 && orders.toSav <= 0 && !receiptFor(0) && !receiptFor(1) && !receiptFor(2) ? (
          <div className="text-sm" style={{ color: C.mut }}>Nothing to do yet — add debts in the Ledger tab.</div>
        ) : semi ? (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
            {cutoffGroup(payInfo.first, true)}
            {cutoffGroup(payInfo.second, false)}
          </div>
        ) : receiptFor(0) ? (
          receiptBlock(receiptFor(0), 0)
        ) : (
          <div className="space-y-2">
            {actualField(0, state.income)}
            {orders.lines.map((l) => <OrderRow key={l.key} l={l} />)}
            <SavRow amount={orders.toSav} cutKey="sav:0" />
            <div className="flex items-center justify-between px-3 pt-2 text-xs" style={{ color: C.faint, borderTop: `1px solid ${C.line2}` }}>
              <span>total deployed</span>
              <span style={mono}>
                {fmt(orders.lines.reduce((s, l) => s + l.amount, 0) + orders.toSav)} of {fmt(orders.oAvail0)} available
                {orders.shortTotal > 0 && <span style={{ color: C.rose }}> · short {fmt(orders.shortTotal)}</span>}
              </span>
            </div>
            <ApplyBtn cut={0} />
          </div>
        )}
        {available > 0 && (
          <div className="px-1 pt-3 text-xs" style={{ color: C.faint }}>
            Salary landed early or off-plan? Set “actual received” first, then “Mark paid” — it applies the payments, freezes that payday as done for the whole cycle, and the other payday recalculates around it. Sync exact balances with your statement later (Ledger).
          </div>
        )}
      </div>

      {/* verdict + life happens */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <Card accent={C.roseDeep}>
          <div className="flex items-center justify-between mb-1">
            <Eyebrow jp="裁定" en="Sophie’s verdict" />
            <Gavel size={15} style={{ color: C.rose }} />
          </div>
          {!verdict.ready ? (
            <div className="text-sm" style={{ color: C.mut }}>{verdict.text}</div>
          ) : (
            <div>
              <div className="text-base mb-1" style={{ ...serif, fontStyle: "italic", color: C.text }}>“{verdict.title}”</div>
              <p className="text-xs leading-relaxed" style={{ color: C.mut }}>{verdict.text}</p>
              {verdictMatched ? (
                <div className="text-xs mt-2" style={{ color: C.cel }}>You’re already doing what I said. Good oniichan ♡</div>
              ) : (
                <button onClick={applyVerdict} className="hoverable rounded-xl px-4 py-2 mt-3 text-sm font-semibold w-full"
                  style={{ background: C.rose, color: C.ink }}>
                  Do what Sophie says
                </button>
              )}
            </div>
          )}
        </Card>

        <Card>
          <Eyebrow jp="不測の事態" en="Life happens" />
          <p className="text-xs mb-3" style={{ color: C.mut }}>
            Reality punched you? Log it — orders, chart, everything redraws instantly.
          </p>
          <div className="grid grid-cols-3 gap-2">
            <button onClick={() => setPanel(panel === "windfall" ? null : "windfall")}
              className="hoverable rounded-xl p-2 text-xs flex flex-col items-center gap-1"
              style={{ background: panel === "windfall" ? C.celDim : C.card2, border: `1px solid ${panel === "windfall" ? C.cel : C.line}`, color: C.text }}>
              <Sparkles size={15} style={{ color: C.cel }} />Windfall
            </button>
            <button onClick={() => setPanel(panel === "expense" ? null : "expense")}
              className="hoverable rounded-xl p-2 text-xs flex flex-col items-center gap-1"
              style={{ background: panel === "expense" ? C.roseDim : C.card2, border: `1px solid ${panel === "expense" ? C.rose : C.line}`, color: C.text }}>
              <AlertTriangle size={15} style={{ color: C.rose }} />Expense
            </button>
            <button onClick={() => setPanel(panel === "income" ? null : "income")}
              className="hoverable rounded-xl p-2 text-xs flex flex-col items-center gap-1"
              style={{ background: panel === "income" ? C.goldDim : C.card2, border: `1px solid ${panel === "income" ? C.gold : C.line}`, color: C.text }}>
              <Wallet size={15} style={{ color: C.gold }} />Income
            </button>
          </div>

          {panel === "windfall" && (
            <div className="mt-3 space-y-2">
              <FieldLabel>Amount</FieldLabel>
              <input className="fld" style={{ ...inputStyle, ...mono }} type="number" min="0" value={evt.amount} placeholder="10000"
                onChange={(e) => setEvt({ ...evt, amount: e.target.value })} />
              <FieldLabel>Send it to</FieldLabel>
              <select className="fld" style={inputStyle} value={evt.dest} onChange={(e) => setEvt({ ...evt, dest: e.target.value })}>
                <option value="smart">Smart — current attack target</option>
                <option value="savings">Savings</option>
                {state.debts.filter((d) => d.balance > 0).map((d) => (
                  <option key={d.id} value={d.id}>“{d.name}”</option>
                ))}
              </select>
              <button onClick={applyWindfall} className="hoverable rounded-xl px-4 py-2 text-sm font-semibold w-full"
                style={{ background: C.cel, color: C.ink }}>Apply windfall</button>
            </div>
          )}

          {panel === "expense" && (
            <div className="mt-3 space-y-2">
              <FieldLabel>Amount</FieldLabel>
              <input className="fld" style={{ ...inputStyle, ...mono }} type="number" min="0" value={evt.amount} placeholder="8000"
                onChange={(e) => setEvt({ ...evt, amount: e.target.value })} />
              <FieldLabel>What happened</FieldLabel>
              <input className="fld" style={inputStyle} value={evt.note} placeholder="vet bills, laptop died…"
                onChange={(e) => setEvt({ ...evt, note: e.target.value })} />
              <label className="flex items-center gap-2 text-xs cursor-pointer" style={{ color: C.mut }}>
                <input type="checkbox" checked={evt.coverDebt} onChange={(e) => setEvt({ ...evt, coverDebt: e.target.checked })} />
                If savings can’t cover it, add the rest as a one-time 0% debt
              </label>
              <button onClick={applyExpense} className="hoverable rounded-xl px-4 py-2 text-sm font-semibold w-full"
                style={{ background: C.rose, color: C.ink }}>Log expense</button>
              <div className="text-xs" style={{ color: C.faint }}>One-time hits live here. Recurring costs belong in the living expenses list (Ledger).</div>
            </div>
          )}

          {panel === "income" && (
            <div className="mt-3 space-y-2">
              {!semi ? (
                <>
                  <FieldLabel>New monthly income</FieldLabel>
                  <input className="fld" style={{ ...inputStyle, ...mono }} type="number" min="0" value={evt.income} placeholder={String(state.income)}
                    onChange={(e) => setEvt({ ...evt, income: e.target.value })} />
                </>
              ) : (
                <div className="grid grid-cols-2 gap-2">
                  <div>
                    <FieldLabel>New 15th cutoff</FieldLabel>
                    <input className="fld" style={{ ...inputStyle, ...mono }} type="number" min="0" value={evt.income} placeholder={String(state.incomeA)}
                      onChange={(e) => setEvt({ ...evt, income: e.target.value })} />
                  </div>
                  <div>
                    <FieldLabel>New 30th cutoff</FieldLabel>
                    <input className="fld" style={{ ...inputStyle, ...mono }} type="number" min="0" value={evt.incomeB} placeholder={String(state.incomeB)}
                      onChange={(e) => setEvt({ ...evt, incomeB: e.target.value })} />
                  </div>
                </div>
              )}
              <button onClick={applyIncome} className="hoverable rounded-xl px-4 py-2 text-sm font-semibold w-full"
                style={{ background: C.gold, color: C.ink }}>Change income</button>
              {semi && <div className="text-xs" style={{ color: C.faint }}>Leave a field empty to keep that cutoff as-is.</div>}
            </div>
          )}
        </Card>
      </div>
    </>
  );

  const RoadView = () => (
    <>
      <p className="text-2xl md:text-4xl leading-snug mb-4 max-w-3xl" style={{ ...serif, fontStyle: "italic" }}>
        {heroSentence()}
      </p>

      <div className="flex flex-wrap gap-x-8 gap-y-3 pb-5 mb-5" style={{ borderBottom: `1px solid ${C.line2}` }}>
        <div>
          <div className="text-xs uppercase" style={eyeStyle}>for the plan</div>
          <div className="text-lg" style={{ ...mono, color: C.text }}>{fmt(available)}<span style={{ color: C.faint }}>/mo</span></div>
        </div>
        <div>
          <div className="text-xs uppercase" style={eyeStyle}>interest ahead</div>
          <div className="text-lg" style={{ ...mono, color: C.gold }}>
            {fmt(sim.totalInterest)}
            {interestSaved !== null && interestSaved > 0.5 && <span style={{ color: C.faint }}> ({fmt(interestSaved)} dodged)</span>}
          </div>
        </div>
        <div>
          <div className="text-xs uppercase" style={eyeStyle}>savings at debt-free</div>
          <div className="text-lg" style={{ ...mono, color: C.cel }}>{dfm !== null && dfm > 0 ? fmt(sim.savAtFree) : "—"}</div>
        </div>
        <div>
          <div className="text-xs uppercase" style={eyeStyle}>income · living</div>
          <div className="text-lg" style={{ ...mono, color: C.mut }}><span style={{ color: C.gold }}>{fmt(incomeTotal)}</span> − {fmt(livingTotal)}</div>
        </div>
      </div>

      {/* chart */}
      <Card>
        <div className="flex items-center justify-between mb-3">
          <Eyebrow jp="道のり" en="The road to zero" />
          <div className="flex gap-4 text-xs" style={{ color: C.mut }}>
            <span className="flex items-center gap-1"><span className="inline-block w-2 h-2 rounded-full" style={{ background: C.rose }} />debt</span>
            <span className="flex items-center gap-1"><span className="inline-block w-2 h-2 rounded-full" style={{ background: C.cel }} />savings</span>
          </div>
        </div>
        <div className="h-72">
          <ResponsiveContainer width="100%" height="100%">
            <AreaChart data={sim.rows} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
              <defs>
                <linearGradient id="gDebt" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor={C.rose} stopOpacity={0.35} />
                  <stop offset="100%" stopColor={C.rose} stopOpacity={0} />
                </linearGradient>
                <linearGradient id="gSav" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor={C.cel} stopOpacity={0.3} />
                  <stop offset="100%" stopColor={C.cel} stopOpacity={0} />
                </linearGradient>
              </defs>
              <CartesianGrid stroke={C.line2} strokeDasharray="3 3" vertical={false} />
              <XAxis dataKey="label" tick={{ fill: C.faint, fontSize: 11 }} interval="preserveStartEnd" minTickGap={36} axisLine={{ stroke: C.line2 }} tickLine={false} />
              <YAxis tick={{ fill: C.faint, fontSize: 11 }} tickFormatter={fmtCompact} axisLine={false} tickLine={false} width={46} />
              <Tooltip content={<Tip />} />
              {dfRowLabel && (
                <ReferenceLine x={dfRowLabel} stroke={C.rose} strokeDasharray="4 4"
                  label={{ value: "debt-free ♡", fill: C.rose, fontSize: 11, position: "insideTopRight" }} />
              )}
              <Area type="monotone" dataKey="debt" name="Debt" stroke={C.rose} strokeWidth={2} fill="url(#gDebt)" />
              <Area type="monotone" dataKey="savings" name="Savings" stroke={C.cel} strokeWidth={2} fill="url(#gSav)" />
            </AreaChart>
          </ResponsiveContainer>
        </div>
      </Card>

      {/* milestones */}
      {milestones.length > 0 && (
        <div className="flex flex-wrap gap-2 mt-3">
          {milestones.map((ms, i) => (
            <span key={i} className="flex items-center gap-1 rounded-full px-3 py-1 text-xs"
              style={ms.kind === "free"
                ? { background: C.rose, color: C.ink, fontWeight: 700 }
                : { border: `1px solid ${C.line}`, color: ms.kind === "sav" ? C.cel : C.mut, background: C.card2 }}>
              {ms.kind === "free" && <PartyPopper size={12} />}
              <span style={mono}>{mLabel(ms.m)}</span>
              <span>·</span>
              <span>{ms.text}</span>
            </span>
          ))}
        </div>
      )}

      {/* what-if lab + kill order */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mt-4">
        {state.debts.length > 0 && available > 0 && (
          <Card>
            <div className="flex items-center justify-between mb-1">
              <Eyebrow jp="もしも" en="What-if lab" />
              <FlaskConical size={15} style={{ color: C.cel }} />
            </div>
            <FieldLabel>Throw an extra {fmt(whatIfExtra)}/mo at the plan</FieldLabel>
            <input type="range" min="500" max="15000" step="500" value={whatIfExtra} className="w-full"
              onChange={(e) => setWhatIfExtra(Number(e.target.value))} />
            {whatIf && whatIf.debtFreeMonth !== null && dfm !== null ? (
              <div className="text-sm mt-2">
                → debt-free <span style={{ color: C.rose }}>{mLabel(whatIf.debtFreeMonth)}</span>
                {dfm - whatIf.debtFreeMonth > 0 && <span style={{ color: C.mut }}> · {dfm - whatIf.debtFreeMonth} mo sooner</span>}
                <span style={{ color: C.cel }}> · {fmt(Math.max(0, sim.totalInterest - whatIf.totalInterest))} less interest</span>
              </div>
            ) : whatIf && whatIf.debtFreeMonth !== null && dfm === null ? (
              <div className="text-sm mt-2">→ that extra makes you debt-free by <span style={{ color: C.rose }}>{mLabel(whatIf.debtFreeMonth)}</span>. Find it.</div>
            ) : null}
            {altStrat && altStrat.debtFreeMonth !== null && dfm !== null && (
              <div className="text-xs mt-3 pt-2" style={{ color: C.mut, borderTop: `1px solid ${C.line2}` }}>
                Strategy duel: <span style={{ color: C.text }}>{otherStrategy}</span> would
                {altStrat.totalInterest - sim.totalInterest > 1
                  ? <> cost <span style={{ color: C.gold }}>{fmt(altStrat.totalInterest - sim.totalInterest)}</span> more</>
                  : altStrat.totalInterest - sim.totalInterest < -1
                    ? <> save <span style={{ color: C.cel }}>{fmt(sim.totalInterest - altStrat.totalInterest)}</span></>
                    : <> cost about the same</>}
                {altStrat.debtFreeMonth - dfm > 0 && <> and finish {altStrat.debtFreeMonth - dfm} mo later</>}
                {dfm - altStrat.debtFreeMonth > 0 && <> and finish {dfm - altStrat.debtFreeMonth} mo sooner</>}
                . {altStrat.totalInterest - sim.totalInterest >= -1 ? "Stay put ♡" : "…fine, maybe switch."}
              </div>
            )}
          </Card>
        )}

        {sim.debts.some((d) => d.payoffMonth) && (
          <Card>
            <Eyebrow jp="撃破順" en="Kill order" />
            <div className="space-y-2">
              {[...sim.debts].filter((d) => d.payoffMonth).sort((a, b) => a.payoffMonth - b.payoffMonth).map((d, i) => (
                <div key={d.id} className="flex items-center justify-between text-sm">
                  <div className="flex items-center gap-3">
                    <span className="text-xs" style={{ ...mono, color: C.faint }}>{String(i + 1).padStart(2, "0")}</span>
                    <span>{d.name}</span>
                    {d.oneTime && <Chip color={C.gold}>one-time</Chip>}
                  </div>
                  <span style={{ ...mono, color: C.rose }}>{mLabel(d.payoffMonth)}</span>
                </div>
              ))}
            </div>
          </Card>
        )}
      </div>

      {/* payment preview */}
      {sim.schedule.length > 0 && available > 0 && (
        <div className="rounded-2xl p-4 mt-4" style={{ background: C.card, border: `1px solid ${C.line}` }}>
          <div className="flex items-center justify-between mb-1">
            <Eyebrow jp="先読み" en={`Payment preview — next ${Math.min(state.previewMonths, sim.schedule.length)} months`} />
            <select value={state.previewMonths}
              onChange={(e) => setState((s) => ({ ...s, previewMonths: Number(e.target.value) }))}
              className="text-xs rounded-lg px-2 py-1"
              style={{ background: C.card2, border: `1px solid ${C.line}`, color: C.mut }}
              aria-label="Preview length">
              {[3, 6, 12, 24].map((n) => <option key={n} value={n}>{n} months</option>)}
            </select>
          </div>
          <div>
            {previewRows.map((row) => {
              const total = row.pays.reduce((s, p) => s + p.amount, 0) + row.toSav;
              const open = !!openMonths[row.m];
              return (
                <div key={row.m} style={{ borderBottom: `1px solid ${C.line2}` }}>
                  <button
                    onClick={() => setOpenMonths((o) => ({ ...o, [row.m]: !o[row.m] }))}
                    className="w-full flex flex-wrap items-baseline gap-x-4 gap-y-1 py-2 text-left"
                    style={{ background: "transparent", border: "none", color: C.text, cursor: "pointer", paddingLeft: 0, paddingRight: 0 }}
                    aria-expanded={open}
                  >
                    <span className="flex items-center gap-1 text-xs" style={{ ...mono, color: C.faint, minWidth: "4.4rem" }}>
                      <ChevronDown size={12} style={{ transform: open ? "none" : "rotate(-90deg)", transition: "transform .15s ease" }} />
                      {row.label}
                    </span>
                    <span className="flex-1 flex flex-wrap items-baseline gap-x-4 gap-y-1 text-xs">
                      {row.pays.map((p) => (
                        <span key={p.id} style={{ color: C.mut }}>
                          {p.name} <span style={{ ...mono, color: p.extra > 0.005 || p.oneTime ? C.rose : C.text }}>{fmt(p.amount)}</span>
                          {(p.extra > 0.005 || p.oneTime) && <Flame size={10} style={{ color: C.rose, display: "inline", marginLeft: 2, verticalAlign: "-1px" }} />}
                        </span>
                      ))}
                      {row.toSav > 0.5 && <span style={{ color: C.cel }}>savings <span style={mono}>{fmt(row.toSav)}</span></span>}
                      {row.payoffs.map((n) => <Chip key={n} color={C.rose}>{n} gone ♡</Chip>)}
                    </span>
                    <span className="text-xs" style={{ ...mono, color: C.faint }}>{fmt(total)}</span>
                  </button>

                  {open && (
                    <div className="mb-2 rounded-xl px-3 py-2" style={{ background: C.card2, border: `1px solid ${C.line2}` }}>
                      <div className="grid grid-cols-4 gap-2 text-xs pb-1 mb-1" style={{ color: C.faint, borderBottom: `1px solid ${C.line2}`, letterSpacing: "0.1em" }}>
                        <span className="uppercase">item</span>
                        <span className="uppercase text-right">payment</span>
                        <span className="uppercase text-right">interest</span>
                        <span className="uppercase text-right">left after</span>
                      </div>
                      {row.pays.map((p) => (
                        <div key={p.id} className="grid grid-cols-4 gap-2 text-xs py-1 items-baseline">
                          <span style={{ color: C.text }}>{p.name}</span>
                          <span className="text-right" style={{ ...mono, color: C.text }}>
                            {fmt(p.amount)}
                            {p.min > 0.005 && p.extra > 0.005 && (
                              <div style={{ color: C.faint }}>min {fmt(p.min)} + atk {fmt(p.extra)}</div>
                            )}
                          </span>
                          <span className="text-right" style={{ ...mono, color: p.interest > 0.5 ? C.gold : C.faint }}>
                            {p.interest > 0.5 ? fmt(p.interest) : "—"}
                          </span>
                          <span className="text-right" style={{ ...mono, color: p.after <= 0.005 ? C.rose : C.mut }}>
                            {p.after <= 0.005 ? "gone ♡" : fmt(p.after)}
                          </span>
                        </div>
                      ))}
                      <div className="grid grid-cols-4 gap-2 text-xs py-1 items-baseline" style={{ borderTop: row.pays.length ? `1px solid ${C.line2}` : "none" }}>
                        <span style={{ color: C.cel }}>Savings</span>
                        <span className="text-right" style={{ ...mono, color: C.cel }}>{row.toSav > 0.5 ? `+${fmt(row.toSav)}` : "—"}</span>
                        <span className="text-right" style={{ color: C.faint }}>—</span>
                        <span className="text-right" style={{ ...mono, color: C.cel }}>
                          {fmt(row.savAfter)}
                          {state.emergencyTarget > 0 && (
                            <div style={{ color: C.faint }}>
                              {row.savAfter >= state.emergencyTarget ? "fund full ♡" : `${Math.round((row.savAfter / state.emergencyTarget) * 100)}% of fund`}
                            </div>
                          )}
                        </span>
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>

          <div className="flex flex-wrap gap-x-4 gap-y-1 pt-2 text-xs" style={{ color: C.faint }}>
            <span>window total <span style={{ ...mono, color: C.text }}>{fmt(previewSum.debt + previewSum.sav)}</span></span>
            <span><span style={{ ...mono, color: C.rose }}>{fmt(previewSum.debt)}</span> to debt</span>
            <span><span style={{ ...mono, color: C.gold }}>{fmt(previewSum.int)}</span> eaten by interest</span>
            <span><span style={{ ...mono, color: C.cel }}>{fmt(previewSum.sav)}</span> saved → {fmt(previewEndSav)}</span>
            {previewSum.killed > 0 && <span style={{ color: C.rose }}>{previewSum.killed} debt{previewSum.killed > 1 ? "s" : ""} destroyed ♡</span>}
          </div>
          {semi && <div className="text-xs mt-2" style={{ color: C.faint }}>Monthly view — each month splits across paydays the same way as the orders in 今 Now.</div>}
        </div>
      )}
    </>
  );

  const LedgerView = () => (
    <>
      <WarningsBlock />
      <div className="grid grid-cols-1 md:grid-cols-5 gap-4">
        {/* left: debts */}
        <section className="md:col-span-3 space-y-3">
          <Eyebrow jp="借金" en={`Debts · ${state.debts.length}`} />

          {state.debts.map((d) => {
            const sd = sim.debts.find((x) => x.id === d.id);
            const start = d.startBalance || d.balance;
            const pct = start > 0 ? Math.min(100, Math.max(0, Math.round((1 - d.balance / start) * 100))) : 0;
            const aprColor = d.apr >= 20 ? C.rose : d.apr >= 10 ? C.gold : C.mut;
            const dailyBleed = (d.balance * d.apr) / 36500;
            return (
              <Card key={d.id}>
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <div className="font-medium flex items-center gap-2 flex-wrap">
                      {d.name}
                      {d.oneTime && <Chip color={C.gold}>one-time</Chip>}
                      {d.dueDay && <Chip>{d.oneTime ? "deadline" : "due"} the {ord(d.dueDay)}</Chip>}
                    </div>
                    <div className="text-xs mt-1 flex flex-wrap gap-x-3 gap-y-1" style={{ color: C.mut }}>
                      <span style={{ color: aprColor, ...mono }}>APR {d.apr}%</span>
                      {d.oneTime
                        ? <span>{d.dueDay ? "due in full — paid before the split" : "no minimum — the attack pool settles it"}</span>
                        : <span style={mono}>min {fmt(d.minPayment)}/mo</span>}
                      {dailyBleed >= 0.5 && <span style={{ ...mono, color: C.gold }}>bleeding ≈{fmt(dailyBleed)}/day</span>}
                      {sd && sd.payoffMonth && <span style={{ color: C.rose }}>gone by {mLabel(sd.payoffMonth)}</span>}
                      {sd && sd.interest > 0.5 && <span style={mono}>+{fmt(sd.interest)} interest ahead</span>}
                    </div>
                  </div>
                  <div className="flex items-center gap-1">
                    <button onClick={() => editDebt(d)} className="ghost rounded-lg p-2" style={{ border: `1px solid ${C.line2}`, color: C.faint }} aria-label={`Edit ${d.name}`}>
                      <Pencil size={14} />
                    </button>
                    <button onClick={() => removeDebt(d)} className="ghost rounded-lg p-2" style={{ border: `1px solid ${C.line2}`, color: C.faint }} aria-label={`Delete ${d.name}`}>
                      <Trash2 size={14} />
                    </button>
                  </div>
                </div>
                <div className="mt-3 flex items-center gap-3">
                  <div className="text-xs uppercase" style={eyeStyle}>balance</div>
                  <input
                    key={`${d.id}-${d.balance}`}
                    type="number" min="0" defaultValue={d.balance}
                    onBlur={(e) => commitBalance(d.id, e.target.value)}
                    onKeyDown={(e) => { if (e.key === "Enter") e.currentTarget.blur(); }}
                    className="fld"
                    style={{ ...inputStyle, ...mono, width: "8.5rem" }}
                    aria-label={`${d.name} balance`}
                  />
                  <div className="flex-1 h-2 rounded-full overflow-hidden" style={{ background: C.line2 }}>
                    <div className="h-full rounded-full" style={{ width: `${pct}%`, background: C.rose, transition: "width .3s ease" }} />
                  </div>
                  <div className="text-xs w-10 text-right" style={{ ...mono, color: C.faint }}>{pct}%</div>
                </div>
              </Card>
            );
          })}

          {state.debts.length === 0 && (
            <Card dashed>
              <div className="text-sm" style={{ color: C.mut }}>
                No debts listed. Either you’re lying or you’re perfect — add yours below,
                or <button onClick={loadSample} className="underline" style={{ color: C.rose }}>load sample data</button> to poke around first.
              </div>
            </Card>
          )}

          {/* add / edit form */}
          <Card dashed>
            <div className="flex items-center gap-2 mb-3 text-xs uppercase" style={eyeStyle}>
              <Plus size={14} style={{ color: C.rose }} />
              {form.id ? "Edit debt" : "Add a debt"}
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="col-span-2">
                <FieldLabel>Name</FieldLabel>
                <input className="fld" style={inputStyle} value={form.name} placeholder="Credit card, car loan, that thing you bought…"
                  onChange={(e) => setForm({ ...form, name: e.target.value })} />
              </div>
              <div className="col-span-2">
                <FieldLabel>Type</FieldLabel>
                <div className="grid grid-cols-2 gap-2">
                  <button onClick={() => setForm({ ...form, oneTime: false })}
                    className="hoverable rounded-xl p-2 text-left"
                    style={{ background: !form.oneTime ? C.roseDim : C.card2, border: `1px solid ${!form.oneTime ? C.rose : C.line}` }}>
                    <div className="text-sm font-medium flex items-center gap-1"><Repeat size={13} style={{ color: C.rose }} /> Recurring</div>
                    <div className="text-xs mt-1" style={{ color: C.mut }}>monthly minimum + due day</div>
                  </button>
                  <button onClick={() => setForm({ ...form, oneTime: true })}
                    className="hoverable rounded-xl p-2 text-left"
                    style={{ background: form.oneTime ? C.goldDim : C.card2, border: `1px solid ${form.oneTime ? C.gold : C.line}` }}>
                    <div className="text-sm font-medium flex items-center gap-1"><Zap size={13} style={{ color: C.gold }} /> One-time</div>
                    <div className="text-xs mt-1" style={{ color: C.mut }}>single amount, no minimum</div>
                  </button>
                </div>
              </div>
              <div>
                <FieldLabel>Balance</FieldLabel>
                <input className="fld" style={{ ...inputStyle, ...mono }} type="number" min="0" value={form.balance} placeholder="85000"
                  onChange={(e) => setForm({ ...form, balance: e.target.value })} />
              </div>
              <div>
                <FieldLabel>APR %</FieldLabel>
                <input className="fld" style={{ ...inputStyle, ...mono }} type="number" min="0" step="0.1" value={form.apr} placeholder={form.oneTime ? "0" : "24"}
                  onChange={(e) => setForm({ ...form, apr: e.target.value })} />
              </div>
              {!form.oneTime && (
                <div>
                  <FieldLabel>Minimum / month</FieldLabel>
                  <input className="fld" style={{ ...inputStyle, ...mono }} type="number" min="0" value={form.min} placeholder="4500"
                    onChange={(e) => setForm({ ...form, min: e.target.value })} />
                </div>
              )}
              <div className={form.oneTime ? "col-span-2" : ""}>
                <FieldLabel>{form.oneTime ? "Deadline day (1–31, optional)" : "Due day each month (1–31, optional)"}</FieldLabel>
                <input className="fld" style={{ ...inputStyle, ...mono }} type="number" min="1" max="31" value={form.dueDay} placeholder="20"
                  onChange={(e) => setForm({ ...form, dueDay: e.target.value })}
                  onKeyDown={(e) => { if (e.key === "Enter") submitDebt(); }} />
              </div>
            </div>
            {form.oneTime && (
              <div className="text-xs mt-2" style={{ color: C.faint }}>
                One-time debts with a deadline are treated as dues — paid in full before the savings split, from the right payday. Without a deadline, the attack pool settles them.
              </div>
            )}
            {formErr && <div className="text-xs mt-2" style={{ color: C.rose }}>{formErr}</div>}
            <div className="mt-3 flex gap-2">
              <button onClick={submitDebt} className="hoverable rounded-xl px-4 py-2 text-sm font-semibold"
                style={{ background: C.rose, color: C.ink }}>
                {form.id ? "Save changes" : "Add it"}
              </button>
              {form.id && (
                <button onClick={() => { setForm({ id: null, name: "", balance: "", apr: "", min: "", dueDay: "", oneTime: false }); setFormErr(""); }}
                  className="ghost rounded-xl px-4 py-2 text-sm" style={{ border: `1px solid ${C.line}`, color: C.mut }}>
                  Cancel
                </button>
              )}
            </div>
          </Card>
        </section>

        {/* right: money, plan, scroll, history */}
        <section className="md:col-span-2 space-y-3">
          <Card>
            <Eyebrow jp="収支" en="Money in / out" />
            <div className="space-y-3">
              <div>
                <FieldLabel>Pay schedule</FieldLabel>
                <div className="grid grid-cols-2 gap-2">
                  <button onClick={() => setMode("monthly")}
                    className="hoverable rounded-xl px-3 py-2 text-sm"
                    style={{ background: !semi ? C.roseDim : C.card2, border: `1px solid ${!semi ? C.rose : C.line}` }}>
                    Monthly
                  </button>
                  <button onClick={() => setMode("semi")}
                    className="hoverable rounded-xl px-3 py-2 text-sm"
                    style={{ background: semi ? C.roseDim : C.card2, border: `1px solid ${semi ? C.rose : C.line}` }}>
                    Semi-monthly
                  </button>
                </div>
              </div>

              {!semi ? (
                <div>
                  <FieldLabel>Monthly income (take-home)</FieldLabel>
                  <div className="flex items-center gap-2">
                    <Banknote size={16} style={{ color: C.gold }} />
                    <input className="fld" style={{ ...inputStyle, ...mono }} type="number" min="0" value={state.income}
                      onChange={(e) => setState((s) => ({ ...s, income: nn(e.target.value) }))} />
                  </div>
                </div>
              ) : (
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <FieldLabel>1st cutoff · 15th</FieldLabel>
                    <input className="fld" style={{ ...inputStyle, ...mono }} type="number" min="0" value={state.incomeA}
                      onChange={(e) => setState((s) => ({ ...s, incomeA: nn(e.target.value) }))} />
                  </div>
                  <div>
                    <FieldLabel>2nd cutoff · 30th</FieldLabel>
                    <input className="fld" style={{ ...inputStyle, ...mono }} type="number" min="0" value={state.incomeB}
                      onChange={(e) => setState((s) => ({ ...s, incomeB: nn(e.target.value) }))} />
                  </div>
                </div>
              )}

              <div>
                <FieldLabel>Current savings</FieldLabel>
                <input className="fld" style={{ ...inputStyle, ...mono }} type="number" min="0" value={state.currentSavings}
                  onChange={(e) => setState((s) => ({ ...s, currentSavings: nn(e.target.value) }))} />
              </div>

              <div>
                <div className="flex items-center justify-between mb-1">
                  <FieldLabel>Living expenses (monthly)</FieldLabel>
                  <Receipt size={14} style={{ color: C.faint }} />
                </div>
                <div className="space-y-2">
                  {state.expenses.map((x) => (
                    <div key={x.id} className="flex items-center gap-2">
                      <input className="fld flex-1" style={inputStyle} value={x.name} placeholder="Rent, food, subs…"
                        onChange={(e) => setExpense(x.id, { name: e.target.value })} />
                      <input className="fld" style={{ ...inputStyle, ...mono, width: "5.5rem" }} type="number" min="0" value={x.amount}
                        onChange={(e) => setExpense(x.id, { amount: nn(e.target.value) })} />
                      {semi && (
                        <select className="fld" style={{ ...inputStyle, width: "4.6rem", padding: "8px 6px", fontSize: "12px" }}
                          value={x.cutoff || "split"} onChange={(e) => setExpense(x.id, { cutoff: e.target.value })}
                          aria-label="Which payday covers this">
                          <option value="1">15th</option>
                          <option value="2">30th</option>
                          <option value="split">both</option>
                        </select>
                      )}
                      <button onClick={() => removeExpense(x.id)} className="ghost rounded-lg p-2" style={{ border: `1px solid ${C.line2}`, color: C.faint }} aria-label="Remove expense">
                        <Trash2 size={13} />
                      </button>
                    </div>
                  ))}
                </div>
                <button onClick={addExpense} className="ghost rounded-lg px-3 py-1 mt-2 text-xs flex items-center gap-1"
                  style={{ border: `1px solid ${C.line}`, color: C.mut }}>
                  <Plus size={12} /> Add expense
                </button>
              </div>

              <div className="rounded-xl p-3 text-xs space-y-1" style={{ background: C.card2, border: `1px solid ${C.line2}`, color: C.mut }}>
                {!semi ? (
                  <>
                    <div className="flex justify-between"><span style={{ color: C.gold }}>income</span><span style={{ ...mono, color: C.gold }}>{fmt(state.income)}</span></div>
                    <div className="flex justify-between"><span>living costs</span><span style={mono}>−{fmt(livingTotal)}</span></div>
                  </>
                ) : (
                  <>
                    <div className="flex justify-between"><span style={{ color: C.gold }}>15th: {fmt(state.incomeA)} − {fmt(exp1)}</span><span style={{ ...mono, color: cutOver1 ? C.rose : C.text }}>{fmt(avail1)}</span></div>
                    <div className="flex justify-between"><span style={{ color: C.gold }}>30th: {fmt(state.incomeB)} − {fmt(exp2)}</span><span style={{ ...mono, color: cutOver2 ? C.rose : C.text }}>{fmt(avail2)}</span></div>
                  </>
                )}
                <div className="flex justify-between" style={{ borderTop: `1px solid ${C.line2}`, paddingTop: 4 }}>
                  <span style={{ color: C.text }}>for the plan</span><span style={{ ...mono, color: C.text }}>{fmt(available)}/mo</span>
                </div>
              </div>
            </div>
          </Card>

          <Card>
            <Eyebrow jp="作戦" en="The plan" />
            <div className="space-y-3">
              <div>
                <FieldLabel>Strategy</FieldLabel>
                <div className="grid grid-cols-2 gap-2">
                  <button onClick={() => setState((s) => ({ ...s, strategy: "avalanche" }))}
                    className="hoverable rounded-xl p-3 text-left"
                    style={{ background: state.strategy === "avalanche" ? C.roseDim : C.card2, border: `1px solid ${state.strategy === "avalanche" ? C.rose : C.line}` }}>
                    <Flame size={15} style={{ color: C.rose }} />
                    <div className="text-sm font-medium mt-1">Avalanche</div>
                    <div className="text-xs mt-1" style={{ color: C.mut }}>highest APR first — the smart one ♡</div>
                  </button>
                  <button onClick={() => setState((s) => ({ ...s, strategy: "snowball" }))}
                    className="hoverable rounded-xl p-3 text-left"
                    style={{ background: state.strategy === "snowball" ? C.celDim : C.card2, border: `1px solid ${state.strategy === "snowball" ? C.cel : C.line}` }}>
                    <Snowflake size={15} style={{ color: C.cel }} />
                    <div className="text-sm font-medium mt-1">Snowball</div>
                    <div className="text-xs mt-1" style={{ color: C.mut }}>smallest first — for hearts that need wins</div>
                  </button>
                </div>
                <div className="text-xs mt-1" style={{ color: C.faint }}>Deadlined one-time bills count as dues — paid before the split, no matter what.</div>
              </div>

              <div>
                <label className="flex items-center gap-2 text-sm cursor-pointer">
                  <input type="checkbox" checked={state.emergencyFirst}
                    onChange={(e) => setState((s) => ({ ...s, emergencyFirst: e.target.checked }))} />
                  <span>Build emergency fund first</span>
                </label>
                {state.emergencyFirst && (
                  <div className="mt-2 space-y-2">
                    <div>
                      <FieldLabel>Emergency fund target</FieldLabel>
                      <input className="fld" style={{ ...inputStyle, ...mono }} type="number" min="0" value={state.emergencyTarget}
                        onChange={(e) => setState((s) => ({ ...s, emergencyTarget: nn(e.target.value) }))} />
                    </div>
                    <div>
                      <FieldLabel>While the fund is below target</FieldLabel>
                      <input type="range" min="0" max="100" step="5" value={state.fundSplit == null ? 100 : state.fundSplit} className="w-full"
                        onChange={(e) => setState((s) => ({ ...s, fundSplit: Number(e.target.value) }))} />
                      <div className="flex justify-between text-xs" style={{ color: C.mut }}>
                        <span style={{ color: C.rose }}>{100 - (state.fundSplit == null ? 100 : state.fundSplit)}% still attacks</span>
                        <span style={{ color: C.cel }}>{state.fundSplit == null ? 100 : state.fundSplit}% builds the fund</span>
                      </div>
                      {fundFirstActive && available > minSum && (
                        <div className="text-xs mt-1" style={{ color: C.gold }}>
                          active now — fund is below {fmt(state.emergencyTarget)}
                        </div>
                      )}
                    </div>
                  </div>
                )}
              </div>

              <div>
                <FieldLabel>Extra cash split (after minimums)</FieldLabel>
                <input type="range" min="0" max="100" step="5" value={state.savingsSplit} className="w-full"
                  onChange={(e) => setState((s) => ({ ...s, savingsSplit: Number(e.target.value) }))} />
                <div className="flex justify-between text-xs" style={{ color: C.mut }}>
                  <span style={{ color: C.rose }}>{100 - state.savingsSplit}% attacks debt</span>
                  <span style={{ color: C.cel }}>{state.savingsSplit}% to savings</span>
                </div>
                {fundFirstActive && (
                  <div className="text-xs mt-1" style={{ color: C.faint }}>(the fund-building split above rules until the fund hits target)</div>
                )}
              </div>
            </div>
          </Card>

          <Card>
            <div className="flex items-center justify-between mb-1">
              <Eyebrow jp="巻物" en="The scroll — markdown sync" />
              <ScrollText size={15} style={{ color: C.gold }} />
            </div>
            <p className="text-xs mb-3" style={{ color: C.mut }}>
              Export the whole plan as markdown for the terminal sister to analyze. Edit the tables, import the file back — everything recomputes.
            </p>
            <div className="grid grid-cols-2 gap-2">
              <button onClick={() => { setScrollText(buildMarkdown()); setScrollMsg(""); setScroll(scroll === "export" ? null : "export"); }}
                className="hoverable rounded-xl p-2 text-xs flex items-center justify-center gap-1"
                style={{ background: scroll === "export" ? C.goldDim : C.card2, border: `1px solid ${scroll === "export" ? C.gold : C.line}`, color: C.text }}>
                <Download size={13} style={{ color: C.gold }} /> Export
              </button>
              <button onClick={() => { setScrollText(""); setScrollMsg(""); setScroll(scroll === "import" ? null : "import"); }}
                className="hoverable rounded-xl p-2 text-xs flex items-center justify-center gap-1"
                style={{ background: scroll === "import" ? C.celDim : C.card2, border: `1px solid ${scroll === "import" ? C.cel : C.line}`, color: C.text }}>
                <Upload size={13} style={{ color: C.cel }} /> Import
              </button>
            </div>

            {scroll === "export" && (
              <div className="mt-3 space-y-2">
                <textarea readOnly value={scrollText} rows={8} className="fld w-full"
                  style={{ ...inputStyle, ...mono, fontSize: "11px", resize: "vertical" }} aria-label="Exported markdown" />
                <div className="grid grid-cols-2 gap-2">
                  <button onClick={downloadScroll} className="hoverable rounded-xl px-3 py-2 text-xs font-semibold"
                    style={{ background: C.gold, color: C.ink }}>Download .md</button>
                  <button onClick={copyScroll} className="ghost rounded-xl px-3 py-2 text-xs flex items-center justify-center gap-1"
                    style={{ border: `1px solid ${C.line}`, color: C.mut }}><Copy size={12} /> Copy</button>
                </div>
              </div>
            )}

            {scroll === "import" && (
              <div className="mt-3 space-y-2">
                <input type="file" accept=".md,.markdown,.txt,text/markdown,text/plain"
                  onChange={(e) => {
                    const f = e.target.files && e.target.files[0];
                    if (!f) return;
                    const r = new FileReader();
                    r.onload = () => setScrollText(String(r.result || ""));
                    r.readAsText(f);
                  }}
                  className="text-xs w-full" style={{ color: C.mut }} aria-label="Choose markdown file" />
                <textarea value={scrollText} onChange={(e) => setScrollText(e.target.value)} rows={6}
                  placeholder="…or paste the scroll here"
                  className="fld w-full" style={{ ...inputStyle, ...mono, fontSize: "11px", resize: "vertical" }} aria-label="Markdown to import" />
                <button onClick={() => applyImport(scrollText)} disabled={!scrollText.trim()}
                  className="hoverable rounded-xl px-3 py-2 text-xs font-semibold w-full"
                  style={{ background: C.cel, color: C.ink, opacity: scrollText.trim() ? 1 : 0.5 }}>
                  Load it into the plan
                </button>
              </div>
            )}

            {scrollMsg && <div className="text-xs mt-2" style={{ color: C.gold }}>{scrollMsg}</div>}
          </Card>

          <Card>
            <Eyebrow jp="記録" en="History" />
            {state.events.length === 0 ? (
              <div className="text-xs" style={{ color: C.faint }}>Quiet so far. Reality hasn’t punched you yet.</div>
            ) : (
              <div className="space-y-2">
                {state.events.map((e) => (
                  <div key={e.id} className="text-xs flex gap-2">
                    <span style={{ ...mono, color: C.faint, whiteSpace: "nowrap" }}>
                      {new Date(e.ts).toLocaleDateString(undefined, { month: "short", day: "numeric" })}
                    </span>
                    <span style={{ color: C.mut }}>{e.text}</span>
                  </div>
                ))}
              </div>
            )}
          </Card>
        </section>
      </div>
    </>
  );

  /* ────────────────────────── shell ────────────────────────── */
  return (
    <div className="min-h-screen" style={{ background: C.bg, color: C.text, fontFamily: "ui-sans-serif, system-ui, sans-serif" }}>
      <style>{`
        .fld:focus { border-color: ${C.rose} !important; outline: none; }
        .hoverable { transition: filter .15s ease, border-color .15s ease; }
        .hoverable:hover { filter: brightness(1.15); }
        .ghost:hover { border-color: ${C.rose} !important; color: ${C.text} !important; }
        input[type=range] { accent-color: ${C.rose}; }
        input[type=checkbox] { accent-color: ${C.rose}; }
        button:focus-visible, input:focus-visible, select:focus-visible { outline: 2px solid ${C.rose}; outline-offset: 2px; }
        ::selection { background: ${C.roseDeep}; color: ${C.text}; }
      `}</style>

      <div className="max-w-5xl mx-auto px-4 py-8">

        {/* header */}
        <div className="flex items-start justify-between gap-4">
          <div>
            <div className="text-xs uppercase mb-1" style={{ color: C.rose, letterSpacing: "0.3em" }}>Sophie’s</div>
            <h1 className="text-2xl md:text-3xl" style={{ ...serif, color: C.text }}>
              Debt-Zero Plan <span style={{ color: C.rose }}>♡</span>
            </h1>
          </div>
          <select
            value={state.currency}
            onChange={(e) => setState((s) => ({ ...s, currency: e.target.value }))}
            className="text-xs rounded-lg px-2 py-1"
            style={{ background: C.card, border: `1px solid ${C.line}`, color: C.mut }}
            aria-label="Currency"
          >
            {CURRENCIES.map((c) => <option key={c} value={c}>{c}</option>)}
          </select>
        </div>

        {/* always-on vitals */}
        <div className="flex flex-wrap items-center gap-x-6 gap-y-2 mt-4">
          <div className="text-sm" style={{ ...mono, color: C.rose }}>debt {fmt(totalDebtNow)}</div>
          <div className="text-sm" style={{ ...mono, color: C.cel }}>
            savings {fmt(state.currentSavings)}
            {dfm !== null && dfm > 0 && <span style={{ color: C.faint }}> → {fmt(sim.savAtFree)}</span>}
          </div>
          {state.debts.length > 0 && (
            dfm === null
              ? <Chip color={C.rose}>never at this pace…</Chip>
              : dfm === 0
                ? <span className="rounded-full px-3 py-1 text-xs font-bold" style={{ background: C.rose, color: C.ink }}>DEBT-FREE ♡</span>
                : <span className="rounded-full px-3 py-1 text-xs font-bold" style={{ background: C.rose, color: C.ink }}>debt-free {mLabel(dfm)} ♡</span>
          )}
        </div>
        {state.debts.length > 0 && (
          <div className="flex items-center gap-3 mt-3">
            <div className="flex-1 h-2 rounded-full overflow-hidden" style={{ background: C.line2 }}>
              <div className="h-full rounded-full" style={{ width: `${destroyedPct}%`, background: C.rose, transition: "width .4s ease" }} />
            </div>
            <span className="text-xs" style={{ ...mono, color: C.faint }}>{destroyedPct}% destroyed</span>
          </div>
        )}

        {/* nav */}
        <div className="grid grid-cols-3 gap-2 mt-5 mb-6">
          {TABS.map((t) => (
            <button key={t.id} onClick={() => setView(t.id)}
              className="hoverable rounded-xl py-2 text-sm flex items-center justify-center gap-2"
              style={{ background: view === t.id ? C.roseDim : C.card, border: `1px solid ${view === t.id ? C.rose : C.line}` }}>
              <span style={{ ...serif, color: view === t.id ? C.rose : C.gold }}>{t.jp}</span>
              <span style={{ color: view === t.id ? C.text : C.mut }}>{t.en}</span>
            </button>
          ))}
        </div>

        {view === "now" && NowView()}
        {view === "road" && RoadView()}
        {view === "ledger" && LedgerView()}

        {/* footer */}
        <div className="mt-10 flex flex-wrap items-center justify-between gap-3 text-xs" style={{ color: C.faint }}>
          <div>Auto-saves between visits — your numbers stay put, just for you ♡</div>
          <button
            onClick={() => {
              if (!confirmReset) { setConfirmReset(true); setTimeout(() => setConfirmReset(false), 4000); }
              else doReset();
            }}
            className="ghost flex items-center gap-1 rounded-lg px-3 py-1"
            style={{ border: `1px solid ${C.line}`, color: confirmReset ? C.rose : C.faint }}>
            {confirmReset ? <X size={12} /> : <RotateCcw size={12} />}
            {confirmReset ? "really wipe everything?" : "Reset everything"}
          </button>
        </div>

        <div className="mt-6 text-xs" style={{ color: C.line }}>
          Projections assume monthly compounding and steady income — a planning sketch with rule-of-thumb heuristics, not financial advice, baka. Paydays modeled as the 15th and the last day of the month.
        </div>
      </div>
    </div>
  );
}
