import { createHash } from 'node:crypto';
import type { SurfaceId } from '../mcp/surfaces.js';

/**
 * ChatGPT currently supplies two non-model-controlled conversation-session values on each MCP
 * tool call: `_meta['openai/session']` and the corresponding `x-openai-session` HTTP header.
 * Live PC↔mobile testing on 2026-09-01 showed both survive a device switch within one ChatGPT
 * conversation and differ across separate conversations. They are not standard MCP session ids.
 *
 * This registry deliberately treats them as *continuity evidence*, never as first-use authority.
 * A key becomes usable only after the existing x-request-id → browser/Fiber proof has named the
 * exact conversation on the very same call. Raw values are hashed immediately and never stored.
 *
 * The lifetime is the Electron process. We have not measured whether OpenAI keeps these values
 * stable across app restarts, so persisting them would turn an unverified lifetime assumption into
 * durable local authority. Restart therefore revokes all learned continuity and the next PC call
 * learns it again from exact page evidence.
 */

export const OPENAI_SESSION_META_KEY = 'openai/session';
const MAX_SESSION_VALUE_CHARS = 1024;
const MAX_SESSION_KEYS = 8192;
const MAX_PENDING_REQUESTS = 8192;

export interface OpenAiSessionEvidence {
  surface: SurfaceId;
  /** SHA-256 of `_meta['openai/session']`, domain-separated from the HTTP value. */
  metaDigest: string | null;
  /** SHA-256 of `x-openai-session`, when that corroborating header was present. */
  httpDigest: string | null;
}

type BoundEntry = {
  state: 'bound';
  conversationId: string;
  httpDigest: string | null;
};

type BlockedEntry = { state: 'ambiguous' } | { state: 'retired' };

type SessionEntry = BoundEntry | BlockedEntry;

const bySession = new Map<string, SessionEntry>();
const keysByConversation = new Map<string, Set<string>>();
/**
 * Exact MCP request id -> hashed vendor-session evidence waiting for page proof.
 *
 * This closes the gap where request-id proof arrives only after the recorder's bounded grace
 * window. The durable attribution repair can move the old call later, but without retaining
 * these already-hashed values the app could no longer teach mobile continuity from that same
 * exact proof. Nothing raw or durable is stored here, and request ids are bounded like the
 * learned-session registry itself.
 */
const pendingByRequest = new Map<string, OpenAiSessionEvidence[]>();

function digest(source: 'meta' | 'http', value: unknown): string | null {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_SESSION_VALUE_CHARS) return null;
  return createHash('sha256').update(`cos-openai-session:${source}\0`).update(value).digest('hex');
}

export function openAiMetaSessionDigest(value: unknown): string | null {
  return digest('meta', value);
}

export function openAiHttpSessionDigest(value: unknown): string | null {
  return digest('http', value);
}

function keyOf(evidence: OpenAiSessionEvidence): string | null {
  // Live ChatGPT supplies both values on every sampled PC/mobile call. Requiring the pair makes
  // the HTTP copy a real corroborating boundary rather than optional decoration: a caller that
  // can manufacture only one vendor field never reaches learned conversation authority.
  return evidence.metaDigest && evidence.httpDigest ? `${evidence.surface}\0${evidence.metaDigest}` : null;
}

function pendingEvidenceKey(evidence: OpenAiSessionEvidence): string | null {
  if (!evidence.metaDigest || !evidence.httpDigest) return null;
  return `${evidence.surface}\0${evidence.metaDigest}\0${evidence.httpDigest}`;
}

/** Retains only hashed continuity evidence until this exact request id gets page proof. */
export function rememberOpenAiSessionForRequest(
  requestId: string | null | undefined,
  evidence: OpenAiSessionEvidence
): void {
  if (!requestId || requestId.length > 200) return;
  const evidenceKey = pendingEvidenceKey(evidence);
  if (!evidenceKey) return;
  const held = pendingByRequest.get(requestId) ?? [];
  if (held.some((item) => pendingEvidenceKey(item) === evidenceKey)) return;
  if (!pendingByRequest.has(requestId) && pendingByRequest.size >= MAX_PENDING_REQUESTS) {
    const oldest = pendingByRequest.keys().next().value as string | undefined;
    if (oldest) pendingByRequest.delete(oldest);
  }
  held.push({ ...evidence });
  pendingByRequest.set(requestId, held.slice(-4));
}

/**
 * Spends pending evidence only after the ordinary request-id registry proves the conversation.
 * Multiple surfaces may share one workflow request id, so learn every distinct retained pair.
 */
export function learnPendingOpenAiSessionsForRequest(requestId: string, conversationId: string): number {
  const held = pendingByRequest.get(requestId);
  pendingByRequest.delete(requestId);
  if (!held || !conversationId) return 0;
  let learned = 0;
  for (const evidence of held) {
    const result = learnOpenAiSession(evidence, conversationId);
    if (result.status === 'stored' || result.status === 'same') learned += 1;
  }
  return learned;
}

