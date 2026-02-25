#!/usr/bin/env node
// Fix truncated summaries using gemini-2.5-flash-lite (model that actually outputs full summaries)
import { readFileSync } from 'fs';
import { execSync } from 'child_process';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

// Load env
const lines = readFileSync('/Users/aditya/.openclaw/.env', 'utf8').split('\n');
for (const line of lines) {
  const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
  if (m) process.env[m[1]] ??= m[2].trim().replace(/^["']|["']$/g, '');
}

const KEY = process.env.GEMINI_API_KEY_1 || process.env.GEMINI_API_KEY;
if (!KEY) { console.error('No GEMINI_API_KEY'); process.exit(1); }

// Use the model confirmed to output full summaries
const MODEL = 'gemini-2.5-flash-lite';

async function geminiSummarize(title, content) {
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${KEY}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: `Write a warm, uplifting 4-5 sentence summary of this positive news story.
Write in a joyful, human, conversational tone. Highlight what makes this story special and why it matters.
Include specific details that bring it to life. End with something hopeful or inspiring.
No clichés, no filler phrases like "In conclusion" or "Overall". Output only the summary text.

Title: ${title}
Content: ${content.slice(0, 2000)}` }] }],
        generationConfig: { maxOutputTokens: 400, temperature: 0.7 }
      })
    }
  );
  const data = await res.json();
  const reason = data?.candidates?.[0]?.finishReason;
  const text = data?.candidates?.[0]?.content?.parts?.[0]?.text?.trim() ?? '';
  if (reason === 'MAX_TOKENS' || text.length < 100) {
    console.log(`    ⚠️  Still truncated (${reason}, ${text.length} chars) — trying with 600 tokens`);
    // Retry with more tokens
    const res2 = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${KEY}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: `Summarize this positive news story in 4-5 warm, joyful sentences. Be specific and inspiring. No filler phrases. Just the summary.\n\nTitle: ${title}\nContent: ${content.slice(0, 1500)}` }] }],
          generationConfig: { maxOutputTokens: 600, temperature: 0.7 }
        })
      }
    );
    const d2 = await res2.json();
    return d2?.candidates?.[0]?.content?.parts?.[0]?.text?.trim() ?? text;
  }
  return text;
}

function d1Query(sql, params = []) {
  let i = 0;
  const filled = sql.replace(/\?/g, () => {
    const v = params[i++];
    if (v === null || v === undefined) return 'NULL';
    if (typeof v === 'number') return v.toString();
    return `'${String(v).replace(/'/g, "''")}'`;
  });
  try {
    const out = execSync(
      `wrangler d1 execute happyhappyhappy --remote --json --command ${JSON.stringify(filled)}`,
      { cwd: ROOT, stdio: ['pipe', 'pipe', 'pipe'] }
    ).toString();
    const parsed = JSON.parse(out);
    return Array.isArray(parsed) ? parsed[0] : parsed;
  } catch (e) {
    console.error('D1 error:', e.message?.slice(0, 100));
    return null;
  }
}

async function main() {
  console.log('\n🔧 Fixing truncated summaries with gemini-2.5-flash-lite...\n');

  // Get all items where summary is short (< 200 chars = definitely truncated)
  const result = d1Query(`SELECT id, title, url, summary FROM items WHERE LENGTH(summary) < 200 ORDER BY ingested_at DESC`);
  const rows = result?.results ?? [];
  console.log(`Found ${rows.length} items with short/truncated summaries\n`);

  let fixed = 0, failed = 0;
  for (const row of rows) {
    const title = row.title?.slice(0, 80) ?? '';
    const currentSummary = row.summary ?? '';
    console.log(`  Fixing: ${title}`);
    console.log(`  Current (${currentSummary.length} chars): ${currentSummary.slice(0, 60)}...`);

    // Use current summary + title as the "content" since we don't have the original article text
    const summary = await geminiSummarize(title, currentSummary || title);

    if (summary && summary.length > 100) {
      d1Query(`UPDATE items SET summary = ? WHERE id = ?`, [summary, row.id]);
      console.log(`  ✅ Fixed (${summary.length} chars): ${summary.slice(0, 80)}...\n`);
      fixed++;
    } else {
      console.log(`  ❌ Failed to generate good summary\n`);
      failed++;
    }

    // Rate limit: small delay between calls
    await new Promise(r => setTimeout(r, 500));
  }

  console.log(`\n✅ Fixed: ${fixed}/${rows.length} summaries`);
  if (failed > 0) console.log(`❌ Failed: ${failed}`);
}

main().catch(e => { console.error('Fatal:', e); process.exit(1); });
