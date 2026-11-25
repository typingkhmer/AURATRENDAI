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
const DEDUP_WINDOW_MS = 30000; // 30s cooldown for identical alert bursts

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
let lastGoodSpotGold = null;

function getSessionInfo(date = new Date()) {
  const utcHour = date.getUTCHours();
  if (utcHour >= 12 && utcHour < 17) {
    return { session: 'LONDON_NY_OVERLAP', active: true, bonus: 10 };
  }
  if (utcHour >= 7 && utcHour < 12) {
    return { session: 'LONDON', active: true, bonus: 8 };
  }
  if (utcHour >= 17 && utcHour < 21) {
    return { session: 'NEW_YORK', active: true, bonus: 8 };
  }
  return { session: 'ASIAN_OFFPEAK', active: false, bonus: -5 };
}

function computeRecommendedLot(symbol, entry, sl, balance = 1000, riskPct = 2) {
  if (!entry || !sl) return null;
  const dist = Math.abs(Number(entry) - Number(sl));
  if (!Number.isFinite(dist) || dist <= 0) return null;

  const sym = String(symbol || 'XAUUSD').toUpperCase();
  const contractSize = sym === 'XAUUSD' ? 100 : (sym === 'BTCUSD' ? 1 : 100000);
  const riskUsd = Number(balance) * (Number(riskPct) / 100);
  const rawLot = riskUsd / (dist * contractSize);
  return Math.max(0.01, Number(rawLot.toFixed(2)));
}

function computeSignalQuality(payload) {
  let score = 35;
  const reasons = [];
  const side = String(payload.side || '').toUpperCase();
  const event = String(payload.event || '').toUpperCase();
  const tf = String(payload.timeframe || '15m').toUpperCase();
  const sessionCtx = getSessionInfo(new Date());

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

  let rr = null;
  if (payload.sl && payload.tp && payload.price) {
    const entry = Number(payload.price);
    const sl = Number(payload.sl);
    const tp = Number(payload.tp);
    const risk = Math.abs(entry - sl);
    const reward = Math.abs(tp - entry);
    if (risk > 0) {
      rr = Number((reward / risk).toFixed(2));
      if (rr >= 2.0) {
        score += 15;
        reasons.push(`Strong R:R 1:${rr}`);
      } else if (rr >= 1.5) {
        score += 10;
        reasons.push(`Valid R:R 1:${rr}`);
      }
    }
  }

  score += sessionCtx.bonus;
  reasons.push(`Session:${sessionCtx.session}`);

  const clamped = Math.max(0, Math.min(100, score));
  const recommendedLot = computeRecommendedLot(
    payload.symbol,
    payload.price,
    payload.sl,
    payload.balance || Number(process.env.DEFAULT_BALANCE || 1000),
    payload.riskPct || Number(process.env.DEFAULT_RISK_PCT || 2)
  );

  return {
    score: clamped,
    grade: clamped >= 80 ? 'A+ HIGH CONVICTION' : (clamped >= 60 ? 'B QUALIFIED' : 'C WATCH'),
    session: sessionCtx.session,
    rr,
    recommendedLot,
    reasons
  };
}

async function sendTelegramAlertIfConfigured(item) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) return;
  if ((item.qualityScore || 0) < Number(process.env.TELEGRAM_MIN_SCORE || 75)) return;

  const text = [
    `⚡ <b>AURA TREND AI • ${item.qualityGrade}</b>`,
    `• <b>Pair:</b> ${item.symbol} (${item.timeframe}) — <b>${item.side}</b>`,
    `• <b>Event:</b> ${item.event} | <b>Score:</b> ${item.qualityScore}/100`,
    `• <b>Price:</b> ${item.price} | <b>SL:</b> ${item.sl ?? '-'} | <b>TP:</b> ${item.tp ?? '-'}`,
    item.recommendedLot ? `• <b>Suggested Lot:</b> ${item.recommendedLot}` : null,
    item.note ? `• <b>Note:</b> ${item.note}` : null
  ].filter(Boolean).join('\n');

  try {
    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML' })
    });
  } catch (err) {
    console.error('Telegram notify failed:', err.message);
  }
}

