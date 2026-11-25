import express from 'express';
import cors from 'cors';
import fs from 'fs';
import path from 'path';

const app = express();
app.use(cors());
app.use(express.json({ limit: '1mb' }));

const DATA_DIR = path.resolve('./data');
const ALERTS_FILE = path.join(DATA_DIR, 'tv-alerts.json');
const MAX_ALERTS = 300;

if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

function loadAlerts() {
  try {
    if (!fs.existsSync(ALERTS_FILE)) return [];
    const raw = fs.readFileSync(ALERTS_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch (err) {
    console.error('Failed to read alerts file:', err.message);
    return [];
  }
}

function saveAlerts(list) {
  try {
    fs.writeFileSync(ALERTS_FILE, JSON.stringify(list.slice(0, MAX_ALERTS), null, 2), 'utf8');
  } catch (err) {
    console.error('Failed to write alerts file:', err.message);
  }
}

let recentTvAlerts = loadAlerts();

function computeSignalQuality(payload) {
  let score = 40;
  const reasons = [];
  const side = String(payload.side || '').toUpperCase();
  const event = String(payload.event || '').toUpperCase();
  const tf = String(payload.timeframe || '15m').toUpperCase();

  if (side === 'BUY' || side === 'SELL') {
    score += 20;
    reasons.push(`Directional ${side}`);
  }
  if (['BOS', 'CHOCH', 'SWEEP', 'FVG', 'OB', '1H_PLAN', 'ENGULF', 'SPOT'].some(k => event.includes(k))) {
    score += 20;
    reasons.push(`SMC/PA Event (${event})`);
  }
  if (['1H', '4H', '60', '240'].includes(tf)) {
    score += 10;
    reasons.push(`HTF Confluence (${tf})`);
  }
  if (payload.sl && payload.tp && payload.price) {
    const entry = Number(payload.price);
    const sl = Number(payload.sl);
    const tp = Number(payload.tp);
    const risk = Math.abs(entry - sl);
    const reward = Math.abs(tp - entry);
    if (risk > 0 && reward / risk >= 1.5) {
      score += 10;
      reasons.push(`R:R ${(reward / risk).toFixed(1)} >= 1.5`);
    }
  }

  return {
    score: Math.min(100, score),
    grade: score >= 80 ? 'A+ HIGH CONVICTION' : (score >= 60 ? 'B QUALIFIED' : 'C WATCH'),
    reasons
  };
}

// Spot Gold (XAU/USD) endpoint: uses custom SPOT_GOLD_FEED_URL or TwelveData if configured,
// otherwise falls back cleanly to PAXGUSDT + optional BROKER_GOLD_OFFSET so the client always gets a live number.
app.get('/api/spot-gold', async (req, res) => {
  const brokerOffset = Number(process.env.BROKER_GOLD_OFFSET || 0);

  try {
    if (process.env.SPOT_GOLD_FEED_URL) {
      const r = await fetch(process.env.SPOT_GOLD_FEED_URL, { cache: 'no-store' });
      if (r.ok) {
        const j = await r.json();
        const rawPrice = Number(j.price ?? j.xauusd ?? j.close);
        if (Number.isFinite(rawPrice) && rawPrice > 100) {
          const spotPrice = +(rawPrice + brokerOffset).toFixed(2);
          return res.json({
            ok: true,
            symbol: 'XAUUSD',
            isSpotDirect: true,
            source: j.source || 'Custom Spot Gold Feed',
            price: spotPrice,
            brokerOffset
          });
        }
      }
    }

    if (process.env.TWELVE_DATA_API_KEY) {
      const url = `https://api.twelvedata.com/price?symbol=${encodeURIComponent('XAU/USD')}&apikey=${encodeURIComponent(process.env.TWELVE_DATA_API_KEY)}`;
      const r = await fetch(url, { cache: 'no-store' });
      if (r.ok) {
        const j = await r.json();
        const rawPrice = Number(j.price);
        if (Number.isFinite(rawPrice) && rawPrice > 100) {
          const spotPrice = +(rawPrice + brokerOffset).toFixed(2);
          return res.json({
            ok: true,
            symbol: 'XAUUSD',
            isSpotDirect: true,
            source: 'TwelveData XAU/USD Spot',
            price: spotPrice,
            brokerOffset
          });
        }
      }
    }

    // Fallback to PAXGUSDT with explicit non-spot flag
    const bRes = await fetch('https://api.binance.com/api/v3/ticker/price?symbol=PAXGUSDT', { cache: 'no-store' });
    if (!bRes.ok) throw new Error('Binance PAXGUSDT unreachable');
    const bJson = await bRes.json();
    const paxgPrice = Number(bJson.price);
    const adjustedPrice = +(paxgPrice + brokerOffset).toFixed(2);

    return res.json({
      ok: true,
      symbol: 'XAUUSD',
      isSpotDirect: false,
      source: 'PAXGUSDT Token Proxy (Set TWELVE_DATA_API_KEY or SPOT_GOLD_FEED_URL for Direct Spot XAU/USD)',
      price: adjustedPrice,
      paxgRaw: paxgPrice,
      brokerOffset
    });
  } catch (err) {
    return res.status(502).json({ ok: false, error: err.message });
  }
});

app.get('/health', (req, res) => {
  res.json({
    ok: true,
    alertsStored: recentTvAlerts.length,
    storage: 'persistent-json'
  });
});

app.post('/api/tv-webhook', (req, res) => {
  const secret = req.headers['x-tv-secret'] || req.body?.secret;
  if (process.env.TV_WEBHOOK_SECRET && secret !== process.env.TV_WEBHOOK_SECRET) {
    return res.status(401).json({ ok: false, error: 'Unauthorized webhook secret' });
  }

  const body = req.body || {};
  const price = Number(body.price ?? body.close);
  if (!Number.isFinite(price) || price <= 0) {
    return res.status(400).json({ ok: false, error: 'Missing or invalid price' });
  }

  const slVal = body.sl !== undefined && body.sl !== null && body.sl !== '' && Number.isFinite(Number(body.sl))
    ? Number(body.sl)
    : null;
  const tpVal = body.tp !== undefined && body.tp !== null && body.tp !== '' && Number.isFinite(Number(body.tp))
    ? Number(body.tp)
    : null;

  const quality = computeSignalQuality({ ...body, price, sl: slVal, tp: tpVal });

  const item = {
    id: `TV-${Date.now()}-${Math.floor(Math.random() * 900 + 100)}`,
    receivedAt: new Date().toISOString(),
    symbol: String(body.symbol || 'XAUUSD').toUpperCase(),
    timeframe: String(body.timeframe || '15m'),
    side: String(body.side || 'ALERT').toUpperCase(),
    event: String(body.event || 'TV_WEBHOOK_SIGNAL'),
    price,
    sl: slVal,
    tp: tpVal,
    qualityScore: quality.score,
    qualityGrade: quality.grade,
    qualityReasons: quality.reasons,
    note: String(body.note || '')
  };

  recentTvAlerts.unshift(item);
  if (recentTvAlerts.length > MAX_ALERTS) recentTvAlerts.pop();
  saveAlerts(recentTvAlerts);

  res.status(200).json({ ok: true, id: item.id, quality });
});

app.get('/api/tv-alerts', (req, res) => {
  const symbol = req.query.symbol ? String(req.query.symbol).toUpperCase() : null;
  const minScore = req.query.minScore ? Number(req.query.minScore) : 0;
  const filtered = recentTvAlerts.filter(a => {
    const symOk = !symbol || a.symbol === symbol;
    const scoreOk = !Number.isFinite(minScore) || (a.qualityScore || 0) >= minScore;
    return symOk && scoreOk;
  });
  res.json({ ok: true, totalStored: recentTvAlerts.length, alerts: filtered.slice(0, 40) });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`AURA TV Webhook & Spot Gold Brain Server listening on port ${PORT} (stored: ${recentTvAlerts.length})`);
});
