import * as net from 'node:net';

/** Ответ канала: ping, отказ или метка тестового сервера. */
export interface ChannelResponse {
	result?: { ok?: boolean; extensionId?: string; label?: string };
	error?: { code?: string };
}

/**
 * Отправляет запрос в канал и ждёт первую строку ответа.
 *
 * @param location - Путь канала
 * @param payload - Тело запроса
 * @returns Разобранный ответ
 */
export function channelRequest(location: string, payload: Record<string, unknown>): Promise<ChannelResponse> {
	return new Promise((resolve, reject) => {
		const socket = net.connect(location);
		let buffer = '';
		socket.setEncoding('utf8');
		socket.on('error', reject);
		socket.on('connect', () => socket.write(`${JSON.stringify(payload)}\n`));
		socket.on('data', (chunk: string) => {
			buffer += chunk;
			const end = buffer.indexOf('\n');
			if (end !== -1) {
				socket.destroy();
				resolve(JSON.parse(buffer.slice(0, end)) as ChannelResponse);
			}
		});
	});
}
