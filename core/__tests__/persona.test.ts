import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { assemblePersona, loadPersonaParts } from '../src/agent/persona.ts';
import { instancePaths } from '../src/home.ts';

let dir: string;
beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), 'mreviewer-persona-'));
	await mkdir(join(dir, 'agent'));
	await writeFile(join(dir, 'agent', 'persona.md'), 'BASE');
});
afterEach(() => rm(dir, { recursive: true, force: true }));

describe('loadPersonaParts', () => {
	it('uses only the base persona when the instance has no config yet', async () => {
		const parts = await loadPersonaParts(join(dir, 'agent'), instancePaths(join(dir, 'inst')));
		expect(parts.map((p) => p.source)).toEqual(['agent/persona.md']);
	});

	it('appends persona, conventions (sorted, README skipped) and feedback rules in that order', async () => {
		const paths = instancePaths(join(dir, 'inst'));
		await mkdir(paths.config.conventions, { recursive: true });
		await writeFile(paths.config.persona, 'MINE');
		await writeFile(join(paths.config.conventions, 'sveltekit.md'), 'SVELTE');
		await writeFile(join(paths.config.conventions, 'general.md'), 'GENERAL');
		await writeFile(join(paths.config.conventions, 'README.md'), 'DOCS');
		await writeFile(paths.config.feedbackRules, 'RULES');

		const parts = await loadPersonaParts(join(dir, 'agent'), paths);
		expect(parts.map((p) => p.source)).toEqual([
			'agent/persona.md',
			'config/persona.md',
			'config/conventions/general.md',
			'config/conventions/sveltekit.md',
			'config/feedback-rules.md'
		]);
		const text = assemblePersona(parts);
		expect(text.indexOf('BASE')).toBeLessThan(text.indexOf('MINE'));
		expect(text.indexOf('GENERAL')).toBeLessThan(text.indexOf('SVELTE'));
		expect(text).not.toContain('DOCS');
	});
});

describe('assemblePersona', () => {
	it('labels each part with its source and drops empty parts', () => {
		const text = assemblePersona([
			{ title: 'A', source: 'a.md', body: 'alpha' },
			{ title: 'B', source: 'b.md', body: '  \n' }
		]);
		expect(text).toContain('<!-- source: a.md -->\n## A\n\nalpha');
		expect(text).not.toContain('b.md');
	});
});
