/**
 * MAGI Price Tracker (v2.0 — MooMoo)
 *
 * Hourly Cloud Run service that back-fills price data into
 * `screen-share-459802.magi_analytics.llm_analysis`:
 *
 *   - `actual_price_after_1h` for rows created 60min..48h ago
 *   - `actual_price_after_1d` and `outcome` for rows created 24h..7d ago
 *
 * Prices come from MooMoo via the magi-moomoo Cloud Run proxy. The proxy URL
 * is resolved at runtime from BigQuery `magi_core.service_endpoints`
 * (service='magi-moomoo'). Authentication uses a Google-issued ID token.
 *
 * Migrated from Alpaca-backed v1.0 — same BigQuery schema, no env keys
 * required (Cloud Run service account permissions cover MooMoo proxy + BQ).
 */
import express from 'express';
import { BigQuery } from '@google-cloud/bigquery';
import fetch from 'node-fetch';
import { GoogleAuth } from 'google-auth-library';

const PROJECT_ID = 'screen-share-459802';
const TABLE = `${PROJECT_ID}.magi_analytics.llm_analysis`;

const app = express();
const PORT = process.env.PORT || 8080;
const bigquery = new BigQuery({ projectId: PROJECT_ID });
const auth = new GoogleAuth();

let cachedMoomooUrl = null;
let cachedAt = 0;
const URL_TTL_MS = 5 * 60 * 1000;

/**
 * Resolve the magi-moomoo Cloud Run URL from BigQuery service_endpoints.
 * Cached for 5 minutes.
 */
async function getMoomooUrl() {
  if (cachedMoomooUrl && Date.now() - cachedAt < URL_TTL_MS) {
    return cachedMoomooUrl;
  }
  const [rows] = await bigquery.query({
    query: `SELECT url FROM \`${PROJECT_ID}.magi_core.service_endpoints\`
            WHERE service = 'magi-moomoo'
            ORDER BY updated_at DESC LIMIT 1`,
    location: 'US'
  });
  if (!rows || rows.length === 0) {
    throw new Error('magi-moomoo URL not found in BigQuery service_endpoints');
  }
  cachedMoomooUrl = rows[0].url;
  cachedAt = Date.now();
  return cachedMoomooUrl;
}

let cachedIdTokenClient = null;
let cachedIdTokenAudience = null;

/**
 * Fetch a Bearer ID token for the magi-moomoo proxy (Cloud Run-to-Cloud Run
 * authentication). Handles both google-auth-library v10+ (Headers object)
 * and v9 (plain object) return shapes.
 */
async function getMoomooAuthHeader(targetUrl) {
  if (!cachedIdTokenClient || cachedIdTokenAudience !== targetUrl) {
    cachedIdTokenClient = await auth.getIdTokenClient(targetUrl);
    cachedIdTokenAudience = targetUrl;
  }
  const headers = await cachedIdTokenClient.getRequestHeaders();
  return typeof headers.get === 'function'
    ? headers.get('Authorization')
    : headers.Authorization;
}

/**
 * Fetch the latest price for a symbol from MooMoo via magi-moomoo proxy.
 * Prefers last traded price, falls back to ask/bid.
 *
 * @param {string} symbol
 * @returns {Promise<number|null>}
 */
async function getMoomooPrice(symbol) {
  try {
    const moomooUrl = await getMoomooUrl();
    const authHeader = await getMoomooAuthHeader(moomooUrl);
    const res = await fetch(
      `${moomooUrl}/trade/quote?symbol=${encodeURIComponent(symbol)}`,
      {
        headers: { Authorization: authHeader },
        signal: AbortSignal.timeout(10000)
      }
    );
    if (!res.ok) {
      console.error(`[ERROR] MooMoo quote failed for ${symbol}: HTTP ${res.status}`);
      return null;
    }
    const data = await res.json();
    return data.last_price ?? data.ask ?? data.bid ?? null;
  } catch (e) {
    console.error(`[ERROR] Failed to get price for ${symbol}:`, e.message);
    return null;
  }
}

