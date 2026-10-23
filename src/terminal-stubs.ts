import type { Obstacle, Route } from './routes';
import type { Point } from './geometry';
const distance = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y);
const key = (r: Route, p: Point) => `${r.net}/${r.layer}/${p.x.toFixed(3)}/${p.y.toFixed(3)}`;
const inside = (p: Point, o: Obstacle) => p.x >= o.box.minX - .001 && p.x <= o.box.maxX + .001 && p.y >= o.box.minY - .001 && p.y <= o.box.maxY + .001;

// A degree-two split at a pad's edge must not omit the short continuation to
// the terminal centre. A branch or a route crossing the pad centre still stops.
export function includeTerminalStubs(routes: Route[], anchors: Obstacle[]): Route[] {
	if (!anchors.length) return routes;
	const degrees = new Map<string, number>();
	for (const r of routes) for (const l of r.lines) for (const p of [l.start, l.end]) degrees.set(key(r, p), (degrees.get(key(r, p)) ?? 0) + 1);
	const pending = [...routes], output: Route[] = [];
	while (pending.length) {
		let current = pending.shift()!, grew = true;
		while (grew && !current.unsupported) {
			grew = false;
			for (let i = 0; i < pending.length; i++) {
				const other = pending[i];
				if (other.unsupported || other.net !== current.net || other.layer !== current.layer) continue;
				let joined = false;
				endpoints: for (const end of [false, true]) for (const otherEnd of [false, true]) {
					const p = end ? current.points.at(-1)! : current.points[0], q = otherEnd ? other.points.at(-1)! : other.points[0];
					if (distance(p, q) > .001 || degrees.get(key(current, p)) !== 2) continue;
					const pad = anchors.find(a => a.terminal && a.net === current.net && (a.layer === current.layer || a.layer === 12) && inside(p, a) && distance(p, { x: (a.box.minX + a.box.maxX) / 2, y: (a.box.minY + a.box.maxY) / 2 }) > .001 && (current.points.every(v => inside(v, a)) || other.points.every(v => inside(v, a))));
					if (!pad) continue;
					const aPoints = end ? current.points : [...current.points].reverse(), aLines = end ? current.lines : [...current.lines].reverse();
					const bPoints = otherEnd ? [...other.points].reverse() : other.points, bLines = otherEnd ? [...other.lines].reverse() : other.lines;
					const lines = [...aLines, ...bLines];
					current = { ...current, id: lines.map(l => l.id).sort().join('|'), lines, points: [...aPoints, ...bPoints.slice(1)], fixedStart: end ? current.fixedStart : current.fixedEnd, fixedEnd: otherEnd ? other.fixedStart : other.fixedEnd, locked: current.locked || other.locked };
					joined = true; break endpoints;
				}
				if (joined) { pending.splice(i, 1); grew = true; break; }
			}
		}
		output.push(current);
	}
	return output;
}
