/**
 * Место канала окна: живой именованный канал Windows или Unix-сокет.
 * Запуск: npm run test:node
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import {
	createChannelLocation,
	listenChannel,
	removeChannelLocation,
	SOCKET_PATH_LIMIT,
} from '../../shared/channelLocation';

function randomId(): string {
	return crypto.randomBytes(16).toString('hex');
}

/** Сервер, который возвращает то, что получил. */
function echoServer(): net.Server {
	return net.createServer((socket) => socket.on('data', (data) => socket.end(data)));
}

function roundtrip(location: string, text: string): Promise<string> {
	return new Promise((resolve, reject) => {
		const socket = net.connect(location, () => socket.write(text));
		let answer = '';
		socket.setEncoding('utf8');
		socket.on('data', (chunk: string) => {
			answer += chunk;
		});
		socket.on('end', () => resolve(answer));
		socket.on('error', reject);
	});
}

function close(server: net.Server): Promise<void> {
	return new Promise((resolve) => server.close(() => resolve()));
}

describe('место канала окна', () => {
	test('канал слушает и отвечает', async () => {
		const location = createChannelLocation(randomId());
		const server = echoServer();
		try {
			await listenChannel(server, location);
			assert.equal(await roundtrip(location.path, 'запрос по каналу'), 'запрос по каналу');
		} finally {
			await close(server);
			removeChannelLocation(location);
		}
	});

	test('Windows: именованный канал без каталога', { skip: process.platform !== 'win32' }, () => {
		const location = createChannelLocation('0123456789abcdef');
		assert.equal(location.path, '\\\\.\\pipe\\1c-platform-tools-0123456789abcdef');
		assert.equal(location.dir, undefined);
	});

	test('Unix-сокет лежит в своём каталоге 0700 и укладывается в длину пути', { skip: process.platform === 'win32' }, () => {
		const location = createChannelLocation(randomId());
		try {
			assert.ok(location.dir);
			assert.equal(path.dirname(location.path), location.dir);
			assert.equal(fs.statSync(location.dir).mode & 0o777, 0o700);
			assert.ok(Buffer.byteLength(location.path) < SOCKET_PATH_LIMIT, location.path);
		} finally {
			removeChannelLocation(location);
		}
	});

	test('длинный TMPDIR: сокет уходит в /tmp, а не обрезается', { skip: process.platform === 'win32' }, async () => {
		const saved = process.env.TMPDIR;
		const longDir = path.join(os.tmpdir(), `1cpt-${'d'.repeat(SOCKET_PATH_LIMIT)}`);
		fs.mkdirSync(longDir, { recursive: true });
		process.env.TMPDIR = longDir;
		let location: ReturnType<typeof createChannelLocation> | undefined;
		const server = echoServer();
		try {
			location = createChannelLocation(randomId());
			assert.ok(location.dir);
			assert.ok(!location.path.startsWith(longDir), location.path);
			assert.ok(Buffer.byteLength(location.path) < SOCKET_PATH_LIMIT, location.path);
			assert.equal(fs.statSync(location.dir).mode & 0o777, 0o700);

			await listenChannel(server, location);
			assert.equal(await roundtrip(location.path, 'запрос'), 'запрос');
		} finally {
			if (saved === undefined) {
				delete process.env.TMPDIR;
			} else {
				process.env.TMPDIR = saved;
			}
			await close(server);
			if (location) {
				removeChannelLocation(location);
			}
			fs.rmSync(longDir, { recursive: true, force: true });
		}
	});

	test('занятое имя канала даёт ошибку, а не общий канал', async () => {
		const location = createChannelLocation(randomId());
		const first = echoServer();
		await listenChannel(first, location);
		try {
			await assert.rejects(listenChannel(echoServer(), location), /EADDRINUSE/);
		} finally {
			await close(first);
			removeChannelLocation(location);
		}
	});

	test('после закрытия к каналу не подключиться, каталог удалён', async () => {
		const location = createChannelLocation(randomId());
		const server = echoServer();
		await listenChannel(server, location);
		await close(server);
		removeChannelLocation(location);

		await assert.rejects(roundtrip(location.path, 'запрос'));
		if (location.dir) {
			assert.equal(fs.existsSync(location.dir), false);
		}
	});
});
