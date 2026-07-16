/**
 * Daily planetary mood forecast bot.
 *
 * Reads the live API and composes a deadpan weather-forecaster post
 * (under 280 chars). With BSKY_HANDLE + BSKY_APP_PASSWORD set it posts
 * to Bluesky via the atproto XRPC endpoints; otherwise it prints the
 * composed post to stdout as a dry run.
 *
 * Env:
 *   API_URL            API base (default http://localhost:8787)
 *   SITE_URL           public link for the post's last line (default API_URL)
 *   BSKY_HANDLE        e.g. moodmap.bsky.social (optional)
 *   BSKY_APP_PASSWORD  Bluesky app password — Settings → App Passwords (optional)
 *
 * Usage: npx tsx scripts/forecast.ts
 * Exits non-zero on any API failure. Never prints the app password.
 */
import type { InsightsResponse, Mover, TrendsResponse } from '../shared/types';

const API_URL = (process.env.API_URL ?? 'http://localhost:8787').replace(/\/+$/, '');
const SITE_URL = (process.env.SITE_URL ?? API_URL).replace(/\/+$/, '');
const BSKY_HANDLE = process.env.BSKY_HANDLE;
const BSKY_APP_PASSWORD = process.env.BSKY_APP_PASSWORD;

const MAX_CHARS = 279;

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`GET ${url} → HTTP ${res.status}`);
  return (await res.json()) as T;
}

/** Global valence → current conditions, weather-forecaster deadpan. */
function conditions(valence: number): string {
  if (valence >= 0.3) return 'Sunny 😊';
  if (valence >= 0.1) return 'Fair 🙂';
  if (valence > -0.1) return 'Mixed 😐';
  if (valence > -0.3) return 'Overcast 😕';
  return 'Stormy 😰';
}

/** e.g. "Wed 16 Jul" — always UTC, the planet has no home timezone. */
function utcDay(t: number): string {
  const d = new Date(t);
  const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${days[d.getUTCDay()]} ${d.getUTCDate()} ${months[d.getUTCMonth()]}`;
}

function rate(countPerHour: number): string {
  if (countPerHour >= 1000) {
    const k = countPerHour / 1000;
    const s = k >= 10 ? String(Math.round(k)) : k.toFixed(1).replace(/\.0$/, '');
    return `${s}k reports/hr`;
  }
  return `${countPerHour} reports/hr`;
}

/** "Brightening near Lagos, NG" / "storm brewing near Denver, US". */
function moverPhrase(m: Mover, first: boolean): string {
  const verb = m.deltaValence >= 0 ? 'brightening' : 'storm brewing';
  const phrase = `${verb} ${m.label}`;
  return first ? phrase.charAt(0).toUpperCase() + phrase.slice(1) : phrase;
}

function compose(insights: InsightsResponse, trends: TrendsResponse): string {
  // Reports/hr = current 60-min window count; fall back to the most
  // recent hourly trend bucket if the window happens to be empty.
  let perHour = insights.global.count;
  if (perHour === 0 && trends.points.length > 0) {
    perHour = trends.points[trends.points.length - 1].count;
  }
  const movers = insights.movers.slice(0, 2);
  const lines: string[] = [
    `🌍 Planetary mood report — ${utcDay(insights.at)}`,
    `${conditions(insights.global.valence)} (${rate(perHour)})`,
  ];
  if (movers.length > 0) {
    lines.push(movers.map((m, i) => moverPhrase(m, i === 0)).join('; '));
  }
  lines.push(SITE_URL);
  let text = lines.join('\n');
  // Stay under the char budget: drop the second mover, then the line.
  if (text.length > MAX_CHARS && movers.length === 2) {
    lines[2] = moverPhrase(movers[0], true);
    text = lines.join('\n');
  }
  if (text.length > MAX_CHARS && movers.length > 0) {
    lines.splice(2, 1);
    text = lines.join('\n');
  }
  return text;
}

async function postToBluesky(text: string, handle: string, appPassword: string): Promise<string> {
  const sessionRes = await fetch('https://bsky.social/xrpc/com.atproto.server.createSession', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ identifier: handle, password: appPassword }),
  });
  if (!sessionRes.ok) {
    throw new Error(`Bluesky createSession failed for ${handle}: HTTP ${sessionRes.status}`);
  }
  const session = (await sessionRes.json()) as { accessJwt: string; did: string };
  const recordRes = await fetch('https://bsky.social/xrpc/com.atproto.repo.createRecord', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${session.accessJwt}`,
    },
    body: JSON.stringify({
      repo: session.did,
      collection: 'app.bsky.feed.post',
      record: {
        $type: 'app.bsky.feed.post',
        text,
        createdAt: new Date().toISOString(),
        langs: ['en'],
      },
    }),
  });
  if (!recordRes.ok) {
    throw new Error(`Bluesky createRecord failed: HTTP ${recordRes.status}`);
  }
  const record = (await recordRes.json()) as { uri: string };
  return record.uri;
}

async function main(): Promise<void> {
  const [insights, trends] = await Promise.all([
    getJson<InsightsResponse>(`${API_URL}/api/insights`),
    getJson<TrendsResponse>(`${API_URL}/api/trends/global?hours=24`),
  ]);
  const text = compose(insights, trends);
  if (BSKY_HANDLE && BSKY_APP_PASSWORD) {
    const uri = await postToBluesky(text, BSKY_HANDLE, BSKY_APP_PASSWORD);
    console.log(`posted: ${uri}`);
  } else {
    console.log(text);
    console.log('');
    console.log('[dry run — set BSKY_HANDLE and BSKY_APP_PASSWORD to post to Bluesky]');
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
