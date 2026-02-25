// Happyhappyhappy — Positive news for Aditya & Shweta 💚
// Cloudflare Worker: serves inline HTML + REST API + cron ingestion

export interface Env {
  DB: D1Database;
  GEMINI_API_KEY: string;
  RESEND_API_KEY: string;
  ADMIN_TOKEN?: string;
}

interface Item {
  id: string;
  title: string;
  url: string;
  source: string;
  source_region: string;
  summary: string | null;
  image_url: string | null;
  published_at: number | null;
  ingested_at: number;
  joy_score: number;
  category: string;
  reading_time: number;
  hidden: number;
}

// ─── Negativity blocklist ─────────────────────────────────────────────────────
const NEGATIVE_KEYWORDS = [
  'war', 'killed', 'kill', 'murder', 'attack', 'crash', 'disaster', 'tragedy',
  'shooting', 'bomb', 'flood', 'riot', 'violence', 'recession', 'layoff',
  'scandal', 'arrest', 'prison', 'abuse', 'corruption', 'death toll',
  'dead', 'fatal', 'suicide', 'explosion', 'hostage', 'terrorism', 'massacre',
  'earthquake', 'hurricane', 'wildfire', 'drought', 'famine', 'plague',
  'overdose', 'assault', 'rape', 'fraud', 'hack', 'breach', 'ransomware'
];

function isNegative(title: string): boolean {
  const lower = title.toLowerCase();
  return NEGATIVE_KEYWORDS.some(kw => lower.includes(kw));
}

// ─── Gemini LLM helpers ───────────────────────────────────────────────────────
async function geminiScore(title: string, snippet: string, apiKey: string): Promise<number> {
  const prompt = `Rate how uplifting, positive, and joyful this news story is on a scale of 1-10.
1 = very negative/sad, 5 = neutral, 10 = extremely uplifting and heartwarming.
Only reply with a single integer.

Title: ${title}
Snippet: ${snippet.slice(0, 300)}`;

  try {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-flash-latest:generateContent?key=${apiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: { maxOutputTokens: 5, temperature: 0 }
        })
      }
    );
    const data = await res.json() as { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }> };
    const text = data?.candidates?.[0]?.content?.parts?.[0]?.text?.trim() ?? '0';
    const score = parseInt(text, 10);
    return isNaN(score) ? 0 : Math.min(10, Math.max(0, score));
  } catch {
    return 0;
  }
}

async function geminiSummarize(title: string, content: string, apiKey: string): Promise<string> {
  const prompt = `Write a warm, uplifting 2-sentence summary of this positive news story.
Focus on the good, make it feel joyful and human. No clichés. Keep it concise.

Title: ${title}
Content: ${content.slice(0, 800)}`;

  try {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-flash-latest:generateContent?key=${apiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: { maxOutputTokens: 120, temperature: 0.7 }
        })
      }
    );
    const data = await res.json() as { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }> };
    return data?.candidates?.[0]?.content?.parts?.[0]?.text?.trim() ?? '';
  } catch {
    return '';
  }
}

async function geminiCategory(title: string, apiKey: string): Promise<string> {
  const prompt = `Classify this news story into exactly one category. Reply with only the category name.
Categories: feel-good, science, animals, arts

Title: ${title}`;

  try {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-flash-latest:generateContent?key=${apiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: { maxOutputTokens: 10, temperature: 0 }
        })
      }
    );
    const data = await res.json() as { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }> };
    const raw = data?.candidates?.[0]?.content?.parts?.[0]?.text?.trim().toLowerCase() ?? '';
    if (['feel-good', 'science', 'animals', 'arts'].includes(raw)) return raw;
    return 'feel-good';
  } catch {
    return 'feel-good';
  }
}

// ─── RSS ingestion helpers ────────────────────────────────────────────────────
interface RSSSource {
  name: string;
  url: string;
  region: string;
}

const RSS_SOURCES: RSSSource[] = [
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
  { name: 'Times of India', url: 'https://timesofindia.indiatimes.com/rssfeedstopstories.cms', region: 'india' },
];

