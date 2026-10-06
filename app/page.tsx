'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import axios from 'axios';
import { Activity, Gauge, ShieldCheck, Play, Zap, RefreshCw, AlertTriangle } from 'lucide-react';
import { AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from 'recharts';

// set NEXT_PUBLIC_API_BASE in .env.local (or your Vercel env) to point at the deployed API
const API_BASE = process.env.NEXT_PUBLIC_API_BASE ?? 'http://localhost:8000';

interface Rule { name: string; prefix: string; capacity: number; refill_rate: number }
interface Metrics {
  service: string; status: string; algorithm: string; backend: string; version: string;
  rules: Rule[]; allowed: Record<string, number>; blocked: Record<string, number>;
}
interface Log { id: number; ts: number; path: string; status: number; ms: number; left: number | null }
interface Bucket { remaining: number; ts: number; blockedUntil: number }

// same shape as the backend RULES, used until /metrics answers
const DEFAULT_RULES: Rule[] = [
  { name: 'login', prefix: '/login', capacity: 5, refill_rate: 1 },
  { name: 'default', prefix: '/', capacity: 100, refill_rate: 100 / 60 },
];
const ROUTES = ['/', '/login', '/api/public'];
const OK = '#0d9488';
const BAD = '#e11d48';
const WARN = '#d97706';

const sum = (o?: Record<string, number>) => Object.values(o ?? {}).reduce((a, b) => a + b, 0);

function Card({ title, sub, right, flush, className = '', children }: {
  title: string; sub?: string; right?: React.ReactNode; flush?: boolean; className?: string; children: React.ReactNode;
}) {
  return (
    <section className={`rounded-xl border border-line bg-surface shadow-sm shadow-slate-200/40 ${className}`}>
      <header className="flex items-center justify-between gap-3 border-b border-line-soft px-5 py-3">
        <div>
          <h2 className="text-sm font-bold tracking-tight text-slate-900">{title}</h2>
          {sub && <p className="mt-0.5 text-xs font-medium text-slate-500">{sub}</p>}
        </div>
        {right}
      </header>
      <div className={flush ? '' : 'p-5'}>{children}</div>
    </section>
  );
}

function Kpi({ label, value, hint, icon: Icon, accent }: {
  label: string; value: string; hint: string; icon: typeof Activity; accent?: string;
}) {
  return (
    <div className="group relative overflow-hidden rounded-xl border border-line bg-surface px-5 py-4 shadow-sm shadow-slate-200/40 transition-shadow hover:shadow-md hover:shadow-slate-200/60">
      <div className="flex items-center justify-between">
        <span className="text-xs font-semibold uppercase tracking-wide text-slate-600">{label}</span>
        <span
          className="flex h-7 w-7 items-center justify-center rounded-lg"
          style={{ background: accent ? `${accent}14` : '#0d948814', color: accent ?? '#0d9488' }}
        >
          <Icon className="h-3.5 w-3.5" />
        </span>
      </div>
      <div className="tabular mt-2 text-[28px] font-bold leading-none tracking-tight text-slate-900">{value}</div>
      <div className="mt-1.5 text-xs font-medium text-slate-500">{hint}</div>
    </div>
  );
}

export default function Home() {
  const [metrics, setMetrics] = useState<Metrics | null>(null);
  const [offline, setOffline] = useState(false);
  const [logs, setLogs] = useState<Log[]>([]);
  const [buckets, setBuckets] = useState<Record<string, Bucket>>({});
  const [path, setPath] = useState('/login');
  const [busy, setBusy] = useState(false);
  const [now, setNow] = useState(0);
  const idRef = useRef(0);

  const rules = metrics?.rules ?? DEFAULT_RULES;
  const ruleFor = useCallback((p: string) => rules.find((r) => p.startsWith(r.prefix)) ?? rules[rules.length - 1], [rules]);

  const fetchMetrics = useCallback(async () => {
    try {
      const res = await axios.get<Metrics>(`${API_BASE}/metrics`, { timeout: 4000 });
      setMetrics(res.data);
      setOffline(false);
    } catch {
      setOffline(true);
    }
  }, []);

  useEffect(() => {
    fetchMetrics();
    const poll = setInterval(fetchMetrics, 5000);
    return () => clearInterval(poll);
  }, [fetchMetrics]);

  // one clock drives chart window, bucket refill animation and retry countdown
  useEffect(() => {
    setNow(Date.now());
    const tick = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(tick);
  }, []);

  const send = useCallback(async (p: string) => {
    const t0 = performance.now();
    let status = 0;
    let h: Record<string, string> = {};
    try {
      const res = await axios.get(`${API_BASE}${p}`, { validateStatus: () => true, timeout: 8000 });
      status = res.status;
      h = res.headers as Record<string, string>;
    } catch {
      status = 0;
    }
    const ts = Date.now();
    const left = h['x-ratelimit-remaining'] !== undefined ? Number(h['x-ratelimit-remaining']) : null;
    setLogs((prev) => [{ id: ++idRef.current, ts, path: p, status, ms: Math.round(performance.now() - t0), left }, ...prev].slice(0, 200));
    if (left !== null) {
      const retry = Number(h['retry-after'] ?? 0);
      setBuckets((prev) => ({ ...prev, [ruleFor(p).name]: { remaining: left, ts, blockedUntil: status === 429 ? ts + retry * 1000 : 0 } }));
    }
  }, [ruleFor]);

  const burst = async () => {
    setBusy(true);
    const rule = ruleFor(path);
    const count = rule.name === 'login' ? rule.capacity + 5 : rule.capacity + 20;
    // all at once, like a real traffic spike (one after another is too slow, the bucket refills in between)
    await Promise.all(Array.from({ length: count }, () => send(path)));
    await fetchMetrics();
    setBusy(false);
  };

  // tokens the bucket should hold right now, using the same refill maths as the backend
  const tokensNow = (r: Rule) => {
    const b = buckets[r.name];
    if (!b) return r.capacity;
    return Math.min(r.capacity, b.remaining + ((now - b.ts) / 1000) * r.refill_rate);
  };

  const allowed = logs.filter((l) => l.status >= 200 && l.status < 400).length;
  const blocked = logs.filter((l) => l.status === 429).length;
  const errors = logs.length - allowed - blocked;

  const serverTotal = sum(metrics?.allowed) + sum(metrics?.blocked);
  const blockRate = serverTotal ? (sum(metrics?.blocked) / serverTotal) * 100 : 0;
  const lat = logs.filter((l) => l.status > 0).map((l) => l.ms).sort((a, b) => a - b);
  const avg = lat.length ? Math.round(lat.reduce((a, b) => a + b, 0) / lat.length) : 0;
  const p95 = lat.length ? lat[Math.min(lat.length - 1, Math.floor(lat.length * 0.95))] : 0;

  const series = useMemo(() => {
    if (!now) return [];
    const step = 5000;
    const n = 12;
    const end = (Math.floor(now / step) + 1) * step;
    const start = end - n * step;
    const rows = Array.from({ length: n }, (_, i) => ({
      label: new Date(start + i * step).toLocaleTimeString([], { hour12: false, minute: '2-digit', second: '2-digit' }),
      allowed: 0,
      blocked: 0,
    }));
    for (const l of logs) {
      const i = Math.floor((l.ts - start) / step);
      if (i >= 0 && i < n) (l.status === 429 ? rows[i].blocked++ : rows[i].allowed++);
    }
    return rows;
  }, [logs, now]);

  const chip = (s: number): [string, string] =>
    s >= 200 && s < 400 ? ['Allowed', 'bg-brand-soft text-brand font-semibold']
      : s === 429 ? ['Blocked', 'bg-bad-soft text-bad font-semibold']
        : ['Error', 'bg-warn-soft text-warn font-semibold'];

  const selected = ruleFor(path);

  return (
    <div className="min-h-screen">
      <header className="sticky top-0 z-10 border-b border-white/5 bg-nav/95 backdrop-blur supports-[backdrop-filter]:bg-nav/80">
        <div className="mx-auto flex h-14 max-w-7xl items-center justify-between px-5">
          <div className="flex items-center gap-3">
            <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-brand shadow-sm shadow-teal-900/40">
              <ShieldCheck className="h-4 w-4 text-white" />
            </div>
            <span className="text-sm font-bold tracking-tight text-white">Rate Limiter</span>
          </div>
          <div className="flex items-center gap-2">
            <span className={`flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-semibold ${offline ? 'bg-bad/15 text-rose-300' : 'bg-brand/15 text-teal-300'}`}>
              <span className={`h-1.5 w-1.5 rounded-full ${offline ? 'bg-bad' : 'bg-brand'} ${!offline ? 'animate-pulse' : ''}`} />
              {offline ? 'API unreachable' : 'API healthy'}
            </span>
            <button onClick={fetchMetrics} aria-label="Refresh metrics" className="rounded-lg p-2 text-slate-400 transition-colors hover:bg-white/10 hover:text-white focus-visible:outline-2 focus-visible:outline-brand">
              <RefreshCw className="h-4 w-4" />
            </button>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-7xl space-y-4 px-5 py-5">
        {offline && (
          <div className="flex items-center gap-2.5 rounded-xl border border-warn/30 bg-warn-soft px-4 py-3 text-xs font-semibold text-warn">
            <AlertTriangle className="h-4 w-4 shrink-0" />
            <span>Cannot reach <span className="font-mono">{API_BASE}</span>. Start the API or check NEXT_PUBLIC_API_BASE.</span>
          </div>
        )}

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
          <Kpi label="Requests handled" value={serverTotal.toLocaleString()} hint="All clients, since API start" icon={Activity} />
          <Kpi label="Block rate" value={`${blockRate.toFixed(1)}%`} hint={`${sum(metrics?.blocked).toLocaleString()} requests rejected`} icon={ShieldCheck} accent={BAD} />
          <Kpi label="Latency" value={`${avg} ms`} hint={`p95 ${p95} ms · this session`} icon={Gauge} />
        </div>

        <Card
          title="Traffic"
          sub="Requests sent from this page, 5 second intervals"
          right={
            <div className="flex items-center gap-4 text-xs font-medium text-slate-600">
              <span className="flex items-center gap-1.5"><span className="h-2 w-2 rounded-full bg-brand" />Allowed</span>
              <span className="flex items-center gap-1.5"><span className="h-2 w-2 rounded-full bg-bad" />Blocked</span>
            </div>
          }
        >
          <ResponsiveContainer width="100%" height={280}>
            <AreaChart data={series} margin={{ top: 8, right: 8, left: -16, bottom: 0 }}>
              <defs>
                <linearGradient id="fillAllowed" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor={OK} stopOpacity={0.25} />
                  <stop offset="100%" stopColor={OK} stopOpacity={0.02} />
                </linearGradient>
                <linearGradient id="fillBlocked" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor={BAD} stopOpacity={0.25} />
                  <stop offset="100%" stopColor={BAD} stopOpacity={0.02} />
                </linearGradient>
              </defs>
              <CartesianGrid stroke="#e2e8f0" strokeDasharray="3 3" vertical={false} />
              <XAxis dataKey="label" stroke="#64748b" fontSize={11} tickLine={false} axisLine={false} interval={1} dy={6} />
              <YAxis stroke="#64748b" fontSize={11} tickLine={false} axisLine={false} allowDecimals={false} width={36} />
              <Tooltip
                contentStyle={{ fontSize: 12, borderRadius: 8, border: '1px solid #e2e8f0', boxShadow: '0 4px 12px rgba(15,23,42,0.08)', fontWeight: 500 }}
                cursor={{ stroke: '#cbd5e1', strokeDasharray: '3 3' }}
              />
              <Area type="monotone" dataKey="allowed" name="Allowed" stroke={OK} strokeWidth={2} fill="url(#fillAllowed)" />
              <Area type="monotone" dataKey="blocked" name="Blocked" stroke={BAD} strokeWidth={2} fill="url(#fillBlocked)" />
            </AreaChart>
          </ResponsiveContainer>
        </Card>

        <Card title="Routes and token buckets" sub="Each rule has its own bucket per client. Routes on the same rule share it." flush>
          <div className="overflow-x-auto">
            <table className="w-full text-left text-[13px]">
              <thead className="border-b border-line-soft bg-canvas/60 text-xs text-muted">
                <tr>
                  <th className="px-5 py-2.5 font-semibold">Method</th>
                  <th className="px-5 py-2.5 font-semibold">Route</th>
                  <th className="px-5 py-2.5 font-semibold">Rule</th>
                  <th className="px-5 py-2.5 font-semibold">Bucket</th>
                  <th className="px-5 py-2.5 font-semibold">Allowed</th>
                  <th className="px-5 py-2.5 font-semibold">Blocked</th>
                  <th className="px-5 py-2.5 font-semibold">Status</th>
                </tr>
              </thead>
              <tbody>
                {ROUTES.map((r) => {
                  const rule = ruleFor(r);
                  const b = buckets[rule.name];
                  const tokens = tokensNow(rule);
                  const pct = (tokens / rule.capacity) * 100;
                  const isBlocking = !!b && b.blockedUntil > now;
                  const color = isBlocking || pct < 20 ? BAD : pct < 50 ? WARN : OK;
                  return (
                    <tr key={r} className="border-b border-line-soft transition-colors last:border-0 hover:bg-canvas/40">
                      <td className="px-5 py-3 text-xs font-semibold text-slate-600">GET</td>
                      <td className="px-5 py-3 font-mono text-xs font-semibold text-slate-900">{r}</td>
                      <td className="px-5 py-3">
                        <span className="font-semibold text-slate-900">{rule.name}</span>
                        <span className="ml-2 text-xs font-medium text-slate-500">{rule.capacity} burst · {rule.refill_rate.toFixed(2)}/s</span>
                      </td>
                      <td className="px-5 py-3">
                        <div className="flex items-center gap-2.5">
                          <div className="h-1.5 w-28 overflow-hidden rounded-full bg-line">
                            <div className="h-full rounded-full transition-all duration-500" style={{ width: `${pct}%`, background: color }} />
                          </div>
                          <span className="tabular text-xs font-semibold text-slate-600">{Math.floor(tokens)}/{rule.capacity}</span>
                        </div>
                      </td>
                      <td className="tabular px-5 py-3 font-semibold text-slate-900">{logs.filter((l) => l.path === r && l.status >= 200 && l.status < 400).length}</td>
                      <td className="tabular px-5 py-3 font-semibold text-slate-900">{logs.filter((l) => l.path === r && l.status === 429).length}</td>
                      <td className="px-5 py-3">
                        {isBlocking ? (
                          <span className="inline-flex items-center gap-1.5 rounded-full bg-bad-soft px-2.5 py-0.5 text-xs font-semibold text-bad">
                            <span className="h-1.5 w-1.5 rounded-full bg-bad" />
                            Blocking · {Math.max(1, Math.ceil((b.blockedUntil - now) / 1000))}s
                          </span>
                        ) : (
                          <span className="inline-flex items-center gap-1.5 rounded-full bg-brand-soft px-2.5 py-0.5 text-xs font-semibold text-brand">
                            <span className="h-1.5 w-1.5 rounded-full bg-brand" />
                            Accepting
                          </span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </Card>

        <div className="grid gap-4 lg:grid-cols-3">
          <Card title="Test console" sub="Send traffic to the live API">
            <label htmlFor="route" className="mb-1.5 block text-xs font-semibold text-slate-600">Route</label>
            <select
              id="route"
              value={path}
              onChange={(e) => setPath(e.target.value)}
              className="w-full rounded-lg border border-line bg-surface px-3 py-2 text-sm font-semibold text-slate-900 transition-colors focus-visible:border-brand focus-visible:outline-2 focus-visible:outline-offset-0 focus-visible:outline-brand"
            >
              {ROUTES.map((r) => <option key={r} value={r}>{r}</option>)}
            </select>
            <p className="mt-2.5 text-xs font-medium leading-relaxed text-slate-600">
              Uses the <span className="font-semibold text-slate-900">{selected.name}</span> rule: bucket of {selected.capacity}, refills {selected.refill_rate.toFixed(2)} tokens per second.
            </p>
            <div className="mt-4 grid grid-cols-2 gap-2">
              <button
                onClick={() => send(path)}
                disabled={offline || busy}
                className="flex items-center justify-center gap-1.5 rounded-lg bg-brand px-3 py-2 text-sm font-semibold text-white shadow-sm shadow-teal-900/20 transition-colors hover:bg-brand-strong disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand"
              >
                <Play className="h-3.5 w-3.5" /> Send request
              </button>
              <button
                onClick={burst}
                disabled={offline || busy}
                className="flex items-center justify-center gap-1.5 rounded-lg border border-line bg-surface px-3 py-2 text-sm font-semibold text-slate-900 transition-colors hover:bg-canvas disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand"
              >
                <Zap className="h-3.5 w-3.5" /> {busy ? 'Sending...' : 'Run burst'}
              </button>
            </div>
            <p className="mt-2.5 text-xs font-medium leading-relaxed text-slate-600">A burst sends more requests than the bucket holds, so you can watch it empty and refill.</p>
          </Card>

          <Card title="Recent requests" sub="Latest 50" flush className="lg:col-span-2">
            <div className="max-h-72 overflow-auto">
              <table className="w-full text-left text-[13px]">
                <thead className="sticky top-0 z-[1] border-b border-line-soft bg-canvas/80 backdrop-blur text-xs text-muted">
                  <tr>
                    <th className="px-5 py-2.5 font-semibold">Time</th>
                    <th className="px-5 py-2.5 font-semibold">Route</th>
                    <th className="px-5 py-2.5 font-semibold">Result</th>
                    <th className="px-5 py-2.5 font-semibold">Tokens left</th>
                    <th className="px-5 py-2.5 font-semibold">Latency</th>
                  </tr>
                </thead>
                <tbody>
                  {logs.length === 0 ? (
                    <tr><td colSpan={5} className="px-5 py-12 text-center text-xs font-medium text-slate-500">No requests yet. Use the test console to send one.</td></tr>
                  ) : (
                    logs.slice(0, 50).map((l) => {
                      const [text, cls] = chip(l.status);
                      return (
                        <tr key={l.id} className="border-b border-line-soft transition-colors last:border-0 hover:bg-canvas/40">
                          <td className="tabular px-5 py-2 text-xs font-medium text-slate-500">{new Date(l.ts).toLocaleTimeString([], { hour12: false })}</td>
                          <td className="px-5 py-2 font-mono text-xs font-semibold text-slate-900">{l.path}</td>
                          <td className="px-5 py-2"><span className={`rounded-md px-2 py-0.5 text-xs font-semibold ${cls}`}>{text} {l.status || ''}</span></td>
                          <td className="tabular px-5 py-2 font-semibold text-slate-900">{l.left ?? '—'}</td>
                          <td className="tabular px-5 py-2 text-xs font-medium text-slate-500">{l.ms} ms</td>
                        </tr>
                      );
                    })
                  )}
                </tbody>
              </table>
            </div>
          </Card>
        </div>
      </main>
    </div>
  );
}