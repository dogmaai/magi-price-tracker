# magi-price-tracker

Hourly Cloud Run service that back-fills price data into
`screen-share-459802.magi_analytics.llm_analysis`:

- `actual_price_after_1h` for rows created 60min..48h ago
- `actual_price_after_1d` and `outcome` for rows created 24h..7d ago

Prices come from **MooMoo via the magi-moomoo Cloud Run proxy** (v2.0+).
v1.0 used Alpaca; that dependency has been removed.

## Architecture

```
Cloud Scheduler (magi-price-tracker-hourly, 0 * * * * America/New_York)
  -> GET https://magi-price-tracker-...run.app/run
       -> SELECT magi_analytics.llm_analysis WHERE actual_price_after_* IS NULL
       -> GET magi-moomoo/trade/quote?symbol=<sym>  (ID token auth)
       -> UPDATE magi_analytics.llm_analysis
```

The magi-moomoo proxy URL is resolved at runtime from BigQuery
`magi_core.service_endpoints` (service='magi-moomoo'). The Cloud Run service
account needs:

- `roles/bigquery.dataEditor` on `magi_analytics`
- `roles/bigquery.dataViewer` on `magi_core` (for `service_endpoints` lookup)
- `roles/run.invoker` on the `magi-moomoo` service (for ID-token-authed calls)

No external API keys are required.

## Endpoints

- `GET /health` — liveness probe
- `GET /run` / `POST /run` — trigger one back-fill pass (used by Cloud Scheduler)

## Deploy

CI/CD via `.github/workflows/deploy.yml` on push to `main`. Manual deploy:

```bash
gcloud run deploy magi-price-tracker \
  --source=. \
  --region=asia-northeast1 \
  --no-allow-unauthenticated \
  --memory=512Mi \
  --timeout=540s \
  --project=screen-share-459802
```

## Local dev

```bash
npm install
# Local invocation requires ADC for BigQuery + magi-moomoo:
gcloud auth application-default login
node server.js
curl -X POST http://localhost:8080/run
```
