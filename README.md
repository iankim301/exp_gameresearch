# Game Signal Desk — OpenAI web search

Anthropic Messages API calls were replaced with an OpenAI Responses API request that enables the `web_search` tool. The API key stays on the local server; it is never sent to the browser.

## Easiest way to run

Install Node.js first, then double-click `start.bat`, paste your OpenAI API key, and press Enter. Keep the black window open and open `http://localhost:3001` in Chrome or Edge.

## Run from PowerShell

```powershell
cd "C:\Users\twoianside\Documents\Codex\2026-07-15\new-chat\outputs\game-signal-desk-openai"
$env:OPENAI_API_KEY = "sk-..."
node server.mjs
```

Open http://localhost:3000 in a browser. Set `OPENAI_MODEL` to a Responses API model that supports web search if you do not want to use the default `gpt-5.4-mini`.
