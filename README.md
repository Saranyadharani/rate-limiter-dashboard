# RateLimiter Pro

A full-stack rate limiting dashboard built with Next.js, React, and TypeScript to demonstrate API request throttling using Token Bucket and Sliding Window algorithms. The application provides configurable endpoint-based rate limiting along with real-time request analytics and monitoring.

## Features

- Token Bucket and Sliding Window rate limiting
- Endpoint-specific request limits
- Real-time request monitoring dashboard
- Response time and request analytics
- HTTP 429 (Too Many Requests) handling
- Interactive rate limit testing
- Responsive UI built with Next.js and Tailwind CSS

## Tech Stack

- Next.js 16
- React 19
- TypeScript
- Tailwind CSS
- Axios
- Recharts
- Vercel

## Supported Endpoints

| Endpoint | Limit |
|----------|-------|
| `/login` | 5 requests / 5 seconds |
| `/api/public` | 100 requests / 60 seconds |
| `/api/private` | 50 requests / 60 seconds |
| `/auth/verify` | 10 requests / 10 seconds |

## Project Structure

```
app/            Application routes and UI
public/         Static assets
package.json    Project configuration
```

## Getting Started

Clone the repository:

```bash
git clone https://github.com/Saranyadharani/rate-limiter-dashboard.git
cd rate-limiter-dashboard
```

Install dependencies:

```bash
npm install
```

Run the development server:

```bash
npm run dev
```

Open `http://localhost:3000`.

## Algorithms

- **Token Bucket** – Supports controlled burst traffic by replenishing tokens at a fixed rate.
- **Sliding Window** – Tracks requests over a moving time window for more accurate rate limiting.

## Future Improvements

- Redis-backed distributed rate limiting
- API key and JWT-based rate limiting
- Persistent request storage
- Role-based policies
- Prometheus/Grafana monitoring
- Docker and Kubernetes deployment

## Author

**Saranya M**

- GitHub: https://github.com/Saranyadharani
- LinkedIn: https://linkedin.com/in/saranya-dharani