function calculateOutcome(action, priceAt, priceAfter) {
  if (!priceAt || !priceAfter) return null;
  const change = (priceAfter - priceAt) / priceAt;

  if (action === 'BUY') {
    if (change >= 0.05) return 'correct';
    if (change >= 0.01) return 'partial';
    if (change >= -0.01) return 'neutral';
    return 'incorrect';
  }
  if (action === 'SELL') {
    if (change <= -0.05) return 'correct';
    if (change <= -0.01) return 'partial';
    if (change <= 0.01) return 'neutral';
    return 'incorrect';
  }
  if (action === 'HOLD') {
    if (Math.abs(change) <= 0.02) return 'correct';
    if (Math.abs(change) <= 0.05) return 'partial';
    return 'incorrect';
  }
  return null;
}

async function getRecordsNeedingUpdate(timeframe) {
  const query = timeframe === '1h'
    ? `SELECT id, symbol, action, actual_price_at_analysis, created_at
       FROM \`${TABLE}\`
       WHERE actual_price_after_1h IS NULL
         AND actual_price_at_analysis IS NOT NULL
         AND TIMESTAMP_DIFF(CURRENT_TIMESTAMP(), created_at, MINUTE) >= 60
         AND TIMESTAMP_DIFF(CURRENT_TIMESTAMP(), created_at, HOUR) < 48`
    : `SELECT id, symbol, action, actual_price_at_analysis, created_at
       FROM \`${TABLE}\`
       WHERE actual_price_after_1d IS NULL
         AND actual_price_at_analysis IS NOT NULL
         AND TIMESTAMP_DIFF(CURRENT_TIMESTAMP(), created_at, HOUR) >= 24
         AND TIMESTAMP_DIFF(CURRENT_TIMESTAMP(), created_at, DAY) < 7`;
  const [rows] = await bigquery.query({ query });
  return rows;
}

async function updateRecord(id, updates) {
  const setClauses = [];
  const params = { record_id: id };

  if (updates.price_after_1h !== undefined) {
    setClauses.push('actual_price_after_1h = @price_1h');
    params.price_1h = updates.price_after_1h;
  }
  if (updates.price_after_1d !== undefined) {
    setClauses.push('actual_price_after_1d = @price_1d');
    params.price_1d = updates.price_after_1d;
  }
  if (updates.outcome !== undefined) {
    setClauses.push('outcome = @outcome');
    params.outcome = updates.outcome;
  }
  if (setClauses.length === 0) return;

  await bigquery.query({
    query: `UPDATE \`${TABLE}\` SET ${setClauses.join(', ')} WHERE id = @record_id`,
    params
  });
  console.log(`[UPDATED] ${id}`);
}

async function runTracker() {
  console.log('=== MAGI Price Tracker v2.0 (MooMoo) ===');
  const results = { updated_1h: 0, updated_1d: 0, skipped: 0 };

  const oneHourRecords = await getRecordsNeedingUpdate('1h');
  console.log(`[1H] Found ${oneHourRecords.length} records`);
  for (const record of oneHourRecords) {
    const price = await getMoomooPrice(record.symbol);
    if (price) {
      await updateRecord(record.id, { price_after_1h: price });
      results.updated_1h++;
    } else {
      results.skipped++;
    }
  }

  const oneDayRecords = await getRecordsNeedingUpdate('1d');
  console.log(`[1D] Found ${oneDayRecords.length} records`);
  for (const record of oneDayRecords) {
    const price = await getMoomooPrice(record.symbol);
    if (price) {
      const outcome = calculateOutcome(
        record.action,
        record.actual_price_at_analysis,
        price
      );
      await updateRecord(record.id, { price_after_1d: price, outcome });
      results.updated_1d++;
    } else {
      results.skipped++;
    }
  }

  return results;
}

app.get('/health', (req, res) => {
  res.json({ status: 'ok', service: 'magi-price-tracker', version: '2.0.0' });
});

async function handleRun(req, res) {
  try {
    const results = await runTracker();
    res.json({ status: 'success', ...results });
  } catch (error) {
    console.error('[ERROR]', error.message);
    res.status(500).json({ status: 'error', message: error.message });
  }
}

app.get('/run', handleRun);
app.post('/run', handleRun);

app.listen(PORT, () => {
  console.log(`MAGI Price Tracker listening on port ${PORT}`);
});
