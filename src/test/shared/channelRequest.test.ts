import * as assert from 'node:assert';
import * as path from 'node:path';
import {
	extractCommandFlags,
	resolveRequestDirectory,
	resolveRequestRoot,
	type RequestRootContext,
} from '../../shared/channelRequest';
import { normalizeProjectRoot } from '../../shared/workspaceProjects';

/** Путь в стиле текущей файловой системы. */
function local(...segments: string[]): string {
	return normalizeProjectRoot(path.resolve(path.sep, 'work', ...segments));
}

/** Две папки: проект с подпроектом и папка без packagedef с проектом внутри. */
function windowWith(currentRoot: string | undefined, folders = [local('erp'), local('mono')]): RequestRootContext {
	return {
		currentRoot,
		folders,
		projects: [local('erp'), local('erp', 'sub'), local('mono', 'retail')],
	};
}

suite('resolveRequestRoot', () => {
	test('без projectPath команда выполняется в текущем проекте', () => {
		assert.deepStrictEqual(resolveRequestRoot(undefined, windowWith(local('mono', 'retail'))), {
			root: local('mono', 'retail'),
		});
	});

	test('без projectPath и без текущего проекта выполнять негде', () => {
		assert.deepStrictEqual(resolveRequestRoot(undefined, windowWith(undefined)), { error: 'PROJECT_NOT_FOUND' });
	});

	test('относительный путь считается от текущего проекта, а не от первой папки', () => {
		assert.deepStrictEqual(resolveRequestRoot('sub', windowWith(local('erp'))), { root: local('erp', 'sub') });
		assert.deepStrictEqual(resolveRequestRoot(path.join('..', 'hrm'), windowWith(local('mono', 'retail'))), {
			root: local('mono', 'hrm'),
		});
	});

	test('относительный путь без текущего проекта не к чему привязать', () => {
		assert.deepStrictEqual(resolveRequestRoot('sub', windowWith(undefined)), { error: 'PROJECT_NOT_FOUND' });
	});

	test('путь внутри проекта даёт самый глубокий проект', () => {
		const context = windowWith(local('mono', 'retail'));
		assert.deepStrictEqual(resolveRequestRoot(local('erp', 'sub', 'src', 'cf'), context), { root: local('erp', 'sub') });
		assert.deepStrictEqual(resolveRequestRoot(local('erp', 'src', 'cf'), context), { root: local('erp') });
	});

	test('путь в папке вне проектов остаётся как есть', () => {
		assert.deepStrictEqual(resolveRequestRoot(local('mono', 'tools'), windowWith(local('erp'))), {
			root: local('mono', 'tools'),
		});
		assert.deepStrictEqual(resolveRequestRoot(local('mono'), windowWith(local('erp'))), { root: local('mono') });
	});

	test('путь вне папок рабочей области отклоняется', () => {
		const context = windowWith(local('erp'));
		for (const outside of [local('hrm'), local(), local('erp-old')]) {
			assert.deepStrictEqual(resolveRequestRoot(outside, context), { error: 'WORKSPACE_MISMATCH', projectPath: outside });
		}
		assert.deepStrictEqual(resolveRequestRoot(path.join('..', 'hrm'), context), {
			error: 'WORKSPACE_MISMATCH',
			projectPath: local('hrm'),
		});
	});

	test('без папок рабочей области любой путь чужой', () => {
		assert.deepStrictEqual(resolveRequestRoot(local('erp'), windowWith(undefined, [])), {
			error: 'WORKSPACE_MISMATCH',
			projectPath: local('erp'),
		});
	});

	test('лишние разделители и точки не мешают', () => {
		assert.deepStrictEqual(resolveRequestRoot(path.join(local('erp'), 'src', '..'), windowWith(undefined)), {
			root: local('erp'),
		});
	});

	test('на Windows регистр не мешает, корень приходит в написании проекта', function () {
		if (process.platform !== 'win32') {
			this.skip();
			return;
		}
		assert.deepStrictEqual(resolveRequestRoot(local('erp', 'sub').toUpperCase(), windowWith(undefined)), {
			root: local('erp', 'sub'),
		});
	});
});

suite('resolveRequestDirectory', () => {
	test('каталог внутри проекта остаётся каталогом, а не проектом, в котором лежит', () => {
		const context = windowWith(local('erp'));
		assert.deepStrictEqual(resolveRequestDirectory(local('erp', 'sub', 'поставка'), context), {
			root: local('erp', 'sub', 'поставка'),
		});
		assert.deepStrictEqual(resolveRequestDirectory('поставка', context), { root: local('erp', 'поставка') });
	});

	test('без projectPath текущий проект не подставляется', () => {
		assert.deepStrictEqual(resolveRequestDirectory(undefined, windowWith(local('erp'))), { error: 'PROJECT_PATH_REQUIRED' });
	});

	test('каталог вне папок рабочей области отклоняется', () => {
		assert.deepStrictEqual(resolveRequestDirectory(local('hrm'), windowWith(local('erp'))), {
			error: 'WORKSPACE_MISMATCH',
			projectPath: local('hrm'),
		});
	});
});

suite('extractCommandFlags', () => {
	test('объект с флагами разбирается', () => {
		const flags = extractCommandFlags([{ wait: true, settingsFile: 'env.dev.json' }]);
		assert.strictEqual(flags.wait, true);
		assert.strictEqual(flags.settingsFile, 'env.dev.json');
	});

	test('вызов без аргументов даёт пустые флаги', () => {
		assert.deepStrictEqual(extractCommandFlags([]), {});
	});

	test('строковый аргумент из UI флагами не считается', () => {
		// команды дерева получают строку или элемент: синхронный режим не включаем
		assert.deepStrictEqual(extractCommandFlags(['dev']), {});
	});

	test('массив первым аргументом флагами не считается', () => {
		assert.deepStrictEqual(extractCommandFlags([['a', 'b']]), {});
	});

	test('null первым аргументом не роняет разбор', () => {
		assert.deepStrictEqual(extractCommandFlags([null]), {});
	});
});
