import * as assert from 'node:assert';
import * as os from 'node:os';
import * as path from 'node:path';
import { externalArtifactTarget } from '../../features/metadata/externalArtifactTarget';

const REPO = path.join(os.tmpdir(), 'repo-external');

suite('внешний отчёт и обработка', () => {
	test('проект EDT лежит рядом с проектом конфигурации', () => {
		const configuration = path.join(REPO, 'src', 'Инструменты');
		const target = externalArtifactTarget(REPO, 'src/epf', 'edt', {
			dir: configuration,
			format: 'edt',
		});

		assert.strictEqual(target.artifactsRoot, path.join(REPO, 'src'));
		assert.strictEqual(
			target.configurationMdo,
			path.join(configuration, 'src', 'Configuration', 'Configuration.mdo')
		);
	});

	test('без конфигурации проект EDT лежит в корне, выгрузка — в своём каталоге', () => {
		const edt = externalArtifactTarget(REPO, 'src/epf', 'edt', undefined);
		const designer = externalArtifactTarget(REPO, 'src/erf', 'designer', undefined);

		assert.strictEqual(edt.artifactsRoot, REPO);
		assert.strictEqual(edt.configurationMdo, undefined);
		assert.strictEqual(designer.artifactsRoot, path.join(REPO, 'src', 'erf'));
		assert.strictEqual(designer.configurationMdo, undefined);
	});
});
