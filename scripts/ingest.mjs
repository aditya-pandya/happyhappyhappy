#!/usr/bin/env node
// Happyhappyhappy ingestion script
// Fetches RSS feeds, scores with Gemini, stores in Cloudflare D1

import { readFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { randomUUID } from 'crypto';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

// Load .env
const envPath = '/Users/aditya/.openclaw/.env';
if (existsSync(envPath)) {
  const lines = readFileSync(envPath, 'utf8').split('\n');
  for (const line of lines) {
    const match = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (match) {
      const val = match[2].trim().replace(/^["']|["']$/g, '');
      process.env[match[1]] ??= val;
    }
  }
}

const GEMINI_KEY = process.env.GEMINI_API_KEY_1 || process.env.GEMINI_API_KEY;
const DRY_RUN = process.argv.includes('--dry-run');
const VERBOSE = process.argv.includes('--verbose') || DRY_RUN;

if (!GEMINI_KEY) {
  console.error('ERROR: GEMINI_API_KEY_1 not found in .env');
  process.exit(1);
}

// ─── Sources ──────────────────────────────────────────────────────────────────
const SOURCES = [
  { name: 'Good News Network', url: 'https://www.goodnewsnetwork.org/feed/', region: 'us' },
  { name: 'Positive News', url: 'https://www.positive.news/feed/', region: 'global' },
  { name: 'The Optimist Daily', url: 'https://www.optimistdaily.com/feed/', region: 'us' },
  { name: 'Upworthy', url: 'https://feeds.feedburner.com/upworthy', region: 'us' },
  { name: 'Happy News', url: 'https://www.happynews.com/rss/', region: 'us' },
  { name: 'Science Daily', url: 'https://www.sciencedaily.com/rss/top.xml', region: 'global' },
  { name: 'NASA', url: 'https://www.nasa.gov/rss/dyn/breaking_news.rss', region: 'us' },
  { name: 'The Dodo', url: 'https://www.thedodo.com/feed', region: 'us' },
  { name: 'Mental Floss', url: 'https://www.mentalfloss.com/rss.xml', region: 'us' },
  { name: 'Atlas Obscura', url: 'https://www.atlasobscura.com/feeds/latest', region: 'global' },
  { name: 'The Better India', url: 'https://www.thebetterindia.com/feed/', region: 'india' },
  { name: 'The Hindu Arts', url: 'https://www.thehindu.com/arts/feeder/default.rss', region: 'india' },
  { name: 'The Hindu Society', url: 'https://www.thehindu.com/society/feeder/default.rss', region: 'india' },
  { name: 'The Hindu Science', url: 'https://www.thehindu.com/sci-tech/science/feeder/default.rss', region: 'india' },
];

const NEGATIVE_KEYWORDS = [
  'war', 'killed', 'kill', 'murder', 'attack', 'crash', 'disaster', 'tragedy',
  'shooting', 'bomb', 'flood', 'riot', 'violence', 'recession', 'layoff',
  'scandal', 'arrest', 'prison', 'abuse', 'corruption', 'death toll',
  'fatal', 'suicide', 'explosion', 'hostage', 'terrorism', 'massacre',
  'earthquake', 'hurricane', 'wildfire', 'drought', 'famine', 'plague',
  'overdose', 'assault', 'rape', 'fraud', 'hack', 'breach', 'ransomware'
];

function isNegative(title) {
  const lower = title.toLowerCase();
  return NEGATIVE_KEYWORDS.some(kw => lower.includes(kw));
}

// ─── Gemini helpers ───────────────────────────────────────────────────────────
async function geminiCall(prompt, maxTokens = 10) {
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${maxTokens > 20 ? 'gemini-2.5-flash-lite' : 'gemini-flash-latest'}:generateContent?key=${GEMINI_KEY}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { maxOutputTokens: maxTokens, temperature: maxTokens > 10 ? 0.7 : 0 }
      })
    }
  );
  const data = await res.json();
  return data?.candidates?.[0]?.content?.parts?.[0]?.text?.trim() ?? '';
}

