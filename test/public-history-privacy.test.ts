import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const script = path.join(process.cwd(), 'scripts', 'verify-public-history.mjs');
const repositories: string[] = [];
const safeEmail = '227782719+totec448-spec@users.noreply.github.com';
const trustedUpstreamFile = path.join('scripts', 'public-history-trusted-upstream.txt');

function makeRepository(): string {
  const repository = mkdtempSync(path.join(tmpdir(), 'public-history-privacy-'));
  repositories.push(repository);
  execFileSync('git', ['init', '--initial-branch=main'], { cwd: repository });
  writeFileSync(path.join(repository, 'README.md'), 'clean\n');
  execFileSync('git', ['add', 'README.md'], { cwd: repository });
  commit(repository, 'Clean root', safeEmail);
  return repository;
}

function commit(repository: string, message: string, email: string): void {
  execFileSync('git', ['commit', '--allow-empty', '-m', message], {
    cwd: repository,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'totec448-spec',
      GIT_AUTHOR_EMAIL: email,
      GIT_COMMITTER_NAME: 'totec448-spec',
      GIT_COMMITTER_EMAIL: email,
    },
  });
}

function git(repository: string, args: string[], email = safeEmail): string {
  return execFileSync('git', args, {
    cwd: repository,
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'totec448-spec',
      GIT_AUTHOR_EMAIL: email,
      GIT_COMMITTER_NAME: 'totec448-spec',
      GIT_COMMITTER_EMAIL: email,
    },
  }).trim();
}

function verify(repository: string) {
  return spawnSync(process.execPath, [script], {
    cwd: repository,
    encoding: 'utf8',
    windowsHide: true,
  });
}

function trustUpstream(repository: string, tip: string): void {
  const trustPath = path.join(repository, trustedUpstreamFile);
  mkdirSync(path.dirname(trustPath), { recursive: true });
  writeFileSync(trustPath, `${tip}\n`, { flag: 'w' });
  git(repository, ['add', trustedUpstreamFile]);
  commit(repository, 'Trust reviewed upstream ancestry', safeEmail);
}

afterEach(() => {
  for (const repository of repositories.splice(0)) {
    rmSync(repository, { recursive: true, force: true });
  }
});

describe('public-history privacy gate', () => {
  it('accepts the numeric GitHub noreply identity', () => {
    const repository = makeRepository();
    const result = verify(repository);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('privacy check passed');
  });

  it('rejects a non-noreply maintainer identity without printing the address', () => {
    const repository = makeRepository();
    const privateEmail = ['totec448', 'gmail.com'].join('@');
    commit(repository, 'Unsafe identity', privateEmail);

    const result = verify(repository);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('non-noreply maintainer email');
    expect(result.stderr).not.toContain(privateEmail);
  });

  it('rejects Claude session provenance in commit messages without echoing it', () => {
    const repository = makeRepository();
    const sessionUrl = ['https://claude.ai/code/', 'session_exampleIdentifier'].join('');
    commit(repository, `Unsafe trailer\n\n${['Claude', 'Session'].join('-')}: ${sessionUrl}`, safeEmail);

    const result = verify(repository);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Claude session');
    expect(result.stderr).not.toContain(sessionUrl);
  });

  it('accepts explicitly pinned already-public upstream ancestry with a legacy maintainer identity', () => {
    const repository = makeRepository();
    const privateEmail = ['totec448', 'gmail.com'].join('@');
    git(repository, ['switch', '-c', 'upstream']);
    commit(repository, 'Already-public upstream change', privateEmail);
    const upstreamTip = git(repository, ['rev-parse', 'HEAD']);

    git(repository, ['switch', 'main']);
    trustUpstream(repository, upstreamTip);
    git(repository, ['merge', '--no-ff', 'upstream', '-m', 'Merge reviewed upstream'], safeEmail);

    const result = verify(repository);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('privacy check passed');
  });

  it('still rejects blocked provenance inside explicitly trusted upstream ancestry', () => {
    const repository = makeRepository();
    const sessionUrl = ['https://claude.ai/code/', 'session_trustedButStillBlocked'].join('');
    git(repository, ['switch', '-c', 'upstream']);
    commit(repository, `Upstream trailer\n\n${['Claude', 'Session'].join('-')}: ${sessionUrl}`, safeEmail);
    const upstreamTip = git(repository, ['rev-parse', 'HEAD']);

    git(repository, ['switch', 'main']);
    trustUpstream(repository, upstreamTip);
    git(repository, ['merge', '--no-ff', 'upstream', '-m', 'Merge reviewed upstream'], safeEmail);

    const result = verify(repository);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Claude session');
    expect(result.stderr).not.toContain(sessionUrl);
  });
});
