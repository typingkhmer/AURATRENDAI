import express from 'express';
import cors from 'cors';

const app = express();
app.use(cors());
app.use(express.json());

const recentTvAlerts = [];
const MAX_ALERTS = 100;

app.get('/health', (req, res) => {
  res.json({ ok: true, alertsStored: recentTvAlerts.length });
});

app.post('/api/tv-webhook', (req, res) => {
  const secret = req.headers['x-tv-secret'] || req.body?.secret;
  if (process.env.TV_WEBHOOK_SECRET && secret !== process.env.TV_WEBHOOK_SECRET) {
    return res.status(401).json({ ok: false, error: 'Unauthorized webhook secret' });
  }

  const body = req.body || {};
  const price = Number(body.price || body.close || 0);
  if (!price || Number.isNaN(price)) {
    return res.status(400).json({ ok: false, error: 'Missing or invalid price' });
  }

  const item = {
    id: `TV-${Date.now()}`,
    receivedAt: new Date().toISOString(),
    symbol: String(body.symbol || 'XAUUSD').toUpperCase(),
    timeframe: String(body.timeframe || '15m'),
    side: String(body.side || 'ALERT').toUpperCase(),
    event: String(body.event || 'TV_WEBHOOK_SIGNAL'),
    price,
    sl: body.sl ? Number(body.sl) : null,
    tp: body.tp ? Number(body.tp) : null,
    note: String(body.note || '')
  };

  recentTvAlerts.unshift(item);
  if (recentTvAlerts.length > MAX_ALERTS) recentTvAlerts.pop();

  res.status(200).json({ ok: true, id: item.id });
});

app.get('/api/tv-alerts', (req, res) => {
  const symbol = req.query.symbol ? String(req.query.symbol).toUpperCase() : null;
  const alerts = symbol ? recentTvAlerts.filter(a => a.symbol === symbol) : recentTvAlerts;
  res.json({ ok: true, alerts: alerts.slice(0, 30) });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`AURA TV Webhook Server listening on port ${PORT}`));
