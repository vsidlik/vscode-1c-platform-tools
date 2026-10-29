import * as assert from 'node:assert';
import * as path from 'node:path';
import { initializeProjectCommand } from '../../features/projects/workspaceProjectCommands';
import { handleExecuteCommand, type ChannelWindow } from '../../shared/channelServer';
import { hasProjectFile } from '../../shared/projectLayout';
import { normalizeProjectRoot } from '../../shared/workspaceProjects';
import { copyFixtures, detectedProjects, resetLayout, type ProjectsFixture } from './workspaceProjectsFixture';

interface ExecuteResult {
	result?: { commandResult?: { success?: boolean; data?: { root?: string } }; projectRoot?: string };
	error?: { code?: string; message: string };
}

/** Окно канала над проектами фикстуры: команды инициализации выполняются как зарегистрированные. */
function fixtureWindow(fixture: ProjectsFixture, calls: unknown[][]): ChannelWindow {
	return {
		projects: fixture.source,
		executeCommand: async (commandId, ...args) => {
			calls.push([commandId, ...args]);
			return initializeProjectCommand(fixture.source, args[0], args[1]);
		},
	};
}

suite('канал: инициализация проекта по projectPath', () => {
	setup(() => {
		resetLayout();
	});

	test('конфигурация внутри проекта становится проектом, без projectPath отказ с вариантами', async function () {
		this.timeout(60_000);
		const copy = copyFixtures('две-конфигурации');
		const [root] = copy.roots;
		const delivery = normalizeProjectRoot(path.join(root, 'поставка'));
		const accounting = normalizeProjectRoot(path.join(root, 'учёт'));
		const fixture = await detectedProjects(copy.roots);
		const calls: unknown[][] = [];
		const window = fixtureWindow(fixture, calls);
		try {
			const refused = (await handleExecuteCommand(
				{ id: '1', method: 'executeCommand' },
				{ commandId: '1c-platform-tools.project.initialize', args: [{ wait: true }] },
				window
			)) as ExecuteResult;
			assert.strictEqual(refused.error?.code, 'PROJECT_PATH_REQUIRED');
			assert.ok(refused.error.message.includes(delivery) && refused.error.message.includes(accounting), refused.error.message);
			assert.deepStrictEqual(calls, []);

			const byPath = (await handleExecuteCommand(
				{ id: '2', method: 'executeCommand' },
				{ commandId: '1c-platform-tools.project.initialize', args: [{ wait: true }], projectPath: delivery },
				window
			)) as ExecuteResult;
			assert.strictEqual(byPath.result?.commandResult?.success, true, JSON.stringify(byPath));
			assert.strictEqual(byPath.result?.commandResult?.data?.root, delivery);
			assert.strictEqual(byPath.result?.projectRoot, delivery);
			assert.strictEqual(hasProjectFile(delivery), true);

			const relative = (await handleExecuteCommand(
				{ id: '3', method: 'executeCommand' },
				{
					commandId: '1c-platform-tools.dependencies.initializePackagedef',
					args: [{ wait: false }],
					projectPath: path.join('..', 'учёт'),
				},
				window
			)) as ExecuteResult;
			assert.strictEqual(relative.result?.commandResult?.success, true, JSON.stringify(relative));
			assert.strictEqual(relative.result?.commandResult?.data?.root, accounting);
			assert.strictEqual(hasProjectFile(accounting), true);
		} finally {
			fixture.instance.dispose();
			copy.dispose();
		}
	});
});
