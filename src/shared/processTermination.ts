/**
 * Остановка процесса с ожиданием его фактического выхода.
 *
 * Отправленный сигнал ещё не значит, что процесс вышел: ibsrv на macOS после
 * SIGTERM пишет «Stand-alone Server stopped.», закрывает порты и файлы базы, но
 * сам процесс продолжает жить и держит каталог данных. Поэтому сигналы
 * отправляются по очереди, пока процесс не выйдет.
 *
 * @module processTermination
 */

import type { ChildProcess } from 'node:child_process';
import { processAlive } from './cacheDir';

/** Сигнал остановки и сколько ждать выхода процесса после него. */
export interface StopSignal {
	readonly signal: NodeJS.Signals;
	/** Сколько ждать выхода после сигнала, мс */
	readonly waitMs: number;
}

/**
 * Ожидание выхода процесса.
 *
 * @param timeoutMs - Сколько ждать, мс
 * @returns true, если процесс вышел
 */
export type ExitWaiter = (timeoutMs: number) => Promise<boolean>;

/** Отправка сигнала процессу. */
export type SignalSender = (signal: NodeJS.Signals) => void;

/** Интервал проверки, жив ли процесс, который запущен не нами, мс. */
const GONE_POLL_INTERVAL_MS = 100;

/**
 * Отправляет процессу сигналы по очереди, пока он не выйдет.
 *
 * @param send - Отправка сигнала процессу
 * @param signals - Сигналы и ожидание выхода после каждого
 * @param waitExit - Ожидание выхода процесса
 * @param onRepeat - Вызывается перед следующим сигналом, когда процесс не вышел после предыдущего
 * @returns true, если процесс вышел
 */
export async function signalUntilExit(
	send: SignalSender,
	signals: readonly StopSignal[],
	waitExit: ExitWaiter,
	onRepeat?: (next: StopSignal, previous: StopSignal) => void
): Promise<boolean> {
	let previous: StopSignal | undefined;
	for (const step of signals) {
		if (previous) {
			onRepeat?.(step, previous);
		}
		send(step.signal);
		if (await waitExit(step.waitMs)) {
			return true;
		}
		previous = step;
	}
	return false;
}

/**
 * Отправка сигнала процессу по pid — для процессов, запущенных не нами.
 *
 * Своему дочернему процессу сигнал отправляет `child.kill()`: после выхода
 * процесса он ничего не отправляет, а pid к тому времени может достаться
 * другому процессу.
 *
 * Процесса, которого уже нет, сигнал не касается. Если сигнал отправить
 * нельзя по другой причине (например, процесс чужого пользователя), ошибка
 * пробрасывается.
 *
 * @param pid - Процесс
 * @returns Отправка сигнала этому процессу
 */
export function pidSignalSender(pid: number): SignalSender {
	return (signal) => {
		try {
			process.kill(pid, signal);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== 'ESRCH') {
				throw error;
			}
		}
	};
}

/**
 * Промис выхода дочернего процесса.
 *
 * @param child - Дочерний процесс
 * @returns Промис, который разрешается, когда процесс вышел
 */
export function childExit(child: ChildProcess): Promise<void> {
	if (child.exitCode !== null || child.signalCode !== null) {
		return Promise.resolve();
	}
	return new Promise((resolve) => child.once('exit', () => resolve()));
}

/**
 * Выполняется ли промис за отведённое время.
 *
 * @param promise - Ожидаемое событие
 * @param timeoutMs - Сколько ждать, мс
 * @returns true, если промис выполнился раньше таймаута
 */
export function settlesWithin(promise: Promise<unknown>, timeoutMs: number): Promise<boolean> {
	let timer: NodeJS.Timeout | undefined;
	const timeout = new Promise<boolean>((resolve) => {
		timer = setTimeout(() => resolve(false), timeoutMs);
	});
	const settled = promise.then(() => true, () => true);
	return Promise.race([settled, timeout]).finally(() => clearTimeout(timer));
}

/**
 * Ждёт, пока процесс не исчезнет.
 *
 * Для процессов, запущенных не нами: события выхода у них нет, поэтому
 * наличие процесса проверяется периодически.
 *
 * @param pid - Процесс
 * @param timeoutMs - Сколько ждать, мс
 * @returns true, если процесса больше нет
 */
export async function waitProcessGone(pid: number, timeoutMs: number): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	while (processAlive(pid)) {
		const left = deadline - Date.now();
		if (left <= 0) {
			return false;
		}
		await new Promise((resolve) => setTimeout(resolve, Math.min(GONE_POLL_INTERVAL_MS, left)));
	}
	return true;
}
