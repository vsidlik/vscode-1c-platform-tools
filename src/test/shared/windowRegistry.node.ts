/**
 * Реестр окон для MCP-сервера: запись, разбор и чистка записей упавших окон.
 * Запуск: npm run test:node
 */
import { afterEach, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
	parseWindowRecord,
	pruneWindowRecords,
	readWindowRecords,
	removeWindowRecord,
	windowRegistryDir,
	writeWindowRecord,
	WINDOW_RECORD_VERSION,
	type WindowRecord,
} from '../../shared/windowRegistry';
import { fixturePath } from '../fixtures/helpers/fixturePath';

const FIXTURE_TEXT = fs.readFileSync(fixturePath('windowRegistry', 'record.json'), 'utf8');

/** Запись из фикстуры с другим идентификатором и процессом. */
function recordOf(id: string, changes: Partial<WindowRecord> = {}): WindowRecord {
	return { ...(JSON.parse(FIXTURE_TEXT) as WindowRecord), id, ...changes };
}

let dir: string;

beforeEach(() => {
	dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), '1cpt-registry-')), 'windows');
});

afterEach(() => {
	fs.rmSync(path.dirname(dir), { recursive: true, force: true });
});

describe('запись окна', () => {
	test('фикстура формата разбирается и несёт текущую версию', () => {
		const record = parseWindowRecord(FIXTURE_TEXT);
		assert.ok(record, 'запись из фикстуры должна разбираться');
		assert.equal(record.version, WINDOW_RECORD_VERSION);
		assert.deepEqual(record.folders, ['/home/dev/erp', '/home/dev/retail']);
	});

	test('повреждённая запись, запись другой версии и без полей не разбираются', () => {
		assert.equal(parseWindowRecord('{"version": 1, "id": '), undefined);
		assert.equal(parseWindowRecord(JSON.stringify(recordOf('a', { version: WINDOW_RECORD_VERSION + 1 }))), undefined);
		const withoutToken = JSON.parse(FIXTURE_TEXT) as Record<string, unknown>;
		delete withoutToken.token;
		assert.equal(parseWindowRecord(JSON.stringify(withoutToken)), undefined);
		assert.equal(parseWindowRecord(JSON.stringify({ ...recordOf('c'), folders: '/home/dev/erp' })), undefined);
	});

	test('окно пишет те же поля, что в формате реестра', async () => {
		await writeWindowRecord(dir, recordOf('0a1b'));
		const written = JSON.parse(fs.readFileSync(path.join(dir, '0a1b.json'), 'utf8')) as Record<string, unknown>;
		assert.deepEqual(Object.keys(written).sort(), Object.keys(JSON.parse(FIXTURE_TEXT) as object).sort());
	});

	test('запись читается обратно и заменяется целиком', async () => {
		await writeWindowRecord(dir, recordOf('0a1b'));
		await writeWindowRecord(dir, recordOf('0a1b', { currentProject: '/home/dev/retail' }));

		const records = await readWindowRecords(dir);
		assert.equal(records.length, 1);
		assert.equal(records[0].currentProject, '/home/dev/retail');
		assert.deepEqual(fs.readdirSync(dir), ['0a1b.json'], 'временных файлов остаться не должно');
	});

	test('каталог и файл закрыты от других пользователей', { skip: process.platform === 'win32' }, async () => {
		await writeWindowRecord(dir, recordOf('0a1b'));
		assert.equal(fs.statSync(dir).mode & 0o777, 0o700);
		assert.equal(fs.statSync(path.join(dir, '0a1b.json')).mode & 0o777, 0o600);
	});

	test('запись убирается, повторное удаление не падает', async () => {
		await writeWindowRecord(dir, recordOf('0a1b'));
		removeWindowRecord(dir, '0a1b');
		removeWindowRecord(dir, '0a1b');
		assert.deepEqual(await readWindowRecords(dir), []);
	});

	test('без каталога реестра записей нет', async () => {
		assert.deepEqual(await readWindowRecords(path.join(dir, 'нет')), []);
	});

	test('каталог реестра лежит в домашнем каталоге', () => {
		assert.equal(windowRegistryDir(path.join('/home', 'dev')), path.join('/home', 'dev', '.1c-platform-tools', 'windows'));
	});
});

describe('чистка реестра', () => {
	test('убираются записи упавших окон этой машины, живые и чужие остаются', async () => {
		await writeWindowRecord(dir, recordOf('live', { pid: 1, hostname: 'dev-host' }));
		await writeWindowRecord(dir, recordOf('dead', { pid: 2, hostname: 'dev-host' }));
		await writeWindowRecord(dir, recordOf('other', { pid: 2, hostname: 'other-host' }));

		const removed = await pruneWindowRecords(dir, 'dev-host', (pid) => pid === 1);

		assert.equal(removed, 1);
		assert.deepEqual((await readWindowRecords(dir)).map((record) => record.id).sort(), ['live', 'other']);
	});

	test('запись своего процесса не убирается', async () => {
		await writeWindowRecord(dir, recordOf('self', { pid: process.pid, hostname: os.hostname() }));
		assert.equal(await pruneWindowRecords(dir), 0);
		assert.equal((await readWindowRecords(dir)).length, 1);
	});
});
