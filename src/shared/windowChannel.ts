/**
 * Канал окна для MCP-сервера: именованный канал Windows или Unix-сокет.
 *
 * У каждого окна свой канал со случайным именем и токеном сессии: адрес и
 * токен окно записывает в реестр окон, и MCP-сервер работает с нужным окном.
 *
 * @module windowChannel
 */

import * as crypto from 'node:crypto';
import type * as net from 'node:net';
import type * as vscode from 'vscode';
import {
	createChannelLocation,
	isChannelListening,
	listenChannel,
	removeChannelLocation,
	type ChannelLocation,
} from './channelLocation';
import { logger } from './logger';
import { isWorkspaceTrusted } from './workspaceTrust';

const log = logger.scope('ipc');

/** Адрес канала окна. */
export interface WindowChannelEndpoint {
	/** Путь именованного канала Windows или Unix-сокета. */
	readonly path: string;
	/** Токен сессии: без него канал запросы не выполняет. */
	readonly token: string;
}

/** Сервер канала, который проверяет переданный токен. */
export type ChannelServerFactory = (token: string) => net.Server;

/** Открытый канал. */
interface OpenChannel {
	endpoint: WindowChannelEndpoint;
	server: net.Server;
	location: ChannelLocation;
}

function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/**
 * Канал окна для MCP-сервера.
 *
 * Открывается при первом запросе адреса, в недоверенной папке не открывается.
 */
export class WindowChannel implements vscode.Disposable {
	private opening: Promise<OpenChannel | undefined> | undefined;
	private current: OpenChannel | undefined;
	private disposed = false;

	/**
	 * @param createServer - Сервер канала по токену сессии
	 */
	constructor(private readonly createServer: ChannelServerFactory) {}

	/**
	 * Адрес канала; при первом вызове канал открывается.
	 *
	 * @returns Адрес и токен либо undefined, если папке не доверяют или канал не открылся
	 */
	async endpoint(): Promise<WindowChannelEndpoint | undefined> {
		if (this.disposed || !isWorkspaceTrusted()) {
			return undefined;
		}
		if (this.current && !isChannelListening(this.current.server, this.current.location)) {
			// Сокет во временном каталоге удалила чистка системы: открываем канал заново
			log.warn(`канал окна для MCP-сервера пропал, открывается заново: ${this.current.endpoint.path}`);
			this.close();
		}
		this.opening ??= this.open().catch((error: unknown) => {
			// Следующий запрос попробует открыть канал заново
			this.opening = undefined;
			if (!this.disposed) {
				log.error(`канал окна для MCP-сервера не открыт: ${errorText(error)}`);
			}
			return undefined;
		});
		return (await this.opening)?.endpoint;
	}

	private async open(): Promise<OpenChannel> {
		const token = crypto.randomBytes(32).toString('hex');
		const server = this.createServer(token);
		const location = createChannelLocation(crypto.randomBytes(16).toString('hex'));
		try {
			await listenChannel(server, location);
		} catch (error) {
			removeChannelLocation(location);
			throw error;
		}
		if (this.disposed) {
			server.close();
			removeChannelLocation(location);
			throw new Error('окно закрывается');
		}
		server.on('error', (error) => log.error(`ошибка канала окна: ${errorText(error)}`));
		this.current = { endpoint: { path: location.path, token }, server, location };
		log.info(`канал окна для MCP-сервера открыт: ${location.path}`);
		return this.current;
	}

	private close(): void {
		if (this.current) {
			this.current.server.close();
			removeChannelLocation(this.current.location);
			this.current = undefined;
		}
		this.opening = undefined;
	}

	dispose(): void {
		this.disposed = true;
		this.close();
	}
}
