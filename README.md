# Creative Dashboard

Live ad creative performance dashboard for Loudr Media, sourced directly from the
**Ad_Creative_Tracker** Google Sheet (`Creative Tracker 1` tab).

No database, no build step, no external API keys — the server polls the sheet's public
CSV export every 15 seconds and pushes changes to connected browsers over Server-Sent
Events, so the dashboard updates within seconds of an edit to the spreadsheet.

## Requirements

The source sheet must stay shared as **"Anyone with the link can view"** — the server
reads it via Google's CSV export endpoint, which needs no service account or API key.

## Run locally

```bash
node server.js
# → http://localhost:4174
```

## Deploy on Render

1. Push this repo to GitHub.
2. In Render: **New → Web Service → Connect this repo.**
3. Render reads `render.yaml` automatically — no environment variables or build
   command to set by hand. Runtime: Node, plan: free, start command: `node server.js`.
4. Once deployed, the dashboard is live at `https://<your-service-name>.onrender.com`.

## What it shows

- Total spend / revenue / profit / blended ROAS / win rate across all creatives
- Google vs. Meta platform split
- Top 10 performers and 10 biggest losses, ranked by profit
- A searchable, sortable, platform-filterable table of every creative

## Files

- `server.js` — zero-dependency Node HTTP server: polls the sheet, serves `/api/data`
  (JSON snapshot) and `/api/events` (SSE change notifications), and serves `public/`.
- `public/` — the frontend: `index.html`, `style.css`, `app.js`.
