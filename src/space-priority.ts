import type { Line, Point } from './geometry';
import type { Box, Obstacle } from './routes';
import type { LengthOptions } from './length-planner';
import { copperBounds, copperLength } from './copper';
import { SpatialIndex } from './spatial';
import { PAD_PRIORITY } from './pad-priority';
import type { PadOptions } from './pad-priority';

export type WindowPriority = (line: Line, offset: number, span: number, pattern: string, sign: number) => number;
interface Entry { points: Point[]; box: Box; layer: number; radius: number; id: string; net: string; terminal?: boolean }
const corners = (b: Box) => [{ x: b.minX, y: b.minY }, { x: b.maxX, y: b.minY }, { x: b.minX, y: b.maxY }, { x: b.maxX, y: b.maxY }];
const root = (id: string) => id.split('/length/')[0].split('/mixed/')[0];

/** Conservative corridor estimates rank candidates only; exact collision checks
 * still decide whether each native line/arc can actually be used. */
export function createSpacePriority(lines: Line[], obstacles: Obstacle[], boundaries: Line[], options: LengthOptions): WindowPriority & { source: (line: Line) => number } {
	const entries: Entry[] = lines.concat(boundaries).map(l => ({ id: l.id, net: l.net, layer: l.layer === 11 ? 12 : l.layer, radius: l.layer === 11 ? 0 : l.width / 2, box: copperBounds(l), points: l.arcAngle ? corners(copperBounds(l)) : [l.start, l.end] }));
	entries.push(...obstacles.map(o => ({ ...o, radius: 0, points: corners(o.box) })));
	const index = new SpatialIndex(entries, e => ({ minX: e.box.minX - e.radius, maxX: e.box.maxX + e.radius, minY: e.box.minY - e.radius, maxY: e.box.maxY + e.radius }));
	const cache = new WeakMap<Line, Map<string, number>>();
	const priority: WindowPriority = (line, offset, span, pattern, sign) => {
		let saved = cache.get(line); if (!saved) { saved = new Map(); cache.set(line, saved); }
		const key = `${offset}/${span}/${pattern}/${sign}`;
		const known = saved.get(key); if (known !== undefined) return known;
		const length = copperLength(line), ux = (line.end.x - line.start.x) / length, uy = (line.end.y - line.start.y) / length;
		const at = (x: number, y: number) => ({ x: line.start.x + ux * x - uy * y, y: line.start.y + uy * x + ux * y });
		const area = [at(offset, -options.amplitude), at(offset, options.amplitude), at(offset + span, -options.amplitude), at(offset + span, options.amplitude)];
		const box = { minX: Math.min(...area.map(p => p.x)), maxX: Math.max(...area.map(p => p.x)), minY: Math.min(...area.map(p => p.y)), maxY: Math.max(...area.map(p => p.y)) };
		let left = options.amplitude, right = options.amplitude;
		for (const e of index.query(box, options.clearance + line.width / 2)) {
			if (e.layer !== line.layer && e.layer !== 12 || root(e.id) === root(line.id) || e.terminal && e.net === line.net) continue;
			let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
			for (const p of e.points) { const dx = p.x - line.start.x, dy = p.y - line.start.y, x = dx * ux + dy * uy, y = -dx * uy + dy * ux; x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); }
			const pad = options.clearance + line.width / 2 + e.radius;
			if (x1 + pad < offset || x0 - pad > offset + span) continue;
			if (y0 - pad >= 0) left = Math.min(left, y0 - pad);
			else if (y1 + pad <= 0) right = Math.min(right, -y1 - pad);
			else { left = 0; right = 0; }
		}
		let score = pattern === 'double' ? Math.min(left, right) + Math.max(left, right) / 4 : pattern === 'mixed' ? Math.max(left, right) : sign > 0 ? left : right;
		const pads = (options as PadOptions)[PAD_PRIORITY];
		if (pads) {
			const distance = pads.distance(line, offset, span), zone = Math.max(3 * options.pitch, 2 * (line.width + options.clearance));
			if (pads.endsOnly && distance > zone) score = -Infinity;
			else if (Number.isFinite(distance)) score = -Math.floor(distance / zone) + score / (3 * options.amplitude);
			else score = -1e9 + score / (3 * options.amplitude);
		}
		saved.set(key, score); return score;
	};
	return Object.assign(priority, { source: (line: Line) => {
		const length = copperLength(line), guard = line.width / 2 + options.clearance, radius = (line.width + options.clearance) / 2;
		const count = options.lobes || 4, pattern = options.pattern ?? 'large';
		const span = Math.min(length - 2 * guard, (pattern === 'single' ? 2 * count - 1 : count) * options.pitch + 2 * radius);
		if (span <= 0) return -1;
		const room = Math.max(0, length - 2 * guard - span), signs = options.side === 'left' ? [1] : options.side === 'right' ? [-1] : [1, -1];
		return Math.max(...[.5, 0, 1, .25, .75].flatMap(f => signs.map(sign => priority(line, guard + room * f, span, pattern, sign))));
	} });
}
