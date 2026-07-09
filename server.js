const express = require('express');
const crypto = require('crypto');
const app = express();
const PORT = process.env.PORT || 3000;

const CMC_API_KEY = process.env.CMC_API_KEY;
const BYBIT_API_KEY = process.env.BYBIT_API_KEY;
const BYBIT_API_SECRET = process.env.BYBIT_API_SECRET;

app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET');
  next();
});

// ---- главная страница, просто проверка что сервер жив ----
app.get('/', (req, res) => res.send('Crypto arbitrage proxy server работает.'));

// ---- проверка что ключ CMC дошёл до сервера (не показывает ключ целиком) ----
app.get('/api/key-check', (req, res) => {
  res.json({
    cmc_key_present: Boolean(CMC_API_KEY),
    bybit_key_present: Boolean(BYBIT_API_KEY),
    bybit_secret_present: Boolean(BYBIT_API_SECRET)
  });
});

// ---- цены по биржам от CoinMarketCap (нужен платный план — сейчас не работает на Basic) ----
app.get('/api/spreads', async (req, res) => {
  const symbol = (req.query.symbol || '').toUpperCase();
  if (!symbol) return res.status(400).json({ error: 'symbol required' });
  if (!CMC_API_KEY) return res.status(500).json({ error: 'server misconfigured: no CMC key set' });

  try {
    const url = `https://pro-api.coinmarketcap.com/v1/cryptocurrency/market-pairs/latest?symbol=${symbol}&limit=100`;
    const cmcRes = await fetch(url, {
      headers: {
        'X-CMC_PRO_API_KEY': CMC_API_KEY,
        'Accept': 'application/json'
      }
    });
    const data = await cmcRes.json();

    if (!cmcRes.ok) {
      return res.status(cmcRes.status).json({
        error: 'CMC отклонил запрос',
        cmc_status: cmcRes.status,
        cmc_message: (data.status && data.status.error_message) || 'нет деталей'
      });
    }

    const pairs = (data.data && data.data[symbol] && data.data[symbol][0] && data.data[symbol][0].market_pairs) || [];
    const simplified = pairs
      .filter(p => p.quote && p.quote.exchange_reported && p.quote.exchange_reported.price > 0)
      .map(p => ({
        exchange: p.exchange.name,
        price: p.quote.exchange_reported.price,
        pair: p.market_pair
      }));

    res.json({ symbol, pairs: simplified });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ---- статус ввода/вывода монеты на Bybit (приватный эндпоинт, нужен ключ) ----
app.get('/api/status/bybit', async (req, res) => {
  const coin = (req.query.coin || '').toUpperCase();
  if (!coin) return res.status(400).json({ error: 'coin required' });
  if (!BYBIT_API_KEY || !BYBIT_API_SECRET) {
    return res.status(500).json({ error: 'ключи Bybit не заданы на сервере' });
  }

  const timestamp = Date.now().toString();
  const recvWindow = '5000';
  const queryString = `coin=${coin}`;
  const signPayload = timestamp + BYBIT_API_KEY + recvWindow + queryString;
  const signature = crypto.createHmac('sha256', BYBIT_API_SECRET).update(signPayload).digest('hex');

  try {
    const r = await fetch(`https://api.bybit.com/v5/asset/coin/query-info?${queryString}`, {
      headers: {
        'X-BAPI-API-KEY': BYBIT_API_KEY,
        'X-BAPI-SIGN': signature,
        'X-BAPI-TIMESTAMP': timestamp,
        'X-BAPI-RECV-WINDOW': recvWindow
      }
    });
    const data = await r.json();

    if (data.retCode !== 0) {
      return res.status(400).json({ error: 'Bybit отклонил запрос', detail: data.retMsg });
    }

    const row = (data.result.rows || [])[0];
    if (!row) return res.json({ coin, dep: false, wd: false, note: 'монета не найдена на Bybit' });

    const dep = row.chains.some(c => c.chainDeposit === '1');
    const wd = row.chains.some(c => c.chainWithdraw === '1');
    res.json({ coin, dep, wd });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
