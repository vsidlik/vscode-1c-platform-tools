import * as assert from 'node:assert';
import * as vscode from 'vscode';
import { isAgentOptions, uiOnlyHandler } from '../../shared/agentGate';
import { rootArgument } from '../../features/projects/workspaceProjectCommands';
import { PlatformTreeItem, TreeItemType } from '../../features/tools/treeViewProvider';

class RootNode extends vscode.TreeItem {
	readonly root = 'C:/projects/other';
}

suite('agentGate: агентный вызов или элемент дерева', () => {
	const treeItem = new PlatformTreeItem('Команда', TreeItemType.Task, vscode.TreeItemCollapsibleState.None);

	test('опции MCP распознаются, в том числе пустые и пришедшие через JSON', () => {
		assert.strictEqual(isAgentOptions({ wait: true, projectPath: 'C:/projects/app' }), true);
		assert.strictEqual(isAgentOptions({}), true);
		assert.strictEqual(isAgentOptions(JSON.parse('{"command":"x"}')), true);
	});

	test('элемент дерева с полем command не считается агентом', () => {
		assert.ok('command' in treeItem);
		assert.strictEqual(isAgentOptions(treeItem), false);
		assert.strictEqual(isAgentOptions(undefined), false);
		assert.strictEqual(isAgentOptions([]), false);
	});

	test('интерактивная команда из кнопки панели доходит до обработчика', () => {
		const handler = uiOnlyHandler('подсказка', () => 'открыто');
		assert.strictEqual(handler(treeItem), 'открыто');
		assert.notStrictEqual(handler({ wait: true }), 'открыто');
	});

	test('корень берётся из простого объекта, но не из чужого элемента дерева', () => {
		assert.strictEqual(rootArgument({ root: ' C:/projects/app ' }), 'C:/projects/app');
		assert.strictEqual(rootArgument(new RootNode('Узел')), undefined);
		assert.strictEqual(rootArgument(treeItem), undefined);
	});
});
