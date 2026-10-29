import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { PlatformToolsApi } from '../../app/extensionApi';
import { WindowChannel } from '../../shared/windowChannel';
import { WindowRegistration, type WindowProjects } from '../../shared/windowRegistration';
import { readWindowRecords, windowRegistryDir, type WindowRecord } from '../../shared/windowRegistry';
import { normalizeProjectRoot, type CurrentProjectChange } from '../../shared/workspaceProjects';
import { setWorkspaceTrustProbe } from '../../shared/workspaceTrust';
import { channelRequest } from '../fixtures/helpers/channelRequest';

const EXTENSION_ID = 'yellow-hammer.1c-platform-tools';

/** Папки и проекты окна, которые тест меняет сам. */
interface FakeProjects {
	readonly source: WindowProjects;
	select(root: string): void;
	dispose(): void;
}

function fakeProjects(folders: string[], projects: string[], current: string): FakeProjects {
	const projectsChanged = new vscode.EventEmitter<void>();
	const currentChanged = new vscode.EventEmitter<CurrentProjectChange>();
	let selected = current;
	return {
		source: {
			folders: () => folders.map((root) => ({ name: path.basename(root), root })),
			snapshotNow: () => ({
				projects: projects.map((root) => ({ root, name: path.basename(root), folder: root, subProject: false })),
				candidates: [],
				complete: true,
			}),
			selectedRoot: () => selected,
			onDidChangeProjects: projectsChanged.event,
			onDidChangeCurrentProject: currentChanged.event,
		},
		select(root) {
			const previous = selected;
			selected = root;
			currentChanged.fire({ previous, current: root });
		},
		dispose() {
			projectsChanged.dispose();
			currentChanged.dispose();
		},
	};
}

/** Канал, который отвечает меткой окна. */
function labelledChannel(label: string): WindowChannel {
	return new WindowChannel(() =>
		net.createServer((socket) => {
			socket.on('data', () => socket.end(`${JSON.stringify({ result: { label } })}\n`));
		})
	);
}

async function recordOf(dir: string, id: string): Promise<WindowRecord | undefined> {
	return (await readWindowRecords(dir)).find((record) => record.id === id);
}

/** Ждёт, пока запись окна станет такой, как нужно: запись идёт с задержкой. */
async function waitForRecord(dir: string, id: string, ready: (record: WindowRecord) => boolean): Promise<WindowRecord> {
	for (let attempt = 0; attempt < 50; attempt++) {
		const record = await recordOf(dir, id);
		if (record && ready(record)) {
			return record;
		}
		await new Promise((resolve) => setTimeout(resolve, 100));
	}
	assert.fail('запись окна не обновилась');
}

