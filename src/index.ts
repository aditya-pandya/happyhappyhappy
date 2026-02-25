// Happyhappyhappy — Positive news for Aditya & Shweta
// Cloudflare Worker: serves inline HTML + REST API + cron ingestion + reader mode

import { parseHTML } from 'linkedom';
import { Readability } from '@mozilla/readability';

export interface Env {
  DB: D1Database;
  ASSETS: Fetcher;
  GEMINI_API_KEY: string;
  RESEND_API_KEY: string;
  ADMIN_TOKEN?: string;
}

// Model routing: use lite for scoring/category (cheap), better model for summaries
const GEMINI_SCORE_MODEL = 'gemini-flash-latest';
const GEMINI_SUMMARY_MODEL = 'gemini-2.5-flash-lite';
const GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';

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
type GeminiResponse = { candidates?: Array<{ finishReason?: string; content?: { parts?: Array<{ text?: string }> } }> };

async function geminiCall(model: string, prompt: string, apiKey: string, maxTokens: number, temp = 0): Promise<string> {
  try {
    const res = await fetch(
      `${GEMINI_BASE}/${model}:generateContent?key=${apiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: { maxOutputTokens: maxTokens, temperature: temp }
        })
      }
    );
    const data = await res.json() as GeminiResponse;
    return data?.candidates?.[0]?.content?.parts?.[0]?.text?.trim() ?? '';
  } catch {
    return '';
  }
}

async function geminiScore(title: string, snippet: string, apiKey: string): Promise<number> {
  const text = await geminiCall(
    GEMINI_SCORE_MODEL,
    `Rate how uplifting, positive, and joyful this news story is on a scale of 1-10.
1 = very negative/sad, 5 = neutral, 10 = extremely uplifting and heartwarming.
Only reply with a single integer.

Title: ${title}
Snippet: ${snippet.slice(0, 300)}`,
    apiKey, 5, 0
  );
  const score = parseInt(text, 10);
  return isNaN(score) ? 0 : Math.min(10, Math.max(0, score));
}

async function geminiSummarize(title: string, content: string, apiKey: string): Promise<string> {
  // Use gemini-2.5-flash-lite: reliably generates complete 4-5 sentence summaries
  return geminiCall(
    GEMINI_SUMMARY_MODEL,
    `Write a warm, uplifting 4-5 sentence summary of this positive news story.
Write in a joyful, human, conversational tone. Highlight what makes this story special and why it matters.
Include specific details that bring it to life. End with something hopeful or inspiring.
No clichés, no filler phrases like "In conclusion" or "Overall". Output only the summary text.

Title: ${title}
Content: ${content.slice(0, 2000)}`,
    apiKey, 400, 0.7
  );
}

async function geminiSummarizeArticle(title: string, content: string, apiKey: string): Promise<string> {
  // For reader mode: concise 2-3 sentence summary of full fetched article content
  return geminiCall(
    GEMINI_SUMMARY_MODEL,
    `Write a concise 2-3 sentence summary of this article for a reader preview.
Be specific, warm, and self-contained. Use plain sentences, no markdown.
Output only the summary text.

Title: ${title}
Article: ${content.slice(0, 4000)}`,
    apiKey, 200, 0.5
  );
}

async function geminiCategory(title: string, apiKey: string): Promise<string> {
  const raw = await geminiCall(
    GEMINI_SCORE_MODEL,
    `Classify this news story into exactly one category. Reply with only the category name.
Categories: feel-good, science, animals, arts

Title: ${title}`,
    apiKey, 10, 0
  );
  const clean = raw.toLowerCase().replace(/[^a-z-]/g, '');
  return ['feel-good', 'science', 'animals', 'arts'].includes(clean) ? clean : 'feel-good';
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
  { name: 'The Hindu Arts', url: 'https://www.thehindu.com/arts/feeder/default.rss', region: 'india' },
  { name: 'The Hindu Society', url: 'https://www.thehindu.com/society/feeder/default.rss', region: 'india' },
  { name: 'The Hindu Science', url: 'https://www.thehindu.com/sci-tech/science/feeder/default.rss', region: 'india' },
];

function parseRSSItems(xml: string, source: RSSSource): Array<{ title: string; url: string; snippet: string; imageUrl: string | null; publishedAt: number | null }> {
  const items: Array<{ title: string; url: string; snippet: string; imageUrl: string | null; publishedAt: number | null }> = [];
  const itemRegex = /<item>([\s\S]*?)<\/item>/gi;
  let match;

  while ((match = itemRegex.exec(xml)) !== null) {
    const item = match[1];
    const title = decodeHTMLEntities(extractTag(item, 'title'));
    const link = extractTag(item, 'link') || extractTag(item, 'guid');
    const description = decodeHTMLEntities(stripHTML(extractTag(item, 'description') + extractTag(item, 'content:encoded')));
    const pubDate = extractTag(item, 'pubDate') || extractTag(item, 'dc:date');
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

    if (items.length >= 5) break;
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
        headers: { 'User-Agent': 'Happyhappyhappy/1.0 (+https://happyhappyhappy.aditya-pandya.workers.dev)' },
        signal: AbortSignal.timeout(10000)
      });
      if (!res.ok) { errors.push(`${source.name}: HTTP ${res.status}`); continue; }
      const xml = await res.text();
      const candidates = parseRSSItems(xml, source);

      for (const candidate of candidates) {
        const existing = await env.DB.prepare('SELECT id FROM items WHERE url = ?').bind(candidate.url).first();
        if (existing) { skipped++; continue; }

        const joyScore = await geminiScore(candidate.title, candidate.snippet, env.GEMINI_API_KEY);
        if (joyScore < 7) { skipped++; continue; }

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
  if (existing) return;

  const since = Math.floor(Date.now() / 1000) - 86400;
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

// ─── Reader mode — Musely-style Readability + Jina fallback ──────────────────

function cleanupArticleText(value: string, maxLength = 32000): string {
  const cleaned = String(value ?? '')
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&ldquo;|&rdquo;/gi, '"')
    .replace(/&lsquo;|&rsquo;/gi, "'")
    .replace(/&ndash;/gi, '-')
    .replace(/&mdash;/gi, '-')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/https?:\/\/\S+/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!cleaned) return '';
  return cleaned.length <= maxLength ? cleaned : cleaned.slice(0, maxLength).replace(/[\s,;:.-]+$/, '') + '…';
}

function extractWithReadability(htmlSource: string): { title: string; content: string; excerpt: string } | null {
  try {
    const { document } = parseHTML(htmlSource);
    document.querySelectorAll('script,style,noscript,iframe,header,footer,nav,aside,form').forEach((node: Element) => node.remove());
    const article = new Readability(document as unknown as Document, {
      charThreshold: 220,
      keepClasses: false,
      nbTopCandidates: 7,
      disableJSONLD: true,
    }).parse();
    if (!article) return null;
    const textContent = cleanupArticleText(article.textContent || article.content || '');
    if (!textContent || textContent.length < 280) return null;
    const excerpt = textContent.match(/^(.{60,320}?[.!?])(\s|$)/)?.[1] || textContent.slice(0, 280);
    return {
      title: String(article.title || '').trim(),
      content: textContent,
      excerpt: excerpt.replace(/[\s,;:.-]+$/, ''),
    };
  } catch {
    return null;
  }
}

function extractWithPatterns(htmlSource: string): string {
  const contentPatterns = [
    /<article[^>]*>([\s\S]*?)<\/article>/i,
    /<main[^>]*>([\s\S]*?)<\/main>/i,
    /<div[^>]*class=["'][^"']*(?:article|post)[^"']*(?:body|content)[^"']*["'][^>]*>([\s\S]*?)<\/div>/i,
    /<div[^>]*id=["'][^"']*(?:article|content|main)[^"']*["'][^>]*>([\s\S]*?)<\/div>/i,
  ];
  for (const pattern of contentPatterns) {
    const match = pattern.exec(htmlSource);
    const content = cleanupArticleText(match?.[1] || '');
    if (content.length >= 220) return content;
  }
  const bodyMatch = /<body[^>]*>([\s\S]*?)<\/body>/i.exec(htmlSource);
  return cleanupArticleText(bodyMatch?.[1] || '');
}

async function extractFromJina(targetUrl: string): Promise<string> {
  try {
    const stripped = targetUrl.replace(/^https?:\/\//i, '');
    if (!stripped) return '';
    const resp = await fetch('https://r.jina.ai/http://' + stripped, {
      headers: { 'accept': 'text/plain' },
      signal: AbortSignal.timeout(12000)
    });
    if (!resp.ok) return '';
    const raw = await resp.text();
    const cleaned = raw
      .replace(/^Title:\s.*$/gim, ' ')
      .replace(/^URL Source:\s.*$/gim, ' ')
      .replace(/^Published Time:\s.*$/gim, ' ')
      .replace(/^Author:\s.*$/gim, ' ')
      .replace(/^Markdown Content:\s*/gim, ' ')
      .replace(/^={2,}\s*$/gim, ' ')
      .replace(/^\s*[-*]\s*(Share|Tweet|Follow|Subscribe).+$/gim, ' ')
      .replace(/\b(?:Read more|Subscribe now|Sign up)\b.+$/gim, ' ')
      .trim();
    return cleanupArticleText(cleaned, 36000);
  } catch {
    return '';
  }
}

async function handleArticle(req: Request, env: Env): Promise<Response> {
  const url = new URL(req.url);
  const articleUrl = url.searchParams.get('url');
  if (!articleUrl) return Response.json({ error: 'url parameter required' }, { status: 400 });

  let normalizedUrl: string;
  try {
    const parsed = new URL(articleUrl);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return Response.json({ error: 'unsupported url protocol' }, { status: 400 });
    }
    normalizedUrl = parsed.toString();
  } catch {
    return Response.json({ error: 'invalid article url' }, { status: 400 });
  }

  // Fallback: return summary from DB if we can't fetch the article
  const fallbackFromDB = async (reason: string) => {
    const row = await env.DB.prepare('SELECT title, source, summary FROM items WHERE url = ? LIMIT 1')
      .bind(normalizedUrl).first<{ title: string; source: string; summary: string }>();
    return Response.json({
      ok: true,
      title: row?.title || '',
      content: row?.summary || '',
      excerpt: row?.summary || '',
      summary: row?.summary || '',
      url: normalizedUrl,
      fallback: true,
      reason
    });
  };

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 12000);
    let response: Response | null = null;
    try {
      response = await fetch(normalizedUrl, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          'Accept': 'text/html,application/xhtml+xml',
        },
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeout);
    }

    // If direct fetch failed, try Jina
    if (!response || !response.ok) {
      const jinaContent = await extractFromJina(normalizedUrl);
      if (jinaContent && jinaContent.length >= 120) {
        const aiSummary = await geminiSummarizeArticle('', jinaContent, env.GEMINI_API_KEY);
        return Response.json({
          ok: true, title: '', content: jinaContent,
          excerpt: aiSummary || jinaContent.slice(0, 300),
          summary: aiSummary || jinaContent.slice(0, 300),
          url: normalizedUrl
        });
      }
      return fallbackFromDB('fetch_failed');
    }

    const htmlText = await response.text();
    const titleMatch = /<title[^>]*>([^<]+)<\/title>/i.exec(htmlText);
    const pageTitle = titleMatch?.[1]?.trim() || '';

    // Try Readability first (best quality)
    const readability = extractWithReadability(htmlText);
    if (readability) {
      const aiSummary = await geminiSummarizeArticle(readability.title || pageTitle, readability.content, env.GEMINI_API_KEY);
      return Response.json({
        ok: true,
        title: readability.title || pageTitle,
        content: readability.content,
        excerpt: aiSummary || readability.excerpt,
        summary: aiSummary || readability.excerpt,
        url: normalizedUrl
      });
    }

    // Pattern-based extraction
    let content = extractWithPatterns(htmlText);
    if (!content || content.length < 260) {
      const jinaContent = await extractFromJina(normalizedUrl);
      if (jinaContent && jinaContent.length > content.length) content = jinaContent;
    }

    if (!content || content.length < 120) return fallbackFromDB('extract_failed');

    const aiSummary = await geminiSummarizeArticle(pageTitle, content, env.GEMINI_API_KEY);
    return Response.json({
      ok: true, title: pageTitle, content,
      excerpt: aiSummary || content.slice(0, 300),
      summary: aiSummary || content.slice(0, 300),
      url: normalizedUrl
    });

  } catch (e) {
    if ((e as Error)?.name === 'AbortError') {
      const jinaContent = await extractFromJina(normalizedUrl);
      if (jinaContent && jinaContent.length >= 120) {
        return Response.json({ ok: true, title: '', content: jinaContent, excerpt: jinaContent.slice(0, 300), summary: jinaContent.slice(0, 300), url: normalizedUrl });
      }
    }
    return fallbackFromDB('error');
  }
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function categoryLabel(cat: string): string {
  const map: Record<string, string> = { 'feel-good': 'Feel-good', 'science': 'Science', 'animals': 'Animals', 'arts': 'Arts' };
  return map[cat] ?? 'Good News';
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

  const dateStr = new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });
  const storiesHTML = items.results.map((item, i) => `
    <tr>
      <td style="padding: 0 0 32px 0;">
        <table cellpadding="0" cellspacing="0" border="0" width="100%">
          <tr>
            <td style="background: #ffffff; border-radius: 16px; border: 2px solid #111111; overflow: hidden;">
              ${item.image_url ? `
              <table cellpadding="0" cellspacing="0" border="0" width="100%">
                <tr><td style="padding: 0; line-height: 0;">
                  <img src="${escapeHtml(item.image_url)}" width="100%" height="220" style="display:block;object-fit:cover;border-radius:14px 14px 0 0;" alt="">
                </td></tr>
              </table>` : ''}
              <table cellpadding="0" cellspacing="0" border="0" width="100%">
                <tr>
                  <td style="padding: 24px 28px 28px;">
                    <p style="margin: 0 0 10px; font-family: 'DM Sans', Arial, sans-serif; font-size: 11px; font-weight: 700; letter-spacing: 0.08em; text-transform: uppercase; color: #7B2D8B;">${escapeHtml(categoryLabel(item.category))}</p>
                    <h2 style="margin: 0 0 14px; font-family: 'Fraunces', Georgia, serif; font-size: 22px; font-weight: 900; line-height: 1.25; color: #111111;">
                      <a href="${escapeHtml(item.url)}" style="color: #111111; text-decoration: none;">${escapeHtml(item.title)}</a>
                    </h2>
                    <p style="margin: 0 0 20px; font-family: 'DM Sans', Arial, sans-serif; font-size: 15px; line-height: 1.7; color: #444444;">${escapeHtml(item.summary ?? '')}</p>
                    <table cellpadding="0" cellspacing="0" border="0">
                      <tr>
                        <td style="background: #FF6B35; border-radius: 8px; border: 2px solid #111111;">
                          <a href="${escapeHtml(item.url)}" style="display:inline-block; padding: 10px 20px; font-family: 'DM Sans', Arial, sans-serif; font-size: 14px; font-weight: 700; color: #ffffff; text-decoration: none;">Read the full story &rarr;</a>
                        </td>
                        <td style="padding-left: 14px; font-family: 'DM Sans', Arial, sans-serif; font-size: 12px; color: #999999;">via ${escapeHtml(item.source)}</td>
                      </tr>
                    </table>
                  </td>
                </tr>
              </table>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  `).join('');

  const emailHTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>happyhappyhappy — ${dateStr}</title>
  <link href="https://fonts.googleapis.com/css2?family=Fraunces:wght@700;900&family=DM+Sans:wght@400;500;700&display=swap" rel="stylesheet">
</head>
<body style="margin:0;padding:0;background:#CDFF70;font-family:Arial,sans-serif;">
  <table cellpadding="0" cellspacing="0" border="0" width="100%" style="background:#CDFF70;">
    <tr>
      <td align="center" style="padding: 40px 20px;">
        <table cellpadding="0" cellspacing="0" border="0" width="600" style="max-width:600px;">

          <!-- Header -->
          <tr>
            <td style="padding: 0 0 32px 0;">
              <table cellpadding="0" cellspacing="0" border="0" width="100%" style="background:#111111;border-radius:20px;border:3px solid #111111;">
                <tr>
                  <td style="padding: 36px 40px; text-align: center;">
                    <img src="https://happyhappyhappy.aditya-pandya.workers.dev/icon-192.png" width="64" height="64" style="border-radius:16px;display:block;margin:0 auto 16px;" alt="">
                    <h1 style="margin:0 0 8px;font-family:'Fraunces',Georgia,serif;font-size:32px;font-weight:900;color:#CDFF70;letter-spacing:-0.5px;">happyhappyhappy</h1>
                    <p style="margin:0;font-family:'DM Sans',Arial,sans-serif;font-size:15px;color:#aaaaaa;">Your daily dose of good news &mdash; ${escapeHtml(dateStr)}</p>
                  </td>
                </tr>
              </table>
            </td>
          </tr>

          <!-- Intro -->
          <tr>
            <td style="padding: 0 0 28px 0;">
              <table cellpadding="0" cellspacing="0" border="0" width="100%" style="background:#ffffff;border-radius:16px;border:2px solid #111111;">
                <tr>
                  <td style="padding: 28px 32px; text-align:center;">
                    <h2 style="margin:0 0 8px;font-family:'Fraunces',Georgia,serif;font-size:26px;font-weight:900;color:#111111;">Good morning!</h2>
                    <p style="margin:0;font-family:'DM Sans',Arial,sans-serif;font-size:15px;color:#555555;line-height:1.6;">Here are today's happiest stories, curated just for you. Take a moment to enjoy them.</p>
                  </td>
                </tr>
              </table>
            </td>
          </tr>

          <!-- Stories -->
          <tr>
            <td>
              <table cellpadding="0" cellspacing="0" border="0" width="100%">
                ${storiesHTML}
              </table>
            </td>
          </tr>

          <!-- CTA -->
          <tr>
            <td style="padding: 8px 0 32px 0; text-align: center;">
              <table cellpadding="0" cellspacing="0" border="0" style="display:inline-table;">
                <tr>
                  <td style="background: #CDFF70; border-radius: 12px; border: 2px solid #111111; box-shadow: 3px 3px 0 #111111;">
                    <a href="https://happyhappyhappy.aditya-pandya.workers.dev" style="display:inline-block;padding:14px 28px;font-family:'DM Sans',Arial,sans-serif;font-size:15px;font-weight:700;color:#111111;text-decoration:none;">See all good news &rarr;</a>
                  </td>
                </tr>
              </table>
            </td>
          </tr>

          <!-- Footer -->
          <tr>
            <td style="padding: 0 0 40px 0; text-align: center;">
              <p style="margin:0;font-family:'DM Sans',Arial,sans-serif;font-size:13px;color:#666666;">Made with love for Aditya &amp; Shweta</p>
            </td>
          </tr>

        </table>
      </td>
    </tr>
  </table>
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
        subject: `Good news for ${new Date().toLocaleDateString('en-US', { month: 'long', day: 'numeric' })}`,
        html: emailHTML
      })
    });
  }
}

// ─── HTML Frontend ────────────────────────────────────────────────────────────
function renderHTML(feedItems: Item[], todayItems: Item[], activeTab: string, activeCategory: string): string {
  const heroItems = activeTab === 'today' ? todayItems : feedItems.slice(0, 7);
  const gridItems = activeTab === 'today' ? [] : feedItems.slice(7);

  const categories = [
    { id: '', label: 'All' },
    { id: 'feel-good', label: 'Feel-good' },
    { id: 'science', label: 'Science' },
    { id: 'animals', label: 'Animals' },
    { id: 'arts', label: 'Arts' }
  ];

  const heroCardsHTML = heroItems.map((item, i) => `
    <div class="hero-card" data-index="${i}"${i !== 0 ? ' hidden' : ''}>
      ${item.image_url ? `<div class="hero-img"><img src="${escapeHtml(item.image_url)}" alt="" loading="lazy" onerror="this.parentElement.remove()"></div>` : ''}
      <div class="hero-body">
        <span class="cat-tag">${escapeHtml(categoryLabel(item.category))}</span>
        <h2 class="hero-title">
          <a href="${escapeHtml(item.url)}" target="_blank" rel="noopener">${escapeHtml(item.title)}</a>
        </h2>
        <p class="hero-summary">${escapeHtml(item.summary ?? '')}</p>
        <div class="hero-foot">
          <span class="source">via ${escapeHtml(item.source)}</span>
          <div class="hero-actions">
            <button class="reader-btn" onclick="openReader('${encodeURIComponent(item.url)}','${escapeHtml(item.title.replace(/'/g, "\\'"))}')">Reader view</button>
            <a class="read-link" href="${escapeHtml(item.url)}" target="_blank" rel="noopener">Full story &rarr;</a>
          </div>
        </div>
      </div>
    </div>
  `).join('');

  const gridCardsHTML = gridItems.map(item => `
    <article class="card">
      ${item.image_url
        ? `<div class="card-img"><img src="${escapeHtml(item.image_url)}" alt="" loading="lazy" onerror="this.parentElement.remove()"></div>`
        : `<div class="card-img-placeholder"></div>`
      }
      <div class="card-body">
        <span class="cat-tag small">${escapeHtml(categoryLabel(item.category))}</span>
        <h3 class="card-title">
          <a href="${escapeHtml(item.url)}" target="_blank" rel="noopener">${escapeHtml(item.title)}</a>
        </h3>
        <p class="card-summary">${escapeHtml((item.summary ?? '').slice(0, 140))}…</p>
        <div class="card-foot">
          <span class="source">via ${escapeHtml(item.source)}</span>
          <button class="reader-btn small" onclick="openReader('${encodeURIComponent(item.url)}','${escapeHtml(item.title.replace(/'/g, "\\'"))}')">Read</button>
        </div>
      </div>
    </article>
  `).join('');

  const tickerText = feedItems.slice(0, 20).map(i => escapeHtml(i.title)).join(' &nbsp;&bull;&nbsp; ');
  const dateStr = new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover">
  <title>happyhappyhappy</title>
  <meta name="description" content="Your daily dose of happy, uplifting news">
  <meta name="theme-color" content="#CDFF70">
  <link rel="manifest" href="/manifest.json">
  <link rel="icon" href="/icon-192.png" type="image/png">
  <link rel="apple-touch-icon" href="/apple-touch-icon.png">
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link href="https://fonts.googleapis.com/css2?family=Fraunces:ital,opsz,wght@0,9..144,700;0,9..144,900;1,9..144,700&family=DM+Sans:wght@400;500;600;700&display=swap" rel="stylesheet">
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

    :root {
      --lime: #CDFF70;
      --lime-dark: #b8e85a;
      --orange: #FF6B35;
      --purple: #7B2D8B;
      --black: #111111;
      --white: #FFFFFF;
      --muted: #666666;
      --card-shadow: 3px 3px 0 var(--black);
      --card-shadow-hover: 5px 5px 0 var(--black);
      --radius: 16px;
      --radius-sm: 10px;
    }

    html { scroll-behavior: smooth; }

    body {
      font-family: 'DM Sans', system-ui, sans-serif;
      background: var(--lime);
      color: var(--black);
      min-height: 100vh;
      -webkit-font-smoothing: antialiased;
    }

    /* ── Header ── */
    .header {
      background: var(--black);
      /* iOS safe area: pad top for status bar under notch/dynamic island */
      padding: calc(14px + env(safe-area-inset-top)) 20px 14px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      position: sticky;
      top: 0;
      z-index: 200;
    }

    .logo {
      display: flex;
      align-items: center;
      gap: 10px;
      text-decoration: none;
      min-width: 0;
    }
    .logo img {
      width: 34px;
      height: 34px;
      border-radius: 8px;
      flex-shrink: 0;
    }
    .logo-text {
      font-family: 'Fraunces', Georgia, serif;
      font-size: 19px;
      font-weight: 900;
      color: var(--lime);
      letter-spacing: -0.3px;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }

    .nav {
      display: flex;
      gap: 4px;
      flex-shrink: 0;
    }
    .nav-btn {
      padding: 8px 18px;
      border-radius: 999px;
      border: none;
      cursor: pointer;
      font-family: 'DM Sans', sans-serif;
      font-weight: 600;
      font-size: 14px;
      text-decoration: none;
      color: rgba(255,255,255,0.55);
      background: transparent;
      transition: color 0.15s, background 0.15s;
      white-space: nowrap;
      -webkit-tap-highlight-color: transparent;
    }
    .nav-btn:hover { color: var(--white); }
    .nav-btn.active {
      background: var(--lime);
      color: var(--black);
    }

    /* ── Ticker ── */
    .ticker-wrap {
      background: var(--black);
      border-top: 1px solid #2a2a2a;
      overflow: hidden;
      padding: 7px 0;
    }
    .ticker {
      display: flex;
      white-space: nowrap;
      animation: scroll-ticker 80s linear infinite;
      font-size: 12px;
      font-weight: 500;
      color: var(--lime);
      opacity: 0.85;
    }
    .ticker-inner { padding: 0 12px; }
    @keyframes scroll-ticker {
      from { transform: translateX(0); }
      to { transform: translateX(-50%); }
    }

    /* ── Main ── */
    .main {
      max-width: 1100px;
      margin: 0 auto;
      padding: 28px 20px 60px;
    }

    /* ── Page title ── */
    .page-head {
      margin-bottom: 24px;
    }
    .page-title {
      font-family: 'Fraunces', Georgia, serif;
      font-size: clamp(28px, 5vw, 42px);
      font-weight: 900;
      line-height: 1.1;
      letter-spacing: -0.5px;
    }
    .page-date {
      margin-top: 6px;
      font-size: 14px;
      color: var(--muted);
      font-weight: 500;
    }

    /* ── Category filter ── */
    .cat-filter {
      display: flex;
      gap: 8px;
      flex-wrap: wrap;
      margin-bottom: 28px;
    }
    .cat-filter-btn {
      padding: 7px 16px;
      border-radius: 999px;
      border: 2px solid var(--black);
      background: transparent;
      cursor: pointer;
      font-family: 'DM Sans', sans-serif;
      font-size: 13px;
      font-weight: 600;
      text-decoration: none;
      color: var(--black);
      transition: background 0.15s, color 0.15s;
    }
    .cat-filter-btn:hover,
    .cat-filter-btn.active {
      background: var(--black);
      color: var(--lime);
    }

    /* ── Hero carousel ── */
    .hero-wrap {
      background: var(--white);
      border-radius: 20px;
      border: 2px solid var(--black);
      box-shadow: var(--card-shadow);
      overflow: hidden;
      margin-bottom: 48px;
    }
    .hero-card { display: none; }
    .hero-card:not([hidden]) { display: block; }

    .hero-img {
      width: 100%;
      height: 260px;
      overflow: hidden;
      background: var(--lime-dark);
    }
    .hero-img img {
      width: 100%;
      height: 100%;
      object-fit: cover;
      display: block;
    }

    .hero-body {
      padding: 28px 28px 20px;
    }

    .hero-title {
      font-family: 'Fraunces', Georgia, serif;
      font-size: clamp(20px, 3vw, 28px);
      font-weight: 900;
      line-height: 1.2;
      margin: 10px 0 14px;
    }
    .hero-title a {
      color: var(--black);
      text-decoration: none;
    }
    .hero-title a:hover { text-decoration: underline; }

    .hero-summary {
      font-size: 15px;
      line-height: 1.75;
      color: #333;
      margin-bottom: 20px;
    }

    .hero-foot {
      display: flex;
      align-items: center;
      justify-content: space-between;
      flex-wrap: wrap;
      gap: 12px;
      padding-top: 16px;
      border-top: 1px solid #eee;
    }
    .hero-actions {
      display: flex;
      gap: 10px;
      align-items: center;
    }

    /* ── Carousel controls ── */
    .carousel-controls {
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 14px;
      padding: 14px 28px 18px;
    }
    .carousel-btn {
      background: var(--black);
      color: var(--white);
      border: none;
      width: 34px;
      height: 34px;
      border-radius: 50%;
      cursor: pointer;
      font-size: 16px;
      display: flex;
      align-items: center;
      justify-content: center;
      flex-shrink: 0;
      transition: background 0.15s;
    }
    .carousel-btn:hover { background: var(--purple); }
    .dots {
      display: flex;
      gap: 6px;
      align-items: center;
    }
    .dot {
      width: 7px;
      height: 7px;
      border-radius: 50%;
      background: #ddd;
      cursor: pointer;
      transition: all 0.2s;
      border: none;
    }
    .dot.active {
      background: var(--orange);
      width: 18px;
      border-radius: 4px;
    }

    /* ── Category tag ── */
    .cat-tag {
      display: inline-block;
      padding: 4px 11px;
      border-radius: 999px;
      background: var(--lime);
      border: 1.5px solid var(--black);
      font-size: 11px;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.06em;
    }
    .cat-tag.small { font-size: 10px; padding: 3px 9px; }

    /* ── Buttons ── */
    .reader-btn {
      padding: 9px 18px;
      background: var(--black);
      color: var(--white);
      border: 2px solid var(--black);
      border-radius: var(--radius-sm);
      cursor: pointer;
      font-family: 'DM Sans', sans-serif;
      font-size: 13px;
      font-weight: 600;
      transition: background 0.15s, color 0.15s;
    }
    .reader-btn:hover {
      background: var(--purple);
      border-color: var(--purple);
    }
    .reader-btn.small {
      padding: 6px 13px;
      font-size: 12px;
    }

    .read-link {
      font-size: 14px;
      font-weight: 700;
      color: var(--orange);
      text-decoration: none;
    }
    .read-link:hover { text-decoration: underline; }

    .source {
      font-size: 12px;
      color: var(--muted);
    }

    /* ── Grid ── */
    .section-title {
      font-family: 'Fraunces', Georgia, serif;
      font-size: 26px;
      font-weight: 900;
      margin-bottom: 20px;
    }
    .grid {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(290px, 1fr));
      gap: 18px;
    }
    .card {
      background: var(--white);
      border-radius: var(--radius);
      border: 2px solid var(--black);
      box-shadow: var(--card-shadow);
      overflow: hidden;
      transition: transform 0.15s, box-shadow 0.15s;
      display: flex;
      flex-direction: column;
    }
    .card:hover {
      transform: translate(-2px, -2px);
      box-shadow: var(--card-shadow-hover);
    }
    .card-img {
      height: 150px;
      overflow: hidden;
      background: var(--lime-dark);
    }
    .card-img img {
      width: 100%;
      height: 100%;
      object-fit: cover;
      display: block;
    }
    .card-img-placeholder {
      height: 70px;
      background: linear-gradient(135deg, var(--lime) 0%, var(--lime-dark) 100%);
    }
    .card-body {
      padding: 16px;
      display: flex;
      flex-direction: column;
      flex: 1;
    }
    .card-title {
      font-family: 'Fraunces', Georgia, serif;
      font-size: 16px;
      font-weight: 700;
      line-height: 1.3;
      margin: 8px 0 9px;
    }
    .card-title a {
      color: var(--black);
      text-decoration: none;
    }
    .card-title a:hover { text-decoration: underline; }
    .card-summary {
      font-size: 13px;
      color: #555;
      line-height: 1.55;
      flex: 1;
      margin-bottom: 12px;
    }
    .card-foot {
      display: flex;
      align-items: center;
      justify-content: space-between;
      margin-top: auto;
      padding-top: 10px;
      border-top: 1px solid #f0f0f0;
    }

    /* ── Hero illustration ── */
    .hero-illo {
      width: 100%;
      border-radius: 20px;
      border: 2px solid var(--black);
      box-shadow: var(--card-shadow);
      overflow: hidden;
      margin-bottom: 32px;
    }
    .hero-illo img {
      width: 100%;
      display: block;
      max-height: 300px;
      object-fit: cover;
    }

    /* ── Empty state ── */
    .empty {
      text-align: center;
      padding: 80px 20px;
    }
    .empty img {
      width: 120px;
      margin-bottom: 20px;
    }
    .empty h2 {
      font-family: 'Fraunces', Georgia, serif;
      font-size: 26px;
      font-weight: 900;
      margin-bottom: 8px;
    }
    .empty p { color: var(--muted); font-size: 15px; }

    /* ── Reader modal ── */
    .reader-overlay {
      display: none;
      position: fixed;
      inset: 0;
      background: rgba(0,0,0,0.6);
      z-index: 500;
      padding: env(safe-area-inset-top) env(safe-area-inset-right) 0 env(safe-area-inset-left);
    }
    .reader-overlay.open { display: flex; align-items: flex-end; }
    .reader-sheet {
      background: var(--white);
      width: 100%;
      max-width: 720px;
      margin: 0 auto;
      border-radius: 20px 20px 0 0;
      max-height: 90vh;
      display: flex;
      flex-direction: column;
      overflow: hidden;
    }
    .reader-handle-bar {
      width: 40px;
      height: 4px;
      background: #ddd;
      border-radius: 2px;
      margin: 12px auto 0;
      flex-shrink: 0;
    }
    .reader-header {
      padding: 14px 20px 16px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      border-bottom: 1px solid #eee;
      flex-shrink: 0;
    }
    .reader-header-title {
      font-family: 'Fraunces', Georgia, serif;
      font-size: 16px;
      font-weight: 700;
      flex: 1;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      padding-right: 16px;
    }
    .reader-close {
      background: none;
      border: none;
      cursor: pointer;
      font-size: 22px;
      color: var(--muted);
      padding: 4px;
      flex-shrink: 0;
      line-height: 1;
    }
    .reader-close:hover { color: var(--black); }
    .reader-content {
      overflow-y: auto;
      flex: 1;
      padding: 24px 28px 40px;
    }
    .reader-content h1 {
      font-family: 'Fraunces', Georgia, serif;
      font-size: 26px;
      font-weight: 900;
      line-height: 1.2;
      margin-bottom: 20px;
    }
    .reader-content p {
      font-size: 17px;
      line-height: 1.8;
      color: #333;
      margin-bottom: 16px;
    }
    .reader-loading {
      text-align: center;
      padding: 48px 20px;
      color: var(--muted);
      font-size: 15px;
    }
    .reader-error {
      padding: 32px 20px;
      text-align: center;
    }
    .reader-error p { color: var(--muted); margin-bottom: 20px; }
    .reader-orig-link {
      display: inline-block;
      padding: 11px 22px;
      background: var(--orange);
      color: var(--white);
      font-weight: 700;
      text-decoration: none;
      border-radius: var(--radius-sm);
      font-size: 14px;
    }

    /* ── Footer ── */
    .footer {
      text-align: center;
      padding: 28px;
      font-size: 13px;
      color: var(--muted);
    }

    /* ── Responsive ── */
    @media (max-width: 640px) {
      /* On mobile, header safe-area is already handled by the base rule above */
      .header { padding-left: 16px; padding-right: 16px; padding-bottom: 12px; }
      .logo-text { font-size: 16px; }
      .nav-btn { padding: 8px 14px; font-size: 13px; }
      .main { padding: 20px 16px calc(48px + env(safe-area-inset-bottom)); }
      .hero-img { height: 200px; }
      .hero-body { padding: 20px 18px 16px; }
      .hero-foot { flex-direction: column; align-items: flex-start; gap: 10px; }
      .reader-content { padding: 20px 18px calc(32px + env(safe-area-inset-bottom)); }
      .reader-content h1 { font-size: 22px; }
      .reader-content p { font-size: 16px; }
    }
  </style>
</head>
<body>

<!-- Header -->
<header class="header">
  <a href="/" class="logo">
    <img src="/icon-192.png" alt="happyhappyhappy">
    <span class="logo-text">happyhappyhappy</span>
  </a>
  <nav class="nav">
    <a href="/?tab=today" class="nav-btn${activeTab === 'today' ? ' active' : ''}">Today</a>
    <a href="/?tab=all" class="nav-btn${activeTab === 'all' ? ' active' : ''}">All news</a>
  </nav>
</header>

<!-- Ticker -->
${tickerText ? `
<div class="ticker-wrap" aria-hidden="true">
  <div class="ticker">
    <span class="ticker-inner">${tickerText}</span>
    <span class="ticker-inner" aria-hidden="true">${tickerText}</span>
  </div>
</div>` : ''}

<!-- Main -->
<main class="main">

  <!-- Page heading -->
  <div class="page-head">
    <h1 class="page-title">${activeTab === 'today' ? "Today's dose" : 'All good news'}</h1>
    ${activeTab === 'today' ? `<p class="page-date">${escapeHtml(dateStr)}</p>` : ''}
  </div>

  ${activeTab === 'all' ? `
  <!-- Category filter -->
  <div class="cat-filter">
    ${categories.map(c => `<a href="/?tab=all${c.id ? '&cat=' + c.id : ''}" class="cat-filter-btn${activeCategory === c.id ? ' active' : ''}">${c.label}</a>`).join('')}
  </div>` : ''}

  ${heroItems.length > 0 ? `
  <!-- Hero carousel -->
  <div class="hero-wrap" id="carousel" data-total="${heroItems.length}">
    ${heroCardsHTML}
    ${heroItems.length > 1 ? `
    <div class="carousel-controls">
      <button class="carousel-btn" onclick="prevCard()" aria-label="Previous">&larr;</button>
      <div class="dots" id="dots">
        ${heroItems.map((_, i) => `<button class="dot${i === 0 ? ' active' : ''}" onclick="goCard(${i})" aria-label="Story ${i + 1}"></button>`).join('')}
      </div>
      <button class="carousel-btn" onclick="nextCard()" aria-label="Next">&rarr;</button>
    </div>` : ''}
  </div>` : `
  <!-- Empty state -->
  <div class="empty">
    <img src="/icon-192.png" alt="">
    <h2>Good news incoming!</h2>
    <p>Our happy-news robot is collecting stories. Check back soon!</p>
  </div>`}

  ${activeTab === 'today' && feedItems.length > 0 ? `
  <!-- Hero illustration strip -->
  <div class="hero-illo">
    <img src="/hero.png" alt="Joyful news illustration" loading="lazy">
  </div>` : ''}

  ${gridItems.length > 0 ? `
  <h2 class="section-title">More good news</h2>
  <div class="grid">${gridCardsHTML}</div>` : ''}

</main>

<!-- Footer -->
<footer class="footer">
  Made with love for Aditya &amp; Shweta &nbsp;&bull;&nbsp; <a href="/?tab=all" style="color:var(--purple)">all good news</a>
</footer>

<!-- Reader modal -->
<div class="reader-overlay" id="readerOverlay" role="dialog" aria-modal="true" aria-label="Reader view">
  <div class="reader-sheet" id="readerSheet">
    <div class="reader-handle-bar"></div>
    <div class="reader-header">
      <span class="reader-header-title" id="readerTitle"></span>
      <button class="reader-close" onclick="closeReader()" aria-label="Close">&times;</button>
    </div>
    <div class="reader-content" id="readerContent">
      <div class="reader-loading">Loading article&hellip;</div>
    </div>
  </div>
</div>

<script>
  // ── Carousel ──
  let cur = 0;
  const carousel = document.getElementById('carousel');
  const cards = carousel ? carousel.querySelectorAll('.hero-card') : [];
  const dotsEl = document.getElementById('dots');
  const dots = dotsEl ? dotsEl.querySelectorAll('.dot') : [];
  let autoTimer;

  function showCard(n) {
    if (!cards.length) return;
    n = (n + cards.length) % cards.length;
    cards.forEach((c, i) => { c.hidden = i !== n; });
    dots.forEach((d, i) => d.classList.toggle('active', i === n));
    cur = n;
  }
  function nextCard() { clearInterval(autoTimer); showCard(cur + 1); startAuto(); }
  function prevCard() { clearInterval(autoTimer); showCard(cur - 1); startAuto(); }
  function goCard(n) { clearInterval(autoTimer); showCard(n); startAuto(); }
  function startAuto() {
    if (cards.length > 1) autoTimer = setInterval(() => showCard(cur + 1), 9000);
  }
  startAuto();

  // Touch swipe on carousel
  let touchStartX = 0;
  if (carousel) {
    carousel.addEventListener('touchstart', e => { touchStartX = e.changedTouches[0].screenX; }, { passive: true });
    carousel.addEventListener('touchend', e => {
      const dx = e.changedTouches[0].screenX - touchStartX;
      if (Math.abs(dx) > 40) { dx < 0 ? nextCard() : prevCard(); }
    });
  }

  // ── Reader mode ──
  const overlay = document.getElementById('readerOverlay');
  const readerTitle = document.getElementById('readerTitle');
  const readerContent = document.getElementById('readerContent');
  let currentArticleUrl = '';

  function openReader(encodedUrl, title) {
    currentArticleUrl = decodeURIComponent(encodedUrl);
    readerTitle.textContent = title;
    readerContent.innerHTML = '<div class="reader-loading">Loading article&hellip;</div>';
    overlay.classList.add('open');
    document.body.style.overflow = 'hidden';

    fetch('/api/article?url=' + encodedUrl)
      .then(r => r.json())
      .then(data => {
        if (data.content) {
          const paragraphs = data.content
            .split(/\\n\\n+/)
            .filter(p => p.trim().length > 30)
            .slice(0, 30)
            .map(p => '<p>' + p.replace(/\\n/g, ' ').trim() + '</p>')
            .join('');
          readerContent.innerHTML =
            '<h1>' + (data.title || title) + '</h1>' +
            (paragraphs || '<p>' + data.content.slice(0, 2000) + '</p>');
        } else {
          showReaderError();
        }
      })
      .catch(showReaderError);
  }

  function showReaderError() {
    readerContent.innerHTML =
      '<div class="reader-error"><p>Could not load the article in reader mode.</p>' +
      '<a class="reader-orig-link" href="' + currentArticleUrl + '" target="_blank" rel="noopener">Open original article &rarr;</a></div>';
  }

  function closeReader() {
    overlay.classList.remove('open');
    document.body.style.overflow = '';
  }

  overlay.addEventListener('click', e => {
    if (e.target === overlay) closeReader();
  });

  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') closeReader();
  });

  // Swipe-down to close reader sheet
  const sheet = document.getElementById('readerSheet');
  let sheetTouchStartY = 0;
  sheet.addEventListener('touchstart', e => { sheetTouchStartY = e.changedTouches[0].screenY; }, { passive: true });
  sheet.addEventListener('touchend', e => {
    const dy = e.changedTouches[0].screenY - sheetTouchStartY;
    if (dy > 80) closeReader();
  });
</script>

</body>
</html>`;
}