// Spot Gold (XAU/USD) endpoint with multi-source fallback + cached last-good price
app.get('/api/spot-gold', async (req, res) => {
  const brokerOffset = Number(process.env.BROKER_GOLD_OFFSET || 0);

  try {
    if (process.env.SPOT_GOLD_FEED_URL) {
      const r = await fetch(process.env.SPOT_GOLD_FEED_URL, { cache: 'no-store' });
      if (r.ok) {
        const j = await r.json();
        const rawPrice = Number(j.price ?? j.xauusd ?? j.close);
        if (Number.isFinite(rawPrice) && rawPrice > 100) {
          const payload = {
            ok: true,
            symbol: 'XAUUSD',
            isSpotDirect: true,
            source: j.source || 'Custom Spot Gold Feed',
            price: +(rawPrice + brokerOffset).toFixed(2),
            brokerOffset,
            updatedAt: new Date().toISOString()
          };
          lastGoodSpotGold = payload;
          return res.json(payload);
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
          const payload = {
            ok: true,
            symbol: 'XAUUSD',
            isSpotDirect: true,
            source: 'TwelveData XAU/USD Spot',
            price: +(rawPrice + brokerOffset).toFixed(2),
            brokerOffset,
            updatedAt: new Date().toISOString()
          };
          lastGoodSpotGold = payload;
          return res.json(payload);
        }
      }
    }

    // Fallback to Binance PAXGUSDT with explicit proxy disclosure
    const bRes = await fetch('https://api.binance.com/api/v3/ticker/price?symbol=PAXGUSDT', { cache: 'no-store' });
    if (!bRes.ok) throw new Error('Binance PAXGUSDT unreachable');
    const bJson = await bRes.json();
    const paxgPrice = Number(bJson.price);
    const adjustedPrice = +(paxgPrice + brokerOffset).toFixed(2);

    const payload = {
      ok: true,
      symbol: 'XAUUSD',
      isSpotDirect: false,
      source: 'PAXGUSDT Token Proxy (Configure TWELVE_DATA_API_KEY or SPOT_GOLD_FEED_URL for Direct Spot XAU/USD)',
      price: adjustedPrice,
      paxgRaw: paxgPrice,
      brokerOffset,
      updatedAt: new Date().toISOString()
    };
    lastGoodSpotGold = payload;
    return res.json(payload);
  } catch (err) {
    if (lastGoodSpotGold) {
      return res.json({ ...lastGoodSpotGold, cachedFallback: true, warning: err.message });
    }
    return res.status(502).json({ ok: false, error: err.message });
  }
});

app.get('/health', (req, res) => {
  res.json({
    ok: true,
    alertsStored: recentTvAlerts.length,
    storage: 'persistent-json',
    hasSpotCache: Boolean(lastGoodSpotGold)
  });
});

app.post('/api/tv-webhook', async (req, res) => {
  const secret = req.headers['x-tv-secret'] || req.body?.secret;
  if (process.env.TV_WEBHOOK_SECRET && secret !== process.env.TV_WEBHOOK_SECRET) {
    return res.status(401).json({ ok: false, error: 'Unauthorized webhook secret' });
  }

  const body = req.body || {};
  const price = Number(body.price ?? body.close);
  if (!Number.isFinite(price) || price <= 0) {
    return res.status(400).json({ ok: false, error: 'Missing or invalid price' });
  }

  const symbol = String(body.symbol || 'XAUUSD').toUpperCase();
  const timeframe = String(body.timeframe || '15m');
  const side = String(body.side || 'ALERT').toUpperCase();
  const event = String(body.event || 'TV_WEBHOOK_SIGNAL');

  // Deduplicate burst alerts within DEDUP_WINDOW_MS
  const nowMs = Date.now();
  const duplicate = recentTvAlerts.find(a =>
    a.symbol === symbol &&
    a.side === side &&
    a.event === event &&
    (nowMs - Date.parse(a.receivedAt || 0)) < DEDUP_WINDOW_MS
  );
  if (duplicate) {
    return res.status(200).json({ ok: true, deduplicated: true, id: duplicate.id });
  }

  const slVal = body.sl !== undefined && body.sl !== null && body.sl !== '' && Number.isFinite(Number(body.sl))
    ? Number(body.sl)
    : null;
  const tpVal = body.tp !== undefined && body.tp !== null && body.tp !== '' && Number.isFinite(Number(body.tp))
    ? Number(body.tp)
    : null;

  const quality = computeSignalQuality({ ...body, symbol, timeframe, side, event, price, sl: slVal, tp: tpVal });

  const item = {
    id: `TV-${nowMs}-${Math.floor(Math.random() * 900 + 100)}`,
    receivedAt: new Date(nowMs).toISOString(),
    symbol,
    timeframe,
    side,
    event,
    price,
    sl: slVal,
    tp: tpVal,
    rr: quality.rr,
    session: quality.session,
    recommendedLot: quality.recommendedLot,
    qualityScore: quality.score,
    qualityGrade: quality.grade,
    qualityReasons: quality.reasons,
    note: String(body.note || '')
  };

  recentTvAlerts.unshift(item);
  if (recentTvAlerts.length > MAX_ALERTS) recentTvAlerts.pop();
  saveAlerts(recentTvAlerts);
  await sendTelegramAlertIfConfigured(item);

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
  console.log(`AURA TV Webhook & Spot Gold Brain v3 Server listening on port ${PORT} (stored: ${recentTvAlerts.length})`);
});
