# Edgeview

Live charts for any market, a watchlist robot that spots the start of a move, and multi-timeframe trade plans from Claude built from live candles (Twelve Data or Binance), the live economic calendar and headlines (Finnhub).

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

## Two entries (scaling in) - v17
The Final trade plan can now have **Entry 2**: a second, deeper limit order in the same direction (lower for a buy, higher for a sell), with one shared stop beyond it, a split of the position (for example 40% / 60%) and the **Average entry** with its R:R. It is only used when a real second level exists, otherwise it says NONE. Limit orders in the Scalp, Intraday, Swing and weekly sections can carry a second limit too. The Position size tool has Entry 2 and "% of risk on Entry 1" fields and fills them from the plan: it splits the same total risk across both entries, so risk is never doubled. The Telegram copy and the plan image include Entry 2.

## Fill odds (v18)
Under each Analyze result Edgeview now simulates the plan: it resamples the pair's last ~300 hourly bars (mirrored at random, so there is no built-in direction) over thousands of paths and reports the chance Entry 1 fills, the chance Entry 2 fills, the chance only Entry 1 fills, TP1 before stop, the chance both entries fill and the stop is hit, and the expected value of the two-entry plan against a single entry. Orders can fill until "Valid until"; filled trades are followed for a longer window. It also shows Claude's own probability beside the simulated one. It is a volatility-only baseline, not a forecast, and it needs hourly candles (Twelve Data key, or a crypto pair). Not shown when a saved plan is reopened from History.

## Knowing your pairs (v19)
Edgeview now adds an **instrument background** to every analysis (Analyze and Weekend) for gold, USD, JPY, EUR, GBP, CHF, AUD, CAD and ZAR pairs, for example XAU/USD, USD/JPY, EUR/JPY, CHF/JPY, GBP/JPY, AUD/JPY, GBP/USD, EUR/USD, USD/ZAR, AUD/USD and USD/CAD. It describes what drives each currency, the sessions and data times that matter, and pair notes (JPY intervention risk, ZAR liquidity and spreads, gold and real yields). Claude checks it against the live data and news and is told not to present it as current news.

It also adds your **track record** for the pair from the journal: closed trades, win rate, average stated probability, and win rates by direction and by session. With 15 or more closed trades on a pair Claude may move its probability by up to 5 points toward your real hit rate; with fewer it says the sample is too small. Close your trades in History & journal (win/loss) so this works.

The position size tool's default "$ per 1.0 move / lot" values for JPY, ZAR, CAD and CHF pairs are rough; edit the field to match your broker.

## Twelve Data plan (v20)
Settings has a **Twelve Data plan** choice. Free (the default) skips the dollar index and US10Y series, which free plans usually do not include, so each analysis uses 5 calls instead of 7 and no error is shown for them. Choose Paid if your plan includes them.

## Empty responses (v21)
If Deep mode returns no text (for example when the thinking uses up the token budget), Edgeview now retries once in Standard mode automatically. If that also returns nothing, the error shows the stop reason instead of a generic message.

## Diagnosing a failed analysis (v22)
Settings has a **Test Claude connection** button that sends a tiny text-only request and shows the model's reply or the exact error. An "Empty response" error now includes the model, HTTP status, stop reason, events received and the request id.

## Thinking and token budget (v23)
Some newer models think by default and can spend the whole token allowance on thinking, leaving no text. Standard mode now switches thinking off explicitly and allows 12,000 output tokens; Deep mode allows 24,000 with an 8,000-token thinking budget. If the API rejects the thinking setting, Edgeview retries without it.

## Telegram result posts and recaps (v25)
In History & journal, every closed or skipped plan has a **Post result** button that copies a ready Telegram message: TP1 hit with the result in R, stopped out at -1R, or not taken (expired). The journal also has **Copy 7-day recap** and **Copy 30-day recap**: closed trades, wins and losses, win rate, total and average R, results by pair, and stated probability against the real win rate. Every closed trade in the period is counted, so the recap cannot be cherry-picked. R is measured from Entry 1 to TP1 or the stop, without fees or slippage. Mark each trade Win, Loss or Skipped in the journal for this to work.

## Long answers (v26)
If an answer reaches the token limit (common with 8 to 10 charts), Edgeview now asks the model to continue where it stopped, up to twice, and joins the parts into one result. The limits are 16,000 output tokens in Standard and 32,000 in Deep, and with more than 6 charts Claude is asked to keep each section brief. A continuation sends the screenshots again, so it costs a little more.

