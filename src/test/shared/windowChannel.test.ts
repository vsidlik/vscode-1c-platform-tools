import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as path from 'node:path';
import { WindowChannel, type ChannelServerFactory } from '../../shared/windowChannel';
import { setWorkspaceTrustProbe } from '../../shared/workspaceTrust';
import { channelRequest as request } from '../fixtures/helpers/channelRequest';

/** Сервер канала, который отвечает своей меткой: по ней видно, в какое окно попал запрос. */
function labelledServer(label: string): ChannelServerFactory {
	return () =>
		net.createServer((socket) => {
			socket.on('data', () => socket.end(`${JSON.stringify({ result: { label } })}\n`));
		});
}

suite('канал окна для MCP-сервера', () => {
	teardown(() => setWorkspaceTrustProbe());

	test('у каждого окна свой канал и свой токен', async () => {
		const first = new WindowChannel(labelledServer('первое'));
		const second = new WindowChannel(labelledServer('второе'));
		try {
			const [a, b] = await Promise.all([first.endpoint(), second.endpoint()]);
			assert.ok(a && b, 'оба канала должны открыться');
			assert.notStrictEqual(a.path, b.path);
			assert.notStrictEqual(a.token, b.token);
			assert.strictEqual((await request(a.path, {})).result?.label, 'первое');
			assert.strictEqual((await request(b.path, {})).result?.label, 'второе');
		} finally {
			first.dispose();
			second.dispose();
		}
	});

	test('в недоверенной папке канал не открывается', async () => {
		let created = 0;
		const channel = new WindowChannel((token) => {
			created += 1;
			return labelledServer('окно')(token);
		});
		try {
			setWorkspaceTrustProbe(() => false);
			assert.strictEqual(await channel.endpoint(), undefined);
			assert.strictEqual(created, 0, 'сервер канала не должен создаваться');

			setWorkspaceTrustProbe(() => true);
			assert.ok(await channel.endpoint(), 'после доверия канал должен открыться');
		} finally {
			channel.dispose();
		}
	});

	test('закрытое окно канал не держит', async () => {
		const channel = new WindowChannel(labelledServer('окно'));
		const endpoint = await channel.endpoint();
		assert.ok(endpoint);

		channel.dispose();

		assert.strictEqual(await channel.endpoint(), undefined);
		await assert.rejects(request(endpoint.path, {}), 'к закрытому каналу не должно быть подключения');
		if (process.platform !== 'win32') {
			assert.strictEqual(fs.existsSync(path.dirname(endpoint.path)), false, 'каталог сокета должен удаляться');
		}
	});

	test('окно закрылось, пока канал открывался: канал не остаётся', async () => {
		let server: net.Server | undefined;
		const channel = new WindowChannel((token) => {
			server = labelledServer('окно')(token);
			return server;
		});

		const pending = channel.endpoint();
		channel.dispose();

		assert.strictEqual(await pending, undefined);
		assert.strictEqual(server?.listening, false, 'сервер канала должен закрыться');
	});

	test('после сбоя канал открывается при следующем запросе', async () => {
		let calls = 0;
		const channel = new WindowChannel((token) => {
			calls += 1;
			if (calls === 1) {
				throw new Error('сбой при создании канала');
			}
			return labelledServer('окно')(token);
		});
		try {
			assert.strictEqual(await channel.endpoint(), undefined);
			const endpoint = await channel.endpoint();
			assert.ok(endpoint, 'второй запрос должен открыть канал');
			assert.strictEqual((await request(endpoint.path, {})).result?.label, 'окно');
		} finally {
			channel.dispose();
		}
	});

	test('сокет удалили: канал открывается заново по новому адресу', async function () {
		if (process.platform === 'win32') {
			this.skip();
		}
		const channel = new WindowChannel(labelledServer('окно'));
		try {
			const first = await channel.endpoint();
			assert.ok(first);
			// Так сокет во временном каталоге убирает чистка системы
			fs.rmSync(path.dirname(first.path), { recursive: true, force: true });

			const second = await channel.endpoint();
			assert.ok(second, 'канал должен открыться заново');
			assert.notStrictEqual(second.path, first.path);
			assert.strictEqual((await request(second.path, {})).result?.label, 'окно');
		} finally {
			channel.dispose();
		}
	});
});
