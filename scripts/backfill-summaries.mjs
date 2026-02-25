#!/usr/bin/env node
// Re-summarize all existing items with the new 4-5 sentence prompt

import { readFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { execSync } from 'child_process';

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
if (!GEMINI_KEY) { console.error('No GEMINI key'); process.exit(1); }

async function geminiSummarize(title, content) {
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-flash-latest:generateContent?key=${GEMINI_KEY}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: `Write a warm, uplifting 4-5 sentence summary of this positive news story.
Write in a joyful, human, conversational tone. Highlight what makes this story special and why it matters.
Include specific details that bring it to life. End with something hopeful or inspiring.
No clichés, no filler phrases like "In conclusion" or "Overall".

Title: ${title}
Content: ${content.slice(0, 1200)}` }] }],
        generationConfig: { maxOutputTokens: 350, temperature: 0.7 }
      })
    }
  );
  const data = await res.json();
  return data?.candidates?.[0]?.content?.parts?.[0]?.text?.trim() ?? '';
}

function d1Query(sql, params = []) {
  let paramIdx = 0;
  const filled = sql.replace(/\?/g, () => {
    const val = params[paramIdx++];
    if (val === null || val === undefined) return 'NULL';
    if (typeof val === 'number') return val.toString();
    return `'${String(val).replace(/'/g, "''")}'`;
  });
  try {
    const out = execSync(
      `wrangler d1 execute happyhappyhappy --remote --json --command ${JSON.stringify(filled)}`,
      { cwd: ROOT, stdio: ['pipe', 'pipe', 'pipe'] }
    ).toString();
    const parsed = JSON.parse(out);
    return Array.isArray(parsed) ? parsed[0] : parsed;
  } catch (err) {
    console.error('D1 error:', err.message.slice(0, 100));
    return null;
  }
}

async function main() {
  console.log('🔄 Backfilling summaries with 4-5 sentence prompt...\n');

  const rows = d1Query('SELECT id, title, summary FROM items WHERE hidden = 0');
  const items = rows?.results ?? [];
  console.log(`Found ${items.length} items to re-summarize\n`);

  let done = 0;
  for (const item of items) {
    // Use title as content since we don't store full text in DB
    const newSummary = await geminiSummarize(item.title, item.summary || item.title);
    if (!newSummary) { console.log(`  ❌ Failed: ${item.title.slice(0, 50)}`); continue; }

    d1Query('UPDATE items SET summary = ? WHERE id = ?', [newSummary, item.id]);
    console.log(`  ✅ ${item.title.slice(0, 60)}`);
    console.log(`     ${newSummary.slice(0, 100)}...`);
    done++;

    // Small delay to avoid rate limits
    await new Promise(r => setTimeout(r, 300));
  }

  console.log(`\n✅ Re-summarized ${done}/${items.length} items`);
}

main().catch(err => { console.error(err); process.exit(1); });
