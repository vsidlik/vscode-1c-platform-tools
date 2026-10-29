import * as assert from 'node:assert';
import * as os from 'node:os';
import * as path from 'node:path';
import { handleExecuteCommand } from '../../shared/channelServer';

/** Ответ канала с отказом. */
function errorOf(response: { error?: { code?: string } }): string | undefined {
	return response.error?.code;
}

/** Каталог, который не лежит ни в одной папке рабочей области хоста тестов. */
const OUTSIDE_WORKSPACE = path.join(path.parse(os.tmpdir()).root, '__1cpt-outside-workspace__', 'erp');

suite('канал исполняет только опубликованные агенту команды', () => {
	test('чужая команда редактора отклоняется', async () => {
		const response = await handleExecuteCommand(
			{ id: '1', method: 'executeCommand' },
			{ commandId: 'workbench.action.terminal.sendSequence', args: ['rm -rf /'] }
		);

		assert.strictEqual(errorOf(response), 'COMMAND_NOT_EXPOSED');
	});

	test('своя, но скрытая от агента команда отклоняется', async () => {
		const response = await handleExecuteCommand(
			{ id: '2', method: 'executeCommand' },
			{ commandId: '1c-platform-tools.clusters.terminateSession' }
		);

		assert.strictEqual(errorOf(response), 'COMMAND_NOT_EXPOSED');
	});

	test('пустой идентификатор отклоняется раньше проверки публикации', async () => {
		const response = await handleExecuteCommand(
			{ id: '3', method: 'executeCommand' },
			{ commandId: '  ' }
		);

		assert.strictEqual(errorOf(response), 'INVALID_COMMAND_ID');
	});
});

suite('канал: проект вызова', () => {
	test('путь вне папок рабочей области отклоняется до выполнения', async function () {
		this.timeout(60_000);
		const response = await handleExecuteCommand(
			{ id: '4', method: 'executeCommand' },
			{ commandId: '1c-platform-tools.cf.load', args: [{ wait: true }], projectPath: OUTSIDE_WORKSPACE }
		);

		assert.strictEqual(errorOf(response), 'WORKSPACE_MISMATCH');
	});

	test('команде окна projectPath не мешает', async function () {
		this.timeout(60_000);
		const response = await handleExecuteCommand(
			{ id: '5', method: 'executeCommand' },
			{ commandId: '1c-platform-tools.project.list', args: [{ wait: true }], projectPath: OUTSIDE_WORKSPACE }
		);

		assert.notStrictEqual(errorOf(response), 'WORKSPACE_MISMATCH');
		assert.notStrictEqual(errorOf(response), 'PROJECT_NOT_FOUND');
	});
});