## Gold take-profit ladder (v27)
For gold (XAU/USD), the Final trade plan now has 5 take-profits (6 when there is room for a runner) instead of 2, each with its R:R and the share of the position to close there, for example 25 / 20 / 20 / 15 / 10 / 10 percent. The targets sit at real levels in increasing distance, the blended R:R must still be at least 1:1.5, and Management says where the stop moves after TP1 and TP2. Every other pair keeps TP1 and TP2. The Telegram copy lists every target, and the plan image shows TP3 and beyond on one line. The weekly gold limit orders get five targets too. Fill odds and the Result post still use TP1 only.

## Target record (v28)
Gold plans with a take-profit ladder are saved with their targets and the share to close at each. In History & journal, a gold plan shows **Stopped, TP1, TP2 ... TP6** buttons instead of Win and Loss: tap the highest target the trade reached (or Stopped). The journal then works out the result in R from the partials taken, assuming the rest of the position closed at break-even, and shows it on the entry. Stopped counts as -1R, and any target reached counts as a win for the calibration report. Result posts say which targets were hit with the partials, the 7-day and 30-day recaps add a "reached TP1 ... TP6" line, and the CSV export has two new columns, targets_hit and result_R. Plans from before v28 keep the old Win and Loss buttons.

## Accuracy upgrade (v30)
- **Exact live prices.** Prices keep their real decimals (5 for most forex, 3 for JPY pairs, 2 for gold and BTC). Before this, the live quote was rounded to 2 decimals, so EUR/USD at 1.08347 reached Claude as 1.08.
- **Honest probabilities.** Each order's probability now starts from the no-edge baseline for its reward:risk, 100 / (1 + R:R): 40% at 1:1.5, 33% at 1:2, 25% at 1:3. It used to start at 50% whatever the target. Anything above the baseline is edge Claude has to justify.
- **More candles, same cost.** 1,000 candles per timeframe instead of 300 (Twelve Data still charges one credit per call), so the EMA 200 has had time to settle and matches your charts. Indicators use closed candles only; the forming candle is left out.
- **Weekly view and key zones.** Weekly candles are built from the daily data (no extra API call). Swing levels from 15M to 1W are merged into zones, with a strength score (more weight for higher timeframes) and a count of how often price traded there.
- **Spread.** Each pair has an optional "typical spread" field. Claude is told about it, and the plan check shows R:R and expected value after the spread.
- **Plan check.** Under each result, the app recomputes the plan in code and flags limit orders on the wrong side of the price, stops or targets on the wrong side, a stated R:R that doesn't match the prices, R:R below 1:1.5 (blended across the ladder for gold), Entry 2 too close, stops tighter than 0.3 × the 1H ATR, expiry times already past, and zero or negative expected value. It also shows how far the stated probability is above the no-edge baseline.
- **Results from the candles.** Open plans are checked against hourly candles when you open History & journal, or when you tap "Check results now". A plan that never reached its entry before "Valid until" becomes Skipped. Otherwise, TP1 before the stop is a win and the stop is a loss; for gold ladders it records the highest target reached, then break-even. The check is cautious: an hour that touches both the stop and a target counts as the stop. Your own Win, Loss and Skipped buttons always override it. It needs a Twelve Data key, or a crypto pair without one, and checks up to 6 symbols per run.
- **Adjusted probability.** After 30 closed trades, the plan check also shows the probability adjusted for your real hit rate. The adjustment is scaled down while the sample is small.

## Open exposure and live calendar (v31)
- **Your open trades are taken into account.** Each analysis now includes the plans in your journal that are still live: filled trades, plus pending orders that haven't expired. It also shows your net exposure per currency, in units of one trade's risk. For example, buying EUR/USD, GBP/USD and gold together is USD -3, which is really one bet against the dollar. Claude halves the suggested risk when a plan adds to a currency you're already 2 units long or short in, prefers NO TRADE at 3 units, and flags a plan that goes against an open position on the same pair. The plan check shows the same thing in numbers. Mark trades as closed (or let the candle check do it) so this stays accurate.
- **Live economic calendar.** Edgeview reads this week's ForexFactory calendar feed (medium and high impact, for the pair's currencies; gold and crypto use USD), with times converted to UTC and the forecast and previous values. The feed is cached for an hour to stay within its limits. The feed has no actual results, so screenshots and headlines still supply those. The plan check warns when a high-impact release falls before an order's "Valid until". If the browser can't reach the feed, the "Live data used" card says so and the screenshots work as before.

