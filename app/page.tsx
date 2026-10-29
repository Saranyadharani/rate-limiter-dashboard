'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import axios from 'axios';
import { Activity, Gauge, ShieldCheck, Play, Zap, RefreshCw, AlertTriangle } from 'lucide-react';
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from 'recharts';

// set NEXT_PUBLIC_API_BASE in .env.local / Vercel to override
const API_BASE = process.env.NEXT_PUBLIC_API_BASE ?? 'https://saranyadharani-rate-limiter-api.hf.space';

interface Rule { name: string; prefix: string; capacity: number; refill_rate: number }
interface Metrics {
  rules: Rule[]; allowed: Record<string, number>; blocked: Record<string, number>;
}
interface Log { id: number; ts: number; path: string; status: number; ms: number; left: number | null }
interface Bucket { remaining: number; ts: number; blockedUntil: number }

// same shape as the backend RULES, used until /metrics answers
const DEFAULT_RULES: Rule[] = [
  { name: 'login', prefix: '/login', capacity: 5, refill_rate: 1 },
  { name: 'public', prefix: '/api/public', capacity: 20, refill_rate: 100 / 60 },
  { name: 'default', prefix: '/', capacity: 100, refill_rate: 100 / 60 },
];
const ROUTES = ['/', '/login', '/api/public'];
const TEAL = '#0d9488';
const ROSE = '#e11d48';

const sum = (o?: Record<string, number>) => Object.values(o ?? {}).reduce((a, b) => a + b, 0);

function Card({ title, sub, right, flush, className = '', children }: {
  title: string; sub?: string; right?: React.ReactNode; flush?: boolean; className?: string; children: React.ReactNode;
}) {
  return (
    <section className={`rounded-2xl border border-gray-200 bg-white shadow-sm ${className}`}>
      <header className="flex items-center justify-between gap-3 border-b border-gray-200 px-6 py-4">
        <div>
          <h2 className="text-base font-semibold text-gray-900">{title}</h2>
          {sub && <p className="mt-0.5 text-[13px] text-gray-500">{sub}</p>}
        </div>
        {right}
      </header>
      <div className={flush ? '' : 'p-6'}>{children}</div>
    </section>
  );
}

