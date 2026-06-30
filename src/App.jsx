import { useState, useEffect, useMemo, useRef } from 'react';
import {
  Activity, Plus, Pencil, Trash2, X, Check,
  Cloud, CloudOff, ChevronLeft, ChevronRight,
  Settings, CalendarRange, CalendarDays
} from 'lucide-react';

/* ---------- defaults ---------- */
const DEFAULT_ZONES = [
  { id: "z1", name: "Zone 1", color: "#64748b", low: "0",   high: "128" },
  { id: "z2", name: "Zone 2", color: "#4f8ef7", low: "129", high: "160" },
  { id: "z3", name: "Zone 3", color: "#22c55e", low: "161", high: "175" },
  { id: "z4", name: "Zone 4", color: "#f97316", low: "176", high: "191" },
  { id: "z5", name: "Zone 5", color: "#ef4444", low: "192", high: "" },
];
const ZONE_PALETTE = ["#38bdf8", "#34d399", "#fbbf24", "#fb923c", "#f43f5e", "#a78bfa", "#22d3ee", "#f472b6"];

/* ---------- date + time helpers ---------- */
const pad = (n) => String(n).padStart(2, "0");
function parseDate(s) { const [y, m, d] = s.split("-").map(Number); return new Date(y, m - 1, d); }
function toISO(d) { return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; }
function todayISO() { return toISO(new Date()); }
function addDays(d, n) { const x = new Date(d.getFullYear(), d.getMonth(), d.getDate()); x.setDate(x.getDate() + n); return x; }
function mondayOf(d) { const x = new Date(d.getFullYear(), d.getMonth(), d.getDate()); const dow = (x.getDay() + 6) % 7; x.setDate(x.getDate() - dow); return x; }
function dayMonth(d) { return d.toLocaleDateString(undefined, { month: "short", day: "numeric" }); }
function fmtDate(iso) { return parseDate(iso).toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" }); }
function weekLabel(iso) { const m = parseDate(iso); return `${dayMonth(m)} \u2013 ${dayMonth(addDays(m, 6))}`; }
function fmt(sec) {
  sec = Math.max(0, Math.round(sec));
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
function bpmText(z) {
  if (z.low && z.high) return `${z.low}\u2013${z.high} bpm`;
  if (z.low) return `${z.low}+ bpm`;
  if (z.high) return `0\u2013${z.high} bpm`;
  return "";
}

/* ---------- storage: Supabase cloud (primary) + on-device (fallback) ---------- */
const SB_URL = import.meta.env.VITE_SUPABASE_URL;
const SB_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY;
const SB_KV = `${SB_URL}/rest/v1/hr_kv`;
const sbHeaders = { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`, "Content-Type": "application/json" };

async function cloudPing() {
  const r = await fetch(`${SB_KV}?select=key&limit=1`, { headers: sbHeaders });
  return r.ok;
}
async function cloudGet(key) {
  const r = await fetch(`${SB_KV}?key=eq.${encodeURIComponent(key)}&select=value`, { headers: sbHeaders });
  if (!r.ok) throw new Error("cloud get failed");
  const rows = await r.json();
  return rows.length ? rows[0].value : null;
}
async function cloudSet(key, value) {
  const r = await fetch(SB_KV, {
    method: "POST",
    headers: { ...sbHeaders, Prefer: "resolution=merge-duplicates,return=minimal" },
    body: JSON.stringify({ key, value, updated_at: new Date().toISOString() }),
  });
  if (!r.ok) throw new Error("cloud set failed");
}

async function localGet(key, fallback) {
  try {
    if (typeof window !== "undefined" && window.localStorage) {
      const r = window.localStorage.getItem("hrz_" + key);
      if (r) return JSON.parse(r);
    }
  } catch (e) { /* missing -> fallback */ }
  return fallback;
}
async function localSet(key, value) {
  try {
    if (typeof window !== "undefined" && window.localStorage) {
      window.localStorage.setItem("hrz_" + key, JSON.stringify(value));
    }
  } catch (e) { console.error("local save failed", key, e); }
}

/* ---------- spectrum bar (the signature element) ---------- */
function Spectrum({ zones, totals, height = 14, radius = 999 }) {
  const total = zones.reduce((s, z) => s + (totals[z.id] || 0), 0);
  return (
    <div className="spectrum" style={{ height, borderRadius: radius }}>
      {total > 0 && zones.map((z) => {
        const w = ((totals[z.id] || 0) / total) * 100;
        if (w <= 0) return null;
        return <div key={z.id} title={`${z.name}: ${fmt(totals[z.id] || 0)}`} style={{ width: w + "%", background: z.color }} />;
      })}
    </div>
  );
}

function ZoneBreakdown({ zones, totals }) {
  const total = zones.reduce((s, z) => s + (totals[z.id] || 0), 0);
  if (total <= 0) return null;
  return (
    <div className="zone-rows">
      {zones.map((z) => {
        const t = totals[z.id] || 0;
        const pct = (t / total) * 100;
        const label = bpmText(z);
        return (
          <div className="zrow" key={z.id}>
            <div className="zrow-top">
              <div className="zrow-name">
                <span className="zname">{z.name}</span>
                {label && <span className="zbpm">{label}</span>}
              </div>
              <div className="zrow-val">
                <span className="zpct">{Math.round(pct)}%</span>
                <span className="ztime mono">{fmt(t)}</span>
              </div>
            </div>
            <div className="ztrack"><div className="zfill" style={{ width: pct + "%", background: z.color }} /></div>
          </div>
        );
      })}
    </div>
  );
}

function App() {
  const [zones, setZones] = useState(DEFAULT_ZONES);
  const [runs, setRuns] = useState([]);
  const [loaded, setLoaded] = useState(false);

  const [mode, setMode] = useState("range"); // "range" | "week"
  const [rangeStart, setRangeStart] = useState(null);
  const [rangeEnd, setRangeEnd] = useState(null);
  const [weekStart, setWeekStart] = useState(toISO(mondayOf(new Date())));

  const [form, setForm] = useState(() => ({ date: todayISO(), durations: {} }));
  const [editingId, setEditingId] = useState(null);
  const [error, setError] = useState("");

  const [showSettings, setShowSettings] = useState(false);
  const [expandedId, setExpandedId] = useState(null);
  const [confirmId, setConfirmId] = useState(null);
  const [syncMode, setSyncMode] = useState("checking"); // checking | cloud | local

  const formRef = useRef(null);
  const modeRef = useRef("local");

  /* load: try cloud first, fall back to on-device storage */
  useEffect(() => {
    (async () => {
      let currentMode = "local";
      try {
        if (await cloudPing()) {
          currentMode = "cloud";
          // first time on the cloud: lift any existing on-device data up
          const existing = await cloudGet("zones");
          if (existing == null) {
            const lz = await localGet("zones", null);
            const lr = await localGet("runs", null);
            if (lz) await cloudSet("zones", lz);
            if (lr) await cloudSet("runs", lr);
          }
        }
      } catch (e) { currentMode = "local"; }
      modeRef.current = currentMode;
      setSyncMode(currentMode);

      const z = currentMode === "cloud" ? await cloudGet("zones") : await localGet("zones", null);
      const r = currentMode === "cloud" ? await cloudGet("runs") : await localGet("runs", null);
      const zs = Array.isArray(z) && z.length ? z : DEFAULT_ZONES;
      const rs = Array.isArray(r) ? r : [];
      setZones(zs);
      setRuns(rs);
      const dates = rs.map((x) => x.date).sort();
      setRangeStart(dates[0] || todayISO());
      setRangeEnd(todayISO());
      setLoaded(true);
    })();
  }, []);

  /* persist to the active backend; downgrade to local if a cloud write fails */
  async function saveData(key, value) {
    if (modeRef.current === "cloud") {
      try { await cloudSet(key, value); return; }
      catch (e) { modeRef.current = "local"; setSyncMode("local"); }
    }
    await localSet(key, value);
  }
  useEffect(() => { if (loaded) saveData("zones", zones); }, [zones, loaded]);
  useEffect(() => { if (loaded) saveData("runs", runs); }, [runs, loaded]);

  /* active window */
  const startISO = mode === "range" ? (rangeStart || "0000-01-01") : weekStart;
  const endISO = mode === "range" ? (rangeEnd || "9999-12-31") : toISO(addDays(parseDate(weekStart), 6));

  const agg = useMemo(() => {
    const totals = {}; zones.forEach((z) => (totals[z.id] = 0));
    let count = 0;
    for (const run of runs) {
      if (run.date >= startISO && run.date <= endISO) {
        count++;
        for (const z of zones) totals[z.id] += run.durations[z.id] || 0;
      }
    }
    return { totals, count };
  }, [runs, zones, startISO, endISO]);

  const periodTotal = zones.reduce((s, z) => s + (agg.totals[z.id] || 0), 0);

  const weeks = useMemo(() => {
    const map = {};
    runs.forEach((r) => {
      const wk = toISO(mondayOf(parseDate(r.date)));
      if (!map[wk]) { map[wk] = { totals: {}, count: 0 }; zones.forEach((z) => (map[wk].totals[z.id] = 0)); }
      map[wk].count++;
      zones.forEach((z) => (map[wk].totals[z.id] += r.durations[z.id] || 0));
    });
    return Object.entries(map).map(([wk, v]) => ({ wk, ...v })).sort((a, b) => (a.wk < b.wk ? 1 : -1));
  }, [runs, zones]);

  const sortedRuns = useMemo(() => [...runs].sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0)), [runs]);

  /* form helpers */
  const dv = (zid) => form.durations[zid] || { min: "", sec: "" };
  const setDur = (zid, field, val) =>
    setForm((f) => ({ ...f, durations: { ...f.durations, [zid]: { ...(f.durations[zid] || { min: "", sec: "" }), [field]: val.replace(/[^0-9]/g, "") } } }));

  function resetForm() { setForm({ date: todayISO(), durations: {} }); setEditingId(null); setError(""); }

  function saveRun() {
    const durations = {}; let total = 0;
    zones.forEach((z) => {
      const f = dv(z.id);
      const s = (parseInt(f.min || "0", 10) || 0) * 60 + Math.min(59, parseInt(f.sec || "0", 10) || 0);
      durations[z.id] = s; total += s;
    });
    if (total <= 0) { setError("Add time to at least one zone before saving."); return; }
    if (editingId) setRuns(runs.map((r) => (r.id === editingId ? { ...r, date: form.date, durations } : r)));
    else setRuns([{ id: uid(), date: form.date, durations }, ...runs]);
    resetForm();
  }

  function startEdit(run) {
    const d = {};
    zones.forEach((z) => {
      const s = run.durations[z.id] || 0;
      d[z.id] = { min: s ? String(Math.floor(s / 60)) : "", sec: s ? String(s % 60) : "" };
    });
    setForm({ date: run.date, durations: d });
    setEditingId(run.id); setError("");
    setTimeout(() => formRef.current && formRef.current.scrollIntoView({ behavior: "smooth", block: "start" }), 50);
  }

  /* zone editing */
  const updateZone = (id, patch) => setZones((zs) => zs.map((z) => (z.id === id ? { ...z, ...patch } : z)));
  const addZone = () => setZones((zs) => [...zs, { id: uid(), name: `Zone ${zs.length + 1}`, color: ZONE_PALETTE[zs.length % ZONE_PALETTE.length], low: "", high: "" }]);
  const removeZone = (id) => setZones((zs) => (zs.length > 1 ? zs.filter((z) => z.id !== id) : zs));

  const setQuickRange = (days) => {
    setRangeEnd(todayISO());
    if (days === "all") { const dates = runs.map((r) => r.date).sort(); setRangeStart(dates[0] || todayISO()); }
    else setRangeStart(toISO(addDays(new Date(), -days + 1)));
  };

  const gradient = `linear-gradient(90deg, ${zones.map((z) => z.color).join(", ")})`;

  return (
    <div className="wrap">
      <div className="col">
        {/* header */}
        <header className="head">
          <div className="brand">
            <span className="logo"><Activity size={18} /><span className="pulse-dot" /></span>
            <div>
              <h1>Zone Ledger</h1>
              <p className="sub">Time in heart&#8209;rate zones, run by run.</p>
            </div>
          </div>
          <div className="head-right">
            <span className={"sync " + syncMode}>
              {syncMode === "cloud" && <><Cloud size={13} /> Synced</>}
              {syncMode === "local" && <><CloudOff size={13} /> This device</>}
              {syncMode === "checking" && <>Connecting&hellip;</>}
            </span>
            <button className="icon-btn" onClick={() => setShowSettings((s) => !s)} aria-label="Edit zones">
              <Settings size={18} />
            </button>
          </div>
        </header>
        <div className="rule" style={{ background: gradient }} />

        {/* settings */}
        {showSettings && (
          <section className="card">
            <div className="card-head">
              <span className="eyebrow">Your zones</span>
              <button className="icon-btn" onClick={() => setShowSettings(false)} aria-label="Close"><X size={16} /></button>
            </div>
            <div className="zone-edit-list">
              {zones.map((z) => (
                <div className="zone-edit" key={z.id}>
                  <input className="color" type="color" value={z.color} onChange={(e) => updateZone(z.id, { color: e.target.value })} aria-label="Zone color" />
                  <input className="input grow" type="text" value={z.name} onChange={(e) => updateZone(z.id, { name: e.target.value })} placeholder="Zone name" />
                  <input className="input num" type="number" min="0" value={z.low} onChange={(e) => updateZone(z.id, { low: e.target.value })} placeholder="low" aria-label="Low BPM" />
                  <span className="dash">&ndash;</span>
                  <input className="input num" type="number" min="0" value={z.high} onChange={(e) => updateZone(z.id, { high: e.target.value })} placeholder="high" aria-label="High BPM" />
                  <span className="unit">bpm</span>
                  <button className="icon-btn danger" onClick={() => removeZone(z.id)} aria-label="Remove zone" disabled={zones.length <= 1}><Trash2 size={15} /></button>
                </div>
              ))}
            </div>
            <button className="btn ghost full" onClick={addZone}><Plus size={15} /> Add zone</button>
          </section>
        )}

        {/* AGGREGATE PANEL (top) */}
        <section className="card hero">
          <div className="card-head">
            <span className="eyebrow">Time in zone</span>
            <div className="seg">
              <button className={mode === "range" ? "on" : ""} onClick={() => setMode("range")}><CalendarRange size={14} /> Range</button>
              <button className={mode === "week" ? "on" : ""} onClick={() => setMode("week")}><CalendarDays size={14} /> Weekly</button>
            </div>
          </div>

          {/* filter controls */}
          {mode === "range" ? (
            <div className="filter">
              <div className="dates">
                <label>From <input className="input" type="date" value={rangeStart || ""} onChange={(e) => setRangeStart(e.target.value)} /></label>
                <label>To <input className="input" type="date" value={rangeEnd || ""} onChange={(e) => setRangeEnd(e.target.value)} /></label>
              </div>
              <div className="quick">
                {[["7d", 7], ["30d", 30], ["90d", 90], ["All", "all"]].map(([lbl, v]) => (
                  <button key={lbl} className="chip" onClick={() => setQuickRange(v)}>{lbl}</button>
                ))}
              </div>
            </div>
          ) : (
            <div className="weeknav">
              <button className="icon-btn" onClick={() => setWeekStart(toISO(addDays(parseDate(weekStart), -7)))} aria-label="Previous week"><ChevronLeft size={18} /></button>
              <div className="weeknav-label"><span className="mono">{weekLabel(weekStart)}</span><button className="thisweek" onClick={() => setWeekStart(toISO(mondayOf(new Date())))}>This week</button></div>
              <button className="icon-btn" onClick={() => setWeekStart(toISO(addDays(parseDate(weekStart), 7)))} aria-label="Next week"><ChevronRight size={18} /></button>
            </div>
          )}

          {/* readout */}
          <div className="readout">
            <span className="mono big">{fmt(periodTotal)}</span>
            <span className="readout-meta mono">{agg.count} {agg.count === 1 ? "run" : "runs"}</span>
          </div>

          {/* per-zone breakdown (Runna-style, share of total) */}
          {periodTotal > 0 ? (
            <ZoneBreakdown zones={zones} totals={agg.totals} />
          ) : (
            <p className="empty">No time logged for this period. Pick another window or add a run below.</p>
          )}

          {/* weekly list */}
          {mode === "week" && weeks.length > 0 && (
            <div className="weeklist">
              <span className="eyebrow">By week</span>
              <div className="weeklist-scroll">
                {weeks.map((w) => {
                  const wt = zones.reduce((s, z) => s + (w.totals[z.id] || 0), 0);
                  return (
                    <button key={w.wk} className={"wkrow" + (w.wk === weekStart ? " sel" : "")} onClick={() => setWeekStart(w.wk)}>
                      <span className="mono wklabel">{weekLabel(w.wk)}</span>
                      <span className="wkbar"><Spectrum zones={zones} totals={w.totals} height={8} radius={4} /></span>
                      <span className="mono wktotal">{fmt(wt)}</span>
                    </button>
                  );
                })}
              </div>
            </div>
          )}
        </section>

        {/* LOG A RUN */}
        <section className="card" ref={formRef}>
          <div className="card-head">
            <span className="eyebrow">{editingId ? "Edit run" : "Log a run"}</span>
            <input className="input date-in" type="date" value={form.date} onChange={(e) => setForm((f) => ({ ...f, date: e.target.value }))} />
          </div>
          <div className="entry-list">
            {zones.map((z) => (
              <div className="entry" key={z.id}>
                <div className="entry-name">
                  <span className="dot" style={{ background: z.color }} />
                  <span className="zname">{z.name}</span>
                </div>
                <div className="time-in">
                  <input className="input num" type="number" min="0" inputMode="numeric" value={dv(z.id).min} onChange={(e) => setDur(z.id, "min", e.target.value)} placeholder="0" aria-label={`${z.name} minutes`} />
                  <span className="tlabel">min</span>
                  <input className="input num" type="number" min="0" max="59" inputMode="numeric" value={dv(z.id).sec} onChange={(e) => setDur(z.id, "sec", e.target.value)} placeholder="00" aria-label={`${z.name} seconds`} />
                  <span className="tlabel">sec</span>
                </div>
              </div>
            ))}
          </div>
          {error && <p className="error">{error}</p>}
          <div className="actions">
            <button className="btn primary" onClick={saveRun}>{editingId ? <><Check size={15} /> Update run</> : <><Plus size={15} /> Add run</>}</button>
            {editingId && <button className="btn ghost" onClick={resetForm}>Cancel</button>}
          </div>
        </section>

        {/* HISTORY */}
        <section className="card">
          <div className="card-head">
            <span className="eyebrow">History</span>
            <span className="count mono">{runs.length}</span>
          </div>
          {sortedRuns.length === 0 ? (
            <p className="empty">No runs logged yet. Add your first run above to start building your zone history.</p>
          ) : (
            <div className="hist">
              {sortedRuns.map((run) => {
                const total = zones.reduce((s, z) => s + (run.durations[z.id] || 0), 0);
                const open = expandedId === run.id;
                return (
                  <div className={"hrow" + (open ? " open" : "")} key={run.id}>
                    <button className="hrow-main" onClick={() => setExpandedId(open ? null : run.id)}>
                      <div className="hrow-left">
                        <span className="hdate">{fmtDate(run.date)}</span>
                        <span className="mono htotal">{fmt(total)}</span>
                      </div>
                      <span className="hbar"><Spectrum zones={zones} totals={run.durations} height={8} radius={4} /></span>
                    </button>
                    <div className="hrow-act">
                      {confirmId === run.id ? (
                        <>
                          <span className="confirm">Delete?</span>
                          <button className="icon-btn danger" onClick={() => { setRuns(runs.filter((r) => r.id !== run.id)); setConfirmId(null); if (editingId === run.id) resetForm(); }} aria-label="Confirm delete"><Check size={15} /></button>
                          <button className="icon-btn" onClick={() => setConfirmId(null)} aria-label="Cancel delete"><X size={15} /></button>
                        </>
                      ) : (
                        <>
                          <button className="icon-btn" onClick={() => startEdit(run)} aria-label="Edit run"><Pencil size={14} /></button>
                          <button className="icon-btn" onClick={() => setConfirmId(run.id)} aria-label="Delete run"><Trash2 size={14} /></button>
                        </>
                      )}
                    </div>
                    {open && (
                      <div className="hdetail">
                        <ZoneBreakdown zones={zones} totals={run.durations} />
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </section>

        <p className="foot">{syncMode === "cloud" ? "Synced to your Supabase project \u2014 open on any device" : syncMode === "local" ? "Saved on this device" : "Connecting\u2026"} &middot; weeks run Monday to Sunday</p>
      </div>
    </div>
  );
}

export default App;