/** Contradictory request-id evidence can never safely seed continuity. */
export function forgetPendingOpenAiSessionsForRequest(requestId: string | null | undefined): void {
  if (requestId) pendingByRequest.delete(requestId);
}

function unlink(key: string, conversationId: string): void {
  const keys = keysByConversation.get(conversationId);
  if (!keys) return;
  keys.delete(key);
  if (keys.size === 0) keysByConversation.delete(conversationId);
}

function block(key: string, state: BlockedEntry['state']): void {
  const previous = bySession.get(key);
  if (previous?.state === 'bound') unlink(key, previous.conversationId);
  bySession.set(key, { state });
}

function capacityAvailable(): boolean {
  if (bySession.size < MAX_SESSION_KEYS) return true;
  // Never evict ambiguous/retired keys: forgetting a contradiction would let that same key be
  // learned again as if the conflict had never happened. Evict only an old healthy binding; the
  // consequence is loss of continuity for that chat, never attribution to a different chat.
  for (const [key, entry] of bySession) {
    if (entry.state !== 'bound') continue;
    bySession.delete(key);
    unlink(key, entry.conversationId);
    return true;
  }
  return false;
}

export interface OpenAiSessionResolution {
  conversationId: string | null;
  error: string | null;
}

const AMBIGUOUS_ERROR =
  'CALLER_IDENTITY_CONFLICT: this ChatGPT session was proven for contradictory conversations in the current app session. No local tool was run.';
const CORROBORATION_ERROR =
  'CALLER_IDENTITY_CONFLICT: this ChatGPT session no longer matches the HTTP session evidence it was originally proven with. No local tool was run.';
const RETIRED_ERROR =
  'CALLER_IDENTITY_RETIRED: this ChatGPT session belonged to a conversation whose local authority was retired in the current app session. No local tool was run.';

/** Resolves only a key that was already learned from exact browser evidence. */
export function resolveOpenAiSession(evidence: OpenAiSessionEvidence): OpenAiSessionResolution {
  const key = keyOf(evidence);
  if (!key) return { conversationId: null, error: null };
  const entry = bySession.get(key);
  if (!entry) return { conversationId: null, error: null };
  if (entry.state === 'ambiguous') return { conversationId: null, error: AMBIGUOUS_ERROR };
  if (entry.state === 'retired') return { conversationId: null, error: RETIRED_ERROR };
  if (entry.httpDigest && evidence.httpDigest !== entry.httpDigest) {
    block(key, 'ambiguous');
    return { conversationId: null, error: CORROBORATION_ERROR };
  }
  return { conversationId: entry.conversationId, error: null };
}

/**
 * Learns one surface/session only from an exact conversation proof on the same call.
 * Contradictions are sticky until process exit and are never last-writer-wins.
 */
export function learnOpenAiSession(
  evidence: OpenAiSessionEvidence,
  conversationId: string
): { status: 'missing' | 'stored' | 'same' | 'conflict' | 'retired' | 'capacity'; error: string | null } {
  const key = keyOf(evidence);
  if (!key || !conversationId) return { status: 'missing', error: null };
  const entry = bySession.get(key);
  if (entry?.state === 'ambiguous') return { status: 'conflict', error: AMBIGUOUS_ERROR };
  if (entry?.state === 'retired') return { status: 'retired', error: RETIRED_ERROR };
  if (entry?.state === 'bound') {
    if (entry.conversationId !== conversationId) {
      block(key, 'ambiguous');
      return { status: 'conflict', error: AMBIGUOUS_ERROR };
    }
    if (entry.httpDigest && evidence.httpDigest !== entry.httpDigest) {
      block(key, 'ambiguous');
      return { status: 'conflict', error: CORROBORATION_ERROR };
    }
    return { status: 'same', error: null };
  }
  if (!capacityAvailable()) return { status: 'capacity', error: null };
  bySession.set(key, {
    state: 'bound',
    conversationId,
    httpDigest: evidence.httpDigest
  });
  let keys = keysByConversation.get(conversationId);
  if (!keys) {
    keys = new Set();
    keysByConversation.set(conversationId, keys);
  }
  keys.add(key);
  return { status: 'stored', error: null };
}

/**
 * Permanent for this process: destructive worker retirement and Compact & Resume source
 * retirement must not let an old learned ChatGPT session fall through as an ordinary caller.
 */
export function retireOpenAiSessionsForConversation(conversationId: string | null | undefined): number {
  if (!conversationId) return 0;
  const keys = keysByConversation.get(conversationId);
  if (!keys) return 0;
  const retired = [...keys];
  for (const key of retired) block(key, 'retired');
  keysByConversation.delete(conversationId);
  return retired.length;
}

/** App restart naturally clears this module; tests use the same boundary explicitly. */
export function resetOpenAiSessionsForTests(): void {
  bySession.clear();
  keysByConversation.clear();
  pendingByRequest.clear();
}
