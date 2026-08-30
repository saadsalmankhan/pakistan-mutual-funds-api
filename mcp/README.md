# pakistan-mutual-funds-mcp

MCP server for Pakistani mutual fund data: current NAVs, daily NAV history
and trailing returns for ~550 funds, sourced from MUFAP and updated every
business day.

Zero setup: by default it reads the free public
[pakistan-mutual-funds-data](https://github.com/saadsalmankhan/pakistan-mutual-funds-data)
dataset. No API key, no server to run.

## Use with Claude

```bash
claude mcp add pakistan-mutual-funds -- npx -y pakistan-mutual-funds-mcp
```

Or in any MCP client config:

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

Built by [Saad Salman](https://saadsalman.org). MIT.
