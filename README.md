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

## Weekend engine
Open the menu (☰) and choose **Weekend engine**. Best run after the Friday close or on the weekend, when the market is closed. It reads the whole week from candles (day by day, weekly and previous-week stats, weekly and daily indicators, exact swing levels, weekly pivots, expected weekly range, average Monday gap, dollar index and yields, positioning, headlines) plus your weekly/daily/4H screenshots and next week's calendar screenshots. It returns a week review, scenarios with probabilities, a Monday open plan, buy and sell limit orders valid for the week, and a final weekly plan you can copy for Telegram. Gold and forex need a Twelve Data key for the exact numbers; crypto works without one (Binance). Saved plans appear in History & journal.

## Analyzing up to 3 pairs at once
On the **Analyze** page, Pair 1 is always shown and Pairs 2 and 3 are in collapsible sections. Each pair takes up to 10 charts (30 in total) and has its own symbol, market and optional price. The news/calendar screenshots are shared. Pairs are analyzed one after another, and each gets its own result card with its own Copy, Telegram, image-card and Position size buttons. With a Twelve Data key, data fetches for pairs 2 and 3 are spaced about a minute apart to respect the free limit (this overlaps with the analysis of the previous pair). When more than one pair is analyzed, the calendar screenshots are read once into text and shared, instead of being sent three times.

The **Weekend engine** also takes up to 3 pairs (6 charts each; extra pairs run only when they have charts). Next week's calendar screenshots are read once and shared, each pair gets its own outlook card with its own Telegram copy button, and the dollar and yield data is fetched once and reused. If you saved an outlook for the same symbol last week, Claude grades it against what actually happened.

## Institutional-grade context (v16)
- **Macro (FRED):** real 10Y yield, 10Y breakeven inflation, fed funds, 2s10s curve and VIX are added to every analysis. Works without a key; an optional FRED API key in Settings is used as a fallback. Cached 6 hours.
- **Volatility context:** ATR percentile (regime), realized volatility, average range by weekday and by session, and rolling correlation with the dollar index and US10Y (needs a Twelve Data key for DXY/US10Y).
- **Calibration report:** in History & journal, closed trades are grouped by stated probability and compared with the actual win rate, with a Brier score and an over/under-confidence verdict. Needs roughly 30 closed trades to mean anything.
- **Export and backup:** export the journal as CSV (opens in Excel/Sheets) or as a JSON backup; import a backup to merge it (duplicates are skipped).
- **Audit metadata:** each saved entry records the model, depth mode and app version. History keeps up to 400 entries (full text for the newest 40; older entries keep the numbers only).
- Any data source that fails (CORS, rate limit, plan limits) is listed in the "Live data used" card instead of failing silently.