function parseRSSItems(xml: string, source: RSSSource): Array<{ title: string; url: string; snippet: string; imageUrl: string | null; publishedAt: number | null }> {
  const items: Array<{ title: string; url: string; snippet: string; imageUrl: string | null; publishedAt: number | null }> = [];

  // Simple regex-based RSS parser (no DOM in cron handler)
  const itemRegex = /<item>([\s\S]*?)<\/item>/gi;
  let match;

  while ((match = itemRegex.exec(xml)) !== null) {
    const item = match[1];

    const title = decodeHTMLEntities(extractTag(item, 'title'));
    const link = extractTag(item, 'link') || extractTag(item, 'guid');
    const description = decodeHTMLEntities(stripHTML(extractTag(item, 'description') + extractTag(item, 'content:encoded')));
    const pubDate = extractTag(item, 'pubDate') || extractTag(item, 'dc:date');

    // Extract image from media:content, enclosure, or img tag in description
    const mediaUrl = extractAttr(item, 'media:content', 'url') ||
      extractAttr(item, 'enclosure', 'url') ||
      extractImgSrc(extractTag(item, 'description'));

    if (!title || !link) continue;
    if (isNegative(title)) continue;

    const publishedAt = pubDate ? Math.floor(new Date(pubDate).getTime() / 1000) : null;

    items.push({
      title: title.trim(),
      url: link.trim(),
      snippet: description.slice(0, 500),
      imageUrl: mediaUrl || null,
      publishedAt
    });

    if (items.length >= 5) break; // max 5 per source per run
  }

  return items;
}

function extractTag(xml: string, tag: string): string {
  const cdataMatch = new RegExp(`<${tag}[^>]*><!\\[CDATA\\[([\\s\\S]*?)\\]\\]><\\/${tag}>`, 'i').exec(xml);
  if (cdataMatch) return cdataMatch[1];
  const match = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i').exec(xml);
  return match ? match[1] : '';
}

function extractAttr(xml: string, tag: string, attr: string): string {
  const match = new RegExp(`<${tag}[^>]*\\s${attr}=["']([^"']+)["']`, 'i').exec(xml);
  return match ? match[1] : '';
}

function extractImgSrc(html: string): string {
  const match = /<img[^>]+src=["']([^"']+)["']/i.exec(html);
  return match ? match[1] : '';
}

