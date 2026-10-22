/**
 * Остановка процесса с ожиданием выхода: на живых процессах, которые ведут себя
 * как ibsrv на macOS (#565).
 * Запуск: npm run test:node
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import {
	childExit,
	pidSignalSender,
	settlesWithin,
	signalUntilExit,
	waitProcessGone,
	type StopSignal,
} from '../../shared/processTermination';

const posix = { skip: process.platform === 'win32' };

/** Pid, которого не бывает: больше предела pid в Linux и macOS. */
const MISSING_PID = 2_147_483_646;

/** Как ibsrv на macOS: после первого SIGTERM сервер остановлен, но процесс не выходит. */
const STOPS_ON_SECOND_SIGTERM = `
process.on('SIGTERM', () => {
	process.removeAllListeners('SIGTERM');
	console.log('stopped');
});
setInterval(() => {}, 1000);
console.log('ready');
`;

/** Не выходит ни по какому SIGTERM. */
const IGNORES_SIGTERM = `
process.on('SIGTERM', () => {});
setInterval(() => {}, 1000);
console.log('ready');
`;

/** Выходит по первому SIGTERM. */
const EXITS_ON_SIGTERM = `
setInterval(() => {}, 1000);
console.log('ready');
`;

/** Как у сервера, только короче: запас на медленные машины CI. */
const QUICK: readonly StopSignal[] = [
	{ signal: 'SIGTERM', waitMs: 1500 },
	{ signal: 'SIGTERM', waitMs: 1500 },
	{ signal: 'SIGKILL', waitMs: 5000 },
];

interface Started {
	child: ChildProcess;
	output: () => string;
	exit: Promise<NodeJS.Signals | null>;
}

/** Запускает node со сценарием и ждёт, пока он поставит обработчики сигналов. */
async function startScript(script: string): Promise<Started> {
	const child = spawn(process.execPath, ['-e', script], { stdio: ['ignore', 'pipe', 'inherit'] });
	let output = '';
	const exit = new Promise<NodeJS.Signals | null>((resolve) => child.once('exit', (_code, signal) => resolve(signal)));
	await new Promise<void>((resolve, reject) => {
		child.stdout?.on('data', (chunk: Buffer) => {
			output += chunk.toString('utf8');
			if (output.includes('ready')) {
				resolve();
			}
		});
		child.once('exit', () => reject(new Error(`процесс вышел до готовности: ${output}`)));
	});
	return { child, output: () => output, exit };
}

/** Останавливает сценарий так же, как менеджер сервера останавливает ibsrv. */
async function stop(started: Started, signals: readonly StopSignal[]): Promise<{ stopped: boolean; repeats: string[] }> {
	const repeats: string[] = [];
	const exit = childExit(started.child);
	const stopped = await signalUntilExit(
		(signal) => started.child.kill(signal),
		signals,
		(timeoutMs) => settlesWithin(exit, timeoutMs),
		(next, previous) => repeats.push(`${previous.signal}→${next.signal}`)
	);
	return { stopped, repeats };
}

describe('signalUntilExit', () => {
	test('процесс, который после SIGTERM не вышел, завершает повторный SIGTERM', posix, async () => {
		const started = await startScript(STOPS_ON_SECOND_SIGTERM);

		const { stopped, repeats } = await stop(started, QUICK);

		assert.equal(stopped, true);
		assert.deepEqual(repeats, ['SIGTERM→SIGTERM']);
		assert.equal(await started.exit, 'SIGTERM');
		assert.match(started.output(), /stopped/);
	});

	test('процесс, который не выходит по SIGTERM, завершает SIGKILL', posix, async () => {
		const started = await startScript(IGNORES_SIGTERM);

		const { stopped, repeats } = await stop(started, QUICK);

		assert.equal(stopped, true);
		assert.deepEqual(repeats, ['SIGTERM→SIGTERM', 'SIGTERM→SIGKILL']);
		assert.equal(await started.exit, 'SIGKILL');
	});

	test('процесс, который вышел по первому SIGTERM, больше сигналов не получает', posix, async () => {
		const started = await startScript(EXITS_ON_SIGTERM);

		const { stopped, repeats } = await stop(started, QUICK);

		assert.equal(stopped, true);
		assert.deepEqual(repeats, []);
		assert.equal(await started.exit, 'SIGTERM');
	});

	test('процесс, который пережил все сигналы, остановленным не считается', posix, async () => {
		const started = await startScript(IGNORES_SIGTERM);
		try {
			const { stopped } = await stop(started, [
				{ signal: 'SIGTERM', waitMs: 200 },
				{ signal: 'SIGTERM', waitMs: 200 },
			]);

			assert.equal(stopped, false);
			assert.equal(started.child.exitCode, null);
			assert.equal(started.child.signalCode, null);
		} finally {
			started.child.kill('SIGKILL');
			await started.exit;
		}
	});

	test('процесс, запущенный не нами, останавливается по pid', posix, async () => {
		const started = await startScript(STOPS_ON_SECOND_SIGTERM);
		const pid = started.child.pid as number;

		const stopped = await signalUntilExit(pidSignalSender(pid), QUICK, (timeoutMs) => waitProcessGone(pid, timeoutMs));

		assert.equal(stopped, true);
		assert.equal(await started.exit, 'SIGTERM');
	});
});

describe('pidSignalSender', () => {
	test('сигнал процессу, которого уже нет, не считается ошибкой', () => {
		assert.doesNotThrow(() => pidSignalSender(MISSING_PID)('SIGTERM'));
	});
});

describe('waitProcessGone', () => {
	test('процесса нет: ожидание сразу заканчивается', async () => {
		assert.equal(await waitProcessGone(MISSING_PID, 5000), true);
	});

	test('живой процесс: ожидание заканчивается по таймауту', async () => {
		const started = Date.now();
		assert.equal(await waitProcessGone(process.pid, 300), false);
		assert.ok(Date.now() - started >= 250);
	});
});

describe('settlesWithin', () => {
	test('выполненный промис укладывается во время, зависший нет', async () => {
		assert.equal(await settlesWithin(Promise.resolve(), 1000), true);
		assert.equal(await settlesWithin(Promise.reject(new Error('отказ')), 1000), true);
		assert.equal(await settlesWithin(new Promise(() => undefined), 50), false);
	});
});

describe('childExit', () => {
	test('для вышедшего процесса промис уже выполнен', async () => {
		const child = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' });
		await new Promise((resolve) => child.once('exit', resolve));

		assert.equal(await settlesWithin(childExit(child), 100), true);
	});
});
