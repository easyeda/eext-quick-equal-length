import type { Line } from './geometry';
import { sameLineGeometry } from './geometry';

/** Global PCB directions, independent of the source primitive's local frame. */
export function is45Line(line: Line): boolean {
	if (line.arcAngle) return true;
	const dx = Math.abs(line.end.x - line.start.x), dy = Math.abs(line.end.y - line.start.y);
	return Math.min(dx, dy, Math.abs(dx - dy)) <= .001;
}

export function assert45Changes(before: Line[], after: Line[]) {
	const old = new Map(before.map(l => [l.id, l]));
	for (const line of after) {
		const original = old.get(line.id);
		if (!is45Line(line) && (!original || !sameLineGeometry(original, line))) throw new Error(`走线 ${line.net} 新增直线不符合水平、垂直或45°方向，未提交`);
	}
}