async function scoreJoy(title, snippet) {
  const text = await geminiCall(
    `Rate how uplifting, positive, and joyful this news story is on a scale of 1-10.
1 = very negative/sad, 5 = neutral, 10 = extremely uplifting and heartwarming.
Only reply with a single integer.

Title: ${title}
Snippet: ${snippet.slice(0, 300)}`,
    5
  );
  const score = parseInt(text, 10);
  return isNaN(score) ? 0 : Math.min(10, Math.max(0, score));
}

async function summarize(title, content) {
  return geminiCall(
    `Write a warm, uplifting 4-5 sentence summary of this positive news story.
Write in a joyful, human, conversational tone. Highlight what makes this story special and why it matters.
Include specific details that bring it to life. End with something hopeful or inspiring.
No clichés, no filler phrases like "In conclusion" or "Overall".

Title: ${title}
Content: ${content.slice(0, 1200)}`,
    350
  );
}

async function classify(title) {
  const raw = await geminiCall(
    `Classify this news story into exactly one category. Reply with only the category name.
Categories: feel-good, science, animals, arts

Title: ${title}`,
    10
  );
  const clean = raw.toLowerCase().replace(/[^a-z-]/g, '');
  return ['feel-good', 'science', 'animals', 'arts'].includes(clean) ? clean : 'feel-good';
}

// ─── RSS parser ───────────────────────────────────────────────────────────────
function extractTag(xml, tag) {
  const cdataMatch = new RegExp(`<${tag}[^>]*><!\\[CDATA\\[([\\s\\S]*?)\\]\\]><\\/${tag}>`, 'i').exec(xml);
  if (cdataMatch) return cdataMatch[1];
  const match = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i').exec(xml);
  return match ? match[1] : '';
}

function extractAttr(xml, tag, attr) {
  const match = new RegExp(`<${tag}[^>]*\\s${attr}=["']([^"']+)["']`, 'i').exec(xml);
  return match ? match[1] : '';
}

function extractImgSrc(html) {
  const match = /<img[^>]+src=["']([^"']+)["']/i.exec(html);
  return match ? match[1] : '';
}

function stripHTML(html) {
  return html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

function decodeEntities(text) {
  return text
    .replace(/&#(\d+);/g, (_, dec) => {
      const n = Number.parseInt(dec, 10);
      return Number.isFinite(n) ? String.fromCodePoint(n) : _;
    })
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => {
      const n = Number.parseInt(hex, 16);
      return Number.isFinite(n) ? String.fromCodePoint(n) : _;
    })
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#039;/g, "'").replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, ' ');
}

function parseRSS(xml, source) {
  const items = [];
  const itemRegex = /<item>([\s\S]*?)<\/item>/gi;
  let match;

  while ((match = itemRegex.exec(xml)) !== null) {
    const item = match[1];
    const title = decodeEntities(extractTag(item, 'title')).trim();
    const link = (extractTag(item, 'link') || extractTag(item, 'guid')).trim();
    const description = decodeEntities(stripHTML(
      extractTag(item, 'content:encoded') || extractTag(item, 'description')
    ));
    const pubDate = extractTag(item, 'pubDate') || extractTag(item, 'dc:date');
    const imageUrl = extractAttr(item, 'media:content', 'url') ||
      extractAttr(item, 'enclosure', 'url') ||
      extractImgSrc(extractTag(item, 'description') + extractTag(item, 'content:encoded'));

    if (!title || !link) continue;
    if (!link.startsWith('http')) continue;

    const publishedAt = pubDate ? Math.floor(new Date(pubDate).getTime() / 1000) : null;
    items.push({ title, url: link, snippet: description.slice(0, 600), imageUrl: imageUrl || null, publishedAt });

    if (items.length >= 5) break;
  }
  return items;
}

// ─── D1 via Wrangler CLI ──────────────────────────────────────────────────────
import { execSync } from 'child_process';

