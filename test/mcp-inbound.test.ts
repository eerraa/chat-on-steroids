import { describe, expect, it } from 'vitest';
import {
  inboundOpenAiSessionDigest,
  inboundRequestId,
  requestIdFromHeader,
  withInboundRequest,
  withInboundRequestId
} from '../src/main/mcp/inbound.js';
import { openAiHttpSessionDigest } from '../src/main/session/openai-session.js';

describe('MCP inbound request id boundary', () => {
  it('normalizes the raw x-request-id to the page join key once at ingress', () => {
    expect(requestIdFromHeader('wfr_01a014bdd7cd7a15b6b533d3ce2b42f2/yqy1')).toBe(
      'wfr_01a014bdd7cd7a15b6b533d3ce2b42f2'
    );
    expect(requestIdFromHeader('  wfr_abc_123/relay-hop')).toBe('wfr_abc_123');
    expect(requestIdFromHeader(['wfr_only/a'])).toBe('wfr_only');
    expect(requestIdFromHeader(['wfr_first/a', 'wfr_second/b'])).toBeNull();

    expect(requestIdFromHeader('/missing-base')).toBeNull();
    expect(requestIdFromHeader('wfr.bad/suffix')).toBeNull();
    expect(requestIdFromHeader('x'.repeat(101))).toBeNull();
    expect(requestIdFromHeader(undefined)).toBeNull();
  });

  it('keeps normalized ids isolated across concurrent async requests', async () => {
    const seen = await Promise.all([
      withInboundRequestId('wfr_a', async () => {
        await new Promise((resolve) => setTimeout(resolve, 10));
        return inboundRequestId();
      }),
      withInboundRequestId('wfr_b', async () => {
        await Promise.resolve();
        return inboundRequestId();
      })
    ]);

    expect(seen).toEqual(['wfr_a', 'wfr_b']);
    expect(inboundRequestId()).toBeNull();
  });

  it('keeps only a one-way x-openai-session digest in request context', () => {
    const secret = 'mobile-conversation-shaped-value';
    const inside = withInboundRequest('wfr_scoped', {
      authorization: 'Bearer ignored-by-this-boundary',
      cookie: 'session=ignored-by-this-boundary',
      'x-openai-session': secret,
      'user-agent': 'openai-mcp-test'
    }, () => ({
      requestId: inboundRequestId(),
      sessionDigest: inboundOpenAiSessionDigest()
    }));
    expect(inside.requestId).toBe('wfr_scoped');
    expect(inside.sessionDigest).toBe(openAiHttpSessionDigest(secret));
    expect(inside.sessionDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(inside.sessionDigest).not.toContain(secret);
    expect(inboundOpenAiSessionDigest()).toBeNull();

    const ambiguous = withInboundRequest('wfr_duplicate', { 'x-openai-session': ['a', 'b'] }, () =>
      inboundOpenAiSessionDigest()
    );
    expect(ambiguous).toBeNull();
  });
});