## No screenshots needed (v32)
- **Type what you want.** Write the instrument in plain words: "gold", "eurusd", "bitcoin", "cable" or "USD/JPY" all work. Leave the chart box empty and tap Analyze. Screenshots are still accepted and still used when you add them.
- **The app reads the charts itself.** It pulls live candles for 1W, 1D, 4H, 1H, 15M and 5M. For each timeframe, Claude gets an exact candle table plus a market-structure summary worked out in code:
  - higher or lower highs and lows (equal highs and lows marked)
  - breaks of structure and changes of character
  - open fair value gaps
  - Fibonacci levels of the last leg
  - the pattern of the last closed candle

  Every price is exact, which is more accurate than reading levels off a screenshot.
- **App-drawn charts.** When a pair has no screenshots, the app also draws 1D, 4H, 1H and 15M charts (candles, EMA 20/50/200, key zones, live price) and sends them to Claude, so it can see the shape of the market as well. You can switch this off on the Analyze page to save cost.
- **Live chart.** Open "📈 Live chart" on the Analyze page for a chart drawn inside the app (5M to 1W, zoom, drag back in time). It shows the key zones and, after an analysis, the entry, stop and targets. Each result card has a **Chart** button. It refreshes every 90 seconds while open.
- With a Twelve Data key each analysis now uses 6 calls (5-minute candles were added). Pairs 2 and 3 are still spaced a minute apart for the free plan. Gold and forex need the key; crypto works without one.

## Robot, watchlist and a new design (v33)
- **No screenshots.** The upload boxes are gone. Every analysis is built from live candles, the market structure worked out in code, the charts the app draws, the live calendar and headlines.
- **Chart for any market.** The app opens on the Chart. Tap the market name (🔍) to search: type gold, GBPJPY, bitcoin or any symbol Twelve Data lists. Your watchlist runs along the top as a ticker; tap a pair to open its chart. "Analyze this market" runs a full analysis of what you are looking at.
- **Auto-trader (paper).** Every analysis that ends in BUY or SELL becomes a paper trade. The robot follows it on 5-minute candles: it waits for the entry, then records the stop, each target or expiry, alerts you when it fills or closes, and writes the result into the journal. Fills, exits and early-move signals are marked on the chart. The Robot page shows equity, net R, win rate and an equity curve from a paper balance and risk you choose. No real orders are sent.
- **Watchlist scanner.** Add up to 12 pairs. At each session open (Sydney, Tokyo, London and New York, adjusted for daylight saving) Claude Haiku screens every pair and alerts you when it sees a possible trade, with the trigger and invalidation. Between opens, each closed 15-minute and 1-hour candle is checked in code (`detect.js`) for the start of a move: a stop sweep that reverses, a change of character, a volatility squeeze breaking out, or a momentum candle. Signals are scored with the higher-timeframe trend, nearby key levels and how far price has already gone; strong ones are confirmed by Haiku before you are alerted. Alerts appear under the bell and, if you allow it, as phone notifications.
- **Alerts when the app is closed.** `.github/workflows/scanner.yml` runs `scanner/scan.mjs` every hour on GitHub Actions (free on public repositories) and sends the same alerts to Telegram. Add the repository secrets `ANTHROPIC_API_KEY`, `TWELVE_DATA_KEY`, `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID`, then send your watchlist from the Robot page (it needs a fine-grained GitHub token with Contents read and write on this repository, saved in Settings). The watchlist lives in `watchlist.json`. GitHub may start scheduled runs a few minutes late, and pauses schedules on repositories with no activity for 60 days.
- **Twelve Data credits.** The app counts credits used today and the robot slows down before the free limit (800 a day, 8 a minute). Each watchlist scan uses one credit per pair every 15 minutes plus one per pair each hour; crypto uses Binance and costs nothing.
- **Design.** A new graphite and brass interface: bottom tabs on phones (Chart, Analyze, Robot, Journal, More), a side rail on wide screens, a price header with today's change, and a search sheet.

