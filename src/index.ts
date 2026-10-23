import { closeController, startController } from './controller';
export async function openPanel(): Promise<void> {
	try {
		const doc = await eda.dmt_SelectControl.getCurrentDocumentInfo();
		// EDMT_EditorDocumentType.PCB=3; SDK enum is ambient, absent at runtime.
		if (doc?.documentType !== 3) throw new Error('请先打开 PCB 文档');
		await startController();
		if (!await eda.sys_IFrame.openIFrame('/iframe/index.html', 410, 670, 'track-equal-length-panel', {
			title: '一键等长', maximizeButton: false, minimizeButton: true, grayscaleMask: false, onBeforeCloseCallFn: closeController,
		})) { await closeController(); throw new Error('无法打开一键等长面板'); }
	}
	catch (error) {
		console.error('[TrackEqualLength]', 'Open panel failed', error);
		try { eda.sys_Dialog.showInformationMessage(`一键等长：${String(error)}`); }
		catch (feedbackError) { console.error('[TrackEqualLength]', 'Feedback failed', feedbackError); }
	}
}

