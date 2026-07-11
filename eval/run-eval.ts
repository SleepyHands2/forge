import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { MemoryService } from '../src/services/memory.ts';

interface EvalEntry {
  question_id: string;
  question_type: string;
  question: string;
  answer: string | string[];
  haystack_sessions: Array<Array<{ role: string; content: string }>>;
  haystack_session_ids: string[];
  answer_session_ids: string[];
}

interface EvalResult {
  questionId: string;
  questionType: string;
  question: string;
  expectedAnswer: string;
  answerSessionIds: string[];
  retrievedMemoryIds: string[];
  hit: boolean;
  rank: number | null;
  searchResults: number;
}

const SCHEMA = fs.readFileSync(
  new URL('../src/db/schemas/memory.sql', import.meta.url),
  'utf-8',
);

function createFreshDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  db.exec(SCHEMA);
  return db;
}

function ingestSessions(
  memory: MemoryService,
  sessions: EvalEntry['haystack_sessions'],
  sessionIds: string[],
): void {
  for (let i = 0; i < sessions.length; i++) {
    const sessionId = sessionIds[i] ?? `session-${i}`;
    const fullText = sessions[i].map(t => `${t.role}: ${t.content}`).join('\n');
    memory.saveSync({
      type: 'conversation',
      content: fullText,
      tags: [sessionId, `session-${i}`],
      importance: 0.5,
    });
  }
}

function extractSessionIds(results: { tags: string[] }[], validIds: string[]): string[] {
  const retrieved: string[] = [];
  for (const result of results) {
    for (const tag of result.tags) {
      if (validIds.includes(tag)) retrieved.push(tag);
    }
  }
  return retrieved;
}

function scoreResult(entry: EvalEntry, retrievedSessionIds: string[], searchResults: number): EvalResult {
  const answerSet = new Set(entry.answer_session_ids);
  const hit = retrievedSessionIds.some(id => answerSet.has(id));
  let rank: number | null = null;
  for (let i = 0; i < retrievedSessionIds.length; i++) {
    if (answerSet.has(retrievedSessionIds[i])) { rank = i + 1; break; }
  }
  return {
    questionId: entry.question_id,
    questionType: entry.question_type,
    question: entry.question,
    expectedAnswer: Array.isArray(entry.answer) ? entry.answer.join(', ') : entry.answer,
    answerSessionIds: entry.answer_session_ids,
    retrievedMemoryIds: retrievedSessionIds,
    hit,
    rank,
    searchResults,
  };
}

async function main(): Promise<void> {
  const dataFile = process.argv[2] ?? 'eval/data/longmemeval_oracle.json';
  const topK = parseInt(process.argv[3] ?? '10');
  const maxEntries = parseInt(process.argv[4] ?? '500');
  const startOffset = parseInt(process.argv[5] ?? '0');

  console.log('\nMemory Eval');
  console.log(`Dataset: ${dataFile}`);
  console.log(`Top-K: ${topK}`);
  console.log(`Max entries: ${maxEntries}`);
  console.log('Mode: FTS5 only\n');

  const raw = fs.readFileSync(dataFile, 'utf-8');
  const entries: EvalEntry[] = JSON.parse(raw).slice(startOffset, startOffset + maxEntries);
  console.log(`Loaded ${entries.length} eval entries (offset ${startOffset})\n`);

  const typeStats = new Map<string, { total: number; hits: number; totalRank: number }>();
  const allResults: EvalResult[] = [];
  let totalHits = 0;
  let totalMRR = 0;
  const startTime = Date.now();

  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    const db = createFreshDb();
    const memory = new MemoryService(db);

    ingestSessions(memory, entry.haystack_sessions, entry.haystack_session_ids);
    const results = memory.search(entry.question, topK);
    const retrievedIds = extractSessionIds(results, entry.haystack_session_ids);
    const result = scoreResult(entry, retrievedIds, results.length);

    allResults.push(result);
    if (result.hit) totalHits++;
    if (result.rank !== null) totalMRR += 1 / result.rank;

    const stats = typeStats.get(result.questionType) ?? { total: 0, hits: 0, totalRank: 0 };
    stats.total++;
    if (result.hit) stats.hits++;
    if (result.rank !== null) stats.totalRank += 1 / result.rank;
    typeStats.set(result.questionType, stats);

    db.close();

    if ((i + 1) % 10 === 0 || i === entries.length - 1) {
      const pct = ((totalHits / (i + 1)) * 100).toFixed(1);
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
      console.log(`  [${i + 1}/${entries.length}] Hit rate: ${pct}% | ${elapsed}s elapsed`);
    }
  }

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log('\nResults (FTS5)\n');
  console.log(`Total entries:   ${entries.length}`);
  console.log(`Total hits:      ${totalHits}`);
  console.log(`Hit rate:        ${((totalHits / entries.length) * 100).toFixed(1)}%`);
  console.log(`MRR@${topK}:         ${(totalMRR / entries.length).toFixed(4)}`);
  console.log(`Time:            ${elapsed}s\n`);

  const sortedTypes = [...typeStats.entries()].sort((a, b) => b[1].total - a[1].total);
  for (const [type, stats] of sortedTypes) {
    const rate = ((stats.hits / stats.total) * 100).toFixed(1);
    const mrr = (stats.totalRank / stats.total).toFixed(4);
    console.log(`${type}: ${stats.hits}/${stats.total} hit (${rate}%), MRR ${mrr}`);
  }

  const failures = allResults.filter(r => !r.hit);
  const reportPath = path.resolve('eval/results-fts.json');
  fs.writeFileSync(reportPath, JSON.stringify({
    mode: 'fts',
    dataset: dataFile,
    topK,
    totalEntries: entries.length,
    totalHits,
    hitRate: totalHits / entries.length,
    mrr: totalMRR / entries.length,
    elapsed: parseFloat(elapsed),
    failures: failures.map(f => ({
      id: f.questionId,
      type: f.questionType,
      question: f.question,
      expected: f.expectedAnswer,
    })),
  }, null, 2));

  console.log(`\nResults saved to ${reportPath}`);
}

main().catch(err => {
  console.error('Eval failed:', err);
  process.exit(1);
});