function stripHTML(html: string): string {
  return html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

function decodeHTMLEntities(text: string): string {
  return text
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#039;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, ' ');
}

function generateId(): string {
  return crypto.randomUUID();
}

// ─── Ingestion cron ───────────────────────────────────────────────────────────
async function runIngestion(env: Env): Promise<{ added: number; skipped: number; errors: string[] }> {
  let added = 0;
  let skipped = 0;
  const errors: string[] = [];

  for (const source of RSS_SOURCES) {
    try {
      const res = await fetch(source.url, {
        headers: { 'User-Agent': 'Happyhappyhappy/1.0 (+https://happyhappyhappy.pages.dev)' },
        signal: AbortSignal.timeout(10000)
      });
      if (!res.ok) { errors.push(`${source.name}: HTTP ${res.status}`); continue; }
      const xml = await res.text();
      const candidates = parseRSSItems(xml, source);

      for (const candidate of candidates) {
        // Check if already exists
        const existing = await env.DB.prepare('SELECT id FROM items WHERE url = ?').bind(candidate.url).first();
        if (existing) { skipped++; continue; }

        // Score with Gemini
        const joyScore = await geminiScore(candidate.title, candidate.snippet, env.GEMINI_API_KEY);
        if (joyScore < 7) { skipped++; continue; }

        // Summarize & classify
        const [summary, category] = await Promise.all([
          geminiSummarize(candidate.title, candidate.snippet, env.GEMINI_API_KEY),
          geminiCategory(candidate.title, env.GEMINI_API_KEY)
        ]);

        const readingTime = Math.max(1, Math.ceil(candidate.snippet.split(' ').length / 200));

        await env.DB.prepare(`
          INSERT INTO items (id, title, url, source, source_region, summary, image_url, published_at, joy_score, category, reading_time)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).bind(
          generateId(),
          candidate.title,
          candidate.url,
          source.name,
          source.region,
          summary || candidate.snippet.slice(0, 200),
          candidate.imageUrl,
          candidate.publishedAt,
          joyScore,
          category,
          readingTime
        ).run();

        added++;
      }
    } catch (err) {
      errors.push(`${source.name}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return { added, skipped, errors };
}

// ─── Daily digest builder ─────────────────────────────────────────────────────
async function buildDailyDigest(env: Env): Promise<void> {
  const today = new Date().toISOString().slice(0, 10);
  const existing = await env.DB.prepare('SELECT date FROM digest_days WHERE date = ?').bind(today).first();
  if (existing) return; // already built today

  const since = Math.floor(Date.now() / 1000) - 86400; // past 24h
  const rows = await env.DB.prepare(`
    SELECT id FROM items
    WHERE hidden = 0 AND joy_score >= 7 AND ingested_at > ?
    ORDER BY joy_score DESC, ingested_at DESC
    LIMIT 7
  `).bind(since).all<{ id: string }>();

  if (!rows.results.length) return;

  const itemIds = JSON.stringify(rows.results.map(r => r.id));
  await env.DB.prepare('INSERT OR REPLACE INTO digest_days (date, item_ids) VALUES (?, ?)').bind(today, itemIds).run();
}

// ─── Email digest ─────────────────────────────────────────────────────────────
async function sendDailyEmail(env: Env): Promise<void> {
  const today = new Date().toISOString().slice(0, 10);
  const digest = await env.DB.prepare('SELECT item_ids FROM digest_days WHERE date = ?').bind(today).first<{ item_ids: string }>();
  if (!digest) return;

  const ids = JSON.parse(digest.item_ids) as string[];
  if (!ids.length) return;

  const placeholders = ids.map(() => '?').join(',');
  const items = await env.DB.prepare(`SELECT * FROM items WHERE id IN (${placeholders})`).bind(...ids).all<Item>();

  const storiesHTML = items.results.map(item => `
    <div style="margin-bottom:24px;padding:20px;background:#f9f9f9;border-radius:12px;">
      ${item.image_url ? `<img src="${item.image_url}" style="width:100%;max-height:200px;object-fit:cover;border-radius:8px;margin-bottom:12px;" alt="">` : ''}
      <span style="font-size:12px;color:#7B2D8B;font-weight:600;text-transform:uppercase;">${categoryEmoji(item.category)} ${item.category}</span>
      <h2 style="font-size:18px;margin:8px 0;color:#111;">${escapeHtml(item.title)}</h2>
      <p style="color:#444;font-size:14px;line-height:1.6;margin:0 0 12px;">${escapeHtml(item.summary ?? '')}</p>
      <a href="${item.url}" style="color:#FF6B35;font-weight:600;text-decoration:none;">Read the full story →</a>
      <span style="color:#999;font-size:12px;margin-left:12px;">via ${item.source}</span>
    </div>
  `).join('');

  const emailHTML = `
<!DOCTYPE html>
<html>
<head><meta charset="utf-8"></head>
<body style="font-family:system-ui,sans-serif;max-width:600px;margin:0 auto;padding:20px;background:#fff;">
  <div style="background:#CDFF70;padding:24px;border-radius:16px;text-align:center;margin-bottom:32px;">
    <h1 style="font-size:28px;margin:0;color:#111;">😊 happyhappyhappy</h1>
    <p style="color:#333;margin:8px 0 0;">Your daily dose of good news — ${new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' })}</p>
  </div>
  <h2 style="font-size:20px;color:#111;">Today's happy stories ✨</h2>
  ${storiesHTML}
  <div style="text-align:center;padding:20px;color:#999;font-size:12px;border-top:1px solid #eee;margin-top:32px;">
    <a href="https://happyhappyhappy.pages.dev" style="color:#FF6B35;">Read more at happyhappyhappy</a><br>
    Made with 💚 for Aditya & Shweta
  </div>
</body>
</html>`;

  const recipients = ['aditya.pandya@outlook.com', 'reachshwetaverma@gmail.com'];
  for (const to of recipients) {
    await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${env.RESEND_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        from: 'happyhappyhappy <hello@happyhappyhappy.app>',
        to,
        subject: `😊 Your happy news for ${new Date().toLocaleDateString('en-US', { month: 'long', day: 'numeric' })}`,
        html: emailHTML
      })
    });
  }
}

function categoryEmoji(cat: string): string {
  const map: Record<string, string> = { 'feel-good': '🤗', 'science': '🔬', 'animals': '🐾', 'arts': '🎨' };
  return map[cat] ?? '✨';
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// ─── HTML Frontend ────────────────────────────────────────────────────────────
function renderHTML(items: Item[], todayItems: Item[], activeTab: string, activeCategory: string): string {
  const navTabs = [
    { id: 'today', label: "Today's Dose", emoji: '🌟' },
    { id: 'all', label: 'All Good News', emoji: '✨' }
  ];

  const categories = [
    { id: '', label: 'All', emoji: '💚' },
    { id: 'feel-good', label: 'Feel-good', emoji: '🤗' },
    { id: 'science', label: 'Science', emoji: '🔬' },
    { id: 'animals', label: 'Animals', emoji: '🐾' },
    { id: 'arts', label: 'Arts', emoji: '🎨' }
  ];

  const heroItems = activeTab === 'today' ? todayItems : items.slice(0, 7);
  const gridItems = activeTab === 'today' ? [] : items.slice(7);

  const heroCardsHTML = heroItems.map((item, i) => `
    <div class="hero-card" data-index="${i}" style="display:${i === 0 ? 'block' : 'none'}">
      ${item.image_url ? `<div class="hero-img-wrap"><img src="${item.image_url}" alt="" onerror="this.parentElement.style.display='none'"></div>` : ''}
      <div class="hero-content">
        <div class="category-pill">${categoryEmoji(item.category)} ${item.category}</div>
        <h2 class="hero-title"><a href="${item.url}" target="_blank" rel="noopener">${escapeHtml(item.title)}</a></h2>
        <p class="hero-summary">${escapeHtml(item.summary ?? '')}</p>
        <div class="hero-meta">
          <span class="joy-bar">${'⭐'.repeat(Math.min(Math.round(item.joy_score / 2), 5))}</span>
          <span class="source-tag">via ${escapeHtml(item.source)}</span>
          <a href="${item.url}" target="_blank" rel="noopener" class="read-link">Read full story →</a>
        </div>
      </div>
    </div>
  `).join('');

  const gridCardsHTML = gridItems.map(item => `
    <div class="grid-card">
      ${item.image_url ? `<div class="card-img-wrap"><img src="${item.image_url}" alt="" onerror="this.parentElement.style.display='none'"></div>` : '<div class="card-img-placeholder"></div>'}
      <div class="card-body">
        <div class="category-pill small">${categoryEmoji(item.category)} ${item.category}</div>
        <h3 class="card-title"><a href="${item.url}" target="_blank" rel="noopener">${escapeHtml(item.title)}</a></h3>
        <p class="card-summary">${escapeHtml((item.summary ?? '').slice(0, 120))}…</p>
        <div class="card-meta">
          <span class="source-tag">via ${escapeHtml(item.source)}</span>
        </div>
      </div>
    </div>
  `).join('');

  const tickerItems = items.slice(0, 20).map(i => escapeHtml(i.title)).join(' &nbsp;•&nbsp; ');

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>😊 happyhappyhappy</title>
  <meta name="description" content="Your daily dose of happy, uplifting news">
  <meta name="theme-color" content="#CDFF70">
  <link rel="manifest" href="/manifest.json">
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link href="https://fonts.googleapis.com/css2?family=Fraunces:wght@700;900&family=Inter:wght@400;500;600&display=swap" rel="stylesheet">
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

    :root {
      --lime: #CDFF70;
      --lime-dark: #aada50;
      --orange: #FF6B35;
      --purple: #7B2D8B;
      --black: #111111;
      --white: #FFFFFF;
      --gray: #f5f5f5;
      --text-muted: #666;
    }

    body {
      font-family: 'Inter', sans-serif;
      background: var(--lime);
      color: var(--black);
      min-height: 100vh;
    }

    /* Header */
    .header {
      background: var(--black);
      padding: 16px 24px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      position: sticky;
      top: 0;
      z-index: 100;
    }
    .logo {
      font-family: 'Fraunces', serif;
      font-size: 22px;
      font-weight: 900;
      color: var(--lime);
      text-decoration: none;
    }
    .nav-tabs {
      display: flex;
      gap: 8px;
    }
    .nav-tab {
      padding: 8px 16px;
      border-radius: 999px;
      border: 2px solid transparent;
      cursor: pointer;
      font-weight: 600;
      font-size: 14px;
      text-decoration: none;
      transition: all 0.15s;
      color: #ccc;
      background: transparent;
    }
    .nav-tab:hover { color: var(--white); }
    .nav-tab.active {
      background: var(--lime);
      color: var(--black);
      border-color: var(--lime);
    }

    /* Ticker */
    .ticker-wrap {
      background: var(--black);
      padding: 8px 0;
      overflow: hidden;
      border-top: 1px solid #222;
    }
    .ticker {
      display: flex;
      white-space: nowrap;
      animation: ticker 60s linear infinite;
      font-size: 13px;
      color: var(--lime);
      font-weight: 500;
    }
    .ticker span { padding: 0 16px; }
    @keyframes ticker { from { transform: translateX(0) } to { transform: translateX(-50%) } }

    /* Main layout */
    .main {
      max-width: 1100px;
      margin: 0 auto;
      padding: 32px 24px;
    }

    /* Section header */
    .section-header {
      display: flex;
      align-items: baseline;
      gap: 12px;
      margin-bottom: 24px;
    }
    .section-title {
      font-family: 'Fraunces', serif;
      font-size: 36px;
      font-weight: 900;
      color: var(--black);
    }
    .section-sub {
      color: var(--text-muted);
      font-size: 14px;
    }

    /* Category filter */
    .category-filter {
      display: flex;
      gap: 8px;
      flex-wrap: wrap;
      margin-bottom: 28px;
    }
    .cat-btn {
      padding: 6px 14px;
      border-radius: 999px;
      border: 2px solid var(--black);
      background: transparent;
      cursor: pointer;
      font-size: 13px;
      font-weight: 600;
      text-decoration: none;
      color: var(--black);
      transition: all 0.15s;
    }
    .cat-btn:hover { background: var(--black); color: var(--lime); }
    .cat-btn.active { background: var(--black); color: var(--lime); }

    /* Hero carousel */
    .hero-wrap {
      background: var(--white);
      border-radius: 24px;
      overflow: hidden;
      margin-bottom: 48px;
      box-shadow: 4px 4px 0 var(--black);
      border: 2px solid var(--black);
    }
    .hero-img-wrap {
      width: 100%;
      height: 280px;
      overflow: hidden;
    }
    .hero-img-wrap img {
      width: 100%;
      height: 100%;
      object-fit: cover;
    }
    .hero-content {
      padding: 28px 32px 24px;
    }
    .hero-title {
      font-family: 'Fraunces', serif;
      font-size: 28px;
      font-weight: 900;
      line-height: 1.2;
      margin: 10px 0 14px;
    }
    .hero-title a { color: var(--black); text-decoration: none; }
    .hero-title a:hover { text-decoration: underline; }
    .hero-summary {
      font-size: 16px;
      line-height: 1.7;
      color: #333;
      margin-bottom: 18px;
    }
    .hero-meta {
      display: flex;
      align-items: center;
      gap: 16px;
      flex-wrap: wrap;
    }
    .joy-bar { font-size: 14px; }
    .source-tag {
      font-size: 12px;
      color: var(--text-muted);
    }
    .read-link {
      margin-left: auto;
      color: var(--orange);
      font-weight: 700;
      text-decoration: none;
      font-size: 14px;
    }
    .read-link:hover { text-decoration: underline; }

    /* Carousel controls */
    .carousel-controls {
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 16px;
      padding: 16px 32px;
      border-top: 2px solid #f0f0f0;
    }
    .carousel-btn {
      background: var(--black);
      color: var(--white);
      border: none;
      width: 36px;
      height: 36px;
      border-radius: 50%;
      cursor: pointer;
      font-size: 16px;
      display: flex;
      align-items: center;
      justify-content: center;
      transition: background 0.15s;
    }
    .carousel-btn:hover { background: var(--purple); }
    .carousel-dots {
      display: flex;
      gap: 6px;
    }
    .dot {
      width: 8px;
      height: 8px;
      border-radius: 50%;
      background: #ddd;
      cursor: pointer;
      transition: background 0.15s;
    }
    .dot.active { background: var(--orange); width: 20px; border-radius: 4px; }

    /* Category pill */
    .category-pill {
      display: inline-block;
      padding: 4px 12px;
      border-radius: 999px;
      background: var(--lime);
      border: 1px solid var(--black);
      font-size: 11px;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.05em;
    }
    .category-pill.small { font-size: 10px; padding: 3px 9px; }

    /* Grid */
    .grid-section-title {
      font-family: 'Fraunces', serif;
      font-size: 26px;
      font-weight: 900;
      margin-bottom: 20px;
    }
    .grid {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(300px, 1fr));
      gap: 20px;
    }
    .grid-card {
      background: var(--white);
      border-radius: 16px;
      overflow: hidden;
      border: 2px solid var(--black);
      box-shadow: 3px 3px 0 var(--black);
      transition: transform 0.15s, box-shadow 0.15s;
    }
    .grid-card:hover { transform: translate(-2px, -2px); box-shadow: 5px 5px 0 var(--black); }
    .card-img-wrap {
      height: 160px;
      overflow: hidden;
    }
    .card-img-wrap img { width: 100%; height: 100%; object-fit: cover; }
    .card-img-placeholder {
      height: 80px;
      background: linear-gradient(135deg, var(--lime) 0%, var(--lime-dark) 100%);
    }
    .card-body { padding: 16px; }
    .card-title {
      font-family: 'Fraunces', serif;
      font-size: 16px;
      font-weight: 700;
      line-height: 1.3;
      margin: 8px 0 8px;
    }
    .card-title a { color: var(--black); text-decoration: none; }
    .card-title a:hover { text-decoration: underline; }
    .card-summary {
      font-size: 13px;
      color: #555;
      line-height: 1.5;
      margin-bottom: 10px;
    }
    .card-meta { font-size: 11px; color: var(--text-muted); }

    /* Empty state */
    .empty-state {
      text-align: center;
      padding: 80px 20px;
    }
    .empty-state .emoji { font-size: 64px; margin-bottom: 16px; }
    .empty-state h2 { font-family: 'Fraunces', serif; font-size: 28px; margin-bottom: 8px; }
    .empty-state p { color: var(--text-muted); }

    /* Footer */
    .footer {
      text-align: center;
      padding: 32px;
      color: var(--text-muted);
      font-size: 13px;
    }
    .footer a { color: var(--purple); }

    @media (max-width: 600px) {
      .header { padding: 12px 16px; }
      .logo { font-size: 18px; }
      .nav-tab { padding: 6px 12px; font-size: 13px; }
      .main { padding: 20px 16px; }
      .section-title { font-size: 28px; }
      .hero-title { font-size: 22px; }
      .hero-content { padding: 20px; }
    }
  </style>
</head>
<body>

<header class="header">
  <a href="/" class="logo">😊 happyhappyhappy</a>
  <nav class="nav-tabs">
    ${navTabs.map(t => `<a href="?tab=${t.id}" class="nav-tab${activeTab === t.id ? ' active' : ''}">${t.emoji} ${t.label}</a>`).join('')}
  </nav>
</header>

${items.length > 0 ? `
<div class="ticker-wrap">
  <div class="ticker">
    <span>${tickerItems} &nbsp;•&nbsp; ${tickerItems}</span>
  </div>
</div>` : ''}

<main class="main">

  ${activeTab === 'all' ? `
  <div class="section-header">
    <h1 class="section-title">All Good News ✨</h1>
  </div>
  <div class="category-filter">
    ${categories.map(c => `<a href="?tab=all${c.id ? '&cat=' + c.id : ''}" class="cat-btn${activeCategory === c.id ? ' active' : ''}">${c.emoji} ${c.label}</a>`).join('')}
  </div>` : `
  <div class="section-header">
    <h1 class="section-title">Today's Dose 🌟</h1>
    <span class="section-sub">Your happy highlights for ${new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' })}</span>
  </div>`}

  ${heroItems.length > 0 ? `
  <div class="hero-wrap">
    ${heroCardsHTML}
    ${heroItems.length > 1 ? `
    <div class="carousel-controls">
      <button class="carousel-btn" onclick="prevCard()">←</button>
      <div class="carousel-dots">
        ${heroItems.map((_, i) => `<div class="dot${i === 0 ? ' active' : ''}" onclick="goToCard(${i})"></div>`).join('')}
      </div>
      <button class="carousel-btn" onclick="nextCard()">→</button>
    </div>` : ''}
  </div>` : `
  <div class="empty-state">
    <div class="emoji">🌱</div>
    <h2>Good news is on its way!</h2>
    <p>Our happy-news robot is collecting stories right now. Check back in a bit!</p>
  </div>`}

  ${gridItems.length > 0 ? `
  <h2 class="grid-section-title">More good news 💚</h2>
  <div class="grid">${gridCardsHTML}</div>` : ''}

</main>

<footer class="footer">
  Made with 💚 for Aditya &amp; Shweta &nbsp;•&nbsp; <a href="https://happyhappyhappy.pages.dev">happyhappyhappy</a>
</footer>

<script>
  let current = 0;
  const cards = document.querySelectorAll('.hero-card');
  const dots = document.querySelectorAll('.dot');

  function showCard(n) {
    cards.forEach((c, i) => c.style.display = i === n ? 'block' : 'none');
    dots.forEach((d, i) => d.classList.toggle('active', i === n));
    current = n;
  }
  function nextCard() { showCard((current + 1) % cards.length); }
  function prevCard() { showCard((current - 1 + cards.length) % cards.length); }
  function goToCard(n) { showCard(n); }

  // Auto-advance every 8 seconds
  if (cards.length > 1) setInterval(nextCard, 8000);
</script>

</body>
</html>`;
}

// ─── Main request handler ─────────────────────────────────────────────────────
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    // Manifest
    if (path === '/manifest.json') {
      return new Response(JSON.stringify({
        name: 'happyhappyhappy',
        short_name: 'HHH',
        description: 'Your daily dose of positive news',
        start_url: '/',
        display: 'standalone',
        background_color: '#CDFF70',
        theme_color: '#CDFF70',
        icons: [{ src: '/icon.png', sizes: '192x192', type: 'image/png' }]
      }), { headers: { 'Content-Type': 'application/json' } });
    }

    // Health check
    if (path === '/health') {
      const count = await env.DB.prepare('SELECT COUNT(*) as n FROM items WHERE hidden = 0').first<{ n: number }>();
      return Response.json({ ok: true, items: count?.n ?? 0 });
    }

    // API: today's digest
    if (path === '/api/today') {
      const today = new Date().toISOString().slice(0, 10);
      const digest = await env.DB.prepare('SELECT item_ids FROM digest_days WHERE date = ?').bind(today).first<{ item_ids: string }>();

      if (!digest) {
        return Response.json({ items: [] });
      }

      const ids = JSON.parse(digest.item_ids) as string[];
      const placeholders = ids.map(() => '?').join(',');
      const rows = await env.DB.prepare(`SELECT * FROM items WHERE id IN (${placeholders}) AND hidden = 0`).bind(...ids).all<Item>();
      return Response.json({ items: rows.results });
    }

    // API: full feed
    if (path === '/api/feed') {
      const category = url.searchParams.get('category') ?? '';
      const page = parseInt(url.searchParams.get('page') ?? '1', 10);
      const limit = 30;
      const offset = (page - 1) * limit;

      let rows;
      if (category) {
        rows = await env.DB.prepare(
          'SELECT * FROM items WHERE hidden = 0 AND category = ? ORDER BY published_at DESC, ingested_at DESC LIMIT ? OFFSET ?'
        ).bind(category, limit, offset).all<Item>();
      } else {
        rows = await env.DB.prepare(
          'SELECT * FROM items WHERE hidden = 0 ORDER BY published_at DESC, ingested_at DESC LIMIT ? OFFSET ?'
        ).bind(limit, offset).all<Item>();
      }
      return Response.json({ items: rows.results, page, hasMore: rows.results.length === limit });
    }

    // Admin: manual ingest trigger
    if (path === '/api/ingest' && request.method === 'POST') {
      const token = request.headers.get('Authorization')?.replace('Bearer ', '');
      if (!env.ADMIN_TOKEN || token !== env.ADMIN_TOKEN) {
        return new Response('Unauthorized', { status: 401 });
      }
      const result = await runIngestion(env);
      await buildDailyDigest(env);
      return Response.json(result);
    }

    // Admin: trigger email
    if (path === '/api/send-digest' && request.method === 'POST') {
      const token = request.headers.get('Authorization')?.replace('Bearer ', '');
      if (!env.ADMIN_TOKEN || token !== env.ADMIN_TOKEN) {
        return new Response('Unauthorized', { status: 401 });
      }
      await buildDailyDigest(env);
      await sendDailyEmail(env);
      return Response.json({ ok: true });
    }

    // Main UI — GET /
    if (path === '/' || path === '') {
      const tab = url.searchParams.get('tab') ?? 'today';
      const category = url.searchParams.get('cat') ?? '';

      // Load today's digest items
      const today = new Date().toISOString().slice(0, 10);
      const digest = await env.DB.prepare('SELECT item_ids FROM digest_days WHERE date = ?').bind(today).first<{ item_ids: string }>();

      let todayItems: Item[] = [];
      if (digest) {
        const ids = JSON.parse(digest.item_ids) as string[];
        const ph = ids.map(() => '?').join(',');
        const rows = await env.DB.prepare(`SELECT * FROM items WHERE id IN (${ph}) AND hidden = 0`).bind(...ids).all<Item>();
        todayItems = rows.results;
      }

      // Load full feed (for 'all' tab or ticker)
      let feedItems: Item[] = [];
      if (category) {
        const rows = await env.DB.prepare(
          'SELECT * FROM items WHERE hidden = 0 AND category = ? ORDER BY published_at DESC, ingested_at DESC LIMIT 50'
        ).bind(category).all<Item>();
        feedItems = rows.results;
      } else {
        const rows = await env.DB.prepare(
          'SELECT * FROM items WHERE hidden = 0 ORDER BY published_at DESC, ingested_at DESC LIMIT 50'
        ).all<Item>();
        feedItems = rows.results;
      }

      const displayItems = tab === 'today' ? todayItems : feedItems;
      const html = renderHTML(displayItems, todayItems, tab, category);
      return new Response(html, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
    }

    return new Response('Not found', { status: 404 });
  },

  async scheduled(event: ScheduledEvent, env: Env): Promise<void> {
    const hour = new Date().getUTCHours();

    // Run ingestion every hour
    await runIngestion(env);

    // At 16 UTC (8am PT), build digest and send email
    if (hour === 16) {
      await buildDailyDigest(env);
      await sendDailyEmail(env);
    }
  }
};
