# InOut application latency records

**Author:** Rahul Datta · **Document version:** 1.0 · **Prepared:** 6 November 2026
**Purpose:** Presentation-ready inventory of measured timings and available runtime instrumentation.

## Executive summary

- The repository contains historical synthetic PostgreSQL-handler benchmarks and one earlier local dashboard-handler comparison. These are not end-to-end application response times.
- The latest committed synthetic benchmark records a p95 of **30.011 ms** for the aggregate dashboard read, **239.509 ms** for a scan with durable intent, **54.010 ms** for the first 50 alert-command records, **495.771 ms** for the first 25 registry records, and **366.376 ms** for a single consistent report read.
- Live Kong latency collection is configured. On 6 November 2026, Prometheus reported the Kong scrape target as **up**. The p95 query returned nine series with `NaN`, so there was no usable request-latency observation in the query window at capture time.
- No committed representative load test measures full browser-to-API latency, throughput under load, or latency through Keycloak, Redis, and Temporal together.

## How to read the numbers

All values are milliseconds. p50 is the median; p95 means 95% of sampled operations completed within that time; p99 shows the slow tail. `n` is the number of measured samples. These percentiles describe only the measurement boundary named in each section.

## Recorded PostgreSQL-handler benchmark

Source record: `docs/performance-results-2026-10-16.json`. The benchmark used a synthetic fixture of 1,000 subjects, 5,000 movements, and 500 alerts. Its stated scope excludes HTTP, TLS, Kong, Keycloak, and rendering. Reads are single-concurrency; scan/mixed/dashboard cases use concurrency four. Report cases use five samples; other cases use 30. No errors were recorded in these cases.

| Operation | n / concurrency | p50 | p95 | p99 | Median SQL statements | Median response bytes |
|---|---:|---:|---:|---:|---:|---:|
| Complete registry read | 30 / 1 | 498.776 | 1,184.538 | 1,279.390 | 19 | 612,601 |
| Registry first 25 plus global summary | 30 / 1 | 259.849 | 495.771 | 546.633 | 15 | 20,518 |
| Complete alerts read | 30 / 1 | 101.098 | 299.354 | 311.972 | 10 | 312,109 |
| Alert command first 50 | 30 / 1 | 40.348 | 54.010 | 70.080 | 13 | 32,385 |
| Report assembled from public 200-row pages | 5 / 1 | 733.158 | 748.858 | 748.858 | 75 | 1,760,814 |
| Report from one consistent read | 5 / 1 | 332.637 | 366.376 | 366.376 | 4 | 1,760,902 |
| Scan with durable intent | 30 / 4 | 66.357 | 239.509 | 257.274 | 17 | 1,108 |
| Mixed scans and dashboard reads | 30 / 4 | 45.272 | 61.464 | 63.230 | 11.5 | 25,736 |
| Dashboard with aggregate reads | 30 / 4 | 24.272 | 30.011 | 30.832 | 6 | 56,169 |

### Separate synthetic delivery timing

The same benchmark drained **45 outbox rows in 322.253 ms** using an injected successful no-network sink. This is a test of the drain loop only; it is not Redis publication latency, Temporal workflow latency, or user-visible update latency.

## Earlier local dashboard comparison

The README records a separate local comparison using 126 movements, five warmups, 60 samples, and concurrency one:

| Measurement boundary | Median | p95 |
|---|---:|---:|
| Direct PostgreSQL dashboard handler | 11.347 ms | 13.650 ms |

This older result also excludes HTTP, authentication, rendering, and concurrent scans. Keep it separate from the October 16 benchmark because the fixture and run differ.

## Live Kong and Prometheus status

Kong exports request counts and upstream-latency histograms. Prometheus scrapes Kong every 15 seconds. Its UI is available locally at `http://localhost:1010/query` when the `observability` profile is running.

At capture time, `up{job="kong"}` was `1`. The following p95 query produced nine route/service series, all with `NaN`, meaning a numeric p95 was not available for the selected five-minute window:

```promql
histogram_quantile(
  0.95,
  sum by (le, service, route) (
    rate(kong_upstream_latency_ms_bucket[5m])
  )
)
```

Generate real application requests and allow at least two 15-second scrape intervals before re-running the query. The same metric supports p50 and p99 by replacing `0.95` with `0.50` or `0.99`. Request throughput can be checked with:

```promql
sum by (service, route) (rate(kong_http_requests_total[5m]))
```

The configured alert threshold is **p95 upstream latency above 2,000 ms for five minutes**. This is an alert condition, not a measured application latency or an agreed service-level objective.

Kong upstream latency is time spent waiting for the upstream service. It does not include the full browser journey, client network time, or frontend rendering.

## Request-level timings available in logs and headers

These are emitted at runtime but are not stored as historical percentile records in the repository:

| Instrumentation | Fields or stages | What it measures |
|---|---|---|
| FastAPI structured request log | `headers_ms`, `duration_ms`, route, status, outcome, request ID | Time until response headers and total ASGI request duration for each Python API request. |
| Next.js BFF request log | `duration_ms`, method, status, request ID | Duration of wrapped BFF API requests. |
| Next.js `Server-Timing` response header | `auth`, `upstream`, `upstream_wall`, `upstream_parse`, `request_parse`, `normalize`, `serialize`, `total` when applicable | Per-request authentication, upstream, parsing, normalization, serialization, and total durations. `upstream` is cumulative work; `upstream_wall` records wall time for overlapping upstream calls. |
| Browser Developer Tools Network panel | Request timing phases and page requests | User-visible browser network timing. Rendering and long tasks should be assessed separately in the Performance panel. |

To report FastAPI request samples from the running stack, inspect `docker compose logs --since=10m python-api` and summarize `duration_ms` by route. To report the end-to-end experience, collect browser Network timings for the same pages and test account.

## Presentation-safe conclusions

1. The available recorded benchmarks are small synthetic handler measurements, not production or full-stack SLAs.
2. In the October 16 fixture, focused reads and a one-read report had lower measured p95 values than their corresponding complete-read or paginated alternatives; the tables preserve the exact sample counts and response sizes.
3. Live gateway instrumentation is running and Prometheus is scraping Kong, but a current numeric live p95 requires recent application traffic.
4. Do not present the 11.347 ms dashboard median, the October 16 handler timings, or the no-network outbox drain as end-to-end user response times.

## Measurement gaps

The repository does not contain a representative, repeatable end-to-end load report with browser/API p50/p95/p99, throughput, error rates, CPU/memory, database wait, and real Keycloak/Redis/Temporal timings. The latency-remediation plan specifies these measurements as future benchmark work; its procedures are not evidence that those runs have been completed.
