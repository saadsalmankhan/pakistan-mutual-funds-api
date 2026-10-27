-- Usage analytics for the hosted connector (see usage.js for what each
-- column can and can't tell you). Apply with `npm run db:migrate`.
CREATE TABLE IF NOT EXISTS events (
  ts INTEGER NOT NULL,          -- unix ms
  day TEXT NOT NULL,            -- YYYY-MM-DD, UTC
  method TEXT NOT NULL,         -- JSON-RPC method: initialize, tools/call...
  tool TEXT,                    -- tool name, for tools/call
  client TEXT,                  -- client app from the initialize handshake
  client_version TEXT,
  ua TEXT,                      -- user-agent, truncated
  client_key TEXT,              -- salted hash of IP + user-agent, never the IP
  country TEXT,                 -- Cloudflare's country code for the caller
  status TEXT NOT NULL,         -- ok | tool_error | rpc_error | http_error | exception
  ms INTEGER,                   -- time to answer
  internal INTEGER NOT NULL DEFAULT 0  -- 1 = our own monitoring/smoke tests
);
CREATE INDEX IF NOT EXISTS events_day ON events(day);
