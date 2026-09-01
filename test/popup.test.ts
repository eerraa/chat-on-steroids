import { promises as fs } from 'node:fs';
import path from 'node:path';
import { JSDOM } from 'jsdom';
import { describe, expect, it } from 'vitest';

describe('extension popup continuity status', () => {
  it('treats proven OpenAI-session continuity as app-processed instead of blocked', async () => {
    const [html, source] = await Promise.all([
      fs.readFile(path.join(process.cwd(), 'extension', 'popup.html'), 'utf8'),
      fs.readFile(path.join(process.cwd(), 'extension', 'popup.js'), 'utf8')
    ]);
    const dom = new JSDOM(html, { url: 'chrome-extension://cos/popup.html', runScripts: 'outside-only' });
    const now = Date.now();
    const status = {
      connected: true,
      paired: true,
      compatible: true,
      port: 8765,
      extensionVersion: '2.0.2',
      extensionProtocol: 11,
      appVersion: '2.0.2'
    };
    const tabStatus = {
      isChat: true,
      recorder: true,
      tab: 7,
      epoch: 1,
      bound: true,
      terminal: false,
      pending: 0,
      pendingAll: 0,
      conversationId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
      delivery: { ok: true, total: 2, events: 2, at: now },
      page: {
        events: 2,
        sends: 2,
        failures: 0,
        session: 'session-1',
        recorderVersion: 17,
        runId: 'run-1',
        generating: false,
        requestId: 'wfr_exact',
        trace: [
          { requestId: 'wfr_exact', tool: 'read', read: true, sent: true, app: 'request_id' },
          { requestId: 'wfr_mobile', tool: 'observe', read: true, sent: true, app: 'openai_session' }
        ]
      }
    };
    const runtime = {
      sendMessage: async (message: { type?: string }) =>
        message.type === 'status' ? status : message.type === 'tabStatus' ? tabStatus : { ok: true }
    };
    const storage = {
      local: {
        get: async () => ({}),
        set: async () => undefined
      }
    };
    Object.defineProperty(dom.window, 'chrome', { configurable: true, value: { runtime, storage } });

    dom.window.eval(source);
    await new Promise((resolve) => dom.window.setTimeout(resolve, 0));
    await new Promise((resolve) => dom.window.setTimeout(resolve, 0));

    expect(dom.window.document.querySelector('#r-app')?.className).toBe('row ok');
    expect(dom.window.document.querySelector('#s-proc')?.className).toBe('stage done');
    expect(dom.window.document.querySelector('#n-proc')?.textContent).toBe('2/2');
    expect(dom.window.document.querySelector('#why')?.textContent).toBe(
      'Every tool call was placed by proven identity; page-less calls used ChatGPT session continuity.'
    );
    const pips = [...dom.window.document.querySelectorAll('#calls .call .pip:last-child')].map((node) => node.className);
    expect(pips).toEqual(['pip on', 'pip on']);
    dom.window.close();
  });
});
