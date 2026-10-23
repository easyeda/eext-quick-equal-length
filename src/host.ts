import type { Line } from './geometry';

const TAG = '[TrackEqualLength]';
// Verified EDMT_EditorDocumentType.PCB value.
// These SDK enums have ambient declarations, but no runtime globals in 4.1.71.
const PCB = 3;

export interface Selection {
	doc: IDMT_EditorDocumentItem;
	selectedIds: string[];
	lines: Line[];
	ignored: number;
}

export async function assertDocument(expected?: IDMT_EditorDocumentItem) {
	try {
		const doc = await eda.dmt_SelectControl.getCurrentDocumentInfo();
		if (!doc || doc.documentType !== PCB)
			throw new Error('请先激活 PCB 画布');
		if (expected && (expected.uuid !== doc.uuid || expected.parentProjectUuid !== doc.parentProjectUuid))
			throw new Error('PCB 已切换，请重新读取');
		return doc;
	}
	catch (error) {
		console.error(TAG, 'Document check failed', error);
		throw error;
	}
}

export function lineData(p: IPCB_PrimitiveLine): Line {
	return {
		id: p.getState_PrimitiveId(),
		layer: p.getState_Layer(),
		net: p.getState_Net(),
		width: p.getState_LineWidth(),
		locked: p.getState_PrimitiveLock(),
		start: { x: p.getState_StartX(), y: p.getState_StartY() },
		end: { x: p.getState_EndX(), y: p.getState_EndY() },
	};
}
export function arcData(p: IPCB_PrimitiveArc): Line {
	return { id: p.getState_PrimitiveId(), layer: p.getState_Layer(), net: p.getState_Net(), width: p.getState_LineWidth(), locked: p.getState_PrimitiveLock(), start: { x: p.getState_StartX(), y: p.getState_StartY() }, end: { x: p.getState_EndX(), y: p.getState_EndY() }, arcAngle: p.getState_ArcAngle(), interactiveMode: p.getState_InteractiveMode() };
}