## Learning from every trade (v34)
Claude does not change between calls, so the app does the learning: it records every setup and every result, works out what has been working, and sends that evidence with the next analysis.
- **Setup fingerprint.** Every plan is saved with a fingerprint worked out in code: the 1D/4H/1H trend and how many of them agree with the trade, against-the-daily-trend, 4H EMA stack, RSI relative to the trade, volatility regime (daily ATR percentile), session, R:R, stop size and entry distance in 1H ATR, the strength of the key zone at the entry, and whether high-impact news falls inside the order window. Claude also names the **Setup type** (trend pullback, breakout retest, range fade, liquidity sweep reversal, momentum continuation, news reaction) and lists the **Edge factors** behind its probability.
- **How trades behaved.** The robot and the candle check now record how far each trade went for you (MFE) and against you (MAE) in R, minutes to fill, minutes held, and how close an unfilled order came to its entry.
- **Learning block.** Every analysis receives a summary of your resolved paper trades: win rate by setup, regime, session, timeframe agreement, stop size, zone and news, each against the no-edge baseline for its R:R and shrunk toward zero for small samples; trade-behaviour findings (losers that were +1R first, how deep winners went against you, unfilled orders); how similar past buys and sells did in conditions like now; and the most relevant lessons. Claude may only move a probability for patterns with 20 or more trades, and must show every adjustment in Edge factors.
- **Post-trade reviews.** When a robot trade closes, Claude Haiku compares the plan with the candles and writes one tagged lesson (about $0.002 each, can be switched off). "Review closed trades now" in the Journal reviews older closed trades that have a fingerprint.
- **Learned probability.** The plan check shows a probability worked out from your most similar resolved trades next to Claude's, and flags gaps of 10 points or more once there are 20 similar trades.
- **Journal.** A "What the robot has learned" card shows the tables, the behaviour findings and the lessons. The CSV export has new columns for the fingerprint and MFE/MAE.

Trades from before v34 have no fingerprint, so the learning starts with new analyses. The tables appear after 5 resolved trades and become meaningful from about 20 to 30.
- **Shadow trades.** The Scalp, Intraday and Swing limit orders in every analysis are also followed on paper as "shadow" trades (duplicates of the final plan are dropped). They never touch the robot's balance, but they go into the learning tables, so each analysis teaches the robot three or four times over. They are resolved with candles the robot already fetched where possible, otherwise with one hourly call per pair at most every 30 minutes.
- **Signal follow-through.** Every early-move signal is now scored once its window has passed: did price go 1 ATR with the signal before 1 ATR against it (16 bars on 15M, 12 on 1H)? The Robot page shows the follow-through rate by signal type, score and trend. Each alert quotes the record of its signal type, Haiku sees it when confirming, and a signal type with 20 or more results and under 40% follow-through needs 15 more points of score before it can alert you. The background scanner keeps its own record the same way (in its cache) and applies the same rule to Telegram alerts.
- **Encrypted backup and sync.** In Settings, add a backup passphrase and turn on automatic backup. The journal, lessons, shadow trades and signal record are compressed, encrypted in the browser (AES-256-GCM, key from the passphrase with PBKDF2) and saved to `edgeview-sync.json` on a separate `edgeview-data` branch of your repository, so GitHub Pages is not rebuilt and the file is unreadable without the passphrase. It backs up when something changed, at most every 10 minutes. Open the app on another device with the same token and passphrase and tap "Restore from backup" (or turn on automatic backup) to share one memory: records are merged by id, and a settled result always wins over an open one. If you lose the passphrase the backup cannot be recovered.