function Kpi({ label, value, hint, icon: Icon, tint }: {
  label: string; value: string; hint: string; icon: typeof Activity; tint: string;
}) {
  return (
    <div className="rounded-2xl border border-gray-200 bg-white p-6 shadow-sm">
      <div className="flex items-start justify-between">
        <span className="text-[13px] font-medium uppercase tracking-wide text-gray-600">{label}</span>
        <span className={`flex h-9 w-9 items-center justify-center rounded-lg ${tint}`}>
          <Icon className="h-[18px] w-[18px]" />
        </span>
      </div>
      <div className="tabular mt-2 text-3xl font-bold text-gray-900">{value}</div>
      <div className="mt-1 text-sm text-gray-500">{hint}</div>
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

  // one clock drives the chart window, the bucket refill and the retry countdown
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
    // small buckets get 3x their size (the browser is slow, it has to outrun the refill)
    const count = rule.capacity <= 20 ? rule.capacity * 3 : rule.capacity + 20;
    for (let i = 0; i < count; i += 10) {
      await Promise.all(Array.from({ length: Math.min(10, count - i) }, () => send(path)));
    }
    await fetchMetrics();
    setBusy(false);
  };

  // tokens the bucket should hold right now, same refill maths as the backend
  const tokensNow = (r: Rule) => {
    const b = buckets[r.name];
    if (!b) return r.capacity;
    return Math.min(r.capacity, b.remaining + ((now - b.ts) / 1000) * r.refill_rate);
  };

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
    s >= 200 && s < 400 ? ['Allowed', 'bg-teal-50 text-teal-700']
      : s === 429 ? ['Blocked', 'bg-rose-50 text-rose-700']
        : ['Error', 'bg-amber-50 text-amber-700'];

  const selected = ruleFor(path);

  return (
    <div className="min-h-screen bg-slate-50">
      <header className="sticky top-0 z-10 bg-[#3f4654]">
        <div className="mx-auto flex h-16 max-w-7xl items-center justify-between px-6">
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-teal-600">
              <ShieldCheck className="h-5 w-5 text-white" />
            </div>
            <span className="text-lg font-bold text-white">Rate Limiter</span>
          </div>
          <div className="flex items-center gap-3">
            <span className={`flex items-center gap-2 rounded-full px-3 py-1.5 text-sm font-medium ${offline ? 'bg-rose-500/20 text-rose-300' : 'bg-teal-500/20 text-teal-300'}`}>
              <span className={`h-2 w-2 rounded-full ${offline ? 'bg-rose-400' : 'bg-teal-400'}`} />
              {offline ? 'API unreachable' : 'API healthy'}
            </span>
            <button onClick={fetchMetrics} aria-label="Refresh metrics" className="rounded-lg p-2 text-gray-300 hover:bg-white/10 hover:text-white focus-visible:outline-2 focus-visible:outline-teal-400">
              <RefreshCw className="h-5 w-5" />
            </button>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-7xl space-y-5 px-6 py-6">
        {offline && (
          <div className="flex items-center gap-2 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
            <AlertTriangle className="h-4 w-4" />
            Cannot reach {API_BASE}. Start the API or check NEXT_PUBLIC_API_BASE.
          </div>
        )}

        <div className="grid grid-cols-1 gap-5 md:grid-cols-3">
          <Kpi label="Requests handled" value={serverTotal.toLocaleString()} hint="All clients, since API start" icon={Activity} tint="bg-teal-50 text-teal-600" />
          <Kpi label="Block rate" value={`${blockRate.toFixed(1)}%`} hint={`${sum(metrics?.blocked).toLocaleString()} requests rejected`} icon={ShieldCheck} tint="bg-rose-50 text-rose-600" />
          <Kpi label="Latency" value={`${avg} ms`} hint={`p95 ${p95} ms · this session`} icon={Gauge} tint="bg-teal-50 text-teal-600" />
        </div>

        <Card
          title="Traffic"
          sub="Requests sent from this page, 5 second intervals"
          right={
            <div className="flex items-center gap-4 text-sm text-gray-600">
              <span className="flex items-center gap-1.5"><span className="h-2.5 w-2.5 rounded-full bg-teal-600" />Allowed</span>
              <span className="flex items-center gap-1.5"><span className="h-2.5 w-2.5 rounded-full bg-rose-600" />Blocked</span>
            </div>
          }
        >
          <ResponsiveContainer width="100%" height={300}>
            <LineChart data={series} margin={{ top: 8, right: 8, left: -16, bottom: 0 }}>
              <CartesianGrid stroke="#e5e7eb" strokeDasharray="4 4" vertical={false} />
              <XAxis dataKey="label" stroke="#6b7280" fontSize={12} tickLine={false} axisLine={false} interval={1} />
              <YAxis stroke="#6b7280" fontSize={12} tickLine={false} axisLine={false} allowDecimals={false} />
              <Tooltip contentStyle={{ fontSize: 13, borderRadius: 8, border: '1px solid #e5e7eb' }} />
              <Line type="monotone" dataKey="allowed" name="Allowed" stroke={TEAL} strokeWidth={2.5} dot={false} />
              <Line type="monotone" dataKey="blocked" name="Blocked" stroke={ROSE} strokeWidth={2.5} dot={false} />
            </LineChart>
          </ResponsiveContainer>
        </Card>

        <Card title="Routes and token buckets" sub="Each rule has its own bucket per client. Routes on the same rule share it." flush>
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead className="border-b border-gray-200 bg-gray-50 text-gray-600">
                <tr>
                  <th className="px-6 py-3 font-medium">Method</th>
                  <th className="px-6 py-3 font-medium">Route</th>
                  <th className="px-6 py-3 font-medium">Rule</th>
                  <th className="px-6 py-3 font-medium">Bucket</th>
                  <th className="px-6 py-3 font-medium">Allowed</th>
                  <th className="px-6 py-3 font-medium">Blocked</th>
                  <th className="px-6 py-3 font-medium">Status</th>
                </tr>
              </thead>
              <tbody>
                {ROUTES.map((r) => {
                  const rule = ruleFor(r);
                  const b = buckets[rule.name];
                  const tokens = tokensNow(rule);
                  const pct = (tokens / rule.capacity) * 100;
                  const isBlocking = !!b && b.blockedUntil > now;
                  const color = isBlocking || pct < 20 ? ROSE : pct < 50 ? '#d97706' : TEAL;
                  return (
                    <tr key={r} className="border-b border-gray-100 last:border-0">
                      <td className="px-6 py-3.5 text-gray-600">GET</td>
                      <td className="px-6 py-3.5 text-gray-900">{r}</td>
                      <td className="px-6 py-3.5">
                        <span className="font-medium text-gray-900">{rule.name}</span>
                        <span className="ml-2 text-[13px] text-gray-500">{rule.capacity} burst, {rule.refill_rate.toFixed(2)} per sec</span>
                      </td>
                      <td className="px-6 py-3.5">
                        <div className="flex items-center gap-3">
                          <div className="h-2 w-36 overflow-hidden rounded-full bg-gray-200">
                            <div className="h-full rounded-full transition-all duration-500" style={{ width: `${pct}%`, background: color }} />
                          </div>
                          <span className="tabular text-gray-600">{Math.floor(tokens)}/{rule.capacity}</span>
                        </div>
                      </td>
                      <td className="tabular px-6 py-3.5 text-gray-900">{logs.filter((l) => l.path === r && l.status >= 200 && l.status < 400).length}</td>
                      <td className="tabular px-6 py-3.5 text-gray-900">{logs.filter((l) => l.path === r && l.status === 429).length}</td>
                      <td className="px-6 py-3.5">
                        {isBlocking ? (
                          <span className="inline-flex items-center gap-1.5 rounded-md bg-rose-50 px-3 py-1 text-sm font-medium text-rose-700">
                            <span className="h-1.5 w-1.5 rounded-full bg-rose-500" />
                            Blocking, retry in {Math.max(1, Math.ceil((b.blockedUntil - now) / 1000))}s
                          </span>
                        ) : (
                          <span className="inline-flex items-center gap-1.5 rounded-md bg-teal-50 px-3 py-1 text-sm font-medium text-teal-700">
                            <span className="h-1.5 w-1.5 rounded-full bg-teal-500" />
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

        <div className="grid gap-5 lg:grid-cols-3">
          <Card title="Test console" sub="Send traffic to the live API">
            <label htmlFor="route" className="mb-1.5 block text-sm font-medium text-gray-700">Route</label>
            <select
              id="route"
              value={path}
              onChange={(e) => setPath(e.target.value)}
              className="h-11 w-full rounded-lg border border-gray-300 bg-white px-4 text-base text-gray-900 focus-visible:outline-2 focus-visible:outline-teal-500"
            >
              {ROUTES.map((r) => <option key={r} value={r}>{r}</option>)}
            </select>
            <p className="mt-3 text-sm text-gray-500">
              Uses the {selected.name} rule: bucket of {selected.capacity}, refills {selected.refill_rate.toFixed(2)} tokens per second.
            </p>
            <div className="mt-4 grid grid-cols-2 gap-3">
              <button
                onClick={() => send(path)}
                disabled={offline || busy}
                className="flex h-12 items-center justify-center gap-2 rounded-lg bg-teal-600 text-base font-medium text-white hover:bg-teal-700 disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-teal-600"
              >
                <Play className="h-4 w-4" /> Send request
              </button>
              <button
                onClick={burst}
                disabled={offline || busy}
                className="flex h-12 items-center justify-center gap-2 rounded-lg border border-gray-300 bg-white text-base font-medium text-gray-900 hover:bg-gray-50 disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-teal-600"
              >
                <Zap className="h-4 w-4" /> {busy ? 'Sending...' : 'Run burst'}
              </button>
            </div>
            <p className="mt-3 text-sm text-gray-500">A burst sends more requests than the bucket holds, so you can watch it empty and refill.</p>
          </Card>

          <Card title="Recent requests" sub="Latest 50" flush className="lg:col-span-2">
            <div className="max-h-[420px] overflow-auto">
              <table className="w-full text-left text-sm">
                <thead className="sticky top-0 border-b border-gray-200 bg-gray-50 text-gray-600">
                  <tr>
                    <th className="px-6 py-3 font-medium">Time</th>
                    <th className="px-6 py-3 font-medium">Route</th>
                    <th className="px-6 py-3 font-medium">Result</th>
                    <th className="px-6 py-3 font-medium">Tokens left</th>
                    <th className="px-6 py-3 font-medium">Latency</th>
                  </tr>
                </thead>
                <tbody>
                  {logs.length === 0 ? (
                    <tr><td colSpan={5} className="px-6 py-12 text-center text-gray-500">No requests yet. Use the test console to send one.</td></tr>
                  ) : (
                    logs.slice(0, 50).map((l) => {
                      const [text, cls] = chip(l.status);
                      return (
                        <tr key={l.id} className="border-b border-gray-100 last:border-0">
                          <td className="tabular px-6 py-3 text-gray-600">{new Date(l.ts).toLocaleTimeString([], { hour12: false })}</td>
                          <td className="px-6 py-3 text-gray-900">{l.path}</td>
                          <td className="px-6 py-3"><span className={`rounded-md px-2.5 py-1 text-[13px] font-medium ${cls}`}>{text} {l.status || ''}</span></td>
                          <td className="tabular px-6 py-3 text-gray-900">{l.left ?? '—'}</td>
                          <td className="tabular px-6 py-3 text-gray-600">{l.ms} ms</td>
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