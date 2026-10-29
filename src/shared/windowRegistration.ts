/**
 * Окно в реестре окон для MCP-сервера.
 *
 * Окно открывает свой канал и записывает в реестр, какие папки и проекты оно
 * обслуживает. Запись обновляется вместе с папками, проектами и текущим
 * проектом и убирается, когда окно закрывается.
 *
 * @module windowRegistration
 */

import { randomBytes } from 'node:crypto';
import * as os from 'node:os';
import * as vscode from 'vscode';
import type { WorkspaceProjectsSource } from '../features/projects/workspaceProjectsSource';
import { logger } from './logger';
import type { WindowChannel } from './windowChannel';
import {
	pruneWindowRecords,
	removeWindowRecord,
	windowRegistryDir,
	writeWindowRecord,
	WINDOW_RECORD_VERSION,
	type WindowRecord,
} from './windowRegistry';
import { normalizeProjectRoot } from './workspaceProjects';
import { isWorkspaceTrusted, onWorkspaceTrustGranted } from './workspaceTrust';

const log = logger.scope('channel');

/** Пачка изменений папок и проектов даёт одну запись. */
const PUBLISH_DELAY_MS = 200;

/** Как часто проверять канал: сокет во временном каталоге может удалить чистка системы. */
const CHECK_INTERVAL_MS = 5 * 60_000;

/** Папки и проекты окна, которые попадают в реестр. */
export type WindowProjects = Pick<
	WorkspaceProjectsSource,
	'folders' | 'snapshotNow' | 'selectedRoot' | 'onDidChangeProjects' | 'onDidChangeCurrentProject'
>;

function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/**
 * Запись окна в реестре окон.
 *
 * В недоверенной папке канал не открывается. Папка всё равно записана, без
 * канала: агент из неё не выполняет команды и в других окнах.
 */
export class WindowRegistration implements vscode.Disposable {
	/** Идентификатор окна в реестре. */
	readonly id = randomBytes(16).toString('hex');
	private queue: Promise<boolean> = Promise.resolve(false);
	private pending: ReturnType<typeof setTimeout> | undefined;
	private readonly check: ReturnType<typeof setInterval>;
	private readonly subscriptions: vscode.Disposable[];
	private disposed = false;

	/**
	 * @param channel - Канал окна
	 * @param projects - Папки и проекты окна
	 * @param dir - Каталог реестра
	 */
	constructor(
		private readonly channel: WindowChannel,
		private readonly projects: WindowProjects,
		private readonly dir: string = windowRegistryDir()
	) {
		this.subscriptions = [
			projects.onDidChangeProjects(() => this.schedule()),
			projects.onDidChangeCurrentProject(() => this.schedule()),
			vscode.workspace.onDidChangeWorkspaceFolders(() => this.schedule()),
			onWorkspaceTrustGranted(() => this.schedule()),
		];
		this.check = setInterval(() => this.schedule(), CHECK_INTERVAL_MS);
		this.check.unref?.();
		pruneWindowRecords(dir)
			.then((removed) => {
				if (removed > 0) {
					log.debug(`из реестра окон убраны записи закрытых окон: ${removed}`);
				}
			})
			.catch((error: unknown) => log.debug(`реестр окон не почищен: ${errorText(error)}`));
		this.schedule();
	}

	/**
	 * Записывает окно в реестр, открыв канал, если он ещё не открыт.
	 *
	 * @returns Промис, который разрешается идентификатором окна либо undefined,
	 *   если папке не доверяют или окно не записано
	 */
	async windowId(): Promise<string | undefined> {
		return (await this.publish()) ? this.id : undefined;
	}

	private schedule(): void {
		if (this.disposed) {
			return;
		}
		clearTimeout(this.pending);
		this.pending = setTimeout(() => void this.publish(), PUBLISH_DELAY_MS);
	}

	/** Записи идут по одной: последняя на диске отражает последнее состояние окна. */
	private publish(): Promise<boolean> {
		this.queue = this.queue.then(
			() => this.write(),
			() => this.write()
		);
		return this.queue;
	}

	private async write(): Promise<boolean> {
		if (this.disposed) {
			return false;
		}
		const endpoint = await this.channel.endpoint();
		if (this.disposed) {
			return false;
		}
		try {
			if (!endpoint) {
				if (!isWorkspaceTrusted()) {
					await writeWindowRecord(this.dir, this.record('', '', false));
					if (this.disposed) {
						removeWindowRecord(this.dir, this.id);
					}
					return false;
				}
				removeWindowRecord(this.dir, this.id);
				return false;
			}
			await writeWindowRecord(this.dir, this.record(endpoint.path, endpoint.token, true));
			if (this.disposed) {
				// Окно закрылось, пока шла запись
				removeWindowRecord(this.dir, this.id);
				return false;
			}
			return true;
		} catch (error) {
			log.error(`окно не записано в реестр окон для MCP-сервера: ${errorText(error)}`);
			return false;
		}
	}

	private record(pipe: string, token: string, trusted: boolean): WindowRecord {
		const currentProject = this.projects.selectedRoot();
		return {
			version: WINDOW_RECORD_VERSION,
			id: this.id,
			pid: process.pid,
			hostname: os.hostname(),
			app: vscode.env.appName,
			name: vscode.workspace.name ?? '',
			pipe,
			token,
			trusted,
			folders: this.projects.folders().map((folder) => normalizeProjectRoot(folder.root)),
			projects: this.projects.snapshotNow().projects.map((project) => project.root),
			...(currentProject === undefined ? {} : { currentProject }),
			updatedAt: new Date().toISOString(),
		};
	}

	dispose(): void {
		this.disposed = true;
		clearTimeout(this.pending);
		clearInterval(this.check);
		for (const subscription of this.subscriptions) {
			subscription.dispose();
		}
		try {
			removeWindowRecord(this.dir, this.id);
		} catch (error) {
			log.debug(`запись окна в реестре не убрана: ${errorText(error)}`);
		}
	}
}
