# RateLimiter 

Live demo: https://rate-limiter-dashboard-six.vercel.app/

A full-stack rate limiting service and live dashboard built with **FastAPI**, **Redis**, and **Next.js**. The backend enforces per-endpoint throttling using **Token Bucket** and **Sliding Window** algorithms, and the frontend visualizes allowed vs. blocked traffic in real time.

## What it does

The backend is a FastAPI service that throttles requests per client and per endpoint using the token bucket algorithm. Bucket state lives in Redis, and each check runs as a single Lua script, so the read, refill and consume steps are atomic and concurrent requests from the same client can't race. The script reads Redis TIME, so multiple app instances never disagree about elapsed time.

If Redis is unreachable, the limiter falls back to an in-memory store instead of failing.

The dashboard polls /metrics, reads the X-RateLimit-* headers from each response, and shows live traffic, latency (average and p95), block rate and the state of every bucket. A built-in test console sends single requests or bursts so you can watch a bucket drain and refill.

##Architecutre diagram
<img width="1616" height="748" alt="image" src="https://github.com/user-attachments/assets/30d3e941-55b2-4b25-b599-516e66a74062" />

## Features

- Token bucket rate limiting with separate burst size and sustained rate per rule
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
| `/api/public` | default | 20 burst, ~1.67 tokens/sec (100 per minute)|

Rules are matched by prefix — the first matching prefix wins, so strict rules sit at the top.

## How it works

1. Client hits an endpoint.
2. FastAPI middleware matches the path to a rule and builds a per-client key (`rl:<rule>:<ip>`).
3. A Lua script runs on Redis: read bucket → refill by elapsed time → try to consume a token → write back.
4. If Redis errors, the in-memory store handles the request instead.
5. Response includes `X-RateLimit-*` headers; empty bucket returns `429` with `Retry-After`.
6. Dashboard polls `/metrics` and reads those headers to render live state.
