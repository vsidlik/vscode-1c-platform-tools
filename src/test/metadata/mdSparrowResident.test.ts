import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { MdSparrowRuntime } from '../../features/metadata/mdSparrowBootstrap';
import {
	MdSparrowResidentPool,
	type ResidentRequest,
	type ResidentTiming,
} from '../../features/metadata/mdSparrowResident';
import type { MdSparrowRunResult } from '../../features/metadata/mdSparrowRunner';

/** Сервер по протоколу `serve`, запускаемый node. */
const FAKE_SERVER = path.resolve(__dirname, '../../../src/test/fixtures/mdSparrowResident/fake-server.mjs');

const silentLog = {
	error: () => undefined,
	warn: () => undefined,
	info: () => undefined,
	debug: () => undefined,
	trace: () => undefined,
};

interface Harness {
	pool: MdSparrowResidentPool;
	runtime: MdSparrowRuntime;
	stateDir: string;
	onceCalls: ResidentRequest[];
	launches: string[];
	read(...args: string[]): Promise<MdSparrowRunResult>;
	write(...args: string[]): Promise<MdSparrowRunResult>;
	starts(): number[];
	executed(behaviour: string): number;
	stats(): Promise<{ maxConcurrent: number; early: number; seen: string[] }>;
}

const harnesses: Harness[] = [];

function harness(
	mode: string,
	options: { timing?: Partial<ResidentTiming>; releaseTag?: string | null; command?: string } = {}
): Harness {
	const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'md-sparrow-resident-test-'));
	const jarPath = path.join(stateDir, 'md-sparrow-all.jar');
	fs.writeFileSync(jarPath, 'сборка 1', 'utf8');
	const runtime: MdSparrowRuntime = {
		java: 'java',
		jarPath,
		releaseTag: options.releaseTag === null ? undefined : (options.releaseTag ?? 'v0.0.0'),
		javaVersion: 25,
	};
	const onceCalls: ResidentRequest[] = [];
	const launches: string[] = [];
	const pool = new MdSparrowResidentPool({
		launch: (_runtime, jar) => {
			launches.push(jar);
			return {
				command: options.command ?? process.execPath,
				args: [FAKE_SERVER, mode, jar, stateDir],
				env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
			};
		},
		runOnce: async (_runtime, request) => {
			onceCalls.push(request);
			return { exitCode: 0, stdout: 'разовый запуск', stderr: '' };
		},
		retryable: (args) => args[0] === 'read-json',
		log: silentLog,
		timing: { readyTimeoutMs: 5000, idleMs: 60_000, exitWaitMs: 2000, drainMs: 5000, ...options.timing },
		tempRoot: stateDir,
	});
	const readLines = (name: string): string[] => {
		try {
			return fs.readFileSync(path.join(stateDir, name), 'utf8').split('\n').filter(Boolean);
		} catch {
			return [];
		}
	};
	const h: Harness = {
		pool,
		runtime,
		stateDir,
		onceCalls,
		launches,
		read: (...args) => pool.run(runtime, { args: ['read-json', ...args] }),
		write: (...args) => pool.run(runtime, { args: ['apply-mutation', ...args] }),
		starts: () => readLines('starts.log').map(Number),
		executed: (behaviour) => readLines('exec.log').filter((line) => line.split(' ')[1] === behaviour).length,
		stats: async () => JSON.parse((await h.read('stats')).stdout) as Awaited<ReturnType<Harness['stats']>>,
	};
	harnesses.push(h);
	return h;
}

function alive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

async function pidOn(h: Harness, runtime: MdSparrowRuntime): Promise<number> {
	return Number((await h.pool.run(runtime, { args: ['read-json', 'pid'] })).stdout);
}

