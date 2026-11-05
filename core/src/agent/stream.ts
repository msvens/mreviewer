/** A tool call the permission layer refused, as reported in the run's result. */
export interface PermissionDenial {
	tool_name: string;
	tool_use_id: string;
	tool_input: Record<string, unknown>;
}

export interface RunInit {
	apiKeySource?: string;
	model?: string;
	tools: string[];
	skills: string[];
	plugins: string[];
}

export interface RunResult {
	subtype: string;
	isError: boolean;
	text: string;
	permissionDenials: PermissionDenial[];
	costUsd?: number;
	numTurns?: number;
	durationMs?: number;
	apiErrorStatus?: number;
	terminalReason?: string;
}

type Json = Record<string, unknown>;

const strings = (v: unknown): string[] =>
	Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
const num = (v: unknown): number | undefined => (typeof v === 'number' ? v : undefined);
const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);

/**
 * Collects the parts of `claude -p --output-format stream-json` output that core acts on: the init
 * event (which auth and tools the run actually got) and the final result. Other events are ignored.
 */
export class StreamCollector {
	init: RunInit | undefined;
	result: RunResult | undefined;
	malformedLines = 0;

	/** Feed one stdout line. Returns the init event when this line was it, so callers can react early. */
	push(line: string): RunInit | undefined {
		if (!line.trim()) return undefined;
		let event: Json;
		try {
			event = JSON.parse(line) as Json;
		} catch {
			this.malformedLines++;
			return undefined;
		}
		if (event.type === 'system' && event.subtype === 'init') {
			const plugins = Array.isArray(event.plugins)
				? (event.plugins as Json[]).filter((p) => p.path !== 'builtin').map((p) => String(p.name))
				: [];
			const init: RunInit = { tools: strings(event.tools), skills: strings(event.skills), plugins };
			const apiKeySource = str(event.apiKeySource);
			const model = str(event.model);
			if (apiKeySource !== undefined) init.apiKeySource = apiKeySource;
			if (model !== undefined) init.model = model;
			this.init = init;
			return init;
		}
		if (event.type === 'result') {
			const result: RunResult = {
				subtype: str(event.subtype) ?? 'unknown',
				isError: event.is_error === true,
				text: str(event.result) ?? '',
				permissionDenials: Array.isArray(event.permission_denials)
					? (event.permission_denials as PermissionDenial[])
					: []
			};
			const optional = {
				costUsd: num(event.total_cost_usd),
				numTurns: num(event.num_turns),
				durationMs: num(event.duration_ms),
				apiErrorStatus: num(event.api_error_status),
				terminalReason: str(event.terminal_reason)
			};
			for (const [k, v] of Object.entries(optional))
				if (v !== undefined) Object.assign(result, { [k]: v });
			this.result = result;
		}
		return undefined;
	}
}
