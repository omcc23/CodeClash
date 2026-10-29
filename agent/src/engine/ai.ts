import { createHash } from 'node:crypto';
import { gateTool, SOURCE_LANGUAGES, type GateDecision } from '@codeclash/shared';
import { z } from 'zod';
import { ProviderError, type Provider } from '../providers.js';
import type { AIStatus, Attack, MutationRecord, PlanContext, Planner } from './pipeline.js';

export interface AuditRow {
  tool: string;
  decision: GateDecision;
  args: unknown;
  model: string;
  tokens: number;
  reason?: string;
}

/** Code and long text go into the audit log as their first 2 KB plus a sha256 of the whole. */
export function auditArgs(value: unknown): unknown {
  if (typeof value === 'string') {
    if (value.length <= 2048) return value;
    return { text: value.slice(0, 2048), length: value.length, sha256: createHash('sha256').update(value).digest('hex') };
  }
  if (Array.isArray(value)) return value.map(auditArgs);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, auditArgs(v)]));
  return value;
}

export const attackSchema = z.object({
  type: z.enum(['wrong_solution', 'edge_case', 'performance']),
  description: z.string().min(1).max(500),
  language: z.enum(SOURCE_LANGUAGES).optional(),
  code: z.string().min(1).max(20_000).optional(),
  input: z.string().min(1).max(200_000).optional(),
  generator: z.string().min(1).max(20_000).optional(),
}).strict();

function parseLoose(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    try {
      return JSON.parse(text.replace(/,\s*([}\]])/g, '$1'));
    } catch {
      return null;
    }
  }
}

/** The balanced `{...}` starting at index, or null when it never closes. */
function balancedObject(text: string, start: number): string | null {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i += 1) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') { inString = true; continue; }
    if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

/**
 * The first JSON object in the text, or null. Models wrap JSON in prose or fences, leave a
 * trailing comma, or stop mid-object. A broken outer object still yields any complete attacks.
 */
