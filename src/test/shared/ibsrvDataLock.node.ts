/**
 * Процесс ibsrv, который держит каталог данных сервера (#565).
 * Запуск: npm run test:node
 */
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { DATA_LOCK_FILE, findDataDirHolder, isIbsrvCommandFor, parseLockPid } from '../../shared/ibsrvDataLock';

/** Pid, которого не бывает: больше предела pid в Linux и macOS. */
const MISSING_PID = 2_147_483_646;

describe('parseLockPid', () => {
	test('pid читается с переводом строки и BOM', () => {
		assert.equal(parseLockPid('75466'), 75466);
		assert.equal(parseLockPid('75466\n'), 75466);
		assert.equal(parseLockPid('\uFEFF75466\r\n'), 75466);
	});

	test('не pid: пусто, текст, ноль, знак, несколько чисел', () => {
		for (const text of ['', '  ', 'pid', '0', '-75466', '+75466', '75466 75467', '7.5']) {
			assert.equal(parseLockPid(text), undefined, JSON.stringify(text));
		}
	});
});

describe('isIbsrvCommandFor', () => {
	const DATA = '/Users/dev/проект/build/ibsrv';

	test('ibsrv, запущенный расширением для этого каталога данных', () => {
		const command = `/opt/1cv8/8.3.27.2074/ibsrv --data=${DATA} --config=${DATA}/publication.yaml`;
		assert.equal(isIbsrvCommandFor(command, DATA), true);
		assert.equal(isIbsrvCommandFor(`/opt/1cv8/8.3.27.2074/ibsrv --data=${DATA}`, DATA), true);
	});

	test('пробелы в пути программы и каталога данных', () => {
		const data = '/Users/dev/Мой проект/build/ibsrv';
		const command = `/Applications/1C Enterprise/8.3.27.2074/ibsrv --data=${data} --config=${data}/publication.yaml`;
		assert.equal(isIbsrvCommandFor(command, data), true);
	});

	test('ibsrv.exe на Windows', () => {
		const data = 'C:\\proj\\build\\ibsrv';
		const command = `C:\\Program Files\\1cv8\\8.3.27.1936\\bin\\ibsrv.exe --data=${data} --config=${data}\\publication.yaml`;
		assert.equal(isIbsrvCommandFor(command, data), true);
		const quoted = `"C:\\Program Files\\1cv8\\8.3.27.1936\\bin\\ibsrv.exe" --data=${data}`;
		assert.equal(isIbsrvCommandFor(quoted, data), true);
	});

	test('другой каталог данных не совпадает, даже если начинается так же', () => {
		assert.equal(isIbsrvCommandFor(`/opt/1cv8/ibsrv --data=${DATA}2 --config=x`, DATA), false);
		assert.equal(isIbsrvCommandFor(`/opt/1cv8/ibsrv --data=${DATA}`, `${DATA}/sub`), false);
		assert.equal(isIbsrvCommandFor(`/opt/1cv8/ibsrv --config=${DATA}/publication.yaml`, DATA), false);
	});

	test('не ibsrv: каталог данных в аргументах другой программы не считается', () => {
		assert.equal(isIbsrvCommandFor(`/usr/bin/node -e setInterval(()=>{},1000) --data=${DATA}`, DATA), false);
		assert.equal(isIbsrvCommandFor(`/opt/1cv8/ibsrv-tool --data=${DATA}`, DATA), false);
		assert.equal(isIbsrvCommandFor(`/opt/1cv8/8.3.27.2074/1cv8 --data=${DATA}`, DATA), false);
	});
});

describe('findDataDirHolder', () => {
	let root: string;
	let dataDir: string;
	const children: ChildProcess[] = [];

	before(() => {
		root = fs.mkdtempSync(path.join(os.tmpdir(), 'ibsrv-lock-'));
		dataDir = path.join(root, 'build', 'ibsrv');
		fs.mkdirSync(dataDir, { recursive: true });
		// Сценарий называется ibsrv: так командная строка процесса похожа на настоящий сервер
		fs.mkdirSync(path.join(root, 'bin'));
		fs.writeFileSync(path.join(root, 'bin', 'ibsrv'), "setInterval(() => {}, 1000);\nconsole.log('ready');\n");
	});

	after(async () => {
		for (const child of children) {
			if (child.exitCode === null && child.signalCode === null) {
				const exit = new Promise((resolve) => child.once('exit', resolve));
				child.kill('SIGKILL');
				await exit;
			}
		}
		fs.rmSync(root, { recursive: true, force: true });
	});

	/** Запускает процесс и ждёт, пока он стартует: до этого его командная строка ещё не его. */
	async function startProcess(args: string[]): Promise<number> {
		const child = spawn(process.execPath, args, { stdio: ['ignore', 'pipe', 'inherit'] });
		children.push(child);
		await new Promise<void>((resolve, reject) => {
			child.stdout?.on('data', (chunk: Buffer) => {
				if (chunk.toString('utf8').includes('ready')) {
					resolve();
				}
			});
			child.once('exit', () => reject(new Error('процесс вышел до готовности')));
		});
		return child.pid as number;
	}

	function writeLock(content: string): void {
		fs.writeFileSync(path.join(dataDir, DATA_LOCK_FILE), content);
	}

	test('без lock.pid каталог свободен', async () => {
		fs.rmSync(path.join(dataDir, DATA_LOCK_FILE), { force: true });
		assert.equal(await findDataDirHolder(dataDir), undefined);
	});

	test('процесса из lock.pid уже нет', async () => {
		writeLock(String(MISSING_PID));
		assert.equal(await findDataDirHolder(dataDir), undefined);
	});

	test('lock.pid с pid самого расширения не считается', async () => {
		writeLock(String(process.pid));
		assert.equal(await findDataDirHolder(dataDir), undefined);
	});

	test('живой ibsrv с этим каталогом данных держит каталог', async () => {
		const pid = await startProcess([path.join(root, 'bin', 'ibsrv'), `--data=${dataDir}`, `--config=${dataDir}/publication.yaml`]);
		writeLock(`${pid}\n`);

		assert.equal(await findDataDirHolder(dataDir), pid);
	});

	test('живой ibsrv с другим каталогом данных каталог не держит', async () => {
		const pid = await startProcess([path.join(root, 'bin', 'ibsrv'), `--data=${path.join(root, 'другой')}`]);
		writeLock(String(pid));

		assert.equal(await findDataDirHolder(dataDir), undefined);
	});

	test('pid из lock.pid достался другой программе', async () => {
		const pid = await startProcess(['-e', "setInterval(() => {}, 1000); console.log('ready');", '--', `--data=${dataDir}`]);
		writeLock(String(pid));

		assert.equal(await findDataDirHolder(dataDir), undefined);
	});
});
