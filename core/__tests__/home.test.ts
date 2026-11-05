import { describe, expect, it } from 'vitest';
import { instancePaths, resolveHome } from '../src/home.ts';

const HOME = '/Users/someone';
const CWD = '/work';

describe('resolveHome', () => {
	it('defaults to ~/.mreviewer when MREVIEWER_HOME is unset or blank', () => {
		expect(resolveHome({}, HOME, CWD)).toBe('/Users/someone/.mreviewer');
		expect(resolveHome({ MREVIEWER_HOME: '  ' }, HOME, CWD)).toBe('/Users/someone/.mreviewer');
	});

	it('uses an absolute MREVIEWER_HOME as is, normalised', () => {
		expect(resolveHome({ MREVIEWER_HOME: '/srv/rev/../mrev/' }, HOME, CWD)).toBe('/srv/mrev');
	});

	it('expands a leading ~', () => {
		expect(resolveHome({ MREVIEWER_HOME: '~/inst' }, HOME, CWD)).toBe('/Users/someone/inst');
		expect(resolveHome({ MREVIEWER_HOME: '~' }, HOME, CWD)).toBe('/Users/someone');
	});

	it('resolves a relative path against cwd', () => {
		expect(resolveHome({ MREVIEWER_HOME: 'inst' }, HOME, CWD)).toBe('/work/inst');
	});
});

describe('instancePaths', () => {
	it('lays out config/ and state/ under the root', () => {
		const p = instancePaths('/i');
		expect(p.config.root).toBe('/i/config');
		expect(p.config.feedbackRules).toBe('/i/config/feedback-rules.md');
		expect(p.state.runLock).toBe('/i/state/run.lock');
		expect(p.state.worktrees).toBe('/i/state/worktrees');
	});

	it('rejects a relative root', () => {
		expect(() => instancePaths('rel')).toThrow(/absolute/);
	});
});
