# pakistan-mutual-funds-mcp

MCP server for Pakistani mutual fund data: current NAVs, daily NAV history
and trailing returns for ~550 funds, sourced from MUFAP and updated every
business day.

Zero setup: by default it reads the free public
[pakistan-mutual-funds-data](https://github.com/saadsalmankhan/pakistan-mutual-funds-data)
dataset. No API key, no server to run.

## What you can ask

- What is the latest NAV for [fund name]?
- Show me the 1 year return on [fund].
- List all money market funds, or all Shariah compliant funds.
- Which AMCs have an income fund, and how do their returns compare?

## Requirements

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

## Use with ChatGPT

This server runs locally over stdio, and ChatGPT's custom connectors only load remote MCP servers
reachable at a public URL, so it cannot launch the local `npx` command the way Claude does. To use
it in ChatGPT you would first host it as a remote (HTTP transport) endpoint, then add that URL under
Settings, Connectors, Developer mode. Until a hosted URL exists, use Claude above.

## Tools

| Tool | What it does |
|---|---|
| `list_funds` | List/filter funds by category, AMC, name substring, Shariah compliance |
| `get_fund` | Full record for one fund: NAV, offer price, benchmark, expense ratio, inception |
| `get_nav_history` | Daily NAV series with optional date bounds and weekly/monthly thinning |
| `get_returns` | Trailing 1m/3m/YTD/1y + sinceTracking returns (simple NAV change, not annualized) |
| `get_filters` | All distinct categories and AMC names |

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

## Data notes

- NAVs are scraped from MUFAP's public pages once per business day; history
  dates are Asia/Karachi scrape dates.
- Returns are simple NAV percentage change: not annualized, payouts and
  dividends not accounted for.
- Informational use only, not financial advice. Verify against MUFAP before
  making decisions. Not affiliated with MUFAP.

## Troubleshooting

- **`command not found: npx`** install Node.js 18+.
- **Tools do not appear in Claude Desktop** fully quit and relaunch (not just close the window),
  and check the JSON is valid, a stray comma breaks it.
- **First call is slow** the first `npx` run fetches the package, quick after that.
- **Nothing returns for a fund** try a shorter name substring, matching is loose.

Built by [Saad Salman](https://saadsalman.org). MIT.
