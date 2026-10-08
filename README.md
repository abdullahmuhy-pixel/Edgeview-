# Edgeview

Upload multi-timeframe chart screenshots and get a scalp, intraday and swing setup from Claude, using live price/indicators (Twelve Data) and headlines (Finnhub).

A single static page (`edgeview.html`). No server, no build step.

## Deploy on GitHub Pages
1. Create a new GitHub repo and upload all the files in this folder.
2. Repo **Settings > Pages**. Under **Build and deployment**, choose **Deploy from a branch**, branch `main`, folder `/ (root)`, then Save.
3. After a minute your app is live at `https://<your-username>.github.io/<repo-name>/edgeview.html`.

## Use
1. Open the page, expand **API keys**, paste your keys, tap **Save in this browser**.
   - Anthropic: console.anthropic.com
   - Twelve Data: twelvedata.com (free tier works, optional)
   - Finnhub: finnhub.io (free tier works, optional)
2. Enter the symbol in Twelve Data format (`XAU/USD`, `EUR/USD`, `BTC/USD`) and pick the market.
3. Add your charts, highest timeframe first (tap, drag, or paste). Up to 8. Optionally add screenshots of news or the economic calendar (for example from the Investing.com app), up to 6. Claude reads the events, forecasts and impact levels from them.
4. Add an optional note, then tap **Analyze**.

## Security
- Keys live only in your browser's localStorage and go straight to the three providers. Nothing is stored on GitHub.
- Anyone who opens the page on their own device must enter their own keys. Never hard-code keys into `edgeview.html`.
- Set a monthly spend limit on your Anthropic key in the console.
- Use a private repo or your own device if you prefer, but note GitHub Pages sites on free plans are public.

## Customize
The strategy lives in the `SYSTEM` constant near the top of the script in `edgeview.html`. Edit it to change the style, rules or output format.

Analysis only, not financial advice.

## Indicators
With a Twelve Data key, Edgeview fetches 1H, 4H and 1D candles (4 API calls per analysis, within the free limit) and calculates RSI, EMA 20/50/200, ATR, MACD, Bollinger Bands, Stochastic, recent highs/lows, yesterday's range and daily pivots. Without a key it still works from your screenshots alone: enter the current price in the optional field and it will rely on price action and any indicators visible on your charts.

For crypto, if no Twelve Data key is entered Edgeview automatically uses Binance's free public candle data (no key needed), e.g. symbol `BTC/USD`. Gold and forex need a Twelve Data key for live indicators.

## Install as an app
Open the live page once. Chrome/Android shows an **Install** button at the top of the page (or use the browser menu > Install app). On iPhone/iPad, tap Share > Add to Home Screen. Installing needs the page served over https, which GitHub Pages provides.

Files: `edgeview.html` (the app), `manifest.json`, `sw.js` (offline shell), and the three `icon-*.png` files. Keep them all in the same folder.