## Trader's toolkit, strength, risk rules and backtests (v35)
Every level an experienced trader marks by hand is now worked out in code (`ta.js`) and sent with each analysis, so Claude never has to estimate it from a chart.
- **Session and liquidity levels.** Today's Asia range (00:00-07:00 UTC), the London and New York opening ranges (first hour, daylight saving handled), the New York midnight open, previous day, week and month highs and lows, this week's open, and untouched equal highs and lows on 1H. Each says whether it has been taken since. Claude is told to keep stops beyond these levels, use them as targets, and treat a sweep that closes back inside as a liquidity sweep reversal.
- **Divergence, order blocks, extensions, premium and discount.** For 4H, 1H and 15M: regular and hidden RSI divergence on the last two swings, unmitigated order blocks (the last opposite candle before a displacement of 1.5 ATR or more that broke structure), Fibonacci extensions (1.272, 1.618, 2.0) of the last leg for targets, and where price sits in the dealing range.
- **Trend strength.** ADX with +DI and -DI and the efficiency ratio classify each timeframe as trending, ranging or in transition. Claude favours pullbacks in trends and fades in ranges, and the 1H regime is part of the setup fingerprint, so the learning tables show which setups work in which conditions.
- **VWAP and volume.** Session VWAP from 00:00 UTC and VWAP anchored at the last major swing high and low (labelled TWAP for forex and gold, which have no real volume). For crypto: a 7-day volume profile (point of control and value area) and the Binance order book (biggest bid and ask walls within 2%, and the balance within 1%).
- **Currency strength and intermarket.** Each currency's average move against the other majors over 4H, 1D and 5D, the strength gap for the pair being analyzed, and gold, silver, WTI oil and the S&P 500 (SPY) with the gold/silver ratio. Refreshed in the background about once an hour while the app is in use (about 11 Twelve Data credits an hour, spaced to respect the free plan's 8 a minute). It can be switched off on the Analyze page.
- **Risk rules for the robot.** A daily loss limit in R (default 3R), half size after a losing streak (default 3 losses) until the next win, and a cap on open trades (default 4), set on the Robot page. When a limit is reached the plan is still saved but the robot does not take it, and you get an alert. Claude is told the robot's risk state in every analysis. The plan check also suggests a size from your measured edge on similar trades (a quarter of the Kelly fraction, capped at 1%).
- **Trade management test.** From how far each closed trade went for and against you, the journal compares rules: as planned, stop to break-even at +1R, half off at +1R, a 30% tighter stop, and take profit at +1R. The best one is sent to Claude so it can adjust Management.
- **Backtests.** On the Robot page, replay the early-move detector over about 7 months of 1H candles or 2 months of 15M candles (2 Twelve Data credits; crypto is free), one closed candle at a time with no look-ahead. Each signal is scored for follow-through and as a simple trade (stop at the signal's stop idea, target 2R). Results are shown by signal type, score, regime, session and trend, and they join the live signal record that decides which alerts are strong enough to send. On a random walk the detector scores about 50% follow-through and about 0R, which is the check that there is no look-ahead.

## Broker costs: XM (v36)
Settings now has a **Broker** choice (XM by default) with the account type: Standard or Micro, Ultra Low, or Zero.
- **Default spreads.** EUR/USD, GBP/USD, USD/JPY and gold use XM's published figures (Standard 1.7, 2.4 and 1.6 pips, gold 0.35; Ultra Low 0.8, 1.1, 0.8 and 0.25; Zero 0.1, 0.3, 0.1 and 0.21 plus $3.50 per lot per side). Every other pair uses a rough estimate, marked with *. For accuracy, enter your own spreads from the Spread column in MT5, for example `XAU/USD=0.30, GBP/JPY=0.035`. Overrides are in price units and always win.
- **Plans.** If a pair's spread field is empty, the broker cost is used automatically, so Claude and the plan check work with R:R after costs.
- **Paper results.** The candle data is a mid price. The robot, the candle check and shadow trades now fill a buy limit only when the ask reaches it and close at the bid (and the reverse for sells), using half the spread each side. Commission and the half spread paid on market orders are taken off the result in R. The journal, recaps, calibration and learning tables all use these net results. Plans saved before v36 have no cost attached and keep their old results.
- **Backtests.** Each simulated 2R trade has the round-trip spread and commission taken off.
Spreads widen around news, at the 21:00-23:00 UTC rollover and on Monday opens, so real costs can be higher than these typical values.
- **Account currency (v36.1).** Settings has an account currency (rand by default, or USD, EUR, GBP). Paper balance, robot equity, the position-size tool and Claude's Risk line all use it. The value of a 1.0 move per lot is worked out from live exchange rates: USD/ZAR from Twelve Data (or the free open.er-api.com rates when there is no key), refreshed every 6 hours, plus the majors from the currency-strength data for crosses. You can type your own USD/ZAR rate instead. For example, at 17.65 one lot of gold is about ZAR 1,765 per $1 move and one lot of EUR/USD about ZAR 176.50 per pip. On an XM Micro account lots are 100 times smaller.
