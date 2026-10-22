import assert from 'node:assert/strict';
import * as path from 'node:path';
import { describe, test } from 'node:test';
import { findSourceDirectories, topLevelWithoutOs } from '../../features/testing/mutatos/mutatosSources';

const FIXTURES = path.resolve(__dirname, '../../../src/test/fixtures/mutatos');

/** Каталоги, которые не мутируются: тесты и результаты сборки. */
function skipOf(root: string): string[] {
	return [path.join(root, 'tests'), path.join(root, 'build', 'out'), path.join(root, 'build', 'dist')];
}

describe('mutatos: каталоги исходников', () => {
	test('каталог src берётся один, вложенные каталоги не перечисляются', () => {
		const root = path.join(FIXTURES, 'calc');

		assert.deepEqual(findSourceDirectories(root, { skip: skipOf(root) }), [path.join(root, 'src')]);
	});

	test('без src берутся каталоги верхнего уровня с файлами .os', () => {
		const root = path.join(FIXTURES, 'roots');

		assert.deepEqual(findSourceDirectories(root, { skip: skipOf(root) }), [
			path.join(root, 'Классы'),
			path.join(root, 'Модули'),
		]);
	});

	test('каталоги тестов и сборки не берутся', () => {
		const root = path.join(FIXTURES, 'roots');
		const found = findSourceDirectories(root, { skip: skipOf(root) });

		assert.ok(!found.includes(path.join(root, 'tests')));
		assert.ok(!found.includes(path.join(root, 'build')));
	});

	test('проект без файлов .os вне тестов: каталогов нет', () => {
		const root = path.join(FIXTURES, 'nosources');

		assert.deepEqual(findSourceDirectories(root, { skip: skipOf(root) }), []);
	});

	test('проект 1С с тестами OneScript: исходники в lib, выгрузка в src без .os', () => {
		const root = path.join(FIXTURES, 'with-cf');
		const withoutOs = topLevelWithoutOs(root);

		assert.deepEqual(findSourceDirectories(root, { skip: skipOf(root) }), [path.join(root, 'lib')]);
		assert.ok(withoutOs.includes('src'));
		assert.ok(withoutOs.includes('features'));
		assert.ok(!withoutOs.includes('lib'));
		assert.ok(!withoutOs.includes('tests'));
	});
});
