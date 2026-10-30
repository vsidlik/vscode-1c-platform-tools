import * as assert from 'node:assert';
import {
	TREE_GROUPS,
	favoriteVisibleFor,
	groupCommandsFor,
	groupVisibleFor,
	mergeFavorites,
	treeTraitsOf,
} from '../../features/tools/treeStructure';

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

suite('дерево команд под вид проекта', () => {
	const oneScript = treeTraitsOf('onescript', false);
	const visibleGroups = (traits: ReturnType<typeof treeTraitsOf>) =>
		TREE_GROUPS.filter((item) => item.sectionType !== 'helpAndSupport' && groupVisibleFor(item, traits)).map((item) => item.sectionType);

	test('у проекта OneScript зависимости, пакет, тесты и навыки, групп платформы нет', () => {
		assert.deepStrictEqual(visibleGroups(oneScript), ['dependency', 'package', 'test', 'skills']);
	});

	test('у проекта 1С группы платформы, пакет только у пакета OneScript', () => {
		const onec = visibleGroups(treeTraitsOf('designer', false));
		assert.ok(onec.includes('configuration') && onec.includes('infobase') && onec.includes('serviceFiles'));
		assert.ok(!onec.includes('package'));
		assert.ok(visibleGroups(treeTraitsOf('designer', true)).includes('package'), 'проект 1С, который ещё и библиотека OneScript');
	});

	test('пока вид не известен, дерево как у проекта 1С', () => {
		assert.deepStrictEqual(visibleGroups(treeTraitsOf(undefined, false)), visibleGroups(treeTraitsOf('onec', false)));
	});

	test('в группах проекта OneScript только его команды', () => {
		const commands = (sectionType: string) => groupCommandsFor(group(sectionType), undefined, oneScript).map((entry) => entry.command);
		assert.deepStrictEqual(commands('test'), [
			'1c-platform-tools.test.onescript',
			'1c-platform-tools.test.mutatos',
			'1c-platform-tools.test.allure',
		]);
		assert.ok(!commands('dependency').includes('1c-platform-tools.dependencies.initializeProjectStructure'));
		assert.ok(commands('dependency').includes('1c-platform-tools.dependencies.selectOscript'));
		assert.deepStrictEqual(commands('skills').sort(), [
			'1c-platform-tools.mcp.configureCursor',
			'1c-platform-tools.skills.add1cpt',
			'1c-platform-tools.skills.addOnescript',
		]);
		// Тесты OneScript у проекта 1С без пакета в дереве не нужны: их гоняет панель тестирования
		assert.ok(!groupCommandsFor(group('test'), undefined, treeTraitsOf('designer', false)).some((entry) => entry.command === '1c-platform-tools.test.onescript'));
	});

	test('избранное: команды платформы у проекта OneScript не видны, цепочки и задачи видны', () => {
		assert.strictEqual(favoriteVisibleFor('1c-platform-tools.cf.load', 'configuration', oneScript), false);
		assert.strictEqual(favoriteVisibleFor('1c-platform-tools.dependencies.install', 'dependency', oneScript), true);
		assert.strictEqual(favoriteVisibleFor('1c-platform-tools.epf.setVersionReport', 'setVersion', oneScript), false);
		assert.strictEqual(favoriteVisibleFor('1c-platform-tools.pipelines.run', 'pipelines', oneScript), true);
		assert.strictEqual(favoriteVisibleFor('1c-platform-tools.tasks.runOscript', 'oscriptTasks', oneScript), true);
	});

	test('избранное: сохранение у проекта OneScript не теряет команды проекта 1С и обратно', () => {
		const load = { command: '1c-platform-tools.cf.load', sectionType: 'configuration' };
		const install = { command: '1c-platform-tools.dependencies.install', sectionType: 'dependency' };
		const build = { command: '1c-platform-tools.package.build', sectionType: 'package' };
		const pipeline = { command: '1c-platform-tools.pipelines.run', sectionType: 'pipelines' };

		// Окно у проекта OneScript показало install, build и цепочку: отмечена только сборка
		assert.deepStrictEqual(mergeFavorites([load, install, pipeline], [build], oneScript), [load, build]);
		// У проекта 1С без пакета команда сборки в окне не видна и тоже остаётся
		assert.deepStrictEqual(mergeFavorites([build, install], [], treeTraitsOf('designer', false)), [build]);
	});
});
