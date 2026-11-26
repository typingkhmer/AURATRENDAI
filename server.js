const TELEGRAM_BOT_TOKEN =
  process.env.TELEGRAM_BOT_TOKEN || "8416578282:AAGic7-AEUoB2dcJ6ElMoX9RFucs34j2lWU";
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID || "955031659";

// រក្សាស្ថានភាពតាម signal ពិត ដើម្បីកុំឱ្យផ្ញើជាន់គ្នាដដែលៗ
const telegramSignalState = new Map();

async function sendTelegramMessage(text) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID || !text) return false;
  try {
    const res = await fetch(
      `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: TELEGRAM_CHAT_ID,
          text,
          parse_mode: "HTML",
        }),
      }
    );
    if (!res.ok) {
      console.error("Telegram API error:", await res.text());
      return false;
    }
    return true;
  } catch (err) {
    console.error("Telegram send error:", err.message);
    return false;
  }
}

/**
 * ហៅ function នេះ តែពេលមាន signal ពិត និងតម្លៃទីផ្សារពិត (currentPrice) ប៉ុណ្ណោះ
 * signal ត្រូវមាន: { id, pair, timeframe, side, currentPrice, entry, zoneLow, zoneHigh, sl, tp1, tp2, preBuffer }
 */
async function pushRealSignalToTelegram(signal) {
  if (!signal || typeof signal.currentPrice !== "number") return;

  const entry = Number(signal.entry);
  const zoneLow = Number(signal.zoneLow ?? entry);
  const zoneHigh = Number(signal.zoneHigh ?? entry);
  const preBuffer = Number(signal.preBuffer ?? 0);

  if (Number.isNaN(zoneLow) || Number.isNaN(zoneHigh)) return;

  const key =
    signal.id ||
    `${signal.pair || "XAUUSD"}_${signal.timeframe || ""}_${signal.side || ""}_${entry}`;

  const state = telegramSignalState.get(key) || {
    preSent: false,
    entrySent: false,
  };

  const isInEntry =
    signal.currentPrice >= zoneLow && signal.currentPrice <= zoneHigh;
  const isNearEntry =
    preBuffer > 0 &&
    signal.currentPrice >= zoneLow - preBuffer &&
    signal.currentPrice <= zoneHigh + preBuffer;

  let stage = null;
  if (isInEntry && !state.entrySent) {
    stage = "ENTRY";
  } else if (isNearEntry && !state.preSent) {
    stage = "PRE_ENTRY";
  }

  if (!stage) return;

  const isPre = stage === "PRE_ENTRY";
  const lines = [
    isPre
      ? "⏳ <b>PRE-ENTRY ALERT (ជិតដល់កន្លែងចូលផ្សារ)</b>"
      : "🚨 <b>ENTRY ALERT (ដល់កន្លែងចូលផ្សារ)</b>",
    "━━━━━━━━━━━━━━━━━━━━",
    `📊 <b>Pair / TF:</b> ${signal.pair || "XAUUSD"} ${signal.timeframe ? `(${signal.timeframe})` : ""}`,
    signal.side ? `📌 <b>Side:</b> <b>${signal.side}</b>` : null,
    `💰 <b>Current Price:</b> ${signal.currentPrice}`,
    !Number.isNaN(entry) ? `🎯 <b>Entry:</b> ${entry}` : null,
    zoneLow !== zoneHigh ? `📦 <b>Zone:</b> ${zoneLow} - ${zoneHigh}` : null,
    signal.sl !== undefined ? `🛑 <b>SL:</b> ${signal.sl}` : null,
    signal.tp1 !== undefined ? `✅ <b>TP1:</b> ${signal.tp1}` : null,
    signal.tp2 !== undefined ? `🚀 <b>TP2:</b> ${signal.tp2}` : null,
  ].filter(Boolean);

  const sent = await sendTelegramMessage(lines.join("\n"));
  if (sent) {
    if (isPre) state.preSent = true;
    else state.entrySent = true;
    telegramSignalState.set(key, state);
  }
}

const API_CONFIG = {
  twelveDataApiKey: '34dcfb25fbc04111a3cc9e57bd609cad',
  fmpApiKey: 'YOUR_FMP_ECONOMIC_CALENDAR_KEY',
  fcsApiKey: '',
  backtestSpreadCostPerLot: 2.5,
  hourlyCadenceMs: 3600000
};
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
const DEDUP_WINDOW_MS = 30000;

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
    outcome: null, // 'WIN' | 'LOSS' | 'BE' | null
    pnlPct: null,
    note: String(body.note || '')
  };

  recentTvAlerts.unshift(item);
  if (recentTvAlerts.length > MAX_ALERTS) recentTvAlerts.pop();
  saveAlerts(recentTvAlerts);
  await sendTelegramAlertIfConfigured(item);

  const livePrice =
    typeof lastGoodSpotGold?.price === "number" ? lastGoodSpotGold.price : price;

  await pushRealSignalToTelegram({
    id: item.id,
    pair: item.symbol,
    timeframe: item.timeframe,
    side: item.side,
    currentPrice: livePrice,
    entry: price,
    zoneLow: price,
    zoneHigh: price,
    sl: item.sl ?? undefined,
    tp1: item.tp ?? undefined,
    preBuffer: 0,
  });

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

// Record WIN / LOSS / BE outcome for an existing alert
app.post('/api/tv-alerts/:id/outcome', (req, res) => {
  const { id } = req.params;
  const outcome = String(req.body?.outcome || '').toUpperCase();
  if (!['WIN', 'LOSS', 'BE'].includes(outcome)) {
    return res.status(400).json({ ok: false, error: 'Outcome must be WIN, LOSS, or BE' });
  }

  const target = recentTvAlerts.find(a => a.id === id);
  if (!target) {
    return res.status(404).json({ ok: false, error: 'Alert ID not found' });
  }

  target.outcome = outcome;
  if (req.body?.pnlPct !== undefined && Number.isFinite(Number(req.body.pnlPct))) {
    target.pnlPct = Number(req.body.pnlPct);
  }
  target.closedAt = new Date().toISOString();
  saveAlerts(recentTvAlerts);

  res.json({ ok: true, alert: target });
});

// Performance & Session Analytics Summary
app.get('/api/stats', (req, res) => {
  const symbolFilter = req.query.symbol ? String(req.query.symbol).toUpperCase() : null;
  const list = symbolFilter
    ? recentTvAlerts.filter(a => a.symbol === symbolFilter)
    : recentTvAlerts;

  const bySession = {
    LONDON_NY_OVERLAP: { total: 0, wins: 0, losses: 0, winRate: null },
    LONDON: { total: 0, wins: 0, losses: 0, winRate: null },
    NEW_YORK: { total: 0, wins: 0, losses: 0, winRate: null },
    ASIAN_OFFPEAK: { total: 0, wins: 0, losses: 0, winRate: null }
  };

  const byGrade = { 'A+ HIGH CONVICTION': 0, 'B QUALIFIED': 0, 'C WATCH': 0 };
  const bySymbol = {};
  let totalWins = 0;
  let totalLosses = 0;
  let scoreSum = 0;

  for (const a of list) {
    const sess = a.session || getSessionInfo(new Date(a.receivedAt || Date.now())).session;
    if (!bySession[sess]) {
      bySession[sess] = { total: 0, wins: 0, losses: 0, winRate: null };
    }
    bySession[sess].total++;

    if (a.outcome === 'WIN') {
      totalWins++;
      bySession[sess].wins++;
    } else if (a.outcome === 'LOSS') {
      totalLosses++;
      bySession[sess].losses++;
    }

    const grade = a.qualityGrade || 'C WATCH';
    byGrade[grade] = (byGrade[grade] || 0) + 1;

    const sym = a.symbol || 'UNKNOWN';
    bySymbol[sym] = (bySymbol[sym] || 0) + 1;
    scoreSum += Number(a.qualityScore || 0);
  }

  for (const key of Object.keys(bySession)) {
    const decided = bySession[key].wins + bySession[key].losses;
    bySession[key].winRate = decided > 0
      ? Number(((bySession[key].wins / decided) * 100).toFixed(1))
      : null;
  }

  const totalDecided = totalWins + totalLosses;
  res.json({
    ok: true,
    filter: symbolFilter || 'ALL',
    totalAlerts: list.length,
    averageQualityScore: list.length > 0 ? Number((scoreSum / list.length).toFixed(1)) : 0,
    outcomes: {
      wins: totalWins,
      losses: totalLosses,
      pending: list.length - totalDecided,
      winRate: totalDecided > 0 ? Number(((totalWins / totalDecided) * 100).toFixed(1)) : null
    },
    bySession,
    byGrade,
    bySymbol
  });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`AURA TV Webhook, Spot Gold & Analytics Server listening on port ${PORT} (stored: ${recentTvAlerts.length})`);
});
