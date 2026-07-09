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

app.get('/', (req, res) => res.send('Crypto arbitrage proxy server работает.'));

app.get('/api/key-check', (req, res) => {
  res.json({
    cmc_key_present: Boolean(CMC_API_KEY),
    bybit_key_present: Boolean(BYBIT_API_KEY),
    bybit_secret_present: Boolean(BYBIT_API_SECRET)
  });
});

app.get('/api/spreads', async (req, res) => {
  const symbol = (req.query.symbol || '').toUpperCase();
  if (!symbol) return res.status(400).json({ error: 'symbol required' });
  if (!CMC_API_KEY) return res.status(500).json({ error: 'server misconfigured: no CMC key set' });
  try {
    const url = `https://pro-api.coinmarketcap.com/v1/cryptocurrency/market-pairs/latest?symbol=${symbol}&limit=100`;
    const cmcRes = await fetch(url, { headers: { 'X-CMC_PRO_API_KEY': CMC_API_KEY, 'Accept': 'application/json' } });
    const data = await cmcRes.json();
    if (!cmcRes.ok) {
      return res.status(cmcRes.status).json({ error: 'CMC отклонил запрос', cmc_status: cmcRes.status, cmc_message: (data.status && data.status.error_message) || 'нет деталей' });
    }
    const pairs = (data.data && data.data[symbol] && data.data[symbol][0] && data.data[symbol][0].market_pairs) || [];
    const simplified = pairs.filter(p => p.quote && p.quote.exchange_reported && p.quote.exchange_reported.price > 0)
      .map(p => ({ exchange: p.exchange.name, price: p.quote.exchange_reported.price, pair: p.market_pair }));
    res.json({ symbol, pairs: simplified });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/status/bybit', async (req, res) => {
  const coin = (req.query.coin || '').toUpperCase();
  if (!coin) return res.status(400).json({ error: 'coin required' });
  if (!BYBIT_API_KEY || !BYBIT_API_SECRET) return res.status(500).json({ error: 'ключи Bybit не заданы на сервере' });

  const timestamp = Date.now().toString();
  const recvWindow = '5000';
  const queryString = `coin=${coin}`;
  const signPayload = timestamp + BYBIT_API_KEY + recvWindow + queryString;
  const signature = crypto.createHmac('sha256', BYBIT_API_SECRET).update(signPayload).digest('hex');

  try {
    const r = await fetch(`https://api.bybit.com/v5/asset/coin/query-info?${queryString}`, {
      headers: { 'X-BAPI-API-KEY': BYBIT_API_KEY, 'X-BAPI-SIGN': signature, 'X-BAPI-TIMESTAMP': timestamp, 'X-BAPI-RECV-WINDOW': recvWindow }
    });

    const rawText = await r.text();
    let data;
    try {
      data = JSON.parse(rawText);
    } catch (parseErr) {
      return res.status(502).json({
        error: 'Bybit ответил не в формате JSON — вероятно, блокировка по IP/региону сервера',
        http_status: r.status,
        raw_response_preview: rawText.slice(0, 300)
      });
    }

    if (data.retCode !== 0) return res.status(400).json({ error: 'Bybit отклонил запрос', detail: data.retMsg });
    const row = (data.result.rows || [])[0];
    if (!row) return res.json({ coin, dep: false, wd: false, note: 'монета не найдена на Bybit' });
    const dep = row.chains.some(c => c.chainDeposit === '1');
    const wd = row.chains.some(c => c.chainWithdraw === '1');
    res.json({ coin, dep, wd });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

const OKX_API_KEY = process.env.OKX_API_KEY;
const OKX_API_SECRET = process.env.OKX_API_SECRET;
const OKX_API_PASSPHRASE = process.env.OKX_API_PASSPHRASE;
const MEXC_API_KEY = process.env.MEXC_API_KEY;
const MEXC_API_SECRET = process.env.MEXC_API_SECRET;

app.get('/api/status/okx', async (req, res) => {
  const coin = (req.query.coin || '').toUpperCase();
  if (!coin) return res.status(400).json({ error: 'coin required' });
  if (!OKX_API_KEY || !OKX_API_SECRET || !OKX_API_PASSPHRASE) {
    return res.status(500).json({ error: 'ключи OKX не заданы на сервере' });
  }

  const requestPath = `/api/v5/asset/currencies?ccy=${coin}`;
  const timestamp = new Date().toISOString();
  const prehash = timestamp + 'GET' + requestPath;
  const sign = crypto.createHmac('sha256', OKX_API_SECRET).update(prehash).digest('base64');

  try {
    const r = await fetch(`https://www.okx.com${requestPath}`, {
      headers: {
        'OK-ACCESS-KEY': OKX_API_KEY,
        'OK-ACCESS-SIGN': sign,
        'OK-ACCESS-TIMESTAMP': timestamp,
        'OK-ACCESS-PASSPHRASE': OKX_API_PASSPHRASE,
        'Content-Type': 'application/json'
      }
    });
    const rawText = await r.text();
    let data;
    try { data = JSON.parse(rawText); }
    catch (e) {
      return res.status(502).json({ error: 'OKX ответил не JSON — вероятно, блокировка по региону', raw_response_preview: rawText.slice(0, 300) });
    }
    if (data.code !== '0') return res.status(400).json({ error: 'OKX отклонил запрос', detail: data.msg });
    const rows = data.data || [];
    if (rows.length === 0) return res.json({ coin, dep: false, wd: false, note: 'монета не найдена на OKX' });
    const dep = rows.some(row => row.canDep);
    const wd = rows.some(row => row.canWd);
    res.json({ coin, dep, wd });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/status/mexc', async (req, res) => {
  const coin = (req.query.coin || '').toUpperCase();
  if (!coin) return res.status(400).json({ error: 'coin required' });
  if (!MEXC_API_KEY || !MEXC_API_SECRET) {
    return res.status(500).json({ error: 'ключи MEXC не заданы на сервере' });
  }

  const timestamp = Date.now();
  const queryString = `timestamp=${timestamp}`;
  const signature = crypto.createHmac('sha256', MEXC_API_SECRET).update(queryString).digest('hex');

  try {
    const r = await fetch(`https://api.mexc.com/api/v3/capital/config/getall?${queryString}&signature=${signature}`, {
      headers: { 'X-MEXC-APIKEY': MEXC_API_KEY }
    });
    const rawText = await r.text();
    let data;
    try { data = JSON.parse(rawText); }
    catch (e) {
      return res.status(502).json({ error: 'MEXC ответил не JSON — вероятно, блокировка по региону', raw_response_preview: rawText.slice(0, 300) });
    }
    if (!Array.isArray(data)) return res.status(400).json({ error: 'MEXC отклонил запрос', detail: data.msg || JSON.stringify(data).slice(0,200) });
    const row = data.find(c => (c.coin || '').toUpperCase() === coin);
    if (!row) return res.json({ coin, dep: false, wd: false, note: 'монета не найдена на MEXC' });
    const nets = row.networkList || [];
    const dep = nets.some(n => n.depositEnable);
    const wd = nets.some(n => n.withdrawEnable);
    res.json({ coin, dep, wd });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
