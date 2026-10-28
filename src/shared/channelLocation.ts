/**
 * Где слушает канал окна: именованный канал Windows или Unix-сокет.
 *
 * Модуль не зависит от VS Code API, поэтому проверяется живыми каналами на
 * Windows, Linux и macOS (`npm run test:node`).
 *
 * @module channelLocation
 */

import * as fs from 'node:fs';
import type * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';

/**
 * Предел длины пути Unix-сокета с запасом: sun_path в macOS — 104 байта, в
 * Linux — 108. Длиннее Node молча обрезает путь, и сокет оказывается вне
 * закрытого каталога.
 */
export const SOCKET_PATH_LIMIT = 100;

const SOCKET_DIR_PREFIX = '1cpt-';
const SOCKET_NAME = 'ipc.sock';

/** Путь канала и каталог Unix-сокета, который удаляется после закрытия. */
export interface ChannelLocation {
	readonly path: string;
	readonly dir?: string;
}

/**
 * Каталог для сокета: временный каталог пользователя, а если путь в нём не
 * влезает в предел (длинный TMPDIR), то /tmp.
 */
function socketBase(): string {
	// mkdtemp дописывает к префиксу шесть символов
	const sample = path.join(os.tmpdir(), `${SOCKET_DIR_PREFIX}XXXXXX`, SOCKET_NAME);
	return Buffer.byteLength(sample) < SOCKET_PATH_LIMIT ? os.tmpdir() : '/tmp';
}

/**
 * Заводит место для канала окна.
 *
 * Имена каналов Windows общие для всех сеансов машины, поэтому имя случайное:
 * его не угадать и не занять раньше окна. Unix-сокет лежит в своём временном
 * каталоге с правами 0700, другой пользователь к нему не подключится.
 *
 * @param id - Случайная часть имени
 * @returns Путь канала и каталог сокета
 */
export function createChannelLocation(id: string): ChannelLocation {
	if (process.platform === 'win32') {
		return { path: `\\\\.\\pipe\\1c-platform-tools-${id}` };
	}
	const dir = fs.mkdtempSync(path.join(socketBase(), SOCKET_DIR_PREFIX));
	return { path: path.join(dir, SOCKET_NAME), dir };
}

/**
 * Убирает каталог Unix-сокета.
 *
 * @param location - Место канала
 */
export function removeChannelLocation(location: ChannelLocation): void {
	if (location.dir) {
		fs.rmSync(location.dir, { recursive: true, force: true });
	}
}

/**
 * Слушает ли канал по-прежнему: сокет во временном каталоге может удалить
 * чистка системы, тогда подключиться к нему уже нельзя.
 *
 * @param server - Сервер канала
 * @param location - Место канала
 * @returns true, если к каналу можно подключиться
 */
export function isChannelListening(server: net.Server, location: ChannelLocation): boolean {
	return server.listening && (location.dir === undefined || fs.existsSync(location.path));
}

/**
 * Начинает слушать канал.
 *
 * @param server - Сервер канала
 * @param location - Место канала
 * @returns Промис, который завершается, когда канал слушает
 */
export function listenChannel(server: net.Server, location: ChannelLocation): Promise<void> {
	return new Promise((resolve, reject) => {
		server.once('error', reject);
		server.listen(location.path, () => {
			server.off('error', reject);
			resolve();
		});
	});
}
