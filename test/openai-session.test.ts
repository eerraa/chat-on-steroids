import { beforeEach, describe, expect, it } from 'vitest';

import {
  learnOpenAiSession,
  openAiHttpSessionDigest,
  openAiMetaSessionDigest,
  resetOpenAiSessionsForTests,
  resolveOpenAiSession,
  retireOpenAiSessionsForConversation,
  type OpenAiSessionEvidence
} from '../src/main/session/openai-session.js';

function evidence(surface: 'core' | 'desktop', meta: string, http = `${meta}-http`): OpenAiSessionEvidence {
  return {
    surface,
    metaDigest: openAiMetaSessionDigest(meta),
    httpDigest: openAiHttpSessionDigest(http)
  };
}

beforeEach(() => resetOpenAiSessionsForTests());

describe('ChatGPT openai/session continuity', () => {
  it('learns only a proven mapping and later restores the same conversation', () => {
    const x = evidence('core', 'session-x');
    const y = evidence('core', 'session-y');

    expect(resolveOpenAiSession(x)).toEqual({ conversationId: null, error: null });
    expect(learnOpenAiSession(x, 'conversation-a')).toMatchObject({ status: 'stored', error: null });
    expect(resolveOpenAiSession(x)).toEqual({ conversationId: 'conversation-a', error: null });
    expect(resolveOpenAiSession(y)).toEqual({ conversationId: null, error: null });
  });

  it('requires both the MCP meta session and its HTTP counterpart', () => {
    const missingHttp: OpenAiSessionEvidence = {
      surface: 'core',
      metaDigest: openAiMetaSessionDigest('session-x'),
      httpDigest: null
    };
    const missingMeta: OpenAiSessionEvidence = {
      surface: 'core',
      metaDigest: null,
      httpDigest: openAiHttpSessionDigest('session-x-http')
    };
    expect(learnOpenAiSession(missingHttp, 'conversation-a').status).toBe('missing');
    expect(learnOpenAiSession(missingMeta, 'conversation-a').status).toBe('missing');
    expect(resolveOpenAiSession(missingHttp)).toEqual({ conversationId: null, error: null });
    expect(resolveOpenAiSession(missingMeta)).toEqual({ conversationId: null, error: null });
  });

  it('makes a contradictory conversation binding sticky instead of picking A or B', () => {
    const x = evidence('core', 'session-x');
    expect(learnOpenAiSession(x, 'conversation-a').error).toBeNull();

    const conflict = learnOpenAiSession(x, 'conversation-b');
    expect(conflict.status).toBe('conflict');
    expect(conflict.error).toContain('CALLER_IDENTITY_CONFLICT');
    expect(resolveOpenAiSession(x)).toMatchObject({ conversationId: null });
    expect(resolveOpenAiSession(x).error).toContain('CALLER_IDENTITY_CONFLICT');

    expect(learnOpenAiSession(x, 'conversation-a').status).toBe('conflict');
    expect(learnOpenAiSession(x, 'conversation-b').status).toBe('conflict');
  });

  it('keys Core and Desktop independently even for one conversation', () => {
    const core = evidence('core', 'core-session');
    const desktop = evidence('desktop', 'desktop-session');
    expect(learnOpenAiSession(core, 'conversation-a').status).toBe('stored');
    expect(learnOpenAiSession(desktop, 'conversation-a').status).toBe('stored');
    expect(resolveOpenAiSession(core).conversationId).toBe('conversation-a');
    expect(resolveOpenAiSession(desktop).conversationId).toBe('conversation-a');

    // The same opaque meta value on another surface is a different key and has no authority.
    expect(resolveOpenAiSession(evidence('desktop', 'core-session'))).toEqual({ conversationId: null, error: null });
  });

  it('fails closed when the corroborating x-openai-session changes', () => {
    const learned = evidence('core', 'session-x', 'http-a');
    expect(learnOpenAiSession(learned, 'conversation-a').status).toBe('stored');

    const changed = evidence('core', 'session-x', 'http-b');
    expect(resolveOpenAiSession(changed).error).toContain('CALLER_IDENTITY_CONFLICT');
    // The contradiction is sticky even if the old HTTP value comes back later.
    expect(resolveOpenAiSession(learned).error).toContain('CALLER_IDENTITY_CONFLICT');
  });

  it('retires learned authority for a conversation until app-process reset', () => {
    const x = evidence('core', 'session-x');
    expect(learnOpenAiSession(x, 'conversation-a').status).toBe('stored');
    expect(retireOpenAiSessionsForConversation('conversation-a')).toBe(1);
    expect(resolveOpenAiSession(x).error).toContain('CALLER_IDENTITY_RETIRED');

    // App restart is the explicit lifetime boundary because cross-restart OpenAI session
    // stability has not been measured. A fresh process knows nothing until a new PC proof.
    resetOpenAiSessionsForTests();
    expect(resolveOpenAiSession(x)).toEqual({ conversationId: null, error: null });
  });
});
