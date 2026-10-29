'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import axios from 'axios';
import { Activity, Gauge, Server, ShieldCheck, Play, Zap, RefreshCw, AlertTriangle } from 'lucide-react';
import { AreaChart, Area, PieChart, Pie, Cell, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from 'recharts';

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
    <section className={`rounded-lg border border-line bg-surface ${className}`}>
      <header className="flex items-center justify-between gap-3 border-b border-line px-4 py-2.5">
        <div>
          <h2 className="text-[13px] font-semibold text-ink">{title}</h2>
          {sub && <p className="text-xs text-muted">{sub}</p>}
        </div>
        {right}
      </header>
      <div className={flush ? '' : 'p-4'}>{children}</div>
    </section>
  );
}

function Kpi({ label, value, hint, icon: Icon }: { label: string; value: string; hint: string; icon: typeof Activity }) {
  return (
    <div className="rounded-lg border border-line bg-surface px-4 py-3">
      <div className="flex items-center justify-between text-muted">
        <span className="text-xs font-medium">{label}</span>
        <Icon className="h-4 w-4" />
      </div>
      <div className="tabular mt-1 text-2xl font-semibold text-ink">{value}</div>
      <div className="text-xs text-muted">{hint}</div>
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
      const res = await axios.get(`${API_BASE}${p}`, { validateStatus: () => true, timeout: 20000 });
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
    // small buckets get 3x their size (the browser is slow, it needs to outrun the refill), big ones just a bit over
    const count = rule.capacity <= 20 ? rule.capacity * 3 : rule.capacity + 20;
    // batches of 10 in parallel: still a spike, but the browser and the free space aren't swamped
    for (let i = 0; i < count; i += 10) {
      await Promise.all(Array.from({ length: Math.min(10, count - i) }, () => send(path)));
    }
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

  const pie = [
    { name: 'Allowed', value: allowed, color: OK },
    { name: 'Blocked', value: blocked, color: BAD },
    { name: 'Errors', value: errors, color: WARN },
  ];

  const chip = (s: number): [string, string] =>
    s >= 200 && s < 400 ? ['Allowed', 'bg-brand-soft text-brand']
      : s === 429 ? ['Blocked', 'bg-bad-soft text-bad']
      : ['Error', 'bg-warn-soft text-warn'];

  const selected = ruleFor(path);

  return (
    <div className="min-h-screen">
      <header className="sticky top-0 z-10 bg-nav">
        <div className="mx-auto flex h-12 max-w-7xl items-center justify-between px-4">
          <div className="flex items-center gap-2.5">
            <div className="flex h-7 w-7 items-center justify-center rounded-md bg-brand">
              <ShieldCheck className="h-4 w-4 text-white" />
            </div>
            <span className="text-sm font-semibold text-white">RateLimiter Console</span>
          </div>
          <div className="flex items-center gap-2">
            {metrics && (
              <span className="rounded-md bg-white/10 px-2 py-1 text-xs text-slate-300">
                {metrics.algorithm.replace('_', ' ')} on {metrics.backend}
              </span>
            )}
            <span className={`flex items-center gap-1.5 rounded-md px-2 py-1 text-xs ${offline ? 'bg-bad/20 text-rose-300' : 'bg-brand/20 text-teal-300'}`}>
              <span className={`h-1.5 w-1.5 rounded-full ${offline ? 'bg-bad' : 'bg-brand'}`} />
              {offline ? 'API unreachable' : 'API healthy'}
            </span>
            <button onClick={fetchMetrics} aria-label="Refresh metrics" className="rounded-md p-1.5 text-slate-400 hover:bg-white/10 hover:text-white focus-visible:outline-2 focus-visible:outline-brand">
              <RefreshCw className="h-4 w-4" />
            </button>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-7xl space-y-3 px-4 py-4">
        {offline && (
          <div className="flex items-center gap-2 rounded-lg border border-warn/30 bg-warn-soft px-3 py-2 text-xs text-warn">
            <AlertTriangle className="h-4 w-4" />
            Cannot reach {API_BASE}. Start the API or check NEXT_PUBLIC_API_BASE.
          </div>
        )}

        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <Kpi label="Requests handled" value={serverTotal.toLocaleString()} hint="All clients, since API start" icon={Activity} />
          <Kpi label="Block rate" value={`${blockRate.toFixed(1)}%`} hint={`${sum(metrics?.blocked).toLocaleString()} requests rejected`} icon={ShieldCheck} />
          <Kpi label="Latency (this session)" value={`${avg} ms`} hint={`p95 ${p95} ms`} icon={Gauge} />
          <Kpi label="Rules loaded" value={String(rules.length)} hint={metrics ? `Version ${metrics.version}` : 'Waiting for API'} icon={Server} />
        </div>

        <div className="grid gap-3 lg:grid-cols-3">
          <Card
            className="lg:col-span-2"
            title="Traffic"
            sub="Requests sent from this page, 5 second intervals"
            right={
              <div className="flex items-center gap-3 text-xs text-muted">
                <span className="flex items-center gap-1"><span className="h-2 w-2 rounded-full bg-brand" />Allowed</span>
                <span className="flex items-center gap-1"><span className="h-2 w-2 rounded-full bg-bad" />Blocked</span>
              </div>
            }
          >
            <ResponsiveContainer width="100%" height={210}>
              <AreaChart data={series} margin={{ top: 4, right: 4, left: -20, bottom: 0 }}>
                <CartesianGrid stroke="#e3e8ef" vertical={false} />
                <XAxis dataKey="label" stroke="#64748b" fontSize={11} tickLine={false} axisLine={false} interval={1} />
                <YAxis stroke="#64748b" fontSize={11} tickLine={false} axisLine={false} allowDecimals={false} />
                <Tooltip contentStyle={{ fontSize: 12, borderRadius: 6, border: '1px solid #e3e8ef' }} />
                <Area type="monotone" dataKey="allowed" name="Allowed" stroke={OK} fill={OK} fillOpacity={0.12} strokeWidth={2} />
                <Area type="monotone" dataKey="blocked" name="Blocked" stroke={BAD} fill={BAD} fillOpacity={0.12} strokeWidth={2} />
              </AreaChart>
            </ResponsiveContainer>
          </Card>

          <Card title="Outcome split" sub="This session">
            {logs.length === 0 ? (
              <div className="flex h-[210px] items-center justify-center text-center text-xs text-muted">
                Send a request to see how traffic is split.
              </div>
            ) : (
              <div>
                <ResponsiveContainer width="100%" height={150}>
                  <PieChart>
                    <Pie data={pie} dataKey="value" innerRadius={42} outerRadius={64} paddingAngle={2} stroke="none">
                      {pie.map((p) => <Cell key={p.name} fill={p.color} />)}
                    </Pie>
                    <Tooltip contentStyle={{ fontSize: 12, borderRadius: 6, border: '1px solid #e3e8ef' }} />
                  </PieChart>
                </ResponsiveContainer>
                <ul className="mt-2 space-y-1 text-xs">
                  {pie.map((p) => (
                    <li key={p.name} className="flex items-center justify-between">
                      <span className="flex items-center gap-1.5 text-muted"><span className="h-2 w-2 rounded-full" style={{ background: p.color }} />{p.name}</span>
                      <span className="tabular font-medium text-ink">{p.value}</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </Card>
        </div>

        <Card title="Routes and token buckets" sub="Each rule has its own bucket per client. Routes on the same rule share it." flush>
          <div className="overflow-x-auto">
            <table className="w-full text-left text-[13px]">
              <thead className="border-b border-line bg-canvas text-xs text-muted">
                <tr>
                  <th className="px-4 py-2 font-medium">Method</th>
                  <th className="px-4 py-2 font-medium">Route</th>
                  <th className="px-4 py-2 font-medium">Rule</th>
                  <th className="px-4 py-2 font-medium">Bucket</th>
                  <th className="px-4 py-2 font-medium">Allowed</th>
                  <th className="px-4 py-2 font-medium">Blocked</th>
                  <th className="px-4 py-2 font-medium">Status</th>
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
                    <tr key={r} className="border-b border-line last:border-0">
                      <td className="px-4 py-2.5 text-muted">GET</td>
                      <td className="px-4 py-2.5 font-mono text-xs text-ink">{r}</td>
                      <td className="px-4 py-2.5">
                        <span className="text-ink">{rule.name}</span>
                        <span className="ml-2 text-xs text-muted">{rule.capacity} burst, {rule.refill_rate.toFixed(2)} per sec</span>
                      </td>
                      <td className="px-4 py-2.5">
                        <div className="flex items-center gap-2">
                          <div className="h-1.5 w-28 overflow-hidden rounded-full bg-line">
                            <div className="h-full rounded-full transition-all duration-500" style={{ width: `${pct}%`, background: color }} />
                          </div>
                          <span className="tabular text-xs text-muted">{Math.floor(tokens)}/{rule.capacity}</span>
                        </div>
                      </td>
                      <td className="tabular px-4 py-2.5 text-ink">{logs.filter((l) => l.path === r && l.status >= 200 && l.status < 400).length}</td>
                      <td className="tabular px-4 py-2.5 text-ink">{logs.filter((l) => l.path === r && l.status === 429).length}</td>
                      <td className="px-4 py-2.5">
                        {isBlocking ? (
                          <span className="rounded-md bg-bad-soft px-2 py-0.5 text-xs font-medium text-bad">
                            Blocking, retry in {Math.max(1, Math.ceil((b.blockedUntil - now) / 1000))}s
                          </span>
                        ) : (
                          <span className="rounded-md bg-brand-soft px-2 py-0.5 text-xs font-medium text-brand">Accepting</span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </Card>

        <div className="grid gap-3 lg:grid-cols-3">
          <Card title="Test console" sub="Send traffic to the live API">
            <label htmlFor="route" className="mb-1 block text-xs font-medium text-muted">Route</label>
            <select
              id="route"
              value={path}
              onChange={(e) => setPath(e.target.value)}
              className="w-full rounded-md border border-line bg-surface px-3 py-2 text-sm text-ink focus-visible:outline-2 focus-visible:outline-brand"
            >
              {ROUTES.map((r) => <option key={r} value={r}>{r}</option>)}
            </select>
            <p className="mt-2 text-xs text-muted">
              Uses the {selected.name} rule: bucket of {selected.capacity}, refills {selected.refill_rate.toFixed(2)} tokens per second.
            </p>
            <div className="mt-3 grid grid-cols-2 gap-2">
              <button
                onClick={() => send(path)}
                disabled={offline || busy}
                className="flex items-center justify-center gap-1.5 rounded-md bg-brand px-3 py-2 text-sm font-medium text-white hover:bg-teal-700 disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand"
              >
                <Play className="h-3.5 w-3.5" /> Send request
              </button>
              <button
                onClick={burst}
                disabled={offline || busy}
                className="flex items-center justify-center gap-1.5 rounded-md border border-line bg-surface px-3 py-2 text-sm font-medium text-ink hover:bg-canvas disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand"
              >
                <Zap className="h-3.5 w-3.5" /> {busy ? 'Sending...' : 'Run burst'}
              </button>
            </div>
            <p className="mt-2 text-xs text-muted">A burst sends more requests than the bucket holds, so you can watch it empty and refill.</p>
          </Card>

          <Card title="Recent requests" sub="Latest 50" flush className="lg:col-span-2">
            <div className="max-h-72 overflow-auto">
              <table className="w-full text-left text-[13px]">
                <thead className="sticky top-0 border-b border-line bg-canvas text-xs text-muted">
                  <tr>
                    <th className="px-4 py-2 font-medium">Time</th>
                    <th className="px-4 py-2 font-medium">Route</th>
                    <th className="px-4 py-2 font-medium">Result</th>
                    <th className="px-4 py-2 font-medium">Tokens left</th>
                    <th className="px-4 py-2 font-medium">Latency</th>
                  </tr>
                </thead>
                <tbody>
                  {logs.length === 0 ? (
                    <tr><td colSpan={5} className="px-4 py-10 text-center text-xs text-muted">No requests yet. Use the test console to send one.</td></tr>
                  ) : (
                    logs.slice(0, 50).map((l) => {
                      const [text, cls] = chip(l.status);
                      return (
                        <tr key={l.id} className="border-b border-line last:border-0">
                          <td className="tabular px-4 py-1.5 text-muted">{new Date(l.ts).toLocaleTimeString([], { hour12: false })}</td>
                          <td className="px-4 py-1.5 font-mono text-xs text-ink">{l.path}</td>
                          <td className="px-4 py-1.5"><span className={`rounded-md px-2 py-0.5 text-xs font-medium ${cls}`}>{text} {l.status || ''}</span></td>
                          <td className="tabular px-4 py-1.5 text-ink">{l.left ?? '-'}</td>
                          <td className="tabular px-4 py-1.5 text-muted">{l.ms} ms</td>
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