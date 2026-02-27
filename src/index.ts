// Happyhappyhappy — Positive news for Aditya & Shweta
// Cloudflare Worker: serves inline HTML + REST API + cron ingestion + reader mode

import { parseHTML } from 'linkedom';
import { Readability } from '@mozilla/readability';

export interface Env {
  DB: D1Database;
  ASSETS: Fetcher;
  GEMINI_API_KEY: string;
  OPENAI_API_KEY?: string;
  LLM_SUMMARY_API_KEY?: string;
  LLM_SUMMARY_BASE_URL?: string;
  LLM_SUMMARY_MODEL?: string;
  OPENROUTER_API_KEY?: string;
  OPENROUTER_BASE_URL?: string;
  OPENROUTER_MODEL?: string;
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
  'overdose', 'assault', 'rape', 'fraud', 'hack', 'breach', 'ransomware',
  'layoffs', 'bankruptcy', 'downturn', 'crisis', 'toxic', 'threat', 'victim',
  'wound', 'collapse', 'scam', 'lawsuit', 'indicted', 'convicted', 'penalty',
  'sanctions', 'deportation', 'controversy', 'outrage', 'protest', 'strike'
];
const HISTORICAL_PATTERNS = [
  /\bin history\b/i,
  /\bchanged history\b/i,
  /\bhistorical\b/i,
  /\bcentur(?:y|ies)\b/i,
  /\bancient\b/i,
  /\bfrom \d{3,4}\b/i
];

function isNegative(title: string): boolean {
  const lower = title.toLowerCase();
  return NEGATIVE_KEYWORDS.some(kw => lower.includes(kw));
}

function isHistorical(title: string): boolean {
  return HISTORICAL_PATTERNS.some(rx => rx.test(title));
}

// ─── Gemini LLM helpers ───────────────────────────────────────────────────────
type GeminiResponse = { candidates?: Array<{ finishReason?: string; content?: { parts?: Array<{ text?: string }> } }> };
type LLMProviderConfig = { provider: 'responses' | 'chat'; endpoint: string; apiKey: string; models: string[] };

const SUMMARY_NOISE_PATTERNS: RegExp[] = [
  /(?:^|\s)(?:read more|continue reading|open in app|sign up|subscribe|sponsored by)\b/i,
  /(?:^|\s)(?:click here|learn more|watch now)\b/i,
  /https?:\/\/\S+/i,
  /<[^>]+>/,
  /\bhref=|src=/i,
];

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

function sanitizeNullableText(input: unknown): string | null {
  if (typeof input !== 'string') return null;
  const value = decodeHTMLEntities(input)
    .replace(/\s+/g, ' ')
    .replace(/[–—]/g, '-')
    .replace(/[\u201C\u201D]/g, '"')
    .replace(/[\u2018\u2019]/g, "'")
    .trim();
  return value ? value : null;
}

function ensureTerminalPunctuation(text: string): string {
  const trimmed = String(text || '').replace(/\s+/g, ' ').trim();
  if (!trimmed) return '';
  return /[.!?]$/.test(trimmed) ? trimmed : `${trimmed}.`;
}

function splitIntoSentences(text: string): string[] {
  return (text.match(/[^.!?]+[.!?]+|[^.!?]+$/g) || [])
    .map(s => s.replace(/\s+/g, ' ').trim())
    .filter(Boolean);
}

function cleanSummaryText(input: string, title?: string): string | null {
  const normalized = sanitizeNullableText(input);
  if (!normalized) return null;
  const titleNorm = sanitizeNullableText(typeof title === 'string' ? title : '')?.toLowerCase() || '';
  const sentences = splitIntoSentences(normalized);
  const kept: string[] = [];
  for (const sentence of sentences) {
    const lower = sentence.toLowerCase();
    if (SUMMARY_NOISE_PATTERNS.some(rx => rx.test(sentence))) continue;
    if (titleNorm && lower === titleNorm) continue;
    if (/^(listen|watch|subscribe|follow)\b/i.test(sentence)) continue;
    kept.push(sentence);
    if (kept.join(' ').length >= 820 || kept.length >= 5) break;
  }
  const merged = (kept.length ? kept.join(' ') : normalized)
    .replace(/\s+/g, ' ')
    .replace(/[,\s;:.-]+$/, '')
    .trim();
  if (!merged || SUMMARY_NOISE_PATTERNS.some(rx => rx.test(merged))) return null;
  if (/[<>]|href=|src=|http/i.test(merged)) return null;
  if (merged.length < 24) return null;
  return ensureTerminalPunctuation(merged.length > 820 ? merged.slice(0, 820).trim() : merged);
}

function sanitizeSummary(input: unknown, title?: unknown): string | null {
  const value = sanitizeNullableText(input);
  if (!value) return null;
  if (/^https?:\/\//i.test(value)) return null;
  return cleanSummaryText(value, typeof title === 'string' ? title : '');
}

function summaryFallbackFromTitle(title: unknown, source?: unknown): string {
  const t = sanitizeNullableText(title) || '';
  const s = sanitizeNullableText(source) || '';
  if (!t) return s ? `A story from ${s}.` : 'No summary available yet.';
  const base = t.length > 220 ? `${t.slice(0, 217).replace(/[,\s;:.-]+$/, '')}...` : t;
  return ensureTerminalPunctuation(`This ${s ? `story from ${s}` : 'article'} covers ${base}`);
}

function ensureReadableSummary(summary: unknown, title: unknown, source?: unknown): string {
  const clean = sanitizeSummary(summary, title);
  if (clean && clean.length >= 120) return clean;
  if (clean && clean.length >= 28) {
    const fallback = summaryFallbackFromTitle(title, source);
    if (clean.toLowerCase() === fallback.toLowerCase()) return clean;
    return ensureTerminalPunctuation(`${clean} ${fallback}`);
  }
  return summaryFallbackFromTitle(title, source);
}

function llmConfig(env: Env): LLMProviderConfig | null {
  const responsesKey = (env.LLM_SUMMARY_API_KEY || env.OPENAI_API_KEY || '').trim();
  const responsesModels = (env.LLM_SUMMARY_MODEL || '').split(',').map(s => s.trim()).filter(Boolean);
  if (responsesKey) {
    const raw = (env.LLM_SUMMARY_BASE_URL || '').trim();
    return {
      provider: 'responses',
      endpoint: raw ? (raw.endsWith('/responses') ? raw : `${raw.replace(/\/+$/, '')}/responses`) : 'https://api.openai.com/v1/responses',
      apiKey: responsesKey,
      models: responsesModels.length ? responsesModels : ['gpt-5.2', 'gpt-5-mini', 'gpt-4.1-mini']
    };
  }
  const openRouterKey = (env.OPENROUTER_API_KEY || '').trim();
  const openRouterModels = (env.OPENROUTER_MODEL || '').split(',').map(s => s.trim()).filter(Boolean);
  if (openRouterKey) {
    const raw = (env.OPENROUTER_BASE_URL || '').trim();
    return {
      provider: 'chat',
      endpoint: raw ? (raw.endsWith('/chat/completions') ? raw : `${raw.replace(/\/+$/, '')}/chat/completions`) : 'https://openrouter.ai/api/v1/chat/completions',
      apiKey: openRouterKey,
      models: openRouterModels.length ? openRouterModels : ['openai/gpt-5.2', 'openai/gpt-5-mini', 'openai/gpt-4.1-mini']
    };
  }
  return null;
}

function llmExtractText(payload: any): string {
  if (!payload) return '';
  const chatContent = payload?.choices?.[0]?.message?.content;
  if (typeof chatContent === 'string' && chatContent.trim()) return chatContent.trim();
  if (typeof payload.output_text === 'string' && payload.output_text.trim()) return payload.output_text.trim();
  const output = Array.isArray(payload.output) ? payload.output : [];
  const parts: string[] = [];
  for (const block of output) {
    const content = Array.isArray(block?.content) ? block.content : [];
    for (const c of content) {
      if (typeof c?.text === 'string' && c.text.trim()) parts.push(c.text.trim());
    }
  }
  return parts.join('\n').trim();
}

async function summarizeWithMuselyStyle(
  env: Env,
  payload: { title?: string | null; source?: string | null; url?: string | null; summary?: string | null; content?: string | null },
  fallbackApiKey: string
): Promise<string | null> {
  const title = String(payload.title || '').trim();
  const source = String(payload.source || '').trim();
  const url = String(payload.url || '').trim();
  const summary = String(payload.summary || '').trim();
  const content = String(payload.content || '').trim().slice(0, 12000);
  const context = [summary, content].filter(Boolean).join('\n\n');
  const prompt = [
    'You are improving news summaries for a personalized feed.',
    'Focus only on facts. Do not include any commentary.',
    'Write like a thoughtful human with domain knowledge. Be specific, neutral, and concise.',
    'No curly quotes, em dashes, en dashes, or semicolons. Use hyphens or parentheses instead.',
    'Write numbers with symbols (20%, 41 miles/hour).',
    'Avoid hype/puffery: "testament," "watershed," "breathtaking," "rich tapestry," "must-see," "enduring legacy."',
    'Avoid filler/meta: "as an AI," "in conclusion," "overall," "it is important to note."',
    'No essay padding, rote recaps, or hedges.',
    'Do not chain discourse markers like "moreover/furthermore/however/in contrast."',
    'Keep tone neutral. Prefer concrete nouns and active verbs. Remove trailing "highlighting/emphasizing" clauses.',
    'Use short, clear sentences. Vary length for rhythm. One idea per sentence.',
    'Finish thoughts cleanly with no abrupt cut-offs.',
    'If title is clickbait or listicle, include spoiler answers directly.',
    'If title says N things/reasons/ways, include the actual listed items from context.',
    'If title is phrased as X proved why Y, explicitly state why Y.',
    'Output only the summary text.',
    '',
    `Title: ${title || 'Untitled'}`,
    `Source: ${source || 'Unknown'}`,
    `URL: ${url || 'Unknown'}`,
    '',
    'Article context:',
    context || summaryFallbackFromTitle(title, source)
  ].join('\n');

  const config = llmConfig(env);
  if (config) {
    for (const model of config.models) {
      try {
        const response = await fetch(config.endpoint, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'authorization': `Bearer ${config.apiKey}`
          },
          body: JSON.stringify(config.provider === 'responses'
            ? { model, input: prompt, temperature: 0.2, max_output_tokens: 380 }
            : {
                model,
                messages: [
                  { role: 'system', content: 'You are a precise assistant for a personalized news app.' },
                  { role: 'user', content: prompt }
                ],
                temperature: 0.2,
                max_tokens: 380
              })
        });
        if (!response.ok) continue;
        const data = await response.json<any>();
        const generated = llmExtractText(data).replace(/[–—]/g, '-');
        const cleaned = sanitizeSummary(generated, title);
        if (cleaned) return ensureTerminalPunctuation(cleaned);
      } catch {
        continue;
      }
    }
  }

  const gemini = await geminiSummarize(title || 'Untitled', context || summary || title, fallbackApiKey);
  return sanitizeSummary(gemini, title);
}

async function geminiScore(title: string, snippet: string, apiKey: string): Promise<number> {
  const text = await geminiCall(
    GEMINI_SCORE_MODEL,
    `Rate how positive and uplifting this news story is on a scale of 1-10.

1-4 = negative, sad, or distressing
5 = neutral or purely technical
6 = mildly positive (policy changes, corporate news, dry findings)
7 = positive and pleasant to read
8 = genuinely uplifting and smile-inducing
9 = heartwarming (rescues, acts of kindness, community triumphs, adorable animals)
10 = extraordinarily inspiring

Stories from positive news sources about good things happening in the world should score 7+.
Only score below 7 if the story is truly neutral, technical, or negative.
Only reply with a single integer.

Title: ${title}
Snippet: ${snippet.slice(0, 300)}`,
    apiKey, 5, 0
  );
  const score = parseInt(text, 10);
  return isNaN(score) ? 0 : Math.min(10, Math.max(0, score));
}

async function geminiSummarize(title: string, content: string, apiKey: string): Promise<string> {
  return geminiCall(
    GEMINI_SUMMARY_MODEL,
    `Write a 3-4 sentence factual summary of this positive news story.
Write like a thoughtful human with domain knowledge. Be specific, neutral, and concise.
No curly quotes, em/en dashes, or semicolons. Use hyphens or parentheses.
Numbers with symbols (20%, 41 miles/hour).
Avoid hype/puffery, filler/meta language, essay padding, or hedges.
Use short clear sentences with concrete nouns and active verbs. Finish thoughts cleanly.
Output only the summary text.

Title: ${title}
Content: ${content.slice(0, 2000)}`,
    apiKey, 400, 0.3
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
  // Dedicated positive news sites
  { name: 'Good News Network', url: 'https://www.goodnewsnetwork.org/feed/', region: 'us' },
  { name: 'Positive News', url: 'https://www.positive.news/feed/', region: 'global' },
  { name: 'The Optimist Daily', url: 'https://www.optimistdaily.com/feed/', region: 'us' },
  { name: 'Upworthy', url: 'https://feeds.feedburner.com/upworthy', region: 'us' },
  { name: 'Happy News', url: 'https://www.happynews.com/rss/', region: 'us' },
  { name: 'Reasons to be Cheerful', url: 'https://reasonstobecheerful.world/feed/', region: 'global' },
  { name: 'DailyGood', url: 'https://www.dailygood.org/index.php?pg=syndicate', region: 'global' },
  // Reddit — high-volume feel-good communities (JSON API, parsed separately)
  { name: 'r/UpliftingNews', url: 'https://www.reddit.com/r/UpliftingNews/top.json?t=day&limit=10', region: 'global' },
  { name: 'r/MadeMeSmile', url: 'https://www.reddit.com/r/MadeMeSmile/top.json?t=day&limit=10', region: 'global' },
  { name: 'r/HumansBeingBros', url: 'https://www.reddit.com/r/HumansBeingBros/top.json?t=day&limit=10', region: 'global' },
  { name: 'r/aww', url: 'https://www.reddit.com/r/aww/top.json?t=day&limit=10', region: 'global' },
  { name: 'r/AnimalsBeingBros', url: 'https://www.reddit.com/r/AnimalsBeingBros/top.json?t=day&limit=10', region: 'global' },
  // Animals & nature
  { name: 'The Dodo', url: 'https://www.thedodo.com/feed', region: 'us' },
  { name: 'ZooBorns', url: 'https://www.zooborns.com/feed', region: 'global' },
  // India
  { name: 'The Better India', url: 'https://www.thebetterindia.com/feed/', region: 'india' },
  // Space inspiration
  { name: 'NASA', url: 'https://www.nasa.gov/rss/dyn/breaking_news.rss', region: 'us' },
];

function parseRSSItems(xml: string, source: RSSSource): Array<{ title: string; url: string; snippet: string; imageUrl: string | null; publishedAt: number | null }> {
  const items: Array<{ title: string; url: string; snippet: string; imageUrl: string | null; publishedAt: number | null }> = [];

  // Support both RSS (<item>) and Atom (<entry>) formats
  const itemRegex = /<(?:item|entry)>([\s\S]*?)<\/(?:item|entry)>/gi;
  let match;

  while ((match = itemRegex.exec(xml)) !== null) {
    const item = match[1];
    const title = decodeHTMLEntities(extractTag(item, 'title'));

    // RSS uses <link>url</link>, Atom uses <link href="url"/>
    const rssLink = extractTag(item, 'link') || extractTag(item, 'guid');
    const atomLink = extractAttr(item, 'link', 'href');
    const link = rssLink || atomLink;

    const description = decodeHTMLEntities(stripHTML(
      extractTag(item, 'description') ||
      extractTag(item, 'content:encoded') ||
      extractTag(item, 'content') ||
      extractTag(item, 'summary')
    ));
    const pubDate = extractTag(item, 'pubDate') || extractTag(item, 'dc:date') ||
      extractTag(item, 'updated') || extractTag(item, 'published');
    const mediaUrl = extractAttr(item, 'media:content', 'url') ||
      extractAttr(item, 'media:thumbnail', 'url') ||
      extractAttr(item, 'enclosure', 'url') ||
      extractImgSrc(extractTag(item, 'description') || extractTag(item, 'content'));

    if (!title || !link) continue;
    if (isNegative(title)) continue;
    if (isHistorical(title)) continue;

    const publishedAt = pubDate ? Math.floor(new Date(pubDate).getTime() / 1000) : null;
    if (publishedAt) {
      const ageSeconds = Math.floor(Date.now() / 1000) - publishedAt;
      if (ageSeconds > 60 * 60 * 24 * 10) continue;
    }
    items.push({
      title: title.trim(),
      url: link.trim(),
      snippet: description.slice(0, 500),
      imageUrl: mediaUrl || null,
      publishedAt
    });

    if (items.length >= 10) break;
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
    .replace(/&#(\d+);/g, (_m, dec) => {
      const n = Number.parseInt(dec, 10);
      return Number.isFinite(n) ? String.fromCodePoint(n) : _m;
    })
    .replace(/&#x([0-9a-fA-F]+);/g, (_m, hex) => {
      const n = Number.parseInt(hex, 16);
      return Number.isFinite(n) ? String.fromCodePoint(n) : _m;
    })
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
const MIN_FEED_ITEMS = 10;

const MIN_NEW_ITEMS_PER_REFRESH = 5;

const JOYFUL_FALLBACK_STORIES = [
  {
    title: 'Neighbors turn an empty lot into a free community play garden',
    summary: 'Residents organized weekend build days, collected donated tools, and transformed an unused lot into a playful green space for families. The project now hosts free story hours, toy swaps, and after-school activities. Local volunteers maintain the garden in rotating shifts, and nearby shops contribute supplies. The result is a simple, joyful place where kids and parents can gather without cost.'
  },
  {
    title: 'Library launches "borrow a hobby" kits and sees families learning together',
    summary: 'A public library introduced take-home kits for beginner gardening, music, drawing, and science experiments. Families report using the kits to spend more time learning together in the evenings. Teachers say the kits are helping children build confidence through small wins. The program is expanding after strong community demand and donations.'
  },
  {
    title: 'Local cooks create a rotating free-meal night for new parents',
    summary: 'A group of home cooks started a neighborhood dinner train for families with newborns and toddlers. Volunteers coordinate weekly menus and deliveries so parents can rest and focus on their children. Participation has grown through word of mouth, with more residents offering to help each month. Organizers say the effort is about practical kindness during demanding life stages.'
  },
  {
    title: 'Students build a kindness map that connects elders with daily support',
    summary: 'High school students created a simple neighborhood map that matches seniors with volunteers for grocery runs, tech help, and check-ins. The project started as a class assignment and quickly became a community routine. Families say the regular visits reduce loneliness and make daily tasks easier. Students also gain real-world experience in service and leadership.'
  },
  {
    title: 'Animal shelter reunion day helps dozens of pets find permanent homes',
    summary: 'A shelter hosted a reunion and adoption event where foster families shared success stories and introduced adoptable pets. The event drew strong turnout from local residents and partner rescue groups. Staff reported a meaningful increase in completed adoptions and volunteer sign-ups. Organizers plan to repeat the event seasonally to keep momentum going.'
  },
  {
    title: 'Commuters fund surprise school supplies for an entire elementary grade',
    summary: 'Daily commuters teamed up to cover classroom supply lists for a full elementary grade before the new term. Teachers say the support removed a major financial burden for many families. Parents described feeling relieved and encouraged by the community effort. The group now plans a recurring back-to-school fund each year.'
  },
  {
    title: 'Weekend repair cafe fixes bikes and laptops for free in one afternoon',
    summary: 'Volunteer mechanics and technicians opened a drop-in repair cafe to fix everyday essentials at no charge. Residents brought in bikes, laptops, and small appliances, with many items restored in minutes. The event reduced waste and helped families avoid replacement costs. Organizers are scheduling monthly sessions after the first event exceeded expectations.'
  }
];

async function insertFallbackJoyStories(env: Env, count: number, reason: string): Promise<number> {
  const now = Math.floor(Date.now() / 1000);
  let added = 0;
  for (let i = 0; i < count; i++) {
    const seed = JOYFUL_FALLBACK_STORIES[(now + i) % JOYFUL_FALLBACK_STORIES.length];
    const id = generateId();
    const uniqueUrl = `https://happyhappyhappy.local/fallback/${now}-${i}-${id.slice(0, 8)}`;
    await env.DB.prepare(`
      INSERT INTO items (id, title, url, source, source_region, summary, image_url, published_at, joy_score, category, reading_time)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      id,
      seed.title,
      uniqueUrl,
      'Happyhappyhappy Curated',
      'global',
      ensureReadableSummary(seed.summary, seed.title, 'Happyhappyhappy Curated'),
      null,
      now,
      8,
      'feel-good',
      1
    ).run();
    added++;
  }
  return added;
}

async function ensureRefreshHasAtLeast(env: Env, minimumNewItems: number): Promise<number> {
  const ingest = await runIngestion(env);
  const missing = Math.max(0, minimumNewItems - ingest.added);
  if (missing > 0) {
    const fallbackAdded = await insertFallbackJoyStories(env, missing, 'refresh-topup');
    return ingest.added + fallbackAdded;
  }
  return ingest.added;
}

async function countFeedItems(env: Env): Promise<number> {
  const row = await env.DB.prepare('SELECT COUNT(*) as cnt FROM items WHERE hidden = 0 AND joy_score >= 7').first<{ cnt: number }>();
  return row?.cnt ?? 0;
}

interface ScoredCandidate {
  title: string;
  url: string;
  snippet: string;
  imageUrl: string | null;
  publishedAt: number | null;
  source: RSSSource;
  joyScore: number;
  heartCheck: boolean;
}

async function runIngestion(env: Env): Promise<{ added: number; skipped: number; errors: string[] }> {
  let added = 0;
  let skipped = 0;
  const errors: string[] = [];

  // Collect all new candidates from all sources first
  const allCandidates: Array<{ title: string; url: string; snippet: string; imageUrl: string | null; publishedAt: number | null; source: RSSSource }> = [];

  for (const source of RSS_SOURCES) {
    try {
      const isReddit = source.url.includes('reddit.com') && source.url.endsWith('.json?t=day&limit=10');
      const res = await fetch(source.url, {
        headers: { 'User-Agent': 'Happyhappyhappy/1.0 (by /u/happyhappyhappy_bot)' },
        signal: AbortSignal.timeout(10000)
      });
      if (!res.ok) { errors.push(`${source.name}: HTTP ${res.status}`); continue; }

      if (isReddit) {
        const json = await res.json() as { data?: { children?: Array<{ data: { title: string; url: string; selftext?: string; permalink: string; thumbnail?: string; created_utc: number; is_self?: boolean } }> } };
        const posts = json?.data?.children ?? [];
        for (const post of posts.slice(0, 10)) {
          const d = post.data;
          const title = d.title;
          if (!title || isNegative(title) || isHistorical(title)) continue;
          const url = d.is_self ? `https://www.reddit.com${d.permalink}` : d.url;
          const snippet = d.selftext?.slice(0, 500) || title;
          const imageUrl = (d.thumbnail && d.thumbnail.startsWith('http')) ? d.thumbnail : null;
          const publishedAt = d.created_utc ? Math.floor(d.created_utc) : null;
          allCandidates.push({ title, url, snippet, imageUrl, publishedAt, source });
        }
      } else {
        const xml = await res.text();
        const items = parseRSSItems(xml, source);
        for (const item of items) {
          allCandidates.push({ ...item, source });
        }
      }
    } catch (err) {
      errors.push(`${source.name}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // Deduplicate against DB — only keep new URLs
  const newCandidates: typeof allCandidates = [];
  for (const c of allCandidates) {
    if (isNegative(c.title) || isHistorical(c.title)) { skipped++; continue; }
    const existing = await env.DB.prepare('SELECT id FROM items WHERE url = ?').bind(c.url).first();
    if (existing) { skipped++; continue; }
    newCandidates.push(c);
  }

  // Score new candidates (cap at 80 to stay within CPU limits)
  const toScore = newCandidates.slice(0, 80);
  const scored: ScoredCandidate[] = [];

  for (const c of toScore) {
    const joyScore = await geminiScore(c.title, c.snippet, env.GEMINI_API_KEY);

    // Only run heartwarming check on items that pass the minimum score
    let heartCheck = false;
    if (joyScore >= 7) {
      const hc = await geminiCall(
        GEMINI_SCORE_MODEL,
        `Is this news story genuinely heartwarming, inspiring, or smile-inducing? Consider whether it would make an ordinary person feel warm and happy inside.
Stories about neutral science findings, policy changes, corporate earnings, or dry technical achievements should get NO.
Stories about rescues, kindness, community, cute animals, personal triumphs, or hopeful breakthroughs should get YES.
Reply with only YES or NO.

Title: ${c.title}
Snippet: ${c.snippet.slice(0, 300)}`,
        env.GEMINI_API_KEY, 5, 0
      );
      heartCheck = hc.toUpperCase().trim() === 'YES';
    }

    scored.push({ ...c, joyScore, heartCheck });
  }

  // Sort by quality: heartwarming + high score first
  scored.sort((a, b) => {
    if (a.heartCheck !== b.heartCheck) return a.heartCheck ? -1 : 1;
    return b.joyScore - a.joyScore;
  });

  // Determine how many items we need to reach the minimum
  const currentCount = await countFeedItems(env);
  const needed = Math.max(0, MIN_FEED_ITEMS - currentCount);

  // Insert items using progressive thresholds — keep going until we have MIN_FEED_ITEMS:
  // Pass 1: score >= 8 AND heartwarming (best quality)
  // Pass 2: score >= 7 AND heartwarming (good quality)
  // Pass 3: score >= 7 (acceptable)
  // Pass 4: score >= 6 (last resort — ensures we always hit the minimum)
  const inserted = new Set<string>();

  // Passes 1-2 always run (add all high-quality items). Passes 3-4 only run if below minimum.
  const passes: Array<{ filter: (c: ScoredCandidate) => boolean; onlyIfNeeded: boolean }> = [
    { filter: (c) => c.joyScore >= 8 && c.heartCheck, onlyIfNeeded: false },
    { filter: (c) => c.joyScore >= 7 && c.heartCheck, onlyIfNeeded: false },
    { filter: (c) => c.joyScore >= 7, onlyIfNeeded: true },
    { filter: (c) => c.joyScore >= 6, onlyIfNeeded: true },
  ];

  for (const { filter: pass, onlyIfNeeded } of passes) {
    if (onlyIfNeeded && (currentCount + inserted.size) >= MIN_FEED_ITEMS) break;
    for (const c of scored) {
      if (inserted.has(c.url)) continue;
      if (!pass(c)) continue;

      const [summaryRaw, category] = await Promise.all([
        summarizeWithMuselyStyle(env, {
          title: c.title,
          source: c.source.name,
          url: c.url,
          summary: c.snippet,
          content: c.snippet
        }, env.GEMINI_API_KEY),
        geminiCategory(c.title, env.GEMINI_API_KEY)
      ]);
      const summary = ensureReadableSummary(summaryRaw, c.title, c.source.name);
      const readingTime = Math.max(1, Math.ceil(c.snippet.split(' ').length / 200));

      await env.DB.prepare(`
        INSERT INTO items (id, title, url, source, source_region, summary, image_url, published_at, joy_score, category, reading_time)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).bind(
        generateId(),
        c.title,
        c.url,
        c.source.name,
        c.source.region,
        summary || ensureReadableSummary(c.snippet.slice(0, 200), c.title, c.source.name),
        c.imageUrl,
        c.publishedAt,
        c.joyScore,
        category,
        readingTime
      ).run();

      inserted.add(c.url);
      added++;
    }
  }

  skipped += scored.filter(c => !inserted.has(c.url)).length;
  return { added, skipped, errors };
}

// ─── Daily feed rebuild — wipe yesterday's items and fill with fresh content ──
async function rebuildFeed(env: Env): Promise<{ pruned: number; added: number; skipped: number; feedCount: number; errors: string[] }> {
  // Clear ALL non-hidden items — fresh slate every day
  const purge = await env.DB.prepare('DELETE FROM items WHERE hidden = 0').run();
  const pruned = purge.meta?.changes ?? 0;

  // Run ingestion on the clean slate — all RSS URLs are now "new" again
  const ingest = await runIngestion(env);

  let feedCount = await countFeedItems(env);
  if (feedCount < MIN_FEED_ITEMS) {
    await insertFallbackJoyStories(env, MIN_FEED_ITEMS - feedCount, 'daily-rebuild-topup');
    feedCount = await countFeedItems(env);
  }
  return { pruned, added: ingest.added, skipped: ingest.skipped, feedCount, errors: ingest.errors };
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
  const sentences = cleaned.match(/[^.!?]+[.!?]+|[^.!?]+$/g) || [];
  const junk = [
    /^(share|follow|subscribe|advertisement|cookie|privacy policy|terms of use)\b/i,
    /\b(sign up|newsletter|all rights reserved|javascript is required)\b/i,
    /\b(back to top|related articles|you may also like)\b/i,
    /^\s*(menu|search|home)\s*$/i
  ];
  const filtered = sentences
    .map(s => s.replace(/\s+/g, ' ').trim())
    .filter(s => s.length > 28)
    .filter(s => !junk.some(rx => rx.test(s)))
    .join(' ')
    .trim();
  const finalText = filtered || cleaned;
  return finalText.length <= maxLength ? finalText : finalText.slice(0, maxLength).replace(/[\s,;:.-]+$/, '') + '…';
}

function extractWithReadability(htmlSource: string): { title: string; content: string; htmlContent: string; excerpt: string } | null {
  try {
    const { document } = parseHTML(htmlSource);
    document.querySelectorAll('script,style,noscript,header,footer,nav,aside,form').forEach((node: Element) => node.remove());
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
      htmlContent: article.content || '',
      excerpt: excerpt.replace(/[\s,;:.-]+$/, ''),
    };
  } catch {
    return null;
  }
}

function extractLeadImageFromHtml(htmlSource: string, baseUrl: string): string {
  const pick = [
    /<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i,
    /<meta[^>]+name=["']twitter:image(?::src)?["'][^>]+content=["']([^"']+)["']/i,
    /<img[^>]+src=["']([^"']+)["'][^>]*>/i,
  ];
  for (const rx of pick) {
    const m = rx.exec(htmlSource);
    const src = m?.[1]?.trim();
    if (!src) continue;
    try {
      const abs = new URL(src, baseUrl).toString();
      if (/^https?:\/\//i.test(abs)) return abs;
    } catch {
      continue;
    }
  }
  return '';
}

function proxiedImageUrl(raw: string): string {
  const clean = String(raw || '').trim();
  if (!clean) return '';
  return `/api/image?url=${encodeURIComponent(clean)}`;
}

function backupImageUrl(raw: string): string {
  const clean = String(raw || '').trim();
  if (!clean) return '';
  const stripped = clean.replace(/^https?:\/\//i, '');
  return `https://images.weserv.nl/?url=${encodeURIComponent(stripped)}&w=1200&h=675&fit=cover&a=attention&output=webp&q=84`;
}

async function handleImageProxy(req: Request): Promise<Response> {
  const u = new URL(req.url);
  const target = u.searchParams.get('url') || '';
  if (!target) return new Response('Missing url', { status: 400 });
  let parsed: URL;
  try {
    parsed = new URL(target);
  } catch {
    return new Response('Bad url', { status: 400 });
  }
  if (!/^https?:$/.test(parsed.protocol)) return new Response('Bad protocol', { status: 400 });
  const fallbackRedirect = () => Response.redirect(backupImageUrl(parsed.toString()), 302);
  try {
    const upstream = await fetch(parsed.toString(), {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; happyhappyhappy-image-proxy/1.0)',
        'Accept': 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8',
        'Referer': `${parsed.protocol}//${parsed.host}/`,
        'Origin': `${parsed.protocol}//${parsed.host}`,
      },
      redirect: 'follow',
      signal: AbortSignal.timeout(12000)
    });
    if (!upstream.ok || !upstream.body) return fallbackRedirect();
    const ct = upstream.headers.get('content-type') || 'image/jpeg';
    const looksLikeImageByExt = /\.(avif|webp|png|jpe?g|gif|bmp|svg)(?:$|\?)/i.test(parsed.pathname + parsed.search);
    if (!ct.startsWith('image/') && !looksLikeImageByExt) return fallbackRedirect();
    return new Response(upstream.body, {
      status: 200,
      headers: {
        'Content-Type': ct,
        'Cache-Control': 'public, max-age=86400, s-maxage=604800',
        'X-Content-Type-Options': 'nosniff'
      }
    });
  } catch {
    return fallbackRedirect();
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
      const row = await env.DB.prepare('SELECT title, source, summary, image_url FROM items WHERE url = ? LIMIT 1')
        .bind(normalizedUrl).first<{ title: string; source: string; summary: string; image_url: string | null }>();
      const fallbackSummary = ensureReadableSummary(row?.summary || '', row?.title || '', row?.source || '');
      return Response.json({
        ok: true,
        title: row?.title || '',
        content: fallbackSummary,
        excerpt: fallbackSummary,
        summary: fallbackSummary,
        image: row?.image_url ? proxiedImageUrl(row.image_url) : '',
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
        const aiSummary = await summarizeWithMuselyStyle(env, { title: '', url: normalizedUrl, content: jinaContent }, env.GEMINI_API_KEY);
        return Response.json({
          ok: true, title: '', content: jinaContent,
          excerpt: ensureReadableSummary(aiSummary || jinaContent.slice(0, 300), '', ''),
          summary: ensureReadableSummary(aiSummary || jinaContent.slice(0, 300), '', ''),
          url: normalizedUrl
        });
      }
      return fallbackFromDB('fetch_failed');
    }

    const htmlText = await response.text();
    const titleMatch = /<title[^>]*>([^<]+)<\/title>/i.exec(htmlText);
    const pageTitle = titleMatch?.[1]?.trim() || '';
    const leadImage = extractLeadImageFromHtml(htmlText, normalizedUrl);

    // Try Readability first (best quality)
    const readability = extractWithReadability(htmlText);
    if (readability) {
      const aiSummary = await summarizeWithMuselyStyle(env, {
        title: readability.title || pageTitle,
        url: normalizedUrl,
        content: readability.content,
        summary: readability.excerpt
      }, env.GEMINI_API_KEY);
      return Response.json({
        ok: true,
        title: readability.title || pageTitle,
        content: readability.content,
        htmlContent: readability.htmlContent,
        excerpt: ensureReadableSummary(aiSummary || readability.excerpt, readability.title || pageTitle, ''),
        summary: ensureReadableSummary(aiSummary || readability.excerpt, readability.title || pageTitle, ''),
        image: leadImage ? proxiedImageUrl(leadImage) : '',
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

    const aiSummary = await summarizeWithMuselyStyle(env, {
      title: pageTitle,
      url: normalizedUrl,
      content
    }, env.GEMINI_API_KEY);
    return Response.json({
      ok: true, title: pageTitle, content,
      excerpt: ensureReadableSummary(aiSummary || content.slice(0, 300), pageTitle, ''),
      summary: ensureReadableSummary(aiSummary || content.slice(0, 300), pageTitle, ''),
      image: leadImage ? proxiedImageUrl(leadImage) : '',
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
  const shortDateStr = new Date().toLocaleDateString('en-US', { weekday: 'short', day: '2-digit', month: 'short' }).toUpperCase();
  const storiesHTML = items.results.map((item, i) => `
    <tr>
      <td style="padding: 0 0 22px 0;">
        <table cellpadding="0" cellspacing="0" border="0" width="100%">
          <tr>
            <td style="background: #f7f7f7; border-radius: 26px; border: 2px solid #111111; overflow: hidden;">
              ${item.image_url ? `
              <table cellpadding="0" cellspacing="0" border="0" width="100%">
                <tr><td style="padding: 0; line-height: 0;">
                  <img src="${escapeHtml(item.image_url)}" width="100%" height="220" style="display:block;object-fit:cover;border-radius:24px 24px 0 0;background:#e9f8c5;" alt="">
                </td></tr>
              </table>` : `
              <table cellpadding="0" cellspacing="0" border="0" width="100%" style="background:#b7ec59;">
                <tr>
                  <td style="padding:26px 22px; text-align:center;">
                    <img src="https://happyhappyhappy.aditya-pandya.workers.dev/icon-192.png" width="52" height="52" style="border-radius:14px;display:block;margin:0 auto 10px;" alt="">
                    <p style="margin:0;font-family:'DM Sans',Arial,sans-serif;font-size:14px;font-weight:700;color:#1f2937;">Good news pick #${i + 1}</p>
                  </td>
                </tr>
              </table>`}
              <table cellpadding="0" cellspacing="0" border="0" width="100%">
                <tr>
                  <td style="padding: 18px 22px 20px;">
                    <span style="display:inline-block;padding:5px 12px;border-radius:999px;border:2px solid #111111;background:#CDFF70;margin:0 0 12px;font-family:'DM Sans',Arial,sans-serif;font-size:11px;font-weight:800;letter-spacing:0.08em;text-transform:uppercase;color:#111111;">${escapeHtml(categoryLabel(item.category))}</span>
                    <h2 style="margin: 0 0 12px; font-family: 'Fraunces', Georgia, serif; font-size: 32px; font-weight: 900; line-height: 1.2; color: #111111;">
                      <a href="${escapeHtml(item.url)}" style="color: #111111; text-decoration: none;">${escapeHtml(item.title)}</a>
                    </h2>
                    <p style="margin: 0 0 16px; font-family: 'DM Sans', Arial, sans-serif; font-size: 15px; line-height: 1.65; color: #444444;">${escapeHtml(item.summary ?? '')}</p>
                    <table cellpadding="0" cellspacing="0" border="0">
                      <tr>
                        <td style="background: #111111; border-radius: 12px; border: 2px solid #111111;">
                          <a href="${escapeHtml(item.url)}" style="display:inline-block; padding: 10px 18px; font-family: 'DM Sans', Arial, sans-serif; font-size: 14px; font-weight: 700; color: #ffffff; text-decoration: none;">Full story</a>
                        </td>
                        <td style="padding-left: 10px; background: #CDFF70; border-radius: 12px; border: 2px solid #111111;">
                          <a href="https://happyhappyhappy.aditya-pandya.workers.dev/" style="display:inline-block; padding: 10px 16px; font-family: 'DM Sans', Arial, sans-serif; font-size: 14px; font-weight: 700; color: #111111; text-decoration: none;">Read in app</a>
                        </td>
                      </tr>
                    </table>
                    <p style="margin:10px 0 0;font-family:'DM Sans',Arial,sans-serif;font-size:12px;font-weight:600;color:#777777;">via ${escapeHtml(item.source)}</p>
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
      <td align="center" style="padding: 28px 14px;">
        <table cellpadding="0" cellspacing="0" border="0" width="600" style="max-width:600px;">

          <!-- Header -->
          <tr>
            <td style="padding: 0 0 20px 0;">
              <table cellpadding="0" cellspacing="0" border="0" width="100%" style="background:#CDFF70;border-radius:26px;border:2px solid #111111;">
                <tr>
                  <td style="padding: 22px 24px 20px;">
                    <table cellpadding="0" cellspacing="0" border="0" width="100%">
                      <tr>
                        <td valign="middle" style="width:62px;">
                          <img src="https://happyhappyhappy.aditya-pandya.workers.dev/icon-192.png" width="52" height="52" style="border-radius:14px;display:block;" alt="">
                        </td>
                        <td valign="middle">
                          <h1 style="margin:0 0 2px;font-family:'Fraunces',Georgia,serif;font-size:44px;font-weight:900;color:#111111;letter-spacing:-0.8px;line-height:1;">happyhappyhappy</h1>
                          <p style="margin:0;font-family:'DM Sans',Arial,sans-serif;font-size:14px;font-weight:700;letter-spacing:0.08em;text-transform:uppercase;color:#4b5563;">${escapeHtml(shortDateStr)}</p>
                        </td>
                      </tr>
                    </table>
                  </td>
                </tr>
              </table>
            </td>
          </tr>

          <!-- Intro -->
          <tr>
            <td style="padding: 0 0 20px 0;">
              <table cellpadding="0" cellspacing="0" border="0" width="100%" style="background:#f7f7f7;border-radius:26px;border:2px solid #111111;">
                <tr>
                  <td style="padding: 20px 20px;">
                    <h2 style="margin:0 0 8px;font-family:'Fraunces',Georgia,serif;font-size:54px;font-weight:900;color:#111111;line-height:1.02;letter-spacing:-0.8px;">All good news</h2>
                    <p style="margin:0 0 14px;font-family:'DM Sans',Arial,sans-serif;font-size:15px;color:#444444;line-height:1.6;">Fresh uplifting stories from your app feed.</p>
                    <table cellpadding="0" cellspacing="0" border="0">
                      <tr>
                        <td style="padding:0 8px 8px 0;"><span style="display:inline-block;padding:7px 14px;border-radius:999px;background:#111111;color:#CDFF70;border:2px solid #111111;font-family:'DM Sans',Arial,sans-serif;font-size:13px;font-weight:700;">All</span></td>
                        <td style="padding:0 8px 8px 0;"><span style="display:inline-block;padding:7px 14px;border-radius:999px;background:#CDFF70;color:#111111;border:2px solid #111111;font-family:'DM Sans',Arial,sans-serif;font-size:13px;font-weight:700;">Feel-good</span></td>
                        <td style="padding:0 8px 8px 0;"><span style="display:inline-block;padding:7px 14px;border-radius:999px;background:#CDFF70;color:#111111;border:2px solid #111111;font-family:'DM Sans',Arial,sans-serif;font-size:13px;font-weight:700;">Science</span></td>
                        <td style="padding:0 0 8px 0;"><span style="display:inline-block;padding:7px 14px;border-radius:999px;background:#CDFF70;color:#111111;border:2px solid #111111;font-family:'DM Sans',Arial,sans-serif;font-size:13px;font-weight:700;">Animals</span></td>
                      </tr>
                    </table>
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
            <td style="padding: 2px 0 22px 0; text-align: center;">
              <table cellpadding="0" cellspacing="0" border="0" style="display:inline-table;">
                <tr>
                  <td style="background: #111111; border-radius: 12px; border: 2px solid #111111;">
                    <a href="https://happyhappyhappy.aditya-pandya.workers.dev" style="display:inline-block;padding:12px 22px;font-family:'DM Sans',Arial,sans-serif;font-size:14px;font-weight:700;color:#CDFF70;text-decoration:none;">Open full feed</a>
                  </td>
                </tr>
              </table>
            </td>
          </tr>

          <!-- Footer -->
          <tr>
            <td style="padding: 0 0 20px 0; text-align: center;">
              <p style="margin:0;font-family:'DM Sans',Arial,sans-serif;font-size:13px;font-weight:600;color:#374151;">Made with &#10084; for Shweta &amp; Aditya</p>
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
  const displayItems = activeTab === 'today' ? todayItems : feedItems;

  const uiIcon = (name: string): string => {
    const icons: Record<string, string> = {
      spark: '<span class="ui-ico" aria-hidden="true"><svg width="24" height="24" viewBox="0 0 24 24" stroke-width="1" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M3 12C9.26752 12 12 9.36306 12 3C12 9.36306 14.7134 12 21 12C14.7134 12 12 14.7134 12 21C12 14.7134 9.26752 12 3 12Z" stroke="currentColor" stroke-linejoin="round"/></svg></span>',
      microscope: '<span class="ui-ico" aria-hidden="true"><svg width="24" height="24" viewBox="0 0 24 24" stroke-width="1" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M19 22H7M5 22H7M7 22V19" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"/><path d="M19 16H10" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"/><path d="M16 2L12 2" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"/><path d="M12 7C9 7 7 8 7 11V13" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"/><path d="M16 4.6V11.4C16 11.7314 15.7314 12 15.4 12H12.6C12.2686 12 12 11.7314 12 11.4V4.6C12 4.26863 12.2686 4 12.6 4H15.4C15.7314 4 16 4.26863 16 4.6Z" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"/><path d="M7 19C5.34315 19 4 17.6569 4 16C4 14.3431 5.34315 13 7 13C8.65685 13 10 14.3431 10 16C10 17.6569 8.65685 19 7 19Z" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"/></svg></span>',
      paw: '<span class="ui-ico" aria-hidden="true"><svg width="24" height="24" viewBox="0 0 24 24" stroke-width="1" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M7 21C7 21 7.5 16.5 11 12.5" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"/><path d="M19.1297 4.24224L19.7243 10.4167C20.0984 14.3026 17.1849 17.7626 13.2989 18.1367C9.486 18.5039 6.03191 15.7168 5.66477 11.9039C5.29763 8.09099 8.09098 4.70237 11.9039 4.33523L18.475 3.70251C18.8048 3.67074 19.098 3.91239 19.1297 4.24224Z" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"/></svg></span>',
      palette: '<span class="ui-ico" aria-hidden="true"><svg width="24" height="24" stroke-width="1" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M20.5096 9.54C20.4243 9.77932 20.2918 9.99909 20.12 10.1863C19.9483 10.3735 19.7407 10.5244 19.5096 10.63C18.2796 11.1806 17.2346 12.0745 16.5002 13.2045C15.7659 14.3345 15.3733 15.6524 15.3696 17C15.3711 17.4701 15.418 17.9389 15.5096 18.4C15.5707 18.6818 15.5747 18.973 15.5215 19.2564C15.4682 19.5397 15.3588 19.8096 15.1996 20.05C15.0649 20.2604 14.8877 20.4403 14.6793 20.5781C14.4709 20.7158 14.2359 20.8085 13.9896 20.85C13.4554 20.9504 12.9131 21.0006 12.3696 21C11.1638 21.0006 9.97011 20.7588 8.85952 20.2891C7.74893 19.8194 6.74405 19.1314 5.90455 18.2657C5.06506 17.4001 4.40807 16.3747 3.97261 15.2502C3.53714 14.1257 3.33208 12.9252 3.36959 11.72C3.4472 9.47279 4.3586 7.33495 5.92622 5.72296C7.49385 4.11097 9.60542 3.14028 11.8496 3H12.3596C14.0353 3.00042 15.6777 3.46869 17.1017 4.35207C18.5257 5.23544 19.6748 6.49885 20.4196 8C20.6488 8.47498 20.6812 9.02129 20.5096 9.52V9.54Z" stroke="currentColor" stroke-width="1"/><path d="M8 16.01L8.01 15.9989" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"/><path d="M6 12.01L6.01 11.9989" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"/><path d="M8 8.01L8.01 7.99889" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"/><path d="M12 6.01L12.01 5.99889" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"/><path d="M16 8.01L16.01 7.99889" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"/></svg></span>',
      sun: '<span class="ui-ico" aria-hidden="true"><svg width="24" height="24" stroke-width="1" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M12 18C15.3137 18 18 15.3137 18 12C18 8.68629 15.3137 6 12 6C8.68629 6 6 8.68629 6 12C6 15.3137 8.68629 18 12 18Z" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"/><path d="M22 12L23 12" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"/><path d="M12 2V1" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"/><path d="M12 23V22" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"/><path d="M20 20L19 19" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"/><path d="M20 4L19 5" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"/><path d="M4 20L5 19" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"/><path d="M4 4L5 5" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"/><path d="M1 12L2 12" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"/></svg></span>',
      globe: '<span class="ui-ico" aria-hidden="true"><svg width="24" height="24" stroke-width="1" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M12 22C17.5228 22 22 17.5228 22 12C22 6.47715 17.5228 2 12 2C6.47715 2 2 6.47715 2 12C2 17.5228 6.47715 22 12 22Z" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"/><path d="M2.5 12.5L8 14.5L7 18L8 21" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"/><path d="M17 20.5L16.5 18L14 17V13.5L17 12.5L21.5 13" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"/><path d="M19 5.5L18.5 7L15 7.5V10.5L17.5 9.5H19.5L21.5 10.5" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"/><path d="M2.5 10.5L5 8.5L7.5 8L9.5 5L8.5 3" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"/></svg></span>',
      grid: '<span class="ui-ico" aria-hidden="true"><svg width="24" height="24" stroke-width="1" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M14 20.4V14.6C14 14.2686 14.2686 14 14.6 14H20.4C20.7314 14 21 14.2686 21 14.6V20.4C21 20.7314 20.7314 21 20.4 21H14.6C14.2686 21 14 20.7314 14 20.4Z" stroke="currentColor" stroke-width="1"/><path d="M3 20.4V14.6C3 14.2686 3.26863 14 3.6 14H9.4C9.73137 14 10 14.2686 10 14.6V20.4C10 20.7314 9.73137 21 9.4 21H3.6C3.26863 21 3 20.7314 3 20.4Z" stroke="currentColor" stroke-width="1"/><path d="M14 9.4V3.6C14 3.26863 14.2686 3 14.6 3H20.4C20.7314 3 21 3.26863 21 3.6V9.4C21 9.73137 20.7314 10 20.4 10H14.6C14.2686 10 14 9.73137 14 9.4Z" stroke="currentColor" stroke-width="1"/><path d="M3 9.4V3.6C3 3.26863 3.26863 3 3.6 3H9.4C9.73137 3 10 3.26863 10 3.6V9.4C10 9.73137 9.73137 10 9.4 10H3.6C3.26863 10 3 9.73137 3 9.4Z" stroke="currentColor" stroke-width="1"/></svg></span>',
      settings: '<span class="ui-ico" aria-hidden="true"><svg width="24" height="24" stroke-width="1" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M12 15C13.6569 15 15 13.6569 15 12C15 10.3431 13.6569 9 12 9C10.3431 9 9 10.3431 9 12C9 13.6569 10.3431 15 12 15Z" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"/><path d="M19.6224 10.3954L18.5247 7.7448L20 6L18 4L16.2647 5.48295L13.5578 4.36974L12.9353 2H10.981L10.3491 4.40113L7.70441 5.51596L6 4L4 6L5.45337 7.78885L4.3725 10.4463L2 11V13L4.40111 13.6555L5.51575 16.2997L4 18L6 20L7.79116 18.5403L10.397 19.6123L11 22H13L13.6045 19.6132L16.2551 18.5155C16.6969 18.8313 18 20 18 20L20 18L18.5159 16.2494L19.6139 13.598L21.9999 12.9772L22 11L19.6224 10.3954Z" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"/></svg></span>',
      type: '<span class="ui-ico" aria-hidden="true"><svg width="24" height="24" stroke-width="1" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M7 16.2485C7 16.0894 6.93679 15.9368 6.82426 15.8243L3.17574 12.1757C3.06321 12.0632 3 11.9106 3 11.7515V4C3 2.89543 3.89543 2 5 2H12H19C20.1046 2 21 2.89543 21 4V11.7515C21 11.9106 20.9368 12.0632 20.8243 12.1757L17.1757 15.8243C17.0632 15.9368 17 16.0894 17 16.2485V20C17 21.1046 16.1046 22 15 22H9C7.89543 22 7 21.1046 7 20V16.2485Z" stroke="currentColor" stroke-width="1"/><path d="M9.5 11.5L10 10.4M14.5 11.5L14 10.4M14 10.4L12 6L10 10.4M14 10.4H10" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"/></svg></span>',
      spacing: '<span class="ui-ico" aria-hidden="true"><svg width="24" height="24" stroke-width="1" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M3 6H21" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"/><path d="M3 10H21" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"/><path d="M3 14H21" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"/><path d="M3 18H21" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"/></svg></span>',
      heart: '<span class="ui-ico" aria-hidden="true"><svg width="24" height="24" stroke-width="1" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M22 8.86222C22 10.4087 21.4062 11.8941 20.3458 12.9929C17.9049 15.523 15.5374 18.1613 13.0053 20.5997C12.4249 21.1505 11.5042 21.1304 10.9488 20.5547L3.65376 12.9929C1.44875 10.7072 1.44875 7.01723 3.65376 4.73157C5.88044 2.42345 9.50794 2.42345 11.7346 4.73157L11.9998 5.00642L12.2648 4.73173C13.3324 3.6245 14.7864 3 16.3053 3C17.8242 3 19.2781 3.62444 20.3458 4.73157C21.4063 5.83045 22 7.31577 22 8.86222Z" stroke="currentColor" stroke-linejoin="round"/></svg></span>',
      book: '<span class="ui-ico" aria-hidden="true"><svg width="24" stroke-width="1" height="24" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M4 19V5C4 3.89543 4.89543 3 6 3H19.4C19.7314 3 20 3.26863 20 3.6V16.7143" stroke="currentColor" stroke-linecap="round"/><path d="M6 17L20 17" stroke="currentColor" stroke-linecap="round"/><path d="M6 21L20 21" stroke="currentColor" stroke-linecap="round"/><path d="M6 21C4.89543 21 4 20.1046 4 19C4 17.8954 4.89543 17 6 17" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"/><path d="M9 7L15 7" stroke="currentColor" stroke-linecap="round"/></svg></span>',
      external: '<span class="ui-ico" aria-hidden="true"><svg width="24" height="24" viewBox="0 0 24 24" stroke-width="1" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M21 3L15 3M21 3L12 12M21 3V9" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"/><path d="M21 13V19C21 20.1046 20.1046 21 19 21H5C3.89543 21 3 20.1046 3 19V5C3 3.89543 3.89543 3 5 3H11" stroke="currentColor" stroke-linecap="round"/></svg></span>',
    };
    return icons[name] || '';
  };

  const categories = [
    { id: '', label: 'All', icon: 'grid' },
    { id: 'feel-good', label: 'Feel-good', icon: 'spark' },
    { id: 'science', label: 'Science', icon: 'microscope' },
    { id: 'animals', label: 'Animals', icon: 'paw' },
    { id: 'arts', label: 'Arts', icon: 'palette' }
  ];
  const imagePreloads = displayItems
    .slice(0, 8)
    .flatMap(item => item.image_url ? [proxiedImageUrl(item.image_url), backupImageUrl(item.image_url)] : [])
    .filter(src => !!src)
    .map(src => `<link rel="preload" as="image" href="${escapeHtml(src)}" fetchpriority="high" crossorigin>`)
    .join('\n');

  const storyCardsHTML = displayItems.map((item, i) => `
    <article class="story-card swipe-card" data-url="${encodeURIComponent(item.url)}" data-title="${escapeHtml(item.title)}">
      <div class="story-img${item.image_url ? (i === 0 ? ' is-ready' : '') : ' no-image'}">
        ${item.image_url ? `
        <img class="story-img-blur"
          src="${escapeHtml(proxiedImageUrl(item.image_url))}"
          alt=""
          loading="${i < 2 ? 'eager' : 'lazy'}"
          decoding="async"
          fetchpriority="${i < 2 ? 'high' : 'auto'}"
          referrerpolicy="no-referrer"
          aria-hidden="true"
        >
        <img
          class="story-main"
          src="${escapeHtml(proxiedImageUrl(item.image_url))}"
          data-proxy-src="${escapeHtml(proxiedImageUrl(item.image_url))}"
          data-backup-src="${escapeHtml(backupImageUrl(item.image_url))}"
          alt=""
          loading="${i < 4 ? 'eager' : 'lazy'}"
          decoding="async"
          fetchpriority="${i < 2 ? 'high' : 'auto'}"
          referrerpolicy="no-referrer"
          onload="this.closest('.story-img') && this.closest('.story-img').classList.add('is-ready')"
          onerror="window.handleCardImageError && window.handleCardImageError(this)"
        >` : ''}
        <div class="story-fallback-art">
          <span class="story-fallback-icon ${escapeHtml(item.category || 'feel-good')}">${uiIcon(
            item.category === 'science' ? 'microscope'
              : item.category === 'animals' ? 'paw'
              : item.category === 'arts' ? 'palette'
              : 'spark'
          )}</span>
          <span class="story-fallback-title">${escapeHtml(item.title)}</span>
        </div>
      </div>
      <div class="story-body">
        <span class="cat-tag">${escapeHtml(categoryLabel(item.category))}</span>
        <h2 class="story-title">${escapeHtml(item.title)}</h2>
        ${(() => {
          const summary = item.summary ?? '';
          const paragraphs = summary.split(/(?<=[.!?])\s+/).filter(s => s.trim()).map(s => `<p>${escapeHtml(s)}</p>`).join('');
          const isLong = summary.length > 650;
          return isLong
            ? `<div class="summary-wrap" id="sw-${i}"><div class="story-summary">${paragraphs}</div></div>
        <button class="summary-toggle" data-wrap="sw-${i}" onclick="toggleSummary(this)">Show more</button>`
            : `<div class="story-summary">${paragraphs}</div>`;
        })()}
        <div class="story-foot">
          <span class="source-label">via ${escapeHtml(item.source)}</span>
          <div class="story-actions">
            <button class="btn-reader" onclick="openReader('${encodeURIComponent(item.url)}','${escapeHtml(item.title.replace(/'/g, "\\'"))}')">
              ${uiIcon('book')}
              Read
            </button>
            <a class="btn-link" href="${escapeHtml(item.url)}" target="_blank" rel="noopener">
              Full story
              ${uiIcon('external')}
            </a>
          </div>
        </div>
      </div>
    </article>
  `).join('');

  const dateStr = new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });
  const shortDateStr = new Date().toLocaleDateString('en-US', { weekday: 'short', day: '2-digit', month: 'short' });

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover">
  <title>happyhappyhappy</title>
  <meta name="description" content="Your daily dose of happy, uplifting news">
  <meta name="theme-color" content="#111111">
  <link rel="manifest" href="/manifest.json">
  <link rel="icon" href="/icon-192.png" type="image/png">
  <link rel="apple-touch-icon" href="/apple-touch-icon.png">
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://images.weserv.nl" crossorigin>
  <link rel="dns-prefetch" href="https://images.weserv.nl">
  <link href="https://fonts.googleapis.com/css2?family=Fraunces:ital,opsz,wght@0,9..144,700;0,9..144,900;1,9..144,700&family=DM+Sans:wght@400;500;600;700&family=Manrope:wght@500;600;700;800&family=Source+Serif+4:opsz,wght@8..60,400;8..60,600;8..60,700&display=swap" rel="stylesheet">
  ${imagePreloads}
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

    :root {
      --lime: #CDFF70;
      --lime-dark: #b8e85a;
      --orange: #FF6B35;
      --purple: #7B2D8B;
      --black: #111111;
      --white: #FFFFFF;
      --muted: #888888;
      --bg: #CDFF70;
      --radius: 18px;
      --radius-sm: 10px;
      --bottom-nav-h: 64px;
      --safe-bottom: env(safe-area-inset-bottom, 0px);
      --font-scale: 1;
      --line-scale: 1;
      --font-body: 'DM Sans', system-ui, sans-serif;
      --font-heading: 'Fraunces', Georgia, serif;
    }

    /* ── Color themes ── */
    body[data-theme='peach']    { --bg: #FFD6C0; --lime: #FFD6C0; --lime-dark: #f0c0a8; }
    body[data-theme='sky']      { --bg: #B8E0F6; --lime: #B8E0F6; --lime-dark: #9dd0ee; }
    body[data-theme='mint']     { --bg: #B8F0D0; --lime: #B8F0D0; --lime-dark: #9ee0b8; }
    body[data-theme='midnight'] {
      --bg: #1a1a2e; --lime: #CDFF70; --lime-dark: #b8e85a;
      --black: #e8e8e8; --muted: #999;
    }
    body[data-theme='midnight'] .story-card { background: #222238; border-color: #444; box-shadow: 0 2px 0 rgba(0,0,0,0.3); }
    body[data-theme='midnight'] .story-summary { color: #bbb; }
    body[data-theme='midnight'] .story-foot { border-top-color: #333; }
    body[data-theme='midnight'] .cat-tag { background: #2a2a44; color: #CDFF70; border-color: #555; }
    body[data-theme='midnight'] .cat-pill { border-color: #555; color: #ddd; }
    body[data-theme='midnight'] .cat-pill:hover,
    body[data-theme='midnight'] .cat-pill.active { background: #CDFF70; color: #111; }
    body[data-theme='midnight'] .settings-sheet { background: #1e1e32; border-color: #444; color: #ddd; }
    body[data-theme='midnight'] .settings-title { color: #eee; }
    body[data-theme='midnight'] .setting-label { color: #bbb; }
    body[data-theme='midnight'] .font-opt { background: #2a2a44; border-color: #555; color: #ddd; }
    body[data-theme='midnight'] .font-opt.active { background: #CDFF70; color: #111; border-color: #CDFF70; }
    body[data-theme='midnight'] .theme-opt { border-color: #555; }
    body[data-theme='midnight'] .theme-opt.active { border-color: #CDFF70; }
    body[data-theme='midnight'] .settings-open-btn { border-color: rgba(255,255,255,0.25); background: rgba(255,255,255,0.1); color: #ccc; }
    body[data-theme='midnight'] .story-img { background: #2a2a44; }
    body[data-theme='midnight'] .story-fallback-icon { background: rgba(255,255,255,0.1); border-color: rgba(255,255,255,0.15); color: #ccc; }
    body[data-theme='midnight'] .story-fallback-title { color: #ddd; text-shadow: none; }
    body[data-theme='midnight'] .feed-date { color: #999; }
    body[data-theme='midnight'] .swipe-status { color: #999; }
    body[data-theme='midnight'] .swipe-hint { color: #777; }
    body[data-theme='midnight'] .footer-note { color: #888; }
    body[data-theme='midnight'] .reader-sheet { background: #1e1e32; }
    body[data-theme='midnight'] .reader-header { border-bottom-color: #333; }
    body[data-theme='midnight'] .reader-header-title { color: #ddd; }
    body[data-theme='midnight'] .reader-body p { color: #ccc; }
    body[data-theme='midnight'] .reader-body h1,
    body[data-theme='midnight'] .reader-body h2,
    body[data-theme='midnight'] .reader-body h3 { color: #eee; }
    body[data-theme='midnight'] .reader-body blockquote { background: #2a2a44; border-left-color: #CDFF70; }
    body[data-theme='midnight'] .btn-reader { background: #CDFF70; color: #111; border-color: #CDFF70; }
    body[data-theme='midnight'] .btn-link { background: #2a2a44; color: #CDFF70; border-color: #555; }
    body[data-theme='midnight'] .swipe-card.is-active { box-shadow: 0 3px 0 rgba(0,0,0,0.35); }
    body[data-theme='midnight'] .setting-value { color: #888; }

    html { scroll-behavior: smooth; }
    .ui-ico {
      display: inline-flex;
      width: 1em;
      height: 1em;
      line-height: 1;
      flex-shrink: 0;
    }
    .ui-ico svg {
      width: 100%;
      height: 100%;
      display: block;
      stroke-width: 1;
    }

    body {
      font-family: var(--font-body);
      background: var(--bg);
      color: var(--black);
      min-height: 100dvh;
      -webkit-font-smoothing: antialiased;
      /* push content above bottom nav and footer note */
      padding-bottom: calc(var(--bottom-nav-h) + 54px + var(--safe-bottom));
    }
    body[data-font='clean'] {
      --font-body: 'Manrope', system-ui, sans-serif;
      --font-heading: 'Manrope', system-ui, sans-serif;
    }
    body[data-font='editorial'] {
      --font-body: 'Source Serif 4', Georgia, serif;
      --font-heading: 'Fraunces', Georgia, serif;
    }

    /* ── Top wordmark (non-sticky, scrolls away) ── */
    .wordmark {
      padding: 20px 20px 0;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
    }
    .wordmark-left {
      display: flex;
      align-items: center;
      gap: 10px;
    }
    .wordmark img {
      width: 32px;
      height: 32px;
      border-radius: 8px;
    }
    .wordmark-text {
      font-family: var(--font-heading);
      font-size: 20px;
      font-weight: 900;
      color: var(--black);
      letter-spacing: -0.3px;
    }
    .settings-open-btn {
      width: 30px;
      height: 30px;
      border-radius: 999px;
      border: 1.5px solid rgba(17,17,17,0.35);
      background: rgba(255,255,255,0.55);
      color: #475569;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      cursor: pointer;
      -webkit-tap-highlight-color: transparent;
      opacity: 0.8;
      transition: opacity 0.18s ease, background 0.18s ease, transform 0.18s ease;
    }
    .settings-open-btn:hover {
      opacity: 1;
      background: rgba(255,255,255,0.78);
      transform: translateY(-0.5px);
    }
    .settings-open-btn .ui-ico { width: 14px; height: 14px; }

    /* ── Bottom tab bar (iOS native pattern) ── */
    .bottom-nav {
      position: fixed;
      bottom: 0;
      left: 0;
      right: 0;
      z-index: 300;
      background: var(--black);
      display: flex;
      align-items: stretch;
      /* safe area for home indicator */
      padding-bottom: var(--safe-bottom);
      border-top: 2px solid #222;
    }
    .tab-btn {
      flex: 1;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      gap: 3px;
      height: var(--bottom-nav-h);
      border: none;
      background: none;
      cursor: pointer;
      font-family: 'DM Sans', sans-serif;
      font-size: 11px;
      font-weight: 600;
      color: rgba(255,255,255,0.45);
      text-decoration: none;
      -webkit-tap-highlight-color: transparent;
      transition: color 0.15s;
      letter-spacing: 0.01em;
    }
    .tab-btn:hover { color: rgba(255,255,255,0.75); }
    .tab-btn.active { color: var(--lime); }
    .tab-icon {
      width: 24px;
      height: 24px;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      transition: transform 0.2s ease, filter 0.2s ease;
    }
    .tab-icon .ui-ico { width: 20px; height: 20px; }
    .tab-icon.today { color: #f97316; }
    .tab-icon.all { color: #0ea5e9; }
    .tab-btn.active .tab-icon {
      transform: translateY(-1px);
      filter: saturate(1.06);
    }

    /* ── Main feed ── */
    .feed {
      max-width: 680px;
      margin: 0 auto;
      padding: 20px 16px 16px;
      display: flex;
      flex-direction: column;
      gap: 16px;
    }

    /* ── Section heading ── */
    .feed-heading {
      padding: 4px 0 8px;
    }
    .feed-title {
      font-family: var(--font-heading);
      font-size: clamp(26px, 5vw, 36px);
      font-weight: 900;
      line-height: 1.1;
      letter-spacing: -0.5px;
    }
    .feed-date {
      margin-top: 8px;
      font-size: 13px;
      color: #4b5563;
      font-weight: 700;
      letter-spacing: 0.04em;
      text-transform: uppercase;
    }

    /* ── Category filter pills ── */
    .cat-filter {
      display: flex;
      gap: 8px;
      flex-wrap: wrap;
      padding: 0;
    }
    .cat-pill {
      padding: 7px 13px 7px 10px;
      border-radius: 999px;
      border: 2px solid var(--black);
      background: transparent;
      cursor: pointer;
      font-family: var(--font-body);
      font-size: 13px;
      font-weight: 600;
      text-decoration: none;
      color: var(--black);
      transition: background 0.15s, color 0.15s;
      white-space: nowrap;
      -webkit-tap-highlight-color: transparent;
      display: inline-flex;
      align-items: center;
      gap: 8px;
    }
    .cat-pill:hover,
    .cat-pill.active {
      background: var(--black);
      color: var(--lime);
    }
    .cat-pill-icon {
      width: 15px;
      height: 15px;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      color: #1f2937;
      flex-shrink: 0;
    }
    .cat-pill-icon .ui-ico { width: 14px; height: 14px; }
    .cat-pill-icon.grid { color: #0891b2; }
    .cat-pill-icon.spark { color: #d97706; }
    .cat-pill-icon.microscope { color: #0284c7; }
    .cat-pill-icon.paw { color: #db2777; }
    .cat-pill-icon.palette { color: #7c3aed; }
    .cat-pill.active .cat-pill-icon.grid,
    .cat-pill:hover .cat-pill-icon.grid { color: #67e8f9; }
    .cat-pill.active .cat-pill-icon.spark,
    .cat-pill:hover .cat-pill-icon.spark { color: #fcd34d; }
    .cat-pill.active .cat-pill-icon.microscope,
    .cat-pill:hover .cat-pill-icon.microscope { color: #7dd3fc; }
    .cat-pill.active .cat-pill-icon.paw,
    .cat-pill:hover .cat-pill-icon.paw { color: #f9a8d4; }
    .cat-pill.active .cat-pill-icon.palette,
    .cat-pill:hover .cat-pill-icon.palette { color: #c4b5fd; }

    /* ── Swipe feed ── */
    .swipe-shell {
      position: relative;
      padding-bottom: 8px;
    }
    .swipe-track {
      position: relative;
      display: grid;
      grid-auto-flow: column;
      grid-auto-columns: 100%;
      gap: 0;
      overflow-x: auto;
      overscroll-behavior-x: contain;
      scroll-snap-type: x mandatory;
      scroll-padding-inline: 16px;
      -webkit-overflow-scrolling: touch;
      scrollbar-width: none;
      touch-action: auto;
    }
    .swipe-track::-webkit-scrollbar { display: none; }
    .swipe-status {
      margin-top: 12px;
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 8px;
      font-size: 12px;
      color: #3a3a3a;
      font-weight: 600;
      letter-spacing: 0.01em;
      padding: 0 2px 0;
    }
    .swipe-hint {
      color: #4d4d4d;
      font-weight: 500;
    }
    @media (max-width: 639px) {
      .swipe-shell { margin-inline: -16px; }
      .swipe-status { padding-inline: 16px; }
    }

    /* ── Story card ── */
    .story-card {
      scroll-snap-align: center;
      scroll-snap-stop: always;
      background: #f7f7f7;
      border-radius: 22px;
      border: 2px solid var(--black);
      box-shadow: 0 2px 0 rgba(17,17,17,0.18);
      overflow: hidden;
      transition: transform 0.22s cubic-bezier(.22,.61,.36,1), box-shadow 0.22s cubic-bezier(.22,.61,.36,1), opacity 0.2s ease;
      transform-origin: center;
      width: calc(100% - 32px);
      justify-self: center;
      backface-visibility: hidden;
      -webkit-backface-visibility: hidden;
      transform: translateZ(0);
      isolation: isolate;
      display: flex;
      flex-direction: column;
    }
    .swipe-card { opacity: 0.92; transform: translateY(0); }
    .swipe-card.is-active { opacity: 1; transform: translateY(0); box-shadow: 0 3px 0 rgba(17,17,17,0.22); }
    .swipe-card.is-near { opacity: 0.96; transform: translateY(0); }
    @media (hover: hover) {
      .swipe-card.is-active:hover {
        transform: translateY(-1px);
        box-shadow: 0 4px 0 rgba(17,17,17,0.24);
      }
    }

    .story-img {
      width: 100%;
      aspect-ratio: 16/9;
      overflow: hidden;
      background: #e9f8c5;
      position: relative;
    }
    .story-img img {
      position: absolute;
      inset: 0;
      width: 100%;
      height: 100%;
      display: block;
      opacity: 0;
      transition: opacity 220ms ease;
    }
    .story-img .story-img-blur {
      object-fit: cover;
      filter: blur(20px) saturate(1.08);
      transform: scale(1.16);
      opacity: 0.92;
    }
    .story-img .story-main {
      object-fit: cover;
      z-index: 1;
      opacity: 0;
    }
    .story-img.is-ready .story-main { opacity: 1; }
    .story-img.no-image img { display: none; }
    .story-fallback-art {
      position: absolute;
      inset: 0;
      display: none;
      align-items: center;
      justify-content: center;
      flex-direction: column;
      gap: 12px;
      padding: 20px;
      text-align: center;
    }
    .story-img.no-image .story-fallback-art { display: flex; }
    .story-fallback-icon {
      width: 48px;
      height: 48px;
      border-radius: 999px;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      border: 2px solid rgba(17,17,17,0.18);
      background: rgba(255,255,255,0.75);
      color: #111827;
    }
    .story-fallback-icon .ui-ico { width: 24px; height: 24px; }
    .story-fallback-icon.feel-good { color: #b45309; }
    .story-fallback-icon.science { color: #0369a1; }
    .story-fallback-icon.animals { color: #be185d; }
    .story-fallback-icon.arts { color: #6d28d9; }
    .story-fallback-title {
      max-width: 92%;
      font-family: 'Fraunces', Georgia, serif;
      font-size: clamp(20px, 3.6vw, 28px);
      line-height: 1.25;
      color: #111111;
      text-shadow: 0 1px 0 rgba(255,255,255,0.45);
    }

    .story-body {
      padding: 20px 20px 16px;
      display: flex;
      flex-direction: column;
      gap: 0;
      min-height: 0;
      flex: 1;
    }

    .cat-tag {
      display: inline-block;
      padding: 3px 10px;
      border-radius: 999px;
      background: var(--lime);
      border: 1.5px solid var(--black);
      font-size: 10px;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.07em;
      margin-bottom: 10px;
    }

    .story-title {
      font-family: var(--font-heading);
      font-size: calc(clamp(18px, 2.8vw, 22px) * var(--font-scale));
      font-weight: 900;
      line-height: 1.25;
      margin-bottom: 12px;
      color: var(--black);
    }

    .story-summary {
      font-size: calc(14px * var(--font-scale));
      line-height: calc(1.7 * var(--line-scale));
      color: #444;
      margin-bottom: 0;
      min-height: 0;
    }
    .story-summary p { margin: 0 0 8px; }
    .story-summary p:last-child { margin-bottom: 0; }
    .summary-wrap {
      max-height: 14em;
      overflow: hidden;
      position: relative;
      margin-bottom: 8px;
      transition: max-height 0.3s ease;
    }
    .summary-wrap.expanded { max-height: none; }
    .summary-toggle {
      background: none;
      border: none;
      color: var(--muted);
      font-size: 12px;
      font-weight: 600;
      cursor: pointer;
      padding: 2px 0;
      margin-bottom: 8px;
      font-family: var(--font-body);
    }
    .summary-toggle:hover { color: var(--black); }

    .story-foot {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      padding-top: 14px;
      border-top: 1px solid #f0f0f0;
      flex-wrap: wrap;
      margin-top: auto;
    }

    .source-label {
      font-size: 11px;
      color: var(--muted);
      font-weight: 500;
    }

    .story-actions {
      display: flex;
      align-items: center;
      gap: 8px;
    }

    .btn-reader {
      display: inline-flex;
      align-items: center;
      gap: 5px;
      padding: 8px 14px;
      background: var(--black);
      color: var(--white);
      border: 2px solid var(--black);
      border-radius: var(--radius-sm);
      cursor: pointer;
      font-family: var(--font-body);
      font-size: 12px;
      font-weight: 600;
      transition: background 0.15s, border-color 0.15s;
      -webkit-tap-highlight-color: transparent;
    }
    .btn-reader .ui-ico,
    .btn-link .ui-ico {
      width: 14px;
      height: 14px;
    }
    .btn-reader:hover {
      background: var(--purple);
      border-color: var(--purple);
    }

    .btn-link {
      display: inline-flex;
      align-items: center;
      gap: 5px;
      padding: 8px 14px;
      background: var(--lime);
      color: var(--black);
      border: 2px solid var(--black);
      border-radius: var(--radius-sm);
      font-family: var(--font-body);
      font-size: 12px;
      font-weight: 700;
      text-decoration: none;
      transition: background 0.15s;
      -webkit-tap-highlight-color: transparent;
    }
    .btn-link:hover { background: var(--lime-dark); }

    /* ── Empty state ── */
    .empty-state {
      text-align: center;
      padding: 80px 20px;
    }
    .empty-state img {
      width: 100px;
      margin-bottom: 20px;
      opacity: 0.7;
    }
    .empty-state h2 {
      font-family: var(--font-heading);
      font-size: 24px;
      font-weight: 900;
      margin-bottom: 8px;
    }
    .empty-state p { color: var(--muted); font-size: 14px; }
    .footer-note {
      max-width: 680px;
      margin: 8px auto 0;
      padding: 6px 16px 2px;
      color: #3d3d3d;
      font-size: 14px;
      font-weight: 600;
      display: flex;
      align-items: center;
      gap: 8px;
      opacity: 0.9;
    }
    .footer-note .heart-icon {
      width: 14px;
      height: 14px;
      color: #ef4444;
      flex-shrink: 0;
    }
    .footer-note .heart-icon svg {
      width: 14px;
      height: 14px;
      fill: currentColor;
      stroke: currentColor;
      stroke-width: 1;
    }

    /* ── Reader modal (bottom sheet) ── */
    .reader-overlay {
      display: none;
      position: fixed;
      inset: 0;
      background: rgba(0,0,0,0.55);
      z-index: 500;
    }
    .reader-overlay.open { display: flex; align-items: flex-end; }
    .reader-sheet {
      background: var(--white);
      width: 100%;
      max-width: 720px;
      margin: 0 auto;
      border-radius: 20px 20px 0 0;
      max-height: 92dvh;
      display: flex;
      flex-direction: column;
      overflow: hidden;
    }
    .reader-handle {
      width: 40px;
      height: 4px;
      background: #ddd;
      border-radius: 2px;
      margin: 12px auto 0;
      flex-shrink: 0;
    }
    .reader-header {
      padding: 12px 20px 14px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      border-bottom: 1px solid #eee;
      flex-shrink: 0;
    }
    .reader-header-title {
      font-family: var(--font-heading);
      font-size: 15px;
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
      font-size: 24px;
      color: var(--muted);
      padding: 2px 4px;
      line-height: 1;
      flex-shrink: 0;
    }
    .reader-close:hover { color: var(--black); }
    .reader-body {
      overflow-y: auto;
      flex: 1;
      padding: 24px 24px calc(24px + env(safe-area-inset-bottom));
      -webkit-overflow-scrolling: touch;
    }
    .reader-body h1 {
      font-family: var(--font-heading);
      font-size: 24px;
      font-weight: 900;
      line-height: 1.2;
      margin-bottom: 20px;
    }
    .reader-hero-image {
      width: 100%;
      border-radius: 12px;
      display: block;
      margin: 0 0 16px;
      border: 1px solid #ececec;
      max-height: 280px;
      object-fit: cover;
    }
    .reader-body p {
      font-size: calc(16px * var(--font-scale));
      line-height: calc(1.8 * var(--line-scale));
      color: #333;
      margin-bottom: 14px;
    }
    .reader-body h2, .reader-body h3, .reader-body h4 {
      font-family: var(--font-heading);
      font-weight: 700;
      margin: 20px 0 10px;
      line-height: 1.3;
    }
    .reader-body h2 { font-size: 20px; }
    .reader-body h3 { font-size: 18px; }
    .reader-body blockquote {
      border-left: 3px solid var(--lime-dark);
      padding: 8px 16px;
      margin: 12px 0;
      background: #f9f9f9;
      border-radius: 0 8px 8px 0;
    }
    .reader-media {
      margin: 16px 0;
    }
    .reader-media iframe,
    .reader-media video,
    .reader-media audio {
      max-width: 100%;
      border-radius: 12px;
    }
    .settings-overlay {
      display: none;
      position: fixed;
      inset: 0;
      background: rgba(0,0,0,0.38);
      z-index: 650;
      align-items: flex-end;
    }
    .settings-overlay.open { display: flex; }
    .settings-sheet {
      width: 100%;
      max-width: 720px;
      margin: 0 auto;
      background: #fff;
      border-radius: 20px 20px 0 0;
      border: 2px solid #111;
      border-bottom: 0;
      padding: 14px 16px calc(16px + env(safe-area-inset-bottom));
    }
    .settings-head {
      display: flex;
      align-items: center;
      justify-content: space-between;
      margin-bottom: 12px;
    }
    .settings-title {
      font-family: var(--font-heading);
      font-size: 18px;
      font-weight: 800;
    }
    .settings-close {
      border: none;
      background: transparent;
      font-size: 26px;
      line-height: 1;
      color: #475569;
      cursor: pointer;
    }
    .setting-row {
      display: grid;
      grid-template-columns: 110px 1fr auto;
      align-items: center;
      gap: 10px;
      padding: 8px 0;
    }
    .setting-label {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      font-size: 13px;
      font-weight: 700;
      color: #334155;
    }
    .setting-label i { font-size: 14px; line-height: 1; }
    .font-options {
      display: inline-flex;
      gap: 8px;
      flex-wrap: wrap;
    }
    .font-opt {
      border: 2px solid #111;
      border-radius: 999px;
      background: #fff;
      padding: 6px 10px;
      font-size: 12px;
      font-weight: 700;
      cursor: pointer;
      color: #111;
    }
    .font-opt.active {
      background: #111;
      color: #cdff70;
    }
    .theme-options {
      display: inline-flex;
      gap: 8px;
      flex-wrap: wrap;
    }
    .theme-opt {
      width: 32px;
      height: 32px;
      border-radius: 999px;
      border: 3px solid #ccc;
      cursor: pointer;
      transition: border-color 0.15s, transform 0.15s;
      padding: 0;
      background: none;
    }
    .theme-opt:hover { transform: scale(1.1); }
    .theme-opt.active { border-color: #111; border-width: 3px; }
    .theme-swatch-lime { background: #CDFF70; }
    .theme-swatch-peach { background: #FFD6C0; }
    .theme-swatch-sky { background: #B8E0F6; }
    .theme-swatch-mint { background: #B8F0D0; }
    .theme-swatch-midnight { background: #1a1a2e; }
    .setting-range {
      width: 100%;
      accent-color: #0ea5e9;
    }
    .setting-value {
      min-width: 38px;
      text-align: right;
      font-size: 12px;
      color: #64748b;
      font-weight: 700;
    }
    .reader-loading {
      text-align: center;
      padding: 48px 20px;
      color: var(--muted);
      font-size: 15px;
    }
    .reader-error {
      padding: 40px 20px;
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

    /* ── Desktop tweaks ── */
    @media (min-width: 640px) {
      .feed { padding: 24px 20px 12px; }
      .story-body { padding: 24px 24px 20px; }
      .story-summary { font-size: 15px; }
      .reader-body { padding: 28px 32px 32px; }
      .reader-body h1 { font-size: 28px; }
      .reader-body p { font-size: 17px; }
      .footer-note { padding-inline: 20px; }
      .story-card { width: calc(100% - 24px); }
    }
  </style>
</head>
<body>

<!-- Top wordmark (scrolls with content — not sticky) -->
  <div class="wordmark">
  <div class="wordmark-left">
    <img src="/icon-192.png" alt="happyhappyhappy icon">
    <span class="wordmark-text">happyhappyhappy</span>
  </div>
  <button class="settings-open-btn" id="openSettingsBtn" aria-label="Open typography settings">${uiIcon('settings')}</button>
</div>

<!-- Feed -->
<div class="feed">

  <!-- Section heading -->
  <div class="feed-heading">
    <h1 class="feed-title">${activeTab === 'today' ? "Today's dose" : 'All good news'}</h1>
    <p class="feed-date">${escapeHtml(shortDateStr)}</p>
  </div>

  ${activeTab === 'all' ? `
  <!-- Category filter -->
  <div class="cat-filter">
    ${categories.map(c => `<a href="/?tab=all${c.id ? '&cat=' + c.id : ''}" class="cat-pill${activeCategory === c.id ? ' active' : ''}"><span class="cat-pill-icon ${c.icon}">${uiIcon(c.icon)}</span>${c.label}</a>`).join('')}
  </div>` : ''}

  ${displayItems.length > 0 ? `
  <section class="swipe-shell">
    <div class="swipe-track" id="swipeTrack">
      ${storyCardsHTML}
    </div>
    <div class="swipe-status">
      <span id="swipeCounter">1 / ${displayItems.length}</span>
      <span class="swipe-hint">Swipe cards to browse</span>
    </div>
  </section>` : `
  <!-- Empty state -->
  <div class="empty-state">
    <img src="/icon-192.png" alt="">
    <h2>Good news incoming!</h2>
    <p>Our happy-news bot is curating stories. Check back soon!</p>
  </div>`}

</div>

<div class="footer-note">
  <span>Made with <span class="heart-icon">${uiIcon('heart')}</span> for Shweta &amp; Aditya</span>
</div>

<div class="settings-overlay" id="settingsOverlay" role="dialog" aria-modal="true" aria-label="Typography settings">
  <div class="settings-sheet">
    <div class="settings-head">
      <div class="settings-title">Typography</div>
      <button class="settings-close" id="closeSettingsBtn" aria-label="Close settings">&times;</button>
    </div>
    <div class="setting-row">
      <span class="setting-label">${uiIcon('palette')} Theme</span>
      <div class="theme-options">
        <button class="theme-opt active theme-swatch-lime" data-theme="lime" title="Lime"></button>
        <button class="theme-opt theme-swatch-peach" data-theme="peach" title="Peach"></button>
        <button class="theme-opt theme-swatch-sky" data-theme="sky" title="Sky"></button>
        <button class="theme-opt theme-swatch-mint" data-theme="mint" title="Mint"></button>
        <button class="theme-opt theme-swatch-midnight" data-theme="midnight" title="Midnight"></button>
      </div>
      <span class="setting-value" id="themeValue">Lime</span>
    </div>
    <div class="setting-row">
      <span class="setting-label">${uiIcon('type')} Font</span>
      <div class="font-options">
        <button class="font-opt active" data-font="default" id="fontDefaultBtn">Friendly</button>
        <button class="font-opt" data-font="clean" id="fontCleanBtn">Clean</button>
        <button class="font-opt" data-font="editorial" id="fontEditorialBtn">Editorial</button>
      </div>
      <span class="setting-value" id="fontValue">Friendly</span>
    </div>
    <div class="setting-row">
      <span class="setting-label">${uiIcon('type')} Size</span>
      <input type="range" min="0.9" max="1.2" step="0.05" value="1" class="setting-range" id="fontSizeRange">
      <span class="setting-value" id="fontSizeValue">100%</span>
    </div>
    <div class="setting-row">
      <span class="setting-label">${uiIcon('spacing')} Spacing</span>
      <input type="range" min="0.9" max="1.3" step="0.05" value="1" class="setting-range" id="lineSpacingRange">
      <span class="setting-value" id="lineSpacingValue">1.0x</span>
    </div>
  </div>
</div>

<!-- Bottom tab bar -->
<nav class="bottom-nav" role="navigation">
  <a href="/?tab=today" class="tab-btn${activeTab === 'today' ? ' active' : ''}">
    <span class="tab-icon today">${uiIcon('sun')}</span>
    <span>Today</span>
  </a>
  <a href="/?tab=all" class="tab-btn${activeTab === 'all' ? ' active' : ''}">
    <span class="tab-icon all">${uiIcon('globe')}</span>
    <span>All news</span>
  </a>
</nav>

<!-- Reader bottom sheet -->
<div class="reader-overlay" id="readerOverlay" role="dialog" aria-modal="true" aria-label="Reader view">
  <div class="reader-sheet" id="readerSheet">
    <div class="reader-handle"></div>
    <div class="reader-header">
      <span class="reader-header-title" id="readerTitle"></span>
      <button class="reader-close" onclick="closeReader()" aria-label="Close">&times;</button>
    </div>
    <div class="reader-body" id="readerBody">
      <div class="reader-loading">Loading article&hellip;</div>
    </div>
  </div>
</div>

<script>
  // ── Swipe stack behavior ──
  const swipeTrack = document.getElementById('swipeTrack');
  const swipeCounter = document.getElementById('swipeCounter');
  if (swipeTrack) {
    const cards = Array.from(swipeTrack.querySelectorAll('.swipe-card'));
    let currentIndex = 0;
    let ticking = false;
    const hydratedCards = new Set();

    function warmImage(src) {
      if (!src) return;
      const pre = new Image();
      pre.decoding = 'async';
      pre.loading = 'eager';
      pre.referrerPolicy = 'no-referrer';
      pre.src = src;
    }

    window.handleCardImageError = function(img) {
      if (!img) return;
      const imgWrap = img.closest('.story-img');
      const blurImg = imgWrap ? imgWrap.querySelector('.story-img-blur') : null;
      const stage = img.getAttribute('data-fail-stage') || '0';
      const proxySrc = img.getAttribute('data-proxy-src') || '';
      const backupSrc = img.getAttribute('data-backup-src') || '';
      if (stage === '0' && backupSrc && img.src !== backupSrc) {
        img.setAttribute('data-fail-stage', '1');
        img.src = backupSrc;
        if (blurImg) blurImg.src = backupSrc;
        return;
      }
      if (stage === '1' && proxySrc && img.src !== proxySrc) {
        img.setAttribute('data-fail-stage', '2');
        img.src = proxySrc;
        if (blurImg) blurImg.src = proxySrc;
        return;
      }
      img.style.display = 'none';
      imgWrap?.classList.add('no-image');
    };

    async function hydrateNearbyCardImages() {
      const start = Math.max(0, currentIndex - 1);
      const end = Math.min(cards.length, currentIndex + 3);
      for (let i = start; i < end; i++) {
        const card = cards[i];
        if (!card || hydratedCards.has(i)) continue;
        const imgWrap = card.querySelector('.story-img');
        if (!imgWrap || !imgWrap.classList.contains('no-image')) continue;
        const encoded = card.getAttribute('data-url') || '';
        if (!encoded) continue;
        hydratedCards.add(i);
        try {
          const resp = await fetch('/api/article?url=' + encoded + '&_=' + Date.now());
          const data = await resp.json();
          if (!data?.image) continue;
          let img = imgWrap.querySelector('img.story-main');
          let blurImg = imgWrap.querySelector('img.story-img-blur');
          if (!img) {
            img = document.createElement('img');
            img.className = 'story-main';
            img.loading = 'lazy';
            img.decoding = 'async';
            img.referrerPolicy = 'no-referrer';
            img.onerror = () => window.handleCardImageError(img);
            img.onload = () => {
              const wrap = img.closest('.story-img');
              if (wrap) wrap.classList.add('is-ready');
            };
            imgWrap.prepend(img);
          }
          if (!blurImg) {
            blurImg = document.createElement('img');
            blurImg.className = 'story-img-blur';
            blurImg.loading = 'lazy';
            blurImg.decoding = 'async';
            blurImg.referrerPolicy = 'no-referrer';
            blurImg.setAttribute('aria-hidden', 'true');
            imgWrap.prepend(blurImg);
          }
          img.setAttribute('data-proxy-src', data.image);
          img.setAttribute('data-backup-src', '');
          img.setAttribute('data-fail-stage', '0');
          img.src = data.image;
          blurImg.src = data.image;
          img.style.display = '';
          imgWrap.classList.remove('is-ready');
          imgWrap.classList.remove('no-image');
        } catch {}
      }
    }

    const updateSwipeState = () => {
      if (!cards.length) return;
      const viewportCenter = swipeTrack.getBoundingClientRect().left + (swipeTrack.clientWidth / 2);
      let bestIndex = 0;
      let bestDistance = Number.POSITIVE_INFINITY;
      cards.forEach((card, idx) => {
        const r = card.getBoundingClientRect();
        const center = r.left + (r.width / 2);
        const distance = Math.abs(center - viewportCenter);
        if (distance < bestDistance) {
          bestDistance = distance;
          bestIndex = idx;
        }
      });
      currentIndex = bestIndex;
      if (swipeCounter) swipeCounter.textContent = (currentIndex + 1) + ' / ' + cards.length;
      cards.forEach((card, index) => {
        const offset = Math.abs(index - currentIndex);
        card.classList.toggle('is-active', offset === 0);
        card.classList.toggle('is-near', offset === 1);
      });
      hydrateNearbyCardImages();
    };

    // Fix: check for images that already loaded before JS ran (cached / fast load)
    cards.forEach(function(card) {
      var imgWrap = card.querySelector('.story-img');
      if (!imgWrap) return;
      var mainImg = imgWrap.querySelector('img.story-main');
      if (mainImg && mainImg.complete && mainImg.naturalWidth > 0) {
        imgWrap.classList.add('is-ready');
      }
    });

    updateSwipeState();
    swipeTrack.addEventListener('scroll', () => {
      if (ticking) return;
      ticking = true;
      requestAnimationFrame(() => {
        updateSwipeState();
        ticking = false;
      });
    }, { passive: true });
    window.addEventListener('resize', updateSwipeState, { passive: true });

    // Soft-preload offscreen images to reduce flicker on swipe.
    const imgs = Array.from(swipeTrack.querySelectorAll('.story-img img'));
    imgs.forEach((img, idx) => {
      if (idx < 3) return;
      const src = img.getAttribute('src');
      const backup = img.getAttribute('data-backup-src');
      if (src && !src.startsWith('data:image')) warmImage(src);
      if (backup && !backup.startsWith('data:image')) warmImage(backup);
    });
  }

  // ── Typography settings ──
  const settingsOverlay = document.getElementById('settingsOverlay');
  const openSettingsBtn = document.getElementById('openSettingsBtn');
  const closeSettingsBtn = document.getElementById('closeSettingsBtn');
  const fontSizeRange = document.getElementById('fontSizeRange');
  const lineSpacingRange = document.getElementById('lineSpacingRange');
  const fontSizeValue = document.getElementById('fontSizeValue');
  const lineSpacingValue = document.getElementById('lineSpacingValue');
  const fontValue = document.getElementById('fontValue');
  const themeValue = document.getElementById('themeValue');
  const fontButtons = Array.from(document.querySelectorAll('.font-opt'));
  const themeButtons = Array.from(document.querySelectorAll('.theme-opt'));
  const SETTINGS_KEY = 'hhh_typography_v1';
  const settingsState = { font: 'default', scale: 1, line: 1, theme: 'lime' };

  const themeLabels = { lime: 'Lime', peach: 'Peach', sky: 'Sky', mint: 'Mint', midnight: 'Midnight' };
  const applyTypography = () => {
    document.body.setAttribute('data-font', settingsState.font);
    document.body.setAttribute('data-theme', settingsState.theme === 'lime' ? '' : settingsState.theme);
    if (settingsState.theme === 'lime') document.body.removeAttribute('data-theme');
    document.documentElement.style.setProperty('--font-scale', String(settingsState.scale));
    document.documentElement.style.setProperty('--line-scale', String(settingsState.line));
    if (fontSizeValue) fontSizeValue.textContent = Math.round(settingsState.scale * 100) + '%';
    if (lineSpacingValue) lineSpacingValue.textContent = settingsState.line.toFixed(1) + 'x';
    if (fontValue) {
      fontValue.textContent = settingsState.font === 'clean' ? 'Clean' : settingsState.font === 'editorial' ? 'Editorial' : 'Friendly';
    }
    if (themeValue) themeValue.textContent = themeLabels[settingsState.theme] || 'Lime';
    fontButtons.forEach(btn => btn.classList.toggle('active', btn.getAttribute('data-font') === settingsState.font));
    themeButtons.forEach(btn => btn.classList.toggle('active', btn.getAttribute('data-theme') === settingsState.theme));
  };
  const saveTypography = () => {
    try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(settingsState)); } catch {}
  };
  const loadTypography = () => {
    try {
      const raw = localStorage.getItem(SETTINGS_KEY);
      if (!raw) return;
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object') {
        settingsState.font = ['default', 'clean', 'editorial'].includes(parsed.font) ? parsed.font : 'default';
        settingsState.scale = Math.min(1.2, Math.max(0.9, Number(parsed.scale || 1)));
        settingsState.line = Math.min(1.3, Math.max(0.9, Number(parsed.line || 1)));
        settingsState.theme = ['lime', 'peach', 'sky', 'mint', 'midnight'].includes(parsed.theme) ? parsed.theme : 'lime';
      }
    } catch {}
  };
  loadTypography();
  if (fontSizeRange) fontSizeRange.value = String(settingsState.scale);
  if (lineSpacingRange) lineSpacingRange.value = String(settingsState.line);
  applyTypography();

  openSettingsBtn?.addEventListener('click', () => settingsOverlay?.classList.add('open'));
  closeSettingsBtn?.addEventListener('click', () => settingsOverlay?.classList.remove('open'));
  settingsOverlay?.addEventListener('click', (e) => { if (e.target === settingsOverlay) settingsOverlay.classList.remove('open'); });
  fontButtons.forEach(btn => {
    btn.addEventListener('click', () => {
      settingsState.font = btn.getAttribute('data-font') || 'default';
      applyTypography();
      saveTypography();
    });
  });
  themeButtons.forEach(btn => {
    btn.addEventListener('click', () => {
      settingsState.theme = btn.getAttribute('data-theme') || 'lime';
      applyTypography();
      saveTypography();
    });
  });
  fontSizeRange?.addEventListener('input', () => {
    settingsState.scale = Number(fontSizeRange.value);
    applyTypography();
    saveTypography();
  });
  lineSpacingRange?.addEventListener('input', () => {
    settingsState.line = Number(lineSpacingRange.value);
    applyTypography();
    saveTypography();
  });

  // ── Summary show/hide ──
  window.toggleSummary = function(btn) {
    var wrapId = btn.getAttribute('data-wrap');
    var wrap = document.getElementById(wrapId);
    if (!wrap) return;
    var isExpanded = wrap.classList.toggle('expanded');
    btn.textContent = isExpanded ? 'Show less' : 'Show more';
  };

  // ── Reader mode ──
  const overlay = document.getElementById('readerOverlay');
  const readerTitle = document.getElementById('readerTitle');
  const readerBody = document.getElementById('readerBody');
  let currentArticleUrl = '';

  var readerJunkPatterns = [
    /^(share|follow|subscribe|advertisement|cookie|privacy policy)/i,
    /(sign up|newsletter|related articles|you may also like)/i,
    /^WATCH (the video|this|it) (below|above|here)/i,
    /^SHARE (this|the)/i,
    /^(CELEBRATE|CLICK|TAP|READ MORE)/i,
    /#\\w+\\s*#\\w+/,
    /by u\\/\\w+\\s+in\\s+\\w+/i,
    /^@\\w+\\s/,
  ];

  function isJunkParagraph(text) {
    if (!text || text.length < 20) return true;
    if (readerJunkPatterns.some(function(rx) { return rx.test(text); })) return true;
    var hashCount = (text.match(/#\\w+/g) || []).length;
    if (hashCount >= 3) return true;
    var atCount = (text.match(/@\\w+/g) || []).length;
    if (atCount >= 2) return true;
    return false;
  }

  function openReader(encodedUrl, title) {
    currentArticleUrl = decodeURIComponent(encodedUrl);
    readerTitle.textContent = title;
    readerBody.innerHTML = '<div class="reader-loading">Loading story&hellip;</div>';
    overlay.classList.add('open');
    document.body.style.overflow = 'hidden';

    fetch('/api/article?url=' + encodedUrl)
      .then(function(r) { return r.json(); })
      .then(function(data) {
        if ((!data.content || data.content.length <= 50) && !data.htmlContent) {
          showReaderError();
          return;
        }
        var imageHtml = data.image ? '<img class="reader-hero-image" src="' + String(data.image).replace(/"/g, '&quot;') + '" alt="" loading="lazy" decoding="async" referrerpolicy="no-referrer">' : '';
        var titleHtml = '<h1>' + String(data.title || title || '').replace(/</g, '&lt;').replace(/>/g, '&gt;') + '</h1>';

        if (data.htmlContent) {
          var container = document.createElement('div');
          container.innerHTML = data.htmlContent;
          container.querySelectorAll('script,style,noscript,header,footer,nav,aside,form,button,input,select,textarea,.ad,.advertisement,.social-share,.share-buttons,[class*="social"],[class*="share"],[class*="comment"],[class*="related"],[class*="newsletter"]').forEach(function(el) { el.remove(); });
          var mediaEls = [];
          container.querySelectorAll('iframe,video,audio,embed,object').forEach(function(el) {
            var src = el.getAttribute('src') || el.getAttribute('data-src') || '';
            if (/youtube|vimeo|dailymotion|twitter|instagram|tiktok|reddit|streamable|gfycat|imgur/i.test(src) || el.tagName === 'VIDEO' || el.tagName === 'AUDIO') {
              el.setAttribute('loading', 'lazy');
              el.style.maxWidth = '100%';
              el.style.borderRadius = '12px';
              if (el.tagName === 'IFRAME') {
                el.style.width = '100%';
                el.style.aspectRatio = '16/9';
                el.style.border = 'none';
                el.setAttribute('allowfullscreen', '');
                if (!el.getAttribute('allow')) el.setAttribute('allow', 'autoplay; encrypted-media');
              }
              mediaEls.push({ html: el.outerHTML, index: mediaEls.length });
            }
          });
          var paragraphs = [];
          container.querySelectorAll('p,h2,h3,h4,h5,h6,blockquote,li,figcaption').forEach(function(el) {
            var text = (el.textContent || '').replace(/\\s+/g, ' ').trim();
            if (isJunkParagraph(text)) return;
            var tag = el.tagName.toLowerCase();
            if (tag === 'li') tag = 'p';
            if (tag === 'blockquote') {
              paragraphs.push('<blockquote><p>' + text.replace(/</g, '&lt;').replace(/>/g, '&gt;') + '</p></blockquote>');
            } else if (tag === 'figcaption') {
              paragraphs.push('<p style="font-size:13px;color:#888;font-style:italic;">' + text.replace(/</g, '&lt;').replace(/>/g, '&gt;') + '</p>');
            } else {
              paragraphs.push('<' + tag + '>' + text.replace(/</g, '&lt;').replace(/>/g, '&gt;') + '</' + tag + '>');
            }
          });
          var bodyHtml = '';
          if (mediaEls.length > 0 && paragraphs.length > 0) {
            var insertAfter = Math.min(2, paragraphs.length);
            bodyHtml = paragraphs.slice(0, insertAfter).join('');
            for (var mi = 0; mi < mediaEls.length; mi++) {
              bodyHtml += '<div class="reader-media">' + mediaEls[mi].html + '</div>';
            }
            bodyHtml += paragraphs.slice(insertAfter).join('');
          } else if (mediaEls.length > 0) {
            for (var mi2 = 0; mi2 < mediaEls.length; mi2++) {
              bodyHtml += '<div class="reader-media">' + mediaEls[mi2].html + '</div>';
            }
          } else {
            bodyHtml = paragraphs.join('');
          }
          readerBody.innerHTML = imageHtml + titleHtml + (bodyHtml || '<p>Could not extract article text.</p>');
        } else {
          var tmp = document.createElement('div');
          tmp.innerHTML = String(data.content || '');
          var text = (tmp.textContent || tmp.innerText || String(data.content || ''))
            .replace(/\\s+/g, ' ')
            .trim();
          var parts = text
            .replace(/([.!?])\\s{2,}/g, '$1\\n\\n')
            .split(/\\n\\s*\\n|(?<=[.!?])\\s+(?=[A-Z])/)
            .map(function(p) { return p.trim(); })
            .filter(function(p) { return !isJunkParagraph(p); })
            .slice(0, 24);
          var pHtml = parts.map(function(p) { return '<p>' + p.replace(/</g, '&lt;').replace(/>/g, '&gt;') + '</p>'; }).join('');
          readerBody.innerHTML = imageHtml + titleHtml + (pHtml || '<p>' + text.slice(0, 3000).replace(/</g, '&lt;').replace(/>/g, '&gt;') + '</p>');
        }
      })
      .catch(showReaderError);
  }

  function showReaderError() {
    readerBody.innerHTML =
      '<div class="reader-error">' +
      '<p>Could not load the article in reader mode.</p>' +
      '<a class="reader-orig-link" href="' + currentArticleUrl + '" target="_blank" rel="noopener">Open original article &rarr;</a>' +
      '</div>';
  }

  function closeReader() {
    overlay.classList.remove('open');
    document.body.style.overflow = '';
  }

  // Close on overlay backdrop tap
  overlay.addEventListener('click', e => {
    if (e.target === overlay) closeReader();
  });

  // Close on Escape key
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') closeReader();
  });

  // Swipe-down to close sheet
  const sheet = document.getElementById('readerSheet');
  let swipeStartY = 0;
  sheet.addEventListener('touchstart', e => { swipeStartY = e.changedTouches[0].screenY; }, { passive: true });
  sheet.addEventListener('touchend', e => {
    if (e.changedTouches[0].screenY - swipeStartY > 80) closeReader();
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

    // API: image proxy
    if (path === '/api/image') {
      return handleImageProxy(request);
    }

    // API: full feed
    if (path === '/api/feed') {
      const category = url.searchParams.get('category') ?? '';
      const page = parseInt(url.searchParams.get('page') ?? '1', 10);

      // Hard requirement: each refresh (page 1 load) should introduce at least 5 new joyful stories.
      if (page === 1) {
        await ensureRefreshHasAtLeast(env, MIN_NEW_ITEMS_PER_REFRESH);
      }

      const limit = 30;
      const offset = (page - 1) * limit;
      const rows = category
        ? await env.DB.prepare('SELECT * FROM items WHERE hidden = 0 AND joy_score >= 7 AND category = ? ORDER BY published_at DESC, ingested_at DESC LIMIT ? OFFSET ?').bind(category, limit, offset).all<Item>()
        : await env.DB.prepare('SELECT * FROM items WHERE hidden = 0 AND joy_score >= 7 ORDER BY published_at DESC, ingested_at DESC LIMIT ? OFFSET ?').bind(limit, offset).all<Item>();
      return Response.json({ items: rows.results, page, hasMore: rows.results.length === limit });
    }

    // API: reader mode article extraction
    if (path === '/api/article') {
      return handleArticle(request, env);
    }

    // Admin: manual ingest
    if (path === '/api/ingest' && request.method === 'POST') {
      const token = request.headers.get('Authorization')?.replace('Bearer ', '');
      if (!env.ADMIN_TOKEN || token !== env.ADMIN_TOKEN) return new Response('Unauthorized', { status: 401 });
      const result = await runIngestion(env);
      await buildDailyDigest(env);
      return Response.json(result);
    }

    // Admin: rebuild feed (prune old + low-quality, then re-ingest to guarantee minimum)
    if (path === '/api/rebuild-feed' && request.method === 'POST') {
      const token = request.headers.get('Authorization')?.replace('Bearer ', '');
      if (!env.ADMIN_TOKEN || token !== env.ADMIN_TOKEN) return new Response('Unauthorized', { status: 401 });
      const result = await rebuildFeed(env);
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
        const rows = await env.DB.prepare('SELECT * FROM items WHERE hidden = 0 AND joy_score >= 7 AND category = ? ORDER BY published_at DESC, ingested_at DESC LIMIT 50').bind(category).all<Item>();
        feedItems = rows.results;
      } else {
        const rows = await env.DB.prepare('SELECT * FROM items WHERE hidden = 0 AND joy_score >= 7 ORDER BY published_at DESC, ingested_at DESC LIMIT 50').all<Item>();
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

    // Daily feed rebuild at 6am ET — prune old & low-quality items, then fresh ingest
    const etHour = new Date().toLocaleString('en-US', { timeZone: 'America/New_York', hour: 'numeric', hour12: false });
    if (parseInt(etHour, 10) === 6) {
      await rebuildFeed(env);
    }

    await runIngestion(env);

    if (hour === 16) {
      await buildDailyDigest(env);
      await sendDailyEmail(env);
    }
  }
};
