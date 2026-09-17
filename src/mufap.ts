// Shared HTTP fetch for MUFAP's server-rendered pages (Fund Directory,
// IndustryStatDaily tabs). Everything that talks to MUFAP goes through here so
// the Cloudflare workaround lives in one place.
//
// MUFAP sits behind Cloudflare's managed-challenge bot protection: a plain
// fetch() gets a 403 with `cf-mitigated: challenge` and never sees the page.
// got-scraping impersonates a real browser's TLS fingerprint and header order,
// which Cloudflare mostly waves through — no headless browser, no clearance
// cookies, no configuration.
//
// Which browser it impersonates matters a lot, though. Measured Sep 2026
// against the Fund Directory:
//
//   network                     chrome   firefox   safari
//   residential (PTCL, PK)       6/10     10/10    10/10
//   GitHub runners (AS8075) *    0/32     14/32     0/32
//
//   * ubuntu-latest, ubuntu-24.04-arm, macos-latest and windows-latest all
//     egress from Microsoft IP space and all scored the same.
//
// Identical headers pass and fail, so it's most likely the TLS fingerprint
// Cloudflare scores: Node can't reproduce Chrome's BoringSSL handshake, and
// from a datacenter IP only the Firefox impersonation survives. got-scraping's
// default header generator leans Chrome, which is why the GitHub Actions
// dataset job went from flaky to failing every attempt. So the generator is
// pinned to Firefox, desktop only. (Safari also passes from a home
// connection, but pinning both would halve the runners' odds per attempt.)
import { gotScraping } from 'got-scraping'

const MAX_ATTEMPTS = Math.max(1, Number(process.env.SCRAPE_ATTEMPTS) || 5)
const REQUEST_TIMEOUT_MS = Math.max(1000, Number(process.env.SCRAPE_TIMEOUT_MS) || 60000)

const HEADER_GENERATOR_OPTIONS = {
  browsers: ['firefox'],
  devices: ['desktop'],
  operatingSystems: ['macos', 'windows'],
  locales: ['en-US'],
}

export class MufapFetchError extends Error {}

// Fetch a MUFAP page, retrying past the occasional Cloudflare challenge.
// Only markup that actually contains fund rows counts as a success; a 200
// that is really a "Just a moment…" challenge page is treated as a miss and
// retried. got-scraping draws a fresh fingerprint on every attempt, so a
// retry is a genuinely different-looking client, not the same one again.
export async function fetchMufapHtml(url: string, what: string): Promise<string> {
  let lastError: unknown
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    // Back off between attempts — challenges resolve far more often with a
    // pause than with an immediate hammer from the same IP.
    if (attempt > 1) await new Promise(r => setTimeout(r, attempt * 5000))
    try {
      const res = await gotScraping({
        url,
        timeout: { request: REQUEST_TIMEOUT_MS },
        retry: { limit: 0 },
        headerGeneratorOptions: HEADER_GENERATOR_OPTIONS,
      })
      // Log which impersonated browser each attempt used, so run logs show
      // what Cloudflare is and isn't letting through from a given network.
      const ua = String(res.request.options.headers['user-agent'] ?? '')
      const family = /Firefox/.test(ua) ? 'firefox' : /Safari/.test(ua) ? 'safari' : 'other'
      if (res.statusCode === 200 && res.body.includes('fund-block')) {
        console.log(`  fetched ${what} on attempt ${attempt}/${MAX_ATTEMPTS} as ${family}`)
        return res.body
      }
      console.log(`  ${what}: attempt ${attempt}/${MAX_ATTEMPTS} as ${family} got HTTP ${res.statusCode} without fund data`)
      lastError = new MufapFetchError(
        `MUFAP returned HTTP ${res.statusCode} without fund data (likely a Cloudflare challenge)`
      )
    } catch (err) {
      console.log(`  ${what}: attempt ${attempt}/${MAX_ATTEMPTS} threw ${err instanceof Error ? err.message : err}`)
      lastError = err
    }
  }
  const detail = lastError instanceof Error ? lastError.message : String(lastError)
  throw new MufapFetchError(`MUFAP ${what} fetch failed after ${MAX_ATTEMPTS} attempts: ${detail}`)
}