function d1Query(sql, params = []) {
  // Escape params for SQL literal insertion (safe for our controlled use)
  let paramIdx = 0;
  const filled = sql.replace(/\?/g, () => {
    const val = params[paramIdx++];
    if (val === null || val === undefined) return 'NULL';
    if (typeof val === 'number') return val.toString();
    return `'${String(val).replace(/'/g, "''")}'`;
  });

  const cmd = `wrangler d1 execute happyhappyhappy --remote --json --command ${JSON.stringify(filled)}`;
  try {
    const out = execSync(cmd, { cwd: ROOT, stdio: ['pipe', 'pipe', 'pipe'] }).toString();
    const parsed = JSON.parse(out);
    return Array.isArray(parsed) ? parsed[0] : parsed;
  } catch (err) {
    if (VERBOSE) console.error('D1 error for query:', filled.slice(0, 100), err.message);
    return null;
  }
}

function d1Select(sql, params = []) {
  const result = d1Query(sql, params);
  return result?.results ?? [];
}

function d1Run(sql, params = []) {
  return d1Query(sql, params);
}

// ─── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  console.log(`\n🌞 Happyhappyhappy ingestion — ${new Date().toISOString()}`);
  console.log(`   Mode: ${DRY_RUN ? 'DRY RUN (no writes)' : 'LIVE'}\n`);

  let totalAdded = 0;
  let totalSkipped = 0;
  const errors = [];

  for (const source of SOURCES) {
    console.log(`📡 ${source.name} [${source.region}]`);

    let xml;
    try {
      const res = await fetch(source.url, {
        headers: { 'User-Agent': 'Happyhappyhappy/1.0' },
        signal: AbortSignal.timeout(15000)
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      xml = await res.text();
    } catch (err) {
      console.log(`   ❌ Fetch error: ${err.message}`);
      errors.push(`${source.name}: ${err.message}`);
      continue;
    }

    const candidates = parseRSS(xml, source);
    console.log(`   Found ${candidates.length} candidates`);

    for (const c of candidates) {
      // Negativity pre-filter
      if (isNegative(c.title)) {
        if (VERBOSE) console.log(`   ⛔ Negative: ${c.title}`);
        totalSkipped++;
        continue;
      }

      // Check if already in DB
      if (!DRY_RUN) {
        const existing = d1Select('SELECT id FROM items WHERE url = ?', [c.url]);
        if (existing.length > 0) {
          if (VERBOSE) console.log(`   ⏭  Exists: ${c.title}`);
          totalSkipped++;
          continue;
        }
      }

      // Joy score
      const joyScore = await scoreJoy(c.title, c.snippet);
      if (VERBOSE) console.log(`   🎯 Joy ${joyScore}/10: ${c.title.slice(0, 60)}`);

      if (joyScore < 7) {
        totalSkipped++;
        continue;
      }

      // Summarize + classify
      const [summary, category] = await Promise.all([
        summarize(c.title, c.snippet),
        classify(c.title)
      ]);

      const readingTime = Math.max(1, Math.ceil(c.snippet.split(' ').length / 200));

      console.log(`   ✅ [${category}] ${c.title.slice(0, 70)}`);

      if (!DRY_RUN) {
        d1Run(
          `INSERT OR IGNORE INTO items (id, title, url, source, source_region, summary, image_url, published_at, joy_score, category, reading_time) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [randomUUID(), c.title, c.url, source.name, source.region, summary || c.snippet.slice(0, 200), c.imageUrl, c.publishedAt, joyScore, category, readingTime]
        );
      }

      totalAdded++;
    }
  }

  // Build daily digest
  if (!DRY_RUN) {
    const today = new Date().toISOString().slice(0, 10);
    const since = Math.floor(Date.now() / 1000) - 86400;
    const top = d1Select(
      'SELECT id FROM items WHERE hidden = 0 AND joy_score >= 7 AND ingested_at > ? ORDER BY joy_score DESC, ingested_at DESC LIMIT 7',
      [since]
    );
    if (top.length > 0) {
      const itemIds = JSON.stringify(top.map(r => r.id));
      d1Run('INSERT OR REPLACE INTO digest_days (date, item_ids) VALUES (?, ?)', [today, itemIds]);
      console.log(`\n📋 Built digest for ${today} with ${top.length} items`);
    }
  }

  console.log(`\n📊 Summary:`);
  console.log(`   Added: ${totalAdded}`);
  console.log(`   Skipped: ${totalSkipped}`);
  if (errors.length > 0) {
    console.log(`   Errors: ${errors.join(', ')}`);
  }
  console.log('');
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
