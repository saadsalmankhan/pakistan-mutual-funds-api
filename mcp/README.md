# pakistan-mutual-funds-mcp

MCP server for Pakistani mutual fund data: current NAVs, daily NAV history
and trailing returns for ~550 funds, sourced from MUFAP and updated every
business day.

Zero setup: by default it reads the free public
[pakistan-mutual-funds-data](https://github.com/saadsalmankhan/pakistan-mutual-funds-data)
dataset. No API key, no server to run.

There are two ways to use it:

- **Hosted connector** for claude.ai, the Claude apps and ChatGPT. Nothing to install, you paste one URL:
  `https://funds.saadsalman.org/mcp`
- **Local server** for Claude Code, Claude Desktop and any other client that launches stdio servers:
  `npx -y pakistan-mutual-funds-mcp`

## What you can ask

- What is the latest NAV for [fund name]?
- Show me the 1 year return on [fund], and did it beat the KSE-100?
- Which equity funds beat the market over 3 years after fees?
- Which asset managers earn their fees, and which don't?
- List all money market funds, or all Shariah compliant funds.
- Which AMCs have an income fund, and how do their returns compare?

## Hosted connector (Claude and ChatGPT)

The connector URL is `https://funds.saadsalman.org/mcp`. It needs no login. Open
[funds.saadsalman.org](https://funds.saadsalman.org) for the same steps on one page.

**Claude** (web, desktop and mobile, every plan; the free plan allows one custom connector)

1. Open Customize, then Connectors. Click + and choose Add custom connector.
2. Name it Pakistan Mutual Funds, paste the URL and click Add. Skip the advanced settings.
3. In a chat, click + at the lower left, open Connectors and switch it on.

**Claude Code**

```bash
claude mcp add --transport http pakistan-mutual-funds https://funds.saadsalman.org/mcp
```

**ChatGPT** (web; Plus, Pro, Business, Enterprise or Education)

1. Open Settings, then Security and login and turn on Developer mode.
2. Go to Plugins, click the plus button and create an app for a remote MCP server. Paste the URL and
   pick No Authentication.
3. In a new chat, choose Developer mode from the plus menu and select the app.

Both apps move these menus around. If the steps look off, check
[Claude's guide](https://support.claude.com/en/articles/11175166-get-started-with-custom-connectors-using-remote-mcp)
or [OpenAI's developer mode guide](https://developers.openai.com/api/docs/guides/developer-mode).

The hosted connector also exposes `search` and `fetch`, the pair ChatGPT requires for deep research.

## Local server: requirements

Node.js 18 or newer (that gives you `npx`). Check with `node -v`. Sanity-check the server with
`npx -y pakistan-mutual-funds-mcp`, it should start and wait quietly (Ctrl+C to exit).

## Use with Claude Code

```bash
claude mcp add pakistan-mutual-funds -- npx -y pakistan-mutual-funds-mcp
```

Add `-s user` to make it available across all your projects. Start a session and the fund tools
are there.

## Use with Claude Desktop

Add the server to your config, then fully quit and reopen the app:

- macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`
- Windows: `%APPDATA%\Claude\claude_desktop_config.json`

```json
{
  "mcpServers": {
    "pakistan-mutual-funds": {
      "command": "npx",
      "args": ["-y", "pakistan-mutual-funds-mcp"]
    }
  }
}
```

The same block works in any other MCP client that launches stdio servers.

## Tools

| Tool | What it does |
|---|---|
| `list_funds` | List/filter funds by category, AMC, name substring, Shariah compliance |
| `get_fund` | Full record for one fund: NAV, offer price, benchmark, expense ratio, inception |
| `get_nav_history` | Daily NAV series with optional date bounds and weekly/monthly thinning |
| `get_returns` | Trailing total returns (1m to 3y, payouts reinvested) next to the fund's benchmark index and the gap between them |
| `get_performance` | Who beat the market after fees: funds (or asset managers) ranked by return in excess of KSE-100 / KMI-30, with a summary of how many beat it |
| `get_filters` | All distinct categories and AMC names |
| `search`, `fetch` | Hosted connector only: free-text fund search and a full fund report, in the shape ChatGPT deep research expects |

## Self-hosted mode

Running your own [pakistan-mutual-funds-api](https://github.com/saadsalmankhan/pakistan-mutual-funds-api)
instance? Point the server at it:

```json
{
  "mcpServers": {
    "pakistan-mutual-funds": {
      "command": "npx",
      "args": ["-y", "pakistan-mutual-funds-mcp"],
      "env": { "API_BASE_URL": "http://localhost:4000" }
    }
  }
}
```

Hosting a fork or mirror of the dataset instead? Set `DATASET_BASE_URL` to its
raw file base URL.

## Data notes

- NAVs are scraped from MUFAP's public pages once per business day; history
  dates are MUFAP's own NAV validity dates.
- Returns are total returns: NAV change with every payout reinvested at the
  ex-NAV, net of fund fees, cumulative and not annualized. They match MUFAP's
  own payout-adjusted figures within 1 percentage point at 1 and 2 years for
  every equity fund checked.
- Benchmarks are KSE-100 (conventional equity) and KMI-30 (Shariah equity),
  both total-return indices, measured over the same dates as the fund.
- League tables leave out funds that closed or merged (they vanish from
  MUFAP), which flatters the share of funds beating the index.
- Informational use only, not financial advice. Verify against MUFAP before
  making decisions. Not affiliated with MUFAP.

## Troubleshooting

- **`command not found: npx`** install Node.js 18+.
- **Tools do not appear in Claude Desktop** fully quit and relaunch (not just close the window),
  and check the JSON is valid, a stray comma breaks it.
- **First call is slow** the first `npx` run fetches the package, quick after that.
- **Nothing returns for a fund** try a shorter name substring, matching is loose.

## Host your own connector

The hosted connector is [`worker.js`](worker.js), a stateless Cloudflare Worker that serves the same
server over Streamable HTTP. It fits the free Workers plan. From a clone of this directory:

```bash
npm install
npm run dev                  # http://localhost:8787/mcp
npm run test:remote          # smoke test every tool against the local Worker
npx wrangler login           # once
npm run deploy
```

Delete the `routes` entry in [`wrangler.jsonc`](wrangler.jsonc) first and you get a free `*.workers.dev` URL,
or point it at a hostname on your own Cloudflare zone.

Built by [Saad Salman](https://saadsalman.org). MIT.
