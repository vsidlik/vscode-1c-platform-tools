/**
 * Слияние конфигураций запуска: комментарии разбирает VS Code, здесь только уровни.
 * Запуск: npm run test:node
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { mergeLaunchConfigurations, readLaunchConfigurations } from '../../shared/launchConfigurations';

describe('mergeLaunchConfigurations', () => {
	test('конфигурация папки перекрывает одноимённую из рабочей области', () => {
		const merged = mergeLaunchConfigurations(
			[
				{ name: 'Отладка', type: 'workspace' },
				{ name: 'Только область', type: 'workspace' },
			],
			[
				{ name: 'Отладка', type: 'folder' },
				{ name: 'Только папка', type: 'folder' },
			]
		);
		assert.deepEqual(merged, [
			{ name: 'Отладка', type: 'folder' },
			{ name: 'Только область', type: 'workspace' },
			{ name: 'Только папка', type: 'folder' },
		]);
	});

	test('пустые уровни и записи без имени не выбрасываются', () => {
		assert.deepEqual(
			mergeLaunchConfigurations<{ name?: string; request?: string }>(undefined, [{ request: 'launch' }]),
			[{ request: 'launch' }]
		);
		assert.deepEqual(readLaunchConfigurations(undefined), []);
		assert.deepEqual(
			readLaunchConfigurations({ workspaceValue: [{ name: 'A' }], workspaceFolderValue: undefined }),
			[{ name: 'A' }]
		);
	});
});
