'use client';

import { useState, useEffect } from 'react';
import axios from 'axios';
import { 
  Activity, Shield, Zap, Clock, CheckCircle, AlertCircle, 
  TrendingUp, BarChart3, LineChart as LineChartIcon,
  Gauge, Play, StopCircle, RefreshCw
} from 'lucide-react';
import {
  LineChart, Line, AreaChart, Area, BarChart, Bar,
  XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer,
  PieChart, Pie, Cell
} from 'recharts';

interface Metrics {
  service: string;
  status: string;
  algorithms: string[];
  version: string;
}

interface RequestLog {
  id: number;
  timestamp: number;
  endpoint: string;
  status: number;
  responseTime: number;
  clientIp: string;
}

interface RateLimitStats {
  endpoint: string;
  limit: number;
  window: number;
  currentUsage: number;
  remaining: number;
  resetIn: number;
  color: string;
}

export default function Home() {
  const [metrics, setMetrics] = useState<Metrics | null>(null);
  const [requests, setRequests] = useState<RequestLog[]>([]);
  const [isTesting, setIsTesting] = useState(false);
  const [selectedEndpoint, setSelectedEndpoint] = useState('/login');
  const [backendError, setBackendError] = useState(false);
  const [rateLimits, setRateLimits] = useState<RateLimitStats[]>([
    { endpoint: '/login', limit: 5, window: 5, currentUsage: 0, remaining: 5, resetIn: 0, color: '#f59e0b' },
    { endpoint: '/api/public', limit: 100, window: 60, currentUsage: 0, remaining: 100, resetIn: 0, color: '#10b981' },
    { endpoint: '/api/private', limit: 50, window: 60, currentUsage: 0, remaining: 50, resetIn: 0, color: '#8b5cf6' },
    { endpoint: '/auth/verify', limit: 10, window: 10, currentUsage: 0, remaining: 10, resetIn: 0, color: '#ec4899' },
  ]);

  const API_BASE = 'https://saranyadharani-rate-limiter-api.hf.space';

  // Fetch metrics every 5 seconds
  useEffect(() => {
    fetchMetrics();
    const interval = setInterval(fetchMetrics, 5000);
    return () => clearInterval(interval);
  }, []);

  const fetchMetrics = async () => {
    try {
      const response = await axios.get(`${API_BASE}/metrics`, { timeout: 3000 });
      setMetrics(response.data);
      setBackendError(false);
    } catch (error) {
      console.error('Backend not reachable:', error);
      setBackendError(true);
    }
  };

  const sendRequest = async (endpoint: string) => {
    const startTime = Date.now();
    try {
      const response = await axios.get(`${API_BASE}${endpoint}`);
      const responseTime = Date.now() - startTime;
      
      const newRequest: RequestLog = {
        id: requests.length + 1,
        timestamp: Date.now(),
        endpoint: endpoint,
        status: response.status,
        responseTime: responseTime,
        clientIp: '127.0.0.1'
      };
      
      setRequests(prev => [newRequest, ...prev].slice(0, 100));
      
      const limit = response.headers['x-ratelimit-limit'];
      const remaining = response.headers['x-ratelimit-remaining'];
      if (limit && remaining) {
        setRateLimits(prev => prev.map(rl => 
          rl.endpoint === endpoint 
            ? { ...rl, currentUsage: rl.limit - parseInt(remaining), remaining: parseInt(remaining), resetIn: 0 }
            : rl
        ));
      }
      
      return response;
    } catch (error: any) {
      const responseTime = Date.now() - startTime;
      const status = error.response?.status || 500;
      
      const newRequest: RequestLog = {
        id: requests.length + 1,
        timestamp: Date.now(),
        endpoint: endpoint,
        status: status,
        responseTime: responseTime,
        clientIp: '127.0.0.1'
      };
      
      setRequests(prev => [newRequest, ...prev].slice(0, 100));
      
      if (status === 429) {
        const retryAfter = error.response?.data?.retry_after || 5;
        setRateLimits(prev => prev.map(rl => 
          rl.endpoint === endpoint 
            ? { ...rl, currentUsage: rl.limit, remaining: 0, resetIn: parseInt(retryAfter) }
            : rl
        ));
        
        let countdown = parseInt(retryAfter);
        const interval = setInterval(() => {
          countdown--;
          if (countdown <= 0) {
            clearInterval(interval);
            setRateLimits(prev => prev.map(rl => 
              rl.endpoint === endpoint 
                ? { ...rl, currentUsage: 0, remaining: rl.limit, resetIn: 0 }
                : rl
            ));
          } else {
            setRateLimits(prev => prev.map(rl => 
              rl.endpoint === endpoint && rl.resetIn > 0
                ? { ...rl, resetIn: countdown }
                : rl
            ));
          }
        }, 1000);
      }
      
      return error.response;
    }
  };

  const startLoadTest = async () => {
    setIsTesting(true);
    const requests_count = selectedEndpoint === '/login' ? 20 : 150;
    
    for (let i = 0; i < requests_count; i++) {
      await sendRequest(selectedEndpoint);
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    
    setIsTesting(false);
  };

  const requestTimeline = [...requests].reverse().slice(0, 50).map((req, idx) => ({
    index: idx + 1,
    responseTime: req.responseTime,
    endpoint: req.endpoint,
    status: req.status
  }));

  const statusDistribution = [
    { name: 'Success (200)', value: requests.filter(r => r.status === 200).length, color: '#10b981' },
    { name: 'Rate Limited (429)', value: requests.filter(r => r.status === 429).length, color: '#ef4444' },
    { name: 'Other Errors', value: requests.filter(r => r.status !== 200 && r.status !== 429).length, color: '#f59e0b' },
  ];

  const endpointStats = [
    { name: '/login', requests: requests.filter(r => r.endpoint === '/login' && r.status === 200).length, blocked: requests.filter(r => r.endpoint === '/login' && r.status === 429).length },
    { name: '/api/public', requests: requests.filter(r => r.endpoint === '/api/public' && r.status === 200).length, blocked: requests.filter(r => r.endpoint === '/api/public' && r.status === 429).length },
  ];

  const avgResponseTime = requests.length > 0 
    ? (requests.reduce((sum, r) => sum + r.responseTime, 0) / requests.length).toFixed(0)
    : 0;

  const successRate = requests.length > 0
    ? ((requests.filter(r => r.status === 200).length / requests.length) * 100).toFixed(1)
    : 0;

  return (
    <div className="min-h-screen bg-gray-100">
      {/* Header */}
      <div className="bg-gray-900 border-b border-gray-800 sticky top-0 z-10">
        <div className="max-w-7xl mx-auto px-6 py-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 bg-gradient-to-br from-purple-500 to-pink-500 rounded-xl flex items-center justify-center">
                <Shield className="w-5 h-5 text-white" />
              </div>
              <div>
                <h1 className="text-xl font-bold text-white">RateLimiter Pro</h1>
                <p className="text-xs text-gray-400">API Rate Limiting Dashboard</p>
              </div>
            </div>
            <div className="flex items-center gap-4">
              <div className={`flex items-center gap-2 px-3 py-1.5 rounded-full ${backendError ? 'bg-red-900/30' : 'bg-green-900/30'}`}>
                <div className={`w-2 h-2 rounded-full animate-pulse ${backendError ? 'bg-red-500' : 'bg-green-500'}`}></div>
                <span className={`text-xs font-medium ${backendError ? 'text-red-400' : 'text-green-400'}`}>
                  {backendError ? 'Backend Offline' : 'System Online'}
                </span>
              </div>
              <button 
                onClick={fetchMetrics}
                className="p-2 hover:bg-gray-800 rounded-lg transition text-gray-400"
              >
                <RefreshCw className="w-4 h-4" />
              </button>
            </div>
          </div>
        </div>
      </div>

      <div className="max-w-7xl mx-auto px-6 py-8">
        {/* Backend Warning */}
        {backendError && (
          <div className="mb-6 bg-yellow-50 border border-yellow-200 rounded-xl p-4">
            <div className="flex items-center gap-3">
              <AlertCircle className="w-5 h-5 text-yellow-600" />
              <div>
                <p className="text-sm font-medium text-yellow-800">Backend Not Reachable</p>
                <p className="text-xs text-yellow-700">Make sure your rate limiter is running on port 9000: <code className="bg-yellow-100 px-2 py-0.5 rounded">python -m uvicorn app.main:app --reload --port 9000</code></p>
              </div>
            </div>
          </div>
        )}

        {/* Stats Cards */}
        <div className="grid grid-cols-1 md:grid-cols-4 gap-5 mb-8">
          <div className="bg-white rounded-2xl p-5 shadow-sm border border-gray-200">
            <div className="flex items-center justify-between mb-3">
              <span className="text-gray-600 text-sm font-medium">Total Requests</span>
              <Activity className="w-5 h-5 text-purple-600" />
            </div>
            <div className="text-3xl font-bold text-gray-900">{requests.length}</div>
            <div className="text-xs text-gray-500 mt-1">In current session</div>
          </div>
          
          <div className="bg-white rounded-2xl p-5 shadow-sm border border-gray-200">
            <div className="flex items-center justify-between mb-3">
              <span className="text-gray-600 text-sm font-medium">Success Rate</span>
              <CheckCircle className="w-5 h-5 text-green-600" />
            </div>
            <div className="text-3xl font-bold text-gray-900">{successRate}%</div>
            <div className="text-xs text-gray-500 mt-1">of total requests</div>
          </div>
          
          <div className="bg-white rounded-2xl p-5 shadow-sm border border-gray-200">
            <div className="flex items-center justify-between mb-3">
              <span className="text-gray-600 text-sm font-medium">Avg Response</span>
              <Gauge className="w-5 h-5 text-blue-600" />
            </div>
            <div className="text-3xl font-bold text-gray-900">{avgResponseTime}ms</div>
            <div className="text-xs text-gray-500 mt-1">response time</div>
          </div>
          
          <div className="bg-white rounded-2xl p-5 shadow-sm border border-gray-200">
            <div className="flex items-center justify-between mb-3">
              <span className="text-gray-600 text-sm font-medium">Active Algorithms</span>
              <Zap className="w-5 h-5 text-yellow-600" />
            </div>
            <div className="text-3xl font-bold text-gray-900">2</div>
            <div className="text-xs text-gray-500 mt-1">Token Bucket + Sliding Window</div>
          </div>
        </div>

        {/* Charts Row */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 mb-8">
          {/* Response Time Chart */}
          <div className="bg-white rounded-2xl p-6 shadow-sm border border-gray-200">
            <div className="flex items-center justify-between mb-5">
              <div>
                <h3 className="font-semibold text-gray-900">Response Time Trend</h3>
                <p className="text-xs text-gray-500 mt-1">Last 50 requests</p>
              </div>
              <LineChartIcon className="w-5 h-5 text-gray-400" />
            </div>
            <ResponsiveContainer width="100%" height={250}>
              <AreaChart data={requestTimeline}>
                <defs>
                  <linearGradient id="responseGradient" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor="#8b5cf6" stopOpacity={0.3}/>
                    <stop offset="95%" stopColor="#8b5cf6" stopOpacity={0}/>
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" />
                <XAxis dataKey="index" stroke="#6b7280" fontSize={12} />
                <YAxis stroke="#6b7280" fontSize={12} />
                <Tooltip 
                  contentStyle={{ backgroundColor: 'white', border: '1px solid #e5e7eb', borderRadius: '8px', color: '#374151' }}
                  formatter={(value: any) => [`${value}ms`, 'Response Time']}
                />
                <Area type="monotone" dataKey="responseTime" stroke="#8b5cf6" fill="url(#responseGradient)" />
              </AreaChart>
            </ResponsiveContainer>
          </div>

          {/* Status Distribution Pie Chart - Fixed Overlap */}
          <div className="bg-white rounded-2xl p-6 shadow-sm border border-gray-200">
            <div className="flex items-center justify-between mb-5">
              <div>
                <h3 className="font-semibold text-gray-900">Request Status Distribution</h3>
                <p className="text-xs text-gray-500 mt-1">Success vs Rate Limited</p>
              </div>
              <BarChart3 className="w-5 h-5 text-gray-400" />
            </div>
            <ResponsiveContainer width="100%" height={280}>
              <PieChart>
                <Pie
                  data={statusDistribution}
                  cx="50%"
                  cy="50%"
                  innerRadius={55}
                  outerRadius={85}
                  paddingAngle={3}
                  dataKey="value"
                  label={({ percent }) => {
  if (!percent) return '';
  const percentage = (percent * 100).toFixed(0);
  return percentage !== '0' ? `${percentage}%` : '';
}}
                  labelLine={true}
                >
                  {statusDistribution.map((entry, index) => (
                    <Cell key={`cell-${index}`} fill={entry.color} />
                  ))}
                </Pie>
                <Tooltip 
                  formatter={(value: any, name: any) => [`${value} requests`, name]}
                  contentStyle={{ backgroundColor: 'white', border: '1px solid #e5e7eb', borderRadius: '8px' }}
                />
                <Legend 
                  verticalAlign="bottom"
                  height={40}
                  wrapperStyle={{ fontSize: '12px', color: '#374151' }}
                  formatter={(value) => <span className="text-gray-700 text-xs">{value}</span>}
                />
              </PieChart>
            </ResponsiveContainer>
          </div>
        </div>

        {/* Rate Limit Cards */}
        <div className="mb-8">
          <div className="flex items-center justify-between mb-5">
            <div>
              <h2 className="text-xl font-bold text-gray-900">Rate Limit Rules</h2>
              <p className="text-sm text-gray-500">Per-endpoint rate limiting configuration</p>
            </div>
          </div>
          
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-5">
            {rateLimits.map((rl, idx) => (
              <div key={idx} className="bg-white rounded-2xl p-5 shadow-sm border border-gray-200">
                <div className="flex items-center justify-between mb-3">
                  <code className="text-sm font-mono bg-gray-100 text-gray-800 px-2 py-1 rounded">{rl.endpoint}</code>
                  <div className={`w-2 h-2 rounded-full ${rl.remaining > 0 ? 'bg-green-500' : 'bg-red-500'}`}></div>
                </div>
                <div className="text-2xl font-bold text-gray-900 mb-1">{rl.limit}</div>
                <div className="text-xs text-gray-500 mb-3">requests per {rl.window} seconds</div>
                <div className="relative pt-1">
                  <div className="flex justify-between text-xs mb-1">
                    <span className="text-gray-600">Usage</span>
                    <span className="text-gray-600">{((rl.currentUsage / rl.limit) * 100).toFixed(0)}%</span>
                  </div>
                  <div className="overflow-hidden h-2 text-xs flex rounded-full bg-gray-200">
                    <div
                      style={{ width: `${(rl.currentUsage / rl.limit) * 100}%`, backgroundColor: rl.color }}
                      className="shadow-none flex flex-col text-center whitespace-nowrap text-white justify-center transition-all duration-500 rounded-full"
                    ></div>
                  </div>
                  <div className="flex justify-between text-xs mt-2">
                    <span className="text-gray-600">
                      <Clock className="w-3 h-3 inline mr-1" />
                      {rl.remaining} remaining
                    </span>
                    {rl.resetIn > 0 && (
                      <span className="text-orange-600 font-medium">
                        Resets in {rl.resetIn}s
                      </span>
                    )}
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* Testing Section */}
        <div className="bg-white rounded-2xl p-6 shadow-sm border border-gray-200 mb-8">
          <div className="flex flex-wrap items-center justify-between gap-4 mb-5">
            <div>
              <h3 className="font-semibold text-gray-900">Test Rate Limiter</h3>
              <p className="text-xs text-gray-500 mt-1">Send test requests to verify rate limiting</p>
            </div>
            <div className="flex flex-wrap gap-3">
              <select
                value={selectedEndpoint}
                onChange={(e) => setSelectedEndpoint(e.target.value)}
                className="px-4 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-purple-500 text-gray-900 bg-white"
              >
                <option value="/login">🔐 /login (5 req/5s)</option>
                <option value="/api/public">🌐 /api/public (100 req/min)</option>
              </select>
              <button
                onClick={() => sendRequest(selectedEndpoint)}
                disabled={backendError}
                className="px-5 py-2 bg-purple-600 text-white rounded-lg text-sm font-medium hover:bg-purple-700 transition flex items-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed"
              >
                <Play className="w-4 h-4" />
                Send Request
              </button>
              <button
                onClick={startLoadTest}
                disabled={isTesting || backendError}
                className="px-5 py-2 bg-gray-600 text-white rounded-lg text-sm font-medium hover:bg-gray-700 transition disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2"
              >
                {isTesting ? <StopCircle className="w-4 h-4 animate-spin" /> : <Zap className="w-4 h-4" />}
                {isTesting ? 'Testing...' : 'Load Test'}
              </button>
            </div>
          </div>

          {/* Endpoint Stats Bar Chart */}
          <div className="mt-6 pt-4 border-t border-gray-200">
            <div className="flex items-center gap-2 mb-4">
              <TrendingUp className="w-4 h-4 text-gray-500" />
              <span className="text-sm font-medium text-gray-700">Endpoint Activity</span>
            </div>
            <ResponsiveContainer width="100%" height={220}>
              <BarChart data={endpointStats}>
                <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" />
                <XAxis dataKey="name" stroke="#6b7280" fontSize={12} />
                <YAxis stroke="#6b7280" fontSize={12} />
                <Tooltip contentStyle={{ backgroundColor: 'white', border: '1px solid #e5e7eb', borderRadius: '8px' }} />
                <Legend wrapperStyle={{ fontSize: '12px' }} />
                <Bar dataKey="requests" name="Successful Requests" fill="#10b981" radius={[8,8,0,0]} />
                <Bar dataKey="blocked" name="Rate Limited" fill="#ef4444" radius={[8,8,0,0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </div>

        {/* Request Log Table */}
        <div className="bg-white rounded-2xl shadow-sm border border-gray-200 overflow-hidden">
          <div className="px-6 py-4 border-b border-gray-200">
            <h3 className="font-semibold text-gray-900">Recent Requests</h3>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-gray-50 border-b border-gray-200">
                <tr className="text-left text-gray-700">
                  <th className="px-6 py-3 font-semibold">Time</th>
                  <th className="px-6 py-3 font-semibold">Endpoint</th>
                  <th className="px-6 py-3 font-semibold">Status</th>
                  <th className="px-6 py-3 font-semibold">Response Time</th>
                  <th className="px-6 py-3 font-semibold">Client IP</th>
                </tr>
              </thead>
              <tbody>
                {requests.length === 0 ? (
                  <tr>
                    <td colSpan={5} className="text-center py-12 text-gray-500">
                      No requests yet. Send a test request to see data.
                    </td>
                  </tr>
                ) : (
                  requests.map((req, idx) => (
                    <tr key={idx} className="border-b border-gray-100 hover:bg-gray-50 transition">
                      <td className="px-6 py-3 text-gray-600 text-xs">
                        {new Date(req.timestamp).toLocaleTimeString()}
                      </td>
                      <td className="px-6 py-3 font-mono text-xs text-gray-800">{req.endpoint}</td>
                      <td className="px-6 py-3">
                        <span className={`inline-flex items-center gap-1 px-2 py-1 rounded-full text-xs font-medium ${
                          req.status === 200 ? 'bg-green-100 text-green-800' :
                          req.status === 429 ? 'bg-red-100 text-red-800' :
                          'bg-yellow-100 text-yellow-800'
                        }`}>
                          {req.status === 200 ? <CheckCircle className="w-3 h-3" /> : <AlertCircle className="w-3 h-3" />}
                          {req.status === 200 ? 'Success' : req.status === 429 ? 'Rate Limited' : `Error ${req.status}`}
                        </span>
                      </td>
                      <td className="px-6 py-3 text-gray-700 text-xs">{req.responseTime}ms</td>
                      <td className="px-6 py-3 text-gray-700 text-xs">{req.clientIp}</td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>

        {/* System Info Footer */}
        {metrics && (
          <div className="mt-6 text-center text-xs text-gray-500">
            <p>Running {metrics.algorithms.join(' + ')} algorithm | Version {metrics.version} | Status: {metrics.status}</p>
          </div>
        )}
      </div>
    </div>
  );
}