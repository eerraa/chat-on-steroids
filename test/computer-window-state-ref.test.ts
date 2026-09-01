import { describe, expect, it, vi } from 'vitest';

const fake = vi.hoisted(() => {
  type Listener = { fn: (...args: any[]) => void; once: boolean };
  class Emitter {
    private readonly listeners = new Map<string, Listener[]>();
    on(event: string, fn: (...args: any[]) => void) {
      const list = this.listeners.get(event) ?? [];
      list.push({ fn, once: false });
      this.listeners.set(event, list);
      return this;
    }
    once(event: string, fn: (...args: any[]) => void) {
      const list = this.listeners.get(event) ?? [];
      list.push({ fn, once: true });
      this.listeners.set(event, list);
      return this;
    }
    emit(event: string, ...args: any[]) {
      const list = [...(this.listeners.get(event) ?? [])];
      this.listeners.set(
        event,
        (this.listeners.get(event) ?? []).filter((entry) => !entry.once)
      );
      for (const entry of list) entry.fn(...args);
    }
  }

  const requests: Array<Record<string, any>> = [];
  const spawn = vi.fn(() => {
    const child = new Emitter() as any;
    child.pid = 9300;
    child.exitCode = null;
    child.stdout = new Emitter();
    child.stderr = new Emitter();
    child.stdin = {
      write(line: string, _encoding: string, callback: (error?: Error | null) => void) {
        callback(null);
        const request = JSON.parse(line) as Record<string, any>;
        requests.push(request);
        let reply: Record<string, any>;
        if (request.op === 'snapshot') {
          reply = {
            ok: true,
            window: {
              id: 77,
              process: 'fixture.exe',
              title: 'Fixture',
              x: 10,
              y: 20,
              width: 640,
              height: 480,
              state: 'normal'
            },
            snapshotId: 51,
            elements: [
              {
                runtimeKey: 'fixture-button-runtime-id',
                name: 'Fixture button',
                role: 'Button',
                automationId: 'fixture-button',
                enabled: true,
                offscreen: false,
                bounds: { x: 20, y: 30, width: 100, height: 30 }
              }
            ],
            visited: 1,
            truncated: false
          };
        } else if (request.op === 'act') {
          reply = { ok: true, routes: ['uia'], cursor: { x: 0, y: 0 } };
        } else {
          reply = { ok: true, cursor: { x: 0, y: 0 } };
        }
        queueMicrotask(() => child.stdout.emit('data', Buffer.from(`${JSON.stringify(reply)}\n`)));
        return true;
      },
      end() {}
    };
    queueMicrotask(() => child.emit('spawn'));
    return child;
  });
  return { requests, spawn };
});

vi.mock('node:child_process', () => ({ spawn: fake.spawn }));
vi.mock('../src/main/env.js', () => ({
  ensureUsablePath: vi.fn(),
  normalizeEnvironment: (env: NodeJS.ProcessEnv) => ({ ...env }),
  setEnvValue: (env: NodeJS.ProcessEnv, key: string, value: string) => {
    env[key] = value;
  }
}));
vi.mock('../src/main/exec.js', () => ({
  findWindowsPowerShell: () => 'powershell.exe',
  terminateProcessTree: vi.fn(async () => undefined)
}));
vi.mock('../src/main/logger.js', () => ({ logInfo: vi.fn(), logWarn: vi.fn() }));

import { act, getWindowState } from '../src/main/computer/index.js';

describe('combined window-state semantic refs', () => {
  it('keeps the snapshot HWND when the helper reply carries WindowInfo instead of a numeric window field', async () => {
    const state = await getWindowState({ window: 77, includeScreenshot: false, maxElements: 5 });
    expect(state.window.id).toBe(77);
    expect(state.elements).toHaveLength(1);

    await expect(act([{ type: 'click_ref', ref: state.elements[0]!.ref }])).resolves.toBeTruthy();
    const action = fake.requests.find((request) => request.op === 'act');
    expect(action?.actions?.[0]).toMatchObject({
      type: 'click_ui',
      window: 77,
      snapshotId: 51,
      runtimeKey: 'fixture-button-runtime-id'
    });
  });
});
