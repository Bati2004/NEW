const express = require('express');
const app = express();
const PORT = process.env.PORT || 3000;
const CMC_API_KEY = process.env.CMC_API_KEY;

app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET');
  next();
});

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
      // отдаём настоящую причину от CMC, а не просто код ошибки
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

app.get('/', (req, res) => res.send('Crypto arbitrage proxy server работает.'));

app.get('/api/key-check', (req, res) => {
  res.json({
    key_present: Boolean(CMC_API_KEY),
    key_length: CMC_API_KEY ? CMC_API_KEY.length : 0,
    key_preview: CMC_API_KEY ? CMC_API_KEY.slice(0, 4) + '...' + CMC_API_KEY.slice(-4) : null
  });
});

app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
