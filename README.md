# RateLimiter Pro

Live demo: https://rate-limiter-dashboard-5bghc9xnv.vercel.app/

A full-stack rate limiting service and live dashboard built with **FastAPI**, **Redis**, and **Next.js**. The backend enforces per-endpoint throttling using **Token Bucket** and **Sliding Window** algorithms, and the frontend visualizes allowed vs. blocked traffic in real time.

## What it does

The backend is a Python FastAPI service that uses Redis for atomic, cross-instance rate tracking via a **Lua script** — so the token bucket read-modify-write runs as a single operation and can't race when concurrent requests hit the same client. Redis `TIME` is called inside the script so multiple app instances never disagree on elapsed time. If Redis is down, the limiter falls back to an in-memory store instead of failing closed.

The frontend polls `/metrics`, reads `X-RateLimit-*` headers from each response, and renders live traffic, latency (avg/p95), and block-rate KPIs. A built-in test console fires single requests or synthetic bursts so you can watch the bucket drain and refill.

## Features

- Token Bucket and Sliding Window rate limiting
- Atomic Redis Lua script for race-free consumption
- Graceful in-memory fallback when Redis is unavailable
- Per-endpoint rules with configurable capacity and refill rate
- Standard rate-limit headers (`X-RateLimit-*`, `Retry-After`)
- HTTP 429 handling with accurate retry guidance
- Real-time dashboard with live traffic charts and KPIs
- Burst testing console to visualize bucket drain/refill
- Prometheus-compatible `/metrics/prometheus` endpoint

## Tech Stack

- **Backend**: Python, FastAPI, Uvicorn, Redis (async), Lua, Upstash
- **Frontend**: Next.js, React, TypeScript, Tailwind CSS, Recharts, Axios
- **Deployment**: Docker on Hugging Face Spaces (backend), Vercel (frontend)

## Endpoints

| Endpoint | Rule | Limit |
|----------|------|-------|
| `/login` | login | 5 burst, refills 1 token/sec |
| `/` | default | 100 burst, refills ~1.67 tokens/sec |
| `/api/public` | default | 100 burst, refills ~1.67 tokens/sec |

Rules are matched by prefix — the first matching prefix wins, so strict rules sit at the top.

## How it works

1. Client hits an endpoint.
2. FastAPI middleware matches the path to a rule and builds a per-client key (`rl:<rule>:<ip>`).
3. A Lua script runs on Redis: read bucket → refill by elapsed time → try to consume a token → write back.
4. If Redis errors, the in-memory store handles the request instead.
5. Response includes `X-RateLimit-*` headers; empty bucket returns `429` with `Retry-After`.
6. Dashboard polls `/metrics` and reads those headers to render live state.
