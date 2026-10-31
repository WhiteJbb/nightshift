import { homedir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { ConfigError, DEFAULTS, loadConfig, parseConfig, slugify } from './config.ts';

describe('slugify', () => {
  it('preserves composed Hangul names', () => {
    expect(slugify('한글 프로젝트')).toBe('한글-프로젝트');
  });

  it('collapses internal runs of spaces and symbols to one hyphen', () => {
    expect(slugify('Night   Shift!!! Dashboard')).toBe('night-shift-dashboard');
  });

  it('removes leading and trailing symbols', () => {
    expect(slugify('---Night Shift!!!')).toBe('night-shift');
  });
});

describe('parseConfig', () => {
  it('fills defaults', () => {
    const c = parseConfig({}, '/base');
    expect(c.host).toBe('127.0.0.1');
    expect(c.refreshIntervalSec).toBe(5);
    expect(c.thresholds).toEqual(DEFAULTS.thresholds);
    expect(c.projects).toEqual([]);
    expect(c.allowedHosts).toEqual([]);
    expect(parseConfig({ allowedHosts: ['Mac.Tailnet.ts.net'] }, '/base').allowedHosts).toEqual(['mac.tailnet.ts.net']);
    expect(c).toMatchObject({ ignoreSpinnerChanges: true, notifications: true });
    expect(parseConfig({ errorPatterns: ['/^E\\d+/'] }, '/base')).toMatchObject({ errorPatterns: ['/^E\\d+/'] });
    // 없어진 보고서 설정이 남아 있는 예전 파일도 그대로 읽는다
    const legacy = parseConfig({ autoReportTime: '7am', reportsDir: 42 }, '/base');
    expect(legacy).not.toHaveProperty('autoReportTime');
    expect(legacy).not.toHaveProperty('reportsDir');
  });

  it('resolves paths and rejects duplicate ids', () => {
    const c = parseConfig(
      {
        thresholds: { idleMinutes: 1 },
        projects: [
          { name: 'My App', repoPath: '~/code/app', tmuxSession: 'app', logFile: 'agent.log' },
          { name: 'Other', repoPath: 'rel' },
        ],
      },
      '/base',
    );
    expect(c.thresholds).toEqual({ idleMinutes: 1, stalledMinutes: 30, noCommitMinutes: 30 });
    expect(c.projects[0]).toMatchObject({
      id: 'my-app',
      repoPath: `${homedir()}/code/app`,
      logFile: `${homedir()}/code/app/agent.log`,
      testCommand: null,
      allowInput: false,
    });
    expect(parseConfig({ projects: [{ name: 'a', repoPath: '/a', allowInput: true }] }, '/base').projects[0]!.allowInput).toBe(true);
    expect(() => parseConfig({ projects: [{ name: 'a', repoPath: '/a', allowInput: 'yes' }] }, '/base')).toThrow(/allowInput/);
    expect(c.projects[1]).toMatchObject({ id: 'other', repoPath: '/base/rel', tmuxSession: null });
    expect(() => parseConfig({ projects: [{ name: 'My App', repoPath: '/a' }, { name: 'my-app', repoPath: '/b' }] }, '/base')).toThrow(/같은 id/);
    // 이름을 바꾼 프로젝트는 적어 둔 id 를 쓴다
    expect(parseConfig({ projects: [{ name: 'Renamed', repoPath: '/a', id: 'my-app' }] }, '/base').projects[0]!.id).toBe('my-app');
    expect(() => parseConfig({ projects: [{ name: 'a', repoPath: '/a', id: 'Bad Id' }] }, '/base')).toThrow(/id:/);
    expect(() => parseConfig({ projects: [{ name: 'X', repoPath: '/a', id: 'b' }, { name: 'B', repoPath: '/b' }] }, '/base')).toThrow(/같은 id/);
  });

  it('collects all issues', () => {
    const bad = {
      port: 'x',
      thresholds: { idleMinutes: -1 },
      errorPatterns: 'error',
      promptPatterns: ['/(/'],
      notifications: 'yes',
      allowedHosts: ['https://mac.ts.net/'],
      projects: [{ name: 'a' }, { name: 'b', repoPath: '/b', tmuxSession: 'bad:name' }, { name: 'c', repoPath: '/c', tmuxSession: '-t' }, { name: 'd', repoPath: '/d', tmuxSession: '$1' }],
    };
    try {
      parseConfig(bad, '/base');
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(ConfigError);
      expect((e as ConfigError).issues).toHaveLength(10);
    }
  });
});

describe('loadConfig', () => {
  it('starts empty when the file is missing', () => {
    const { config, missing } = loadConfig('/nonexistent/nightshift.json', '/base');
    expect(missing).toBe(true);
    expect(config.projects).toEqual([]);
  });

  it('parses the example config', () => {
    const { config, missing } = loadConfig('config/nightshift.example.json', process.cwd());
    expect(missing).toBe(false);
    expect(config.projects).toHaveLength(2);
  });
});