export function extractJson(text: string): unknown {
  const cleaned = text.replace(/```(?:json)?/gi, '');
  const start = cleaned.indexOf('{');
  if (start < 0) return null;
  const whole = balancedObject(cleaned, start);
  if (whole) {
    const parsed = parseLoose(whole);
    if (parsed !== null) return parsed;
  }
  const attacks: unknown[] = [];
  for (let i = start; i < cleaned.length; i += 1) {
    if (cleaned[i] !== '{') continue;
    const slice = balancedObject(cleaned, i);
    if (!slice) continue;
    const parsed = parseLoose(slice);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || !('type' in parsed)) continue;
    attacks.push(parsed);
    i += slice.length - 1;
  }
  return attacks.length ? { attacks } : null;
}

/**
 * Checks a model reply. A `tool` the gate denies, or any field outside the schema, drops that
 * part of the reply and is audited as denied.
 */
export function readAttacks(reply: unknown): { attacks: Attack[]; denied: { what: string; reason: string }[] } {
  const denied: { what: string; reason: string }[] = [];
  if (!reply || typeof reply !== 'object' || Array.isArray(reply)) return { attacks: [], denied: [{ what: 'reply', reason: 'not a JSON object' }] };
  const record = reply as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (key === 'attacks') continue;
    if (key === 'tool') denied.push({ what: String(record.tool), reason: `tool ${gateTool(String(record.tool)) === 'deny' ? 'is prohibited' : 'is not used here'}` });
    else denied.push({ what: key, reason: 'field is not allowed' });
  }
  const list = Array.isArray(record.attacks) ? record.attacks.slice(0, 12) : [];
  const attacks: Attack[] = [];
  for (const raw of list) {
    let candidate = raw;
    if (raw && typeof raw === 'object' && 'tool' in raw) {
      const { tool, ...rest } = raw as Record<string, unknown>;
      if (gateTool(String(tool)) === 'deny') {
        denied.push({ what: String(tool), reason: 'tool is prohibited' });
        continue;
      }
      candidate = rest;
    }
    const parsed = attackSchema.safeParse(candidate);
    if (!parsed.success) {
      denied.push({ what: 'attack', reason: parsed.error.issues.map((i) => `${i.path.join('.') || 'attack'}: ${i.message}`).join('; ') });
      continue;
    }
    if (!parsed.data.code && !parsed.data.input && !parsed.data.generator) {
      denied.push({ what: 'attack', reason: 'needs code, input, or generator' });
      continue;
    }
    attacks.push(parsed.data);
  }
  return { attacks, denied };
}

function clip(text: string, max: number) {
  return text.length > max ? `${text.slice(0, max)}\n…` : text;
}

const REPLY_SHAPE = [
  'Reply with one JSON object and nothing else: {"attacks":[...]}.',
  'Each attack: {"type":"wrong_solution"|"edge_case"|"performance","description":"...", and one of',
  '"code" (a full plausible wrong or slow solution, with "language"), "input" (a complete stdin), or',
  '"generator" (Python 3 that prints one stdin)}. At most 8 attacks. Inputs must respect the constraints.',
  'You cannot publish, edit tests, or change limits; asking to will be denied and logged.',
  'Keep each description under 80 characters. Put newlines in inputs as \\n. No trailing commas.',
].join('\n');

function survivorLines(mutations: MutationRecord[]) {
  return mutations
    .filter((m) => m.diff)
    .slice(0, 12)
    .map((m) => `${m.id} (${m.operator}): - ${m.diff!.original}\n   + ${m.diff!.mutated}`)
    .join('\n');
}

export function planPrompt(context: PlanContext) {
  const survived = context.mutations.filter((m) => m.status === 'survived');
  return [
    'You are helping a problem setter find weak spots in a test suite for a programming problem.',
    `Statement:\n${clip(context.statement, 6000)}`,
    `Input spec:\n${context.spec ?? '(none)'}`,
    `Reference solution (${context.reference.language}):\n${clip(context.reference.code, 8000)}`,
    `Current tests (${context.tests.length}), first few inputs:\n${context.tests.slice(0, 4).map((t) => clip(t.input, 300)).join('\n---\n')}`,
    `Mutants of the reference that the current tests do not catch:\n${survivorLines(survived) || '(none)'}`,
    'Propose wrong solutions a contestant might plausibly write, edge-case inputs, and slow solutions that a max-size test should catch.',
    REPLY_SHAPE,
  ].join('\n\n');
}

export function feedbackPrompt(context: PlanContext, survivors: MutationRecord[]) {
  return [
    'These mutants of the reference survived every test and attack so far. Give one edge_case input per mutant that makes it print a different answer from the reference.',
    `Input spec:\n${context.spec ?? '(none)'}`,
    `Reference (${context.reference.language}):\n${clip(context.reference.code, 8000)}`,
    `Survivors:\n${survivorLines(survivors)}`,
    REPLY_SHAPE,
  ].join('\n\n');
}

export interface PlannerOptions {
  provider: Provider;
  audit: (row: AuditRow) => Promise<void>;
  runTokenCap: number;
  monthlyUsed: number;
  monthlyCap: number;
}

/** At most two calls per run: the plan, and feedback only when mutants survive. */
export function createPlanner(options: PlannerOptions): Planner {
  let status: AIStatus = 'AVAILABLE';
  let note: string | null = null;
  let calls = 0;
  let tokens = 0;
  const log: { tool: string; tokens: number; ok: boolean; note: string | null }[] = [];

  const ask = async (tool: 'model.plan' | 'model.feedback', prompt: string): Promise<Attack[]> => {
    const clipped = prompt.length > 24_000 ? `${prompt.slice(0, 24_000)}\n…` : prompt;
    if (status !== 'AVAILABLE') return [];
    if (tokens >= options.runTokenCap || options.monthlyUsed + tokens >= options.monthlyCap) {
      status = 'BUDGET_EXCEEDED';
      note = tokens >= options.runTokenCap ? 'The per-run token limit is spent.' : 'The monthly token budget is spent.';
      log.push({ tool, tokens: 0, ok: false, note });
      await options.audit({ tool, decision: 'deny', args: { promptLength: clipped.length }, model: options.provider.model, tokens: 0, reason: note });
      return [];
    }
    let reply;
    try {
      reply = await options.provider.complete(clipped);
    } catch (error) {
      status = error instanceof ProviderError ? error.status : 'ERROR';
      note = error instanceof Error ? error.message : 'The model call failed';
      log.push({ tool, tokens: 0, ok: false, note });
      await options.audit({ tool, decision: 'allow', args: { promptLength: clipped.length }, model: options.provider.model, tokens: 0, reason: note });
      return [];
    }
    calls += 1;
    tokens += reply.tokens;
    let parsed = extractJson(reply.text);
    if (parsed === null && calls < 2 && tokens < options.runTokenCap && options.monthlyUsed + tokens < options.monthlyCap) {
      log.push({ tool, tokens: reply.tokens, ok: false, note: 'reply was not JSON; retrying once' });
      return ask(tool, `${clipped}\n\nYour previous reply was not valid JSON. Reply with only {"attacks":[...]}.`);
    }
    if (parsed === null) {
      status = 'ERROR';
      note = `The model reply was not valid JSON. ${reply.text.replace(/\s+/g, ' ').slice(0, 180)}`;
      log.push({ tool, tokens: reply.tokens, ok: false, note });
      await options.audit({ tool, decision: 'deny', args: { promptLength: clipped.length }, model: options.provider.model, tokens: reply.tokens, reason: note });
      return [];
    }
    const { attacks, denied } = readAttacks(parsed);
    log.push({ tool, tokens: reply.tokens, ok: true, note: denied.length ? `${denied.length} part(s) dropped` : null });
    await options.audit({
      tool,
      decision: 'allow',
      args: auditArgs({ promptLength: clipped.length, attacks }),
      model: options.provider.model,
      tokens: reply.tokens,
    });
    for (const item of denied) {
      await options.audit({ tool: item.what, decision: 'deny', args: {}, model: options.provider.model, tokens: 0, reason: item.reason });
    }
    return attacks;
  };

  return {
    plan: (context) => ask('model.plan', planPrompt(context)),
    feedback: (context, survivors) => ask('model.feedback', feedbackPrompt(context, survivors)),
    summary: () => ({ status, calls, tokens, note, log }),
  };
}
