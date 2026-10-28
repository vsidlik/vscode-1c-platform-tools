/**
 * Реестр окон для MCP-сервера: какие папки и проекты обслуживает окно и где
 * слушает его канал.
 *
 * MCP-сервер запускают VS Code, Cursor, Claude Code и другие клиенты, и окно,
 * с которым работать, он находит здесь: по окну, из которого запущен агент, или
 * по пути проекта. У каждого окна в каталоге реестра один файл. Каталог общий
 * для всех окон пользователя на машине, где работает хост расширений.
 *
 * Модуль не зависит от VS Code API и проверяется `npm run test:node`.
 *
 * @module windowRegistry
 */

import { randomBytes } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

/** Версия формата записи: MCP-сервер не берёт записи другой версии. */
export const WINDOW_RECORD_VERSION = 1;

const RECORD_EXTENSION = '.json';

/** Коды, с которыми Windows не заменяет файл, пока его читает другой процесс. */
const BUSY_CODES: ReadonlySet<string> = new Set(['EBUSY', 'EPERM', 'EACCES']);
const REPLACE_ATTEMPTS = 5;
const REPLACE_RETRY_MS = 50;

/** Запись окна в реестре. */
export interface WindowRecord {
	readonly version: number;
	/** Случайный идентификатор окна, он же имя файла записи. */
	readonly id: string;
	/** Процесс хоста расширений окна. */
	readonly pid: number;
	/** Машина процесса: по ней чистка не трогает записи других машин с тем же домашним каталогом. */
	readonly hostname: string;
	/** Редактор окна: Visual Studio Code, Cursor. */
	readonly app: string;
	/** Имя окна: папка или рабочая область. */
	readonly name: string;
	/** Путь канала окна. */
	readonly pipe: string;
	/** Токен канала окна. */
	readonly token: string;
	/** Папки рабочей области. */
	readonly folders: readonly string[];
	/** Проекты окна: каталоги с `packagedef`. */
	readonly projects: readonly string[];
	/** Текущий проект окна. */
	readonly currentProject?: string;
	/** Время записи. */
	readonly updatedAt: string;
}

/**
 * Каталог реестра окон.
 *
 * @param home - Домашний каталог пользователя
 * @returns Путь каталога
 */
export function windowRegistryDir(home: string = os.homedir()): string {
	return path.join(home, '.1c-platform-tools', 'windows');
}

function recordFile(dir: string, id: string): string {
	return path.join(dir, `${id}${RECORD_EXTENSION}`);
}

function isStringList(value: unknown): value is string[] {
	return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

/**
 * Разбирает запись окна.
 *
 * @param text - Содержимое файла записи
 * @returns Запись либо undefined, если файл повреждён или другого формата
 */
export function parseWindowRecord(text: string): WindowRecord | undefined {
	let value: unknown;
	try {
		value = JSON.parse(text);
	} catch {
		return undefined;
	}
	if (typeof value !== 'object' || value === null) {
		return undefined;
	}
	const record = value as Partial<Record<keyof WindowRecord, unknown>>;
	const valid =
		record.version === WINDOW_RECORD_VERSION &&
		typeof record.id === 'string' &&
		typeof record.pid === 'number' &&
		typeof record.hostname === 'string' &&
		typeof record.app === 'string' &&
		typeof record.name === 'string' &&
		typeof record.pipe === 'string' &&
		typeof record.token === 'string' &&
		isStringList(record.folders) &&
		isStringList(record.projects) &&
		(record.currentProject === undefined || typeof record.currentProject === 'string') &&
		typeof record.updatedAt === 'string';
	return valid ? (value as WindowRecord) : undefined;
}

/**
 * Записи реестра; повреждённые и другого формата пропускаются.
 *
 * @param dir - Каталог реестра
 * @returns Промис, который разрешается записями окон
 */
export async function readWindowRecords(dir: string): Promise<WindowRecord[]> {
	let names: string[];
	try {
		names = await fs.promises.readdir(dir);
	} catch {
		return [];
	}
	const records: WindowRecord[] = [];
	for (const name of names.filter((entry) => entry.endsWith(RECORD_EXTENSION))) {
		const text = await fs.promises.readFile(path.join(dir, name), 'utf8').catch(() => undefined);
		const record = text === undefined ? undefined : parseWindowRecord(text);
		if (record) {
			records.push(record);
		}
	}
	return records;
}

async function replaceFile(source: string, target: string): Promise<void> {
	for (let attempt = 1; ; attempt++) {
		try {
			await fs.promises.rename(source, target);
			return;
		} catch (error) {
			const code = (error as NodeJS.ErrnoException).code ?? '';
			if (process.platform !== 'win32' || !BUSY_CODES.has(code) || attempt >= REPLACE_ATTEMPTS) {
				throw error;
			}
			await new Promise((resolve) => setTimeout(resolve, REPLACE_RETRY_MS));
		}
	}
}

/**
 * Записывает окно в реестр.
 *
 * В записи токен канала, поэтому каталог и файл закрыты от других
 * пользователей (0700 и 0600, на Windows права даёт профиль пользователя).
 * Файл заменяется целиком переименованием: MCP-сервер не прочтёт половину записи.
 *
 * @param dir - Каталог реестра
 * @param record - Запись окна
 * @returns Промис, который разрешается, когда запись на диске
 */
export async function writeWindowRecord(dir: string, record: WindowRecord): Promise<void> {
	await fs.promises.mkdir(dir, { recursive: true, mode: 0o700 });
	const file = recordFile(dir, record.id);
	const temp = `${file}.${randomBytes(4).toString('hex')}.tmp`;
	await fs.promises.writeFile(temp, `${JSON.stringify(record, null, '\t')}\n`, { mode: 0o600 });
	try {
		await replaceFile(temp, file);
	} catch (error) {
		await fs.promises.rm(temp, { force: true });
		throw error;
	}
}

/**
 * Убирает запись окна; синхронно, потому что вызывается при закрытии окна.
 *
 * @param dir - Каталог реестра
 * @param id - Идентификатор окна
 */
export function removeWindowRecord(dir: string, id: string): void {
	fs.rmSync(recordFile(dir, id), { force: true });
}

/**
 * Жив ли процесс.
 *
 * @param pid - Идентификатор процесса
 * @returns true, если процесс есть
 */
export function isProcessAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		// EPERM: процесс есть, но сигналы ему слать нельзя
		return (error as NodeJS.ErrnoException).code === 'EPERM';
	}
}

/**
 * Убирает записи окон этой машины, процесс которых завершился: так остаются
 * записи окон, хост расширений которых упал.
 *
 * @param dir - Каталог реестра
 * @param hostname - Эта машина
 * @param isAlive - Проверка процесса
 * @returns Промис, который разрешается числом убранных записей
 */
export async function pruneWindowRecords(
	dir: string,
	hostname: string = os.hostname(),
	isAlive: (pid: number) => boolean = isProcessAlive
): Promise<number> {
	let removed = 0;
	for (const record of await readWindowRecords(dir)) {
		if (record.hostname === hostname && !isAlive(record.pid)) {
			removeWindowRecord(dir, record.id);
			removed += 1;
		}
	}
	return removed;
}