async function waitFor(condition: () => boolean, limitMs = 5000): Promise<void> {
	const deadline = Date.now() + limitMs;
	while (!condition()) {
		if (Date.now() > deadline) {
			throw new Error('условие не выполнилось вовремя');
		}
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
}

suite('резидентный процесс md-sparrow', function () {
	this.timeout(30_000);

	teardown(async () => {
		for (const h of harnesses.splice(0)) {
			await h.pool.dispose();
			fs.rmSync(h.stateDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
		}
	});

	test('запросы уходят после строки готовности', async () => {
		const h = harness('slow-ready');

		const result = await h.read('echo', 'готово');

		assert.deepStrictEqual(result, { exitCode: 0, stdout: 'готово', stderr: '' });
		assert.strictEqual((await h.stats()).early, 0);
		assert.strictEqual(h.starts().length, 1);
		assert.strictEqual(h.onceCalls.length, 0);
	});

	test('параллельные вызовы идут очередью одного процесса и получают свои ответы', async () => {
		const h = harness('normal');
		const delays = [60, 10, 40, 0, 20];

		const results = await Promise.all(delays.map((ms, index) => h.read('sleep', String(ms), `ответ ${index}`)));

		assert.deepStrictEqual(
			results.map((result) => result.stdout),
			delays.map((_ms, index) => `ответ ${index}`)
		);
		assert.strictEqual((await h.stats()).maxConcurrent, 1);
		assert.strictEqual(h.starts().length, 1);
	});

	test('кириллица и каталог запроса доходят без искажений', async () => {
		const h = harness('normal');
		const cwd = path.join(h.stateDir, 'Выгрузка конфигурации');

		const echo = await h.read('echo', 'Справочник.Номенклатура «тест» 😀');
		const where = await h.pool.run(h.runtime, { args: ['read-json', 'cwd'], cwd });
		const nowhere = await h.read('cwd');

		assert.strictEqual(echo.stdout, 'Справочник.Номенклатура «тест» 😀');
		assert.strictEqual(where.stdout, cwd);
		assert.strictEqual(nowhere.stdout, '');
	});

	test('ненулевой код ответа отдаётся как есть', async () => {
		const h = harness('normal');

		const result = await h.write('fail');

		assert.deepStrictEqual(result, { exitCode: 2, stdout: '', stderr: 'ошибка операции' });
	});

	test('отмена запроса в работе уходит сообщением, процесс остаётся', async () => {
		const h = harness('normal');
		const before = await h.read('pid');
		const source = new vscode.CancellationTokenSource();
		const startedAt = Date.now();

		const running = h.pool.run(h.runtime, { args: ['read-json', 'sleep', '20000'], token: source.token });
		setTimeout(() => source.cancel(), 100);
		const result = await running;

		assert.strictEqual(result.exitCode, 130);
		assert.ok(Date.now() - startedAt < 5000);
		assert.strictEqual((await h.read('pid')).stdout, before.stdout);
		source.dispose();
	});

	test('отменённый в очереди запрос не доходит до процесса', async () => {
		const h = harness('normal');
		const source = new vscode.CancellationTokenSource();

		const first = h.read('sleep', '300', 'первый');
		await waitFor(() => h.executed('sleep') === 1);
		const second = h.pool.run(h.runtime, { args: ['read-json', 'echo', 'второй'], token: source.token });
		await waitFor(() => h.pool.queued() === 1);
		source.cancel();

		assert.strictEqual((await second).exitCode, 130);
		assert.strictEqual((await first).stdout, 'первый');
		assert.strictEqual(h.executed('echo'), 0);
	});

	test('уже отменённый запрос не ставится в очередь', async () => {
		const h = harness('normal');
		const source = new vscode.CancellationTokenSource();
		source.cancel();

		const result = await h.pool.run(h.runtime, { args: ['read-json', 'echo', 'нет'], token: source.token });

		assert.strictEqual(result.exitCode, 130);
		assert.deepStrictEqual(h.starts(), []);
	});

	test('падение на чтении: перезапуск и один повтор', async () => {
		const h = harness('normal');

		const result = await h.read('crash-once');

		assert.deepStrictEqual(result, { exitCode: 0, stdout: 'выжил', stderr: '' });
		assert.strictEqual(h.starts().length, 2);
		assert.strictEqual(h.executed('crash-once'), 2);
	});

	test('второе падение на том же чтении отдаётся ошибкой', async () => {
		const h = harness('normal');

		const result = await h.read('crash');

		assert.strictEqual(result.exitCode, 3);
		assert.match(result.stderr, /завершился во время операции/);
		assert.match(result.stderr, /OutOfMemoryError/);
		assert.strictEqual(h.executed('crash'), 2);
	});

	test('падение на записи не повторяется, следующий запрос идёт в новый процесс', async () => {
		const h = harness('normal');

		const writing = h.write('crash-once', '300');
		await waitFor(() => h.executed('crash-once') === 1);
		const queued = h.read('pid');
		await waitFor(() => h.pool.queued() === 1);
		const write = await writing;
		const next = await queued;

		assert.notStrictEqual(write.exitCode, 0);
		assert.match(write.stderr, /завершился во время операции/);
		assert.strictEqual(h.executed('crash-once'), 1);
		assert.strictEqual(next.exitCode, 0);
		assert.strictEqual(h.starts().length, 2);
		assert.strictEqual(next.stdout, String(h.starts()[1]));
	});

	test('после ответа с признаком завершения следующий запрос ждёт новый процесс', async () => {
		const h = harness('normal');

		const failing = h.write('fatal', '300');
		const queued = h.write('pid');
		const failed = await failing;
		const next = await queued;

		assert.strictEqual(failed.exitCode, 1);
		assert.match(failed.stderr, /OutOfMemoryError/);
		assert.strictEqual(next.exitCode, 0);
		assert.strictEqual(h.starts().length, 2);
		assert.strictEqual(next.stdout, String(h.starts()[1]));
		assert.strictEqual(h.executed('pid'), 1);
	});

	test('сборка без резидентного режима работает разовыми запусками без новых попыток', async () => {
		const h = harness('unsupported');

		const first = await h.read('echo', 'раз');
		const second = await h.write('echo', 'два');

		assert.strictEqual(first.stdout, 'разовый запуск');
		assert.strictEqual(second.stdout, 'разовый запуск');
		assert.deepStrictEqual(
			h.onceCalls.map((request) => request.args),
			[
				['read-json', 'echo', 'раз'],
				['apply-mutation', 'echo', 'два'],
			]
		);
		assert.strictEqual(h.starts().length, 1);
		assert.strictEqual(h.launches.length, 1);
	});

	for (const mode of ['garbage', 'silent', 'wrong-protocol']) {
		test(`процесс без готовности снимается, дальше разовые запуски: ${mode}`, async () => {
			const h = harness(mode, { timing: { readyTimeoutMs: 500 } });

			const queued = [h.read('echo', 'раз'), h.read('echo', 'два')];
			const results = await Promise.all(queued);
			await h.read('echo', 'три');

			assert.deepStrictEqual(
				results.map((result) => result.stdout),
				['разовый запуск', 'разовый запуск']
			);
			assert.strictEqual(h.onceCalls.length, 3);
			assert.strictEqual(h.launches.length, 1);
			await waitFor(() => !alive(h.starts()[0]));
			assert.strictEqual(h.executed('echo'), 0);
		});
	}

	test('простой останавливает процесс, следующий запрос поднимает новый', async () => {
		const h = harness('normal', { timing: { idleMs: 200 } });

		const first = Number((await h.read('pid')).stdout);
		await waitFor(() => h.pool.pids().length === 0);
		assert.ok(!alive(first));
		const second = Number((await h.read('pid')).stdout);

		assert.notStrictEqual(second, first);
		assert.strictEqual(h.starts().length, 2);
	});

	test('dispose дожидается запроса в работе и снимает очередь', async () => {
		const h = harness('normal');
		const pid = Number((await h.read('pid')).stdout);

		const running = h.read('sleep', '300', 'дописан');
		await waitFor(() => h.executed('sleep') === 1);
		const queued = h.read('echo', 'не отправлен');
		await waitFor(() => h.pool.queued() === 1);
		await h.pool.dispose();

		assert.strictEqual((await running).stdout, 'дописан');
		const dropped = await queued;
		assert.strictEqual(dropped.exitCode, -1);
		assert.match(dropped.stderr, /остановлен/);
		assert.strictEqual(h.executed('echo'), 0);
		assert.ok(!alive(pid));
	});

	test('остановка с доработкой очереди выполняет всё поставленное', async () => {
		const h = harness('normal');

		const running = h.read('sleep', '200', 'первый');
		await waitFor(() => h.executed('sleep') === 1);
		const queued = h.write('echo', 'второй');
		await waitFor(() => h.pool.queued() === 1);
		const pid = h.pool.pids()[0];
		await h.pool.stopAll('drain');

		assert.strictEqual((await running).stdout, 'первый');
		assert.strictEqual((await queued).stdout, 'второй');
		assert.ok(!alive(pid));
		assert.strictEqual((await h.read('echo', 'после')).stdout, 'после');
		assert.strictEqual(h.starts().length, 2);
	});

	test('остановка с доработкой не ждёт очередь, снятую отказом сборки', async () => {
		const h = harness('silent', { timing: { readyTimeoutMs: 300, drainMs: 10_000 } });

		const queued = h.read('echo', 'раз');
		await waitFor(() => h.launches.length === 1);
		const startedAt = Date.now();
		await h.pool.stopAll('drain');

		assert.ok(Date.now() - startedAt < 5000, `остановка заняла ${Date.now() - startedAt} мс`);
		assert.strictEqual((await queued).stdout, 'разовый запуск');
	});

	test('остановка дожидается записи, которая идёт дольше срока на выход', async () => {
		const h = harness('normal', { timing: { exitWaitMs: 300 } });
		const pid = Number((await h.read('pid')).stdout);

		const writing = h.write('sleep', '1000', 'дописана');
		await waitFor(() => h.executed('sleep') === 1);
		await h.pool.dispose();

		assert.deepStrictEqual(await writing, { exitCode: 0, stdout: 'дописана', stderr: '' });
		assert.ok(!alive(pid));
	});

	test('отмена доходит до запроса в работе и во время остановки', async () => {
		const h = harness('normal');
		const source = new vscode.CancellationTokenSource();

		const running = h.pool.run(h.runtime, { args: ['read-json', 'sleep', '20000'], token: source.token });
		await waitFor(() => h.executed('sleep') === 1);
		const pid = h.pool.pids()[0];
		const startedAt = Date.now();
		const stopped = h.pool.dispose();
		setTimeout(() => source.cancel(), 100);
		await stopped;

		assert.strictEqual((await running).exitCode, 130);
		assert.ok(Date.now() - startedAt < 1500, `остановка заняла ${Date.now() - startedAt} мс`);
		assert.ok(!alive(pid));
		source.dispose();
	});

	test('локальная сборка работает с копии, пересборка перезапускает процесс', async () => {
		const h = harness('normal', { releaseTag: null });

		const [firstJar, firstContent] = (await h.read('jar')).stdout.split('\n');
		assert.notStrictEqual(firstJar, h.runtime.jarPath);
		assert.strictEqual(firstContent, 'сборка 1');
		const firstPid = h.pool.pids()[0];

		fs.writeFileSync(h.runtime.jarPath, 'сборка 2 длиннее', 'utf8');
		const [secondJar, secondContent] = (await h.read('jar')).stdout.split('\n');

		assert.strictEqual(secondContent, 'сборка 2 длиннее');
		assert.notStrictEqual(secondJar, firstJar);
		await waitFor(() => !alive(firstPid) && !fs.existsSync(firstJar));
		await h.pool.dispose();
		await waitFor(() => !fs.existsSync(secondJar));
		assert.ok(fs.existsSync(h.runtime.jarPath));
	});

	test('новая версия из кэша релизов сменяет процесс прежней', async () => {
		const h = harness('normal');
		const nextJar = path.join(h.stateDir, 'v0.0.1', 'md-sparrow-all.jar');
		fs.mkdirSync(path.dirname(nextJar));
		fs.writeFileSync(nextJar, 'сборка 2', 'utf8');

		const first = Number((await h.read('pid')).stdout);
		const second = await pidOn(h, { ...h.runtime, jarPath: nextJar, releaseTag: 'v0.0.1' });

		assert.notStrictEqual(second, first);
		await waitFor(() => !alive(first));
		assert.deepStrictEqual(h.pool.pids(), [second]);
	});

	test('новая portable JRE сменяет процесс прежней', async () => {
		const h = harness('normal');
		const auto: MdSparrowRuntime = { ...h.runtime, java: path.join(h.stateDir, 'jre-1', 'java'), autoJava: true };

		const first = await pidOn(h, auto);
		const second = await pidOn(h, { ...auto, java: path.join(h.stateDir, 'jre-2', 'java') });

		assert.notStrictEqual(second, first);
		await waitFor(() => !alive(first));
		assert.deepStrictEqual(h.pool.pids(), [second]);
	});

	test('сборки из разных путей в настройках работают рядом', async () => {
		const h = harness('normal', { releaseTag: null });
		const otherJar = path.join(h.stateDir, 'другой проект', 'md-sparrow-all.jar');
		fs.mkdirSync(path.dirname(otherJar));
		fs.writeFileSync(otherJar, 'сборка другого проекта', 'utf8');

		const first = Number((await h.read('pid')).stdout);
		const second = await pidOn(h, { ...h.runtime, jarPath: otherJar });

		assert.notStrictEqual(second, first);
		assert.deepStrictEqual(h.pool.pids().sort(), [first, second].sort());
		assert.strictEqual(Number((await h.read('pid')).stdout), first);
	});

	test('сборка релиза запускается с места', async () => {
		const h = harness('normal');

		const [jar] = (await h.read('jar')).stdout.split('\n');

		assert.strictEqual(jar, h.runtime.jarPath);
	});

	test('копии от завершившихся окон убираются', async () => {
		const h = harness('normal', { releaseTag: null });
		const stale = path.join(h.stateDir, 'md-sparrow-resident-999999999-abc');
		fs.mkdirSync(stale);
		fs.writeFileSync(path.join(stale, 'md-sparrow.jar'), '');

		await h.read('echo', 'раз');

		assert.ok(!fs.existsSync(stale));
	});

	test('незапускаемая команда отдаётся ошибкой, а не разовым запуском', async () => {
		const h = harness('normal', { command: path.join(os.tmpdir(), 'нет-такой-java.exe') });

		await assert.rejects(h.read('echo', 'раз'), /ENOENT/);
		assert.strictEqual(h.onceCalls.length, 0);
	});
});
