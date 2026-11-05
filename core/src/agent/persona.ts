import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { InstancePaths } from '../home.ts';

export interface PersonaPart {
	title: string;
	source: string;
	body: string;
}

/** Join persona parts into one system-prompt file, each part labelled with its source. */
export function assemblePersona(parts: PersonaPart[]): string {
	return parts
		.filter((p) => p.body.trim().length > 0)
		.map((p) => `<!-- source: ${p.source} -->\n## ${p.title}\n\n${p.body.trim()}\n`)
		.join('\n');
}

async function readIfExists(path: string): Promise<string | undefined> {
	try {
		return await readFile(path, 'utf8');
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
		throw err;
	}
}

/**
 * The engine's base persona, then the instance's approved knowledge: persona overrides,
 * conventions (one file per stack, sorted; README.md is documentation, not rules), feedback rules.
 * Missing instance files are skipped.
 */
export async function loadPersonaParts(
	agentDir: string,
	paths: InstancePaths
): Promise<PersonaPart[]> {
	const base = await readFile(join(agentDir, 'persona.md'), 'utf8');
	const parts: PersonaPart[] = [{ title: 'Base persona', source: 'agent/persona.md', body: base }];

	const persona = await readIfExists(paths.config.persona);
	if (persona)
		parts.push({ title: 'Persona overrides', source: 'config/persona.md', body: persona });

	let conventionFiles: string[] = [];
	try {
		conventionFiles = (await readdir(paths.config.conventions))
			.filter((f) => f.endsWith('.md') && f.toLowerCase() !== 'readme.md')
			.sort();
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
	}
	for (const file of conventionFiles) {
		const body = await readFile(join(paths.config.conventions, file), 'utf8');
		parts.push({
			title: `Conventions: ${file.replace(/\.md$/, '')}`,
			source: `config/conventions/${file}`,
			body
		});
	}

	const rules = await readIfExists(paths.config.feedbackRules);
	if (rules)
		parts.push({ title: 'Feedback rules', source: 'config/feedback-rules.md', body: rules });

	return parts;
}
