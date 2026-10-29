import { createHash } from 'node:crypto';
import { type Db, ObjectId } from 'mongodb';
import { auditCollection } from '../db/audit.js';

const K = 5;
const WINDOW = 4;
const THRESHOLD = 0.7;
const MIN_TOKENS = 30;
const COMMON = 0.4;

export function hashIp(ip: string) {
  const salt = process.env.IP_HASH_SALT || process.env.JWT_SECRET || 'codeclash';
  return createHash('sha256').update(`${salt}|${ip}`).digest('hex');
}

function stripCommentsAndStrings(code: string) {
  let out = '';
  let i = 0;
  while (i < code.length) {
    const two = code.slice(i, i + 2);
    if (two === '//' || code[i] === '#') {
      const end = code.indexOf('\n', i);
      i = end < 0 ? code.length : end;
      out += ' ';
      continue;
    }
    if (two === '/*') {
      const end = code.indexOf('*/', i + 2);
      i = end < 0 ? code.length : end + 2;
      out += ' ';
      continue;
    }
    const quote = code[i];
    if (quote === '"' || quote === "'" || quote === '`') {
      i += 1;
      while (i < code.length && code[i] !== quote) {
        if (code[i] === '\\') i += 1;
        i += 1;
      }
      i += 1;
      out += ' STR ';
      continue;
    }
    out += code[i];
    i += 1;
  }
  return out;
}

/** Identifiers become ID and numbers become NUM so renaming does not hide a copy. */
export function tokenize(code: string): string[] {
  const raw = stripCommentsAndStrings(code);
  const tokens: string[] = [];
  const pattern = /[A-Za-z_][A-Za-z0-9_]*|\d+(?:\.\d+)?|==|!=|<=|>=|&&|\|\||[^\s]/g;
  for (const match of raw.matchAll(pattern)) {
    const word = match[0];
    if (/^[A-Za-z_]/.test(word)) tokens.push('ID');
    else if (/^\d/.test(word)) tokens.push('NUM');
    else if (word !== 'STR') tokens.push(word);
  }
  return tokens;
}

function fingerprints(tokens: string[]): Set<string> {
  if (tokens.length < K) return new Set();
  const grams: string[] = [];
  for (let i = 0; i <= tokens.length - K; i += 1) grams.push(tokens.slice(i, i + K).join(' '));
  const kept = new Set<string>();
  for (let i = 0; i < grams.length; i += 1) {
    const end = Math.min(grams.length, i + WINDOW);
    let best = grams[i]!;
    for (let j = i; j < end; j += 1) if (grams[j]! < best) best = grams[j]!;
    kept.add(best);
  }
  return kept;
}

export function codeScore(left: string, right: string) {
  return overlapScore(fingerprints(tokenize(left)), fingerprints(tokenize(right)));
}

export function overlapScore(left: Set<string>, right: Set<string>) {
  if (left.size === 0 || right.size === 0) return 0;
  let shared = 0;
  for (const item of left) if (right.has(item)) shared += 1;
  return shared / Math.min(left.size, right.size);
}

interface Piece { userId: string; submissionId: string; language: string; code: string; ipHash: string | null; tokens: string[]; prints: Set<string> }

export async function runSimilarity(db: Db, contestId: string, actorId: string) {
  const contest = await db.collection('contests').findOne({ _id: new ObjectId(contestId) });
  if (!contest) return { pairs: 0 };
  const rows = await db.collection('submissions')
    .find({ contestId: contest._id, status: { $in: ['judged', 'scored'] } })
    .project({ userId: 1, problemId: 1, language: 1, code: 1, verdict: 1, submittedAt: 1, ipHash: 1 })
    .sort({ submittedAt: 1 })
    .toArray();
  const latest = new Map<string, typeof rows[number]>();
  for (const row of rows) {
    const key = `${String(row.userId)}:${String(row.problemId)}`;
    const current = latest.get(key);
    if (!current || row.verdict === 'AC' || (current.verdict !== 'AC' && row.submittedAt >= current.submittedAt)) latest.set(key, row);
  }
  const byProblem = new Map<string, Piece[]>();
  for (const row of latest.values()) {
    const tokens = tokenize(String(row.code ?? ''));
    const problemId = String(row.problemId);
    const list = byProblem.get(problemId) ?? [];
    list.push({
      userId: String(row.userId),
      submissionId: String(row._id),
      language: String(row.language),
      code: String(row.code ?? ''),
      ipHash: (row.ipHash as string | null) ?? null,
      tokens,
      prints: fingerprints(tokens),
    });
    byProblem.set(problemId, list);
  }
  const pairs: Record<string, unknown>[] = [];
  for (const [problemId, pieces] of byProblem) {
    const lengths = pieces.map((p) => p.tokens.length).sort((a, b) => a - b);
    const median = lengths[Math.floor(lengths.length / 2)] ?? 0;
    if (median < MIN_TOKENS) continue;
    const counts = new Map<string, number>();
    for (const piece of pieces) for (const print of piece.prints) counts.set(print, (counts.get(print) ?? 0) + 1);
    const noisy = new Set([...counts].filter(([, n]) => n / pieces.length > COMMON).map(([print]) => print));
    const cleaned = pieces.map((piece) => {
      const prints = new Set([...piece.prints].filter((print) => !noisy.has(print)));
      return { ...piece, prints };
    });
    for (let i = 0; i < cleaned.length; i += 1) {
      for (let j = i + 1; j < cleaned.length; j += 1) {
        const a = cleaned[i]!;
        const b = cleaned[j]!;
        const score = overlapScore(a.prints, b.prints);
        const sameIp = !!(a.ipHash && a.ipHash === b.ipHash);
        if (score < THRESHOLD) continue;
        pairs.push({
          id: `${problemId}:${a.userId}:${b.userId}`,
          problemId,
          userA: a.userId,
          userB: b.userId,
          submissionA: a.submissionId,
          submissionB: b.submissionId,
          languageA: a.language,
          languageB: b.language,
          score: Math.round(score * 1000) / 1000,
          sameIp,
          status: 'open',
          note: '',
        });
      }
    }
  }
  await db.collection('similarity_reports').updateOne(
    { contestId: contest._id },
    { $set: { contestId: contest._id, pairs, updatedAt: new Date() }, $setOnInsert: { createdAt: new Date() } },
    { upsert: true },
  );
  await auditCollection(db).insertOne({
    actor: actorId,
    actorType: actorId === 'scheduler' ? 'system' : 'user',
    action: 'integrity.run',
    target: contestId,
    decision: 'allow',
    payload: { pairs: pairs.length },
    at: new Date(),
  });
  return { pairs: pairs.length };
}