suite('окно в реестре окон для MCP-сервера', () => {
	let dir: string;

	setup(() => {
		dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), '1cpt-registry-')), 'windows');
	});

	teardown(() => {
		setWorkspaceTrustProbe();
		fs.rmSync(path.dirname(dir), { recursive: true, force: true });
	});

	test('API отдаёт окно из реестра, его канал отвечает только с токеном', async function () {
		this.timeout(30_000);
		const extension = vscode.extensions.getExtension<PlatformToolsApi>(EXTENSION_ID);
		assert.ok(extension, 'расширение должно быть в хосте тестов');
		const api = await extension.activate();

		const id = await api.getMcpWindow();
		assert.ok(id, 'окно должно записаться в реестр');
		assert.strictEqual(await api.getMcpWindow(), id, 'повторный запрос должен давать то же окно');

		const record = await recordOf(windowRegistryDir(), id);
		assert.ok(record, 'запись окна должна быть в реестре');
		assert.strictEqual(record.pid, process.pid);
		assert.deepStrictEqual(
			record.folders,
			(vscode.workspace.workspaceFolders ?? []).map((folder) => normalizeProjectRoot(folder.uri.fsPath))
		);

		const ping = await channelRequest(record.pipe, { id: '1', method: 'ping', token: record.token });
		assert.strictEqual(ping.result?.ok, true);
		assert.strictEqual(ping.result?.extensionId, EXTENSION_ID);

		const withoutToken = await channelRequest(record.pipe, { id: '2', method: 'ping' });
		assert.strictEqual(withoutToken.error?.code, 'UNAUTHORIZED');

		const otherToken = await channelRequest(record.pipe, { id: '3', method: 'ping', token: 'f'.repeat(64) });
		assert.strictEqual(otherToken.error?.code, 'UNAUTHORIZED');
	});

	test('запись несёт папки и проекты окна, следует за текущим проектом и убирается с окном', async () => {
		const erp = normalizeProjectRoot(path.join(os.tmpdir(), 'erp'));
		const retail = normalizeProjectRoot(path.join(os.tmpdir(), 'retail'));
		const delivery = path.join(erp, 'delivery');
		const projects = fakeProjects([erp, retail], [erp, delivery, retail], erp);
		const channel = labelledChannel('окно');
		const registration = new WindowRegistration(channel, projects.source, dir);
		try {
			const id = await registration.windowId();
			assert.ok(id);
			const record = await recordOf(dir, id);
			assert.ok(record);
			assert.deepStrictEqual(record.folders, [erp, retail]);
			assert.deepStrictEqual(record.projects, [erp, delivery, retail]);
			assert.strictEqual(record.currentProject, erp);
			assert.strictEqual((await channelRequest(record.pipe, {})).result?.label, 'окно');

			projects.select(retail);
			await waitForRecord(dir, id, (updated) => updated.currentProject === retail);

			registration.dispose();
			assert.strictEqual(await recordOf(dir, id), undefined, 'запись закрытого окна должна убираться');
		} finally {
			registration.dispose();
			channel.dispose();
			projects.dispose();
		}
	});

	test('в недоверенной папке канала нет, папка записана, после доверия канал появляется', async () => {
		const root = normalizeProjectRoot(path.join(os.tmpdir(), 'erp'));
		const projects = fakeProjects([root], [root], root);
		const channel = labelledChannel('окно');
		setWorkspaceTrustProbe(() => false);
		const registration = new WindowRegistration(channel, projects.source, dir);
		try {
			assert.strictEqual(await registration.windowId(), undefined);
			const locked = (await readWindowRecords(dir))[0];
			assert.ok(locked);
			assert.strictEqual(locked.trusted, false);
			assert.strictEqual(locked.pipe, '');
			assert.strictEqual(locked.token, '');
			assert.deepStrictEqual(locked.folders, [root]);

			setWorkspaceTrustProbe(() => true);
			const id = await registration.windowId();
			assert.ok(id, 'после доверия окно должно открыть канал');
			const record = await recordOf(dir, id);
			assert.ok(record);
			assert.strictEqual(record.trusted, true);
			assert.notStrictEqual(record.pipe, '');
		} finally {
			registration.dispose();
			channel.dispose();
			projects.dispose();
		}
	});

	test('сокет удалили: запись получает новый адрес канала', async function () {
		if (process.platform === 'win32') {
			this.skip();
		}
		const root = normalizeProjectRoot(path.join(os.tmpdir(), 'erp'));
		const projects = fakeProjects([root], [root], root);
		const channel = labelledChannel('окно');
		const registration = new WindowRegistration(channel, projects.source, dir);
		try {
			const id = await registration.windowId();
			assert.ok(id);
			const first = await recordOf(dir, id);
			assert.ok(first);
			// Так сокет во временном каталоге убирает чистка системы
			fs.rmSync(path.dirname(first.pipe), { recursive: true, force: true });

			assert.strictEqual(await registration.windowId(), id);
			const second = await recordOf(dir, id);
			assert.ok(second);
			assert.notStrictEqual(second.pipe, first.pipe);
			assert.strictEqual((await channelRequest(second.pipe, {})).result?.label, 'окно');
		} finally {
			registration.dispose();
			channel.dispose();
			projects.dispose();
		}
	});
});
