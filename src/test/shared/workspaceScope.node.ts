/**
 * Уровень записи настройки проекта.
 * Запуск: npm run test:node
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { writesToWorkspaceFolder } from '../../shared/workspaceScope';

describe('workspaceScope', () => {
	test('в окне из нескольких папок настройка пишется в папку проекта', () => {
		assert.equal(writesToWorkspaceFolder(2, true), true);
		assert.equal(writesToWorkspaceFolder(2, false), false);
		assert.equal(writesToWorkspaceFolder(1, true), false);
	});
});
