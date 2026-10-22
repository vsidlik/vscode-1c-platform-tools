import * as assert from 'node:assert';
import { TREE_GROUPS, groupCommandsFor } from '../../features/tools/treeStructure';

const group = (sectionType: string) => {
	const found = TREE_GROUPS.find((item) => item.sectionType === sectionType);
	assert.ok(found, `группа ${sectionType} пропала из дерева`);
	return found;
};

const commands = (sectionType: string, format: 'designer' | 'edt' | undefined) =>
	groupCommandsFor(group(sectionType), format).map((entry) => entry.command);

suite('дерево команд под формат исходников', () => {
	test('у проекта EDT нет команд по файлам выгрузки', () => {
		const edt = commands('configuration', 'edt');
		assert.ok(!edt.includes('1c-platform-tools.cf.loadIncrement'));
		assert.ok(!edt.includes('1c-platform-tools.cf.loadByList'));
		assert.ok(!edt.includes('1c-platform-tools.cf.dumpIncrement'));
		assert.ok(edt.includes('1c-platform-tools.cf.load') && edt.includes('1c-platform-tools.cf.dump'));
		assert.ok(!commands('extension', 'edt').includes('1c-platform-tools.cfe.loadByList'));
		// У выгрузки конфигуратора состав полный
		assert.ok(commands('configuration', 'designer').includes('1c-platform-tools.cf.loadByList'));
		assert.deepStrictEqual(commands('configuration', undefined), group('configuration').commands.map((c) => c.command));
	});

	test('в группе EDT импорт доступен выгрузке, а команды проекта — проекту EDT', () => {
		const designer = commands('edt', 'designer');
		const edt = commands('edt', 'edt');
		assert.ok(designer.includes('1c-platform-tools.edt.import'));
		assert.ok(!edt.includes('1c-platform-tools.edt.import'));
		assert.ok(!designer.includes('1c-platform-tools.edt.export'));
		assert.ok(!designer.includes('1c-platform-tools.edt.projectInfo'));
		assert.ok(edt.includes('1c-platform-tools.edt.export') && edt.includes('1c-platform-tools.edt.projectInfo'));
		// Запуск и проверка живут в своих группах рядом с Предприятием и тестами
		assert.ok(!edt.includes('1c-platform-tools.run.edt') && !edt.includes('1c-platform-tools.edt.validate'));
	});

	test('запуск EDT стоит в группе запуска только у проекта EDT', () => {
		assert.ok(commands('run', 'edt').includes('1c-platform-tools.run.edt'));
		assert.ok(!commands('run', 'designer').includes('1c-platform-tools.run.edt'));
	});

	test('в дереве проверка проекта EDT — edt.validate, а не test.validateEdt', () => {
		const allTreeCommands = TREE_GROUPS.flatMap((item) => item.commands.map((entry) => entry.command));
		assert.ok(allTreeCommands.includes('1c-platform-tools.edt.validate'));
		assert.ok(
			!allTreeCommands.includes('1c-platform-tools.test.validateEdt'),
			'в дереве должна стоять edt.validate: test.validateEdt — отдельная проверка через vanessa-runner'
		);
		assert.ok(commands('test', 'edt').includes('1c-platform-tools.edt.validate'));
		assert.ok(!commands('test', 'designer').includes('1c-platform-tools.edt.validate'));
	});

	test('подписи команд одни на оба формата и не называют раскладку исходников', () => {
		// Команда, которая есть только у одного формата, вправе его называть: проверяются общие
		const entries = TREE_GROUPS.flatMap((item) => item.commands).filter((entry) => entry.formats === undefined);
		for (const entry of entries) {
			for (const layout of ['src/cf', 'src/cfe', 'tests/cfe', 'проект EDT', 'проекта EDT', 'проектов расширений']) {
				assert.ok(!entry.treeLabel.includes(layout), `${entry.command}: ${entry.treeLabel}`);
			}
		}
	});
});
