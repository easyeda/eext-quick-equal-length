import type { Line } from './geometry';
import type { Obstacle, Route, RoutePlan } from './push-routes';
import type { Steps } from './work';
import { materialize, resolvePlansSteps } from './push-routes';
import { pointDistance } from './routes';

export interface PushedRoute { id: string; net: string; lines: number }
// Seed complete original routes with the already tuned geometry. These routes
// stay fixed throughout shove, so the selected segments cannot lose their length.
export function* shoveLengthsSteps(lines: Line[], routes: Route[], chosen: Route[], groups: Line[][], clearance: number, obstacles: Obstacle[], boundaries: Line[]): Steps<{ lines: Line[]; pushed: PushedRoute[]; preview: Line[][] }> {
	const replacements = new Map<string, Line[]>();
	const selected = new Set(chosen.flatMap(r => r.lines.map(l => l.id)));
	for (let i = 0; i < chosen.length; i++) {
		for (const original of chosen[i].lines) {
			const replacement = groups[i].filter(l => l.id === original.id || l.id.startsWith(`${original.id}/length/`));
			if (!replacement.length) throw new Error('补长方案丢失原线段，未提交');
			replacements.set(original.id, replacement);
		}
	}
	const plans = new Map<string, RoutePlan>();
	for (const route of routes) {
		if (!route.lines.some(l => selected.has(l.id))) continue;
		plans.set(route.id, { route, pushed: false, points: route.points.map(p => ({ ...p })), pieces: route.lines.flatMap(before => (replacements.get(before.id) ?? [before]).map(after => ({ before: !after.arcAngle && pointDistance(after.start, before.start, before.end) < .001 && pointDistance(after.end, before.start, before.end) < .001 ? before : undefined, after }))) });
	}
	const resolved = yield* resolvePlansSteps(routes, plans, 'push', clearance, obstacles, boundaries);
	const layout = new Map(lines.map(l => [l.id, l]));
	let serial = 0;
	const pushed: PushedRoute[] = [];
	const preview: Line[][] = [];
	for (const plan of resolved) {
		for (const original of plan.route.lines) layout.delete(original.id);
		const output = materialize(plan).map(({ after }) => {
			if (after.id) return after;
			let id: string;
			do { id = `length-push/${serial++}`; } while (layout.has(id));
			return { ...after, id };
		});
		for (const line of output) {
			if (layout.has(line.id)) throw new Error('推挤生成重复线段标识，未提交');
			layout.set(line.id, line);
		}
		if (plan.pushed) { pushed.push({ id: plan.route.id, net: plan.route.net, lines: output.length }); preview.push(output); }
		yield;
	}
	return { lines: [...layout.values()], pushed, preview };
}
