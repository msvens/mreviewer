import { describe, expect, it } from 'vitest';
import { StreamCollector } from '../src/agent/stream.ts';

const lines = [
	JSON.stringify({
		type: 'system',
		subtype: 'init',
		apiKeySource: 'none',
		model: 'claude-haiku-5-5',
		tools: ['Bash', 'Read'],
		skills: ['mreviewer:review-pr'],
		plugins: [
			{ name: 'cc-plugin-telemetry', path: 'builtin' },
			{ name: 'mreviewer', path: '/engine/agent' }
		]
	}),
	JSON.stringify({ type: 'assistant', message: { content: [] } }),
	'not json',
	JSON.stringify({
		type: 'result',
		subtype: 'success',
		is_error: false,
		result: 'done',
		total_cost_usd: 0.0047,
		num_turns: 3,
		permission_denials: [
			{ tool_name: 'Bash', tool_use_id: 't1', tool_input: { command: 'git push' } }
		]
	})
];

describe('StreamCollector', () => {
	it('captures the init event and the result, ignoring other and malformed lines', () => {
		const c = new StreamCollector();
		const inits = lines.map((l) => c.push(l)).filter(Boolean);
		expect(inits).toHaveLength(1);
		expect(c.init).toEqual({
			apiKeySource: 'none',
			model: 'claude-haiku-5-5',
			tools: ['Bash', 'Read'],
			skills: ['mreviewer:review-pr'],
			plugins: ['mreviewer']
		});
		expect(c.result).toMatchObject({
			subtype: 'success',
			isError: false,
			text: 'done',
			costUsd: 0.0047,
			numTurns: 3
		});
		expect(c.result?.permissionDenials[0]?.tool_input).toEqual({ command: 'git push' });
		expect(c.malformedLines).toBe(1);
	});
});