// ─── Main request handler ─────────────────────────────────────────────────────
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    // PWA Manifest
    if (path === '/manifest.json') {
      return new Response(JSON.stringify({
        name: 'happyhappyhappy',
        short_name: 'HHH',
        description: 'Your daily dose of positive news',
        start_url: '/',
        display: 'standalone',
        background_color: '#CDFF70',
        theme_color: '#111111',
        icons: [
          { src: '/icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: '/icon-512.png', sizes: '512x512', type: 'image/png' },
          { src: '/apple-touch-icon.png', sizes: '180x180', type: 'image/png' }
        ]
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
      if (!digest) return Response.json({ items: [] });
      const ids = JSON.parse(digest.item_ids) as string[];
      const ph = ids.map(() => '?').join(',');
      const rows = await env.DB.prepare(`SELECT * FROM items WHERE id IN (${ph}) AND hidden = 0`).bind(...ids).all<Item>();
      return Response.json({ items: rows.results });
    }

    // API: full feed
    if (path === '/api/feed') {
      const category = url.searchParams.get('category') ?? '';
      const page = parseInt(url.searchParams.get('page') ?? '1', 10);
      const limit = 30;
      const offset = (page - 1) * limit;
      const rows = category
        ? await env.DB.prepare('SELECT * FROM items WHERE hidden = 0 AND category = ? ORDER BY published_at DESC, ingested_at DESC LIMIT ? OFFSET ?').bind(category, limit, offset).all<Item>()
        : await env.DB.prepare('SELECT * FROM items WHERE hidden = 0 ORDER BY published_at DESC, ingested_at DESC LIMIT ? OFFSET ?').bind(limit, offset).all<Item>();
      return Response.json({ items: rows.results, page, hasMore: rows.results.length === limit });
    }

    // API: reader mode article extraction
    if (path === '/api/article') {
      const articleUrl = url.searchParams.get('url') ?? '';
      if (!articleUrl) return Response.json({ error: 'No URL provided' }, { status: 400 });
      try {
        const decoded = decodeURIComponent(articleUrl);
        const article = await fetchArticleContent(decoded);
        return Response.json(article);
      } catch {
        return Response.json({ error: 'Failed to fetch article' }, { status: 500 });
      }
    }

    // Admin: manual ingest
    if (path === '/api/ingest' && request.method === 'POST') {
      const token = request.headers.get('Authorization')?.replace('Bearer ', '');
      if (!env.ADMIN_TOKEN || token !== env.ADMIN_TOKEN) return new Response('Unauthorized', { status: 401 });
      const result = await runIngestion(env);
      await buildDailyDigest(env);
      return Response.json(result);
    }

    // Admin: trigger email
    if (path === '/api/send-digest' && request.method === 'POST') {
      const token = request.headers.get('Authorization')?.replace('Bearer ', '');
      if (!env.ADMIN_TOKEN || token !== env.ADMIN_TOKEN) return new Response('Unauthorized', { status: 401 });
      await buildDailyDigest(env);
      await sendDailyEmail(env);
      return Response.json({ ok: true });
    }

    // Static assets (images) — pass through to ASSETS binding
    if (path.startsWith('/icon') || path.startsWith('/apple') || path.startsWith('/hero') || path === '/favicon.ico') {
      return env.ASSETS.fetch(request);
    }

    // Main UI — GET /
    if (path === '/' || path === '') {
      const tab = url.searchParams.get('tab') ?? 'today';
      const category = url.searchParams.get('cat') ?? '';

      const today = new Date().toISOString().slice(0, 10);
      const digest = await env.DB.prepare('SELECT item_ids FROM digest_days WHERE date = ?').bind(today).first<{ item_ids: string }>();

      let todayItems: Item[] = [];
      if (digest) {
        const ids = JSON.parse(digest.item_ids) as string[];
        const ph = ids.map(() => '?').join(',');
        const rows = await env.DB.prepare(`SELECT * FROM items WHERE id IN (${ph}) AND hidden = 0`).bind(...ids).all<Item>();
        todayItems = rows.results;
      }

      let feedItems: Item[] = [];
      if (category) {
        const rows = await env.DB.prepare('SELECT * FROM items WHERE hidden = 0 AND category = ? ORDER BY published_at DESC, ingested_at DESC LIMIT 50').bind(category).all<Item>();
        feedItems = rows.results;
      } else {
        const rows = await env.DB.prepare('SELECT * FROM items WHERE hidden = 0 ORDER BY published_at DESC, ingested_at DESC LIMIT 50').all<Item>();
        feedItems = rows.results;
      }

      const displayItems = tab === 'today' ? todayItems : feedItems;
      const html = renderHTML(displayItems, todayItems, tab, category);
      return new Response(html, {
        headers: {
          'Content-Type': 'text/html; charset=utf-8',
          'Cache-Control': 'no-cache'
        }
      });
    }

    // Fall through to static assets for anything else
    try {
      return await env.ASSETS.fetch(request);
    } catch {
      return new Response('Not found', { status: 404 });
    }
  },

  async scheduled(_event: ScheduledEvent, env: Env): Promise<void> {
    const hour = new Date().getUTCHours();
    await runIngestion(env);
    if (hour === 16) {
      await buildDailyDigest(env);
      await sendDailyEmail(env);
    }
  }
};
