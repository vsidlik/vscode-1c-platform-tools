import { StringDecoder } from 'node:string_decoder';
import * as net from 'node:net';
import * as crypto from 'node:crypto';
import * as vscode from 'vscode';
import { logger } from './logger';
import type { VRunnerExecutionResult } from './vrunnerManager';
import type { CommandExecutionOptions, StructuredCommandResult } from './commandExecutionTypes';
import {
	commandRunsInProject,
	commandSupportsWait,
	commandTargetsDirectory,
	isCommandExposedToMcp,
} from './mcpCommandPolicy';
import { agentCommandDescription } from './agentCommandDescriptions';
import { readManifestCommands } from './commandCatalog';
import { extractCommandFlags, resolveRequestDirectory, resolveRequestRoot } from './ipcRequest';
import { hasProjectFile } from './projectLayout';
import { normalizeProjectRoot, runWithProject } from './workspaceProjects';
import { isWorkspaceTrusted, onWorkspaceTrustGranted, WORKSPACE_TRUST_REQUIRED } from './workspaceTrust';
import { WindowChannel } from './windowChannel';
import { initializeChoices } from '../features/projects/projectInitialization';
import { workspaceProjectsSource, type WorkspaceProjectsSource } from '../features/projects/workspaceProjectsSource';

const log = logger.scope('ipc');

export interface IpcRequest {
	id: unknown;
	method: unknown;
	params?: unknown;
	token?: unknown;
}

export interface IpcExecuteCommandParams {
	commandId?: unknown;
	args?: unknown;
	projectPath?: unknown;
}

interface IpcResponse {
	id: string | null;
	result?: unknown;
	error?: {
		message: string;
		code?: string;
		details?: unknown;
	};
}

export interface IpcServerConfig {
	enabled: boolean;
	host: string;
	port: number;
	token: string | null;
}

/**
 * Расширенный StructuredCommandResult с метаданными выполнения, которые
 * добавляет ipcServer (длительность, временные метки, корень проекта).
 */
interface StructuredCommandResultWithTiming extends StructuredCommandResult {
	startedAt: string;
	finishedAt: string;
	durationMs: number;
	/** Корень проекта, в котором выполнилась команда. */
	projectRoot?: string;
	/** Данные команды, например список проектов. */
	data?: unknown;
}

function readConfig(): IpcServerConfig {
	const config = vscode.workspace.getConfiguration('1c-platform-tools');
	const enabled = config.get<boolean>('ipc.enabled', false);
	const port = config.get<number>('ipc.port', 40241);
	const token = config.get<string>('ipc.token') ?? '';

	return {
		enabled,
		host: '127.0.0.1',
		port: Number.isFinite(port) ? port : 40241,
		token: token === '' ? null : token,
	};
}

function buildResponseBase(id: unknown): Pick<IpcResponse, 'id'> {
	return {
		id: typeof id === 'string' || typeof id === 'number' ? String(id) : null,
	};
}

async function handlePing(
	request: IpcRequest,
	extensionId: string
): Promise<IpcResponse> {
	const base = buildResponseBase(request.id);
	const extension = vscode.extensions.getExtension(extensionId);

	return {
		...base,
		result: {
			ok: true,
			extensionId,
			extensionVersion: extension?.packageJSON.version ?? 'unknown',
		},
	};
}

/** Окно, в котором канал выполняет команды. */
export interface IpcWindow {
	readonly projects: WorkspaceProjectsSource;
	executeCommand(commandId: string, ...args: unknown[]): Thenable<unknown>;
}

function extensionWindow(): IpcWindow {
	return {
		projects: workspaceProjectsSource(),
		executeCommand: (commandId, ...args) => vscode.commands.executeCommand(commandId, ...args),
	};
}

/**
 * Корень проекта для команды агента; у команд инициализации каталог из projectPath.
 *
 * @param window - Окно канала
 * @param commandId - Идентификатор команды
 * @param projectPath - Путь из запроса
 * @returns Корень (undefined у команд окна) либо ошибка ответа
 */
async function resolveCommandRoot(
	window: IpcWindow,
	commandId: string,
	projectPath: string | undefined
): Promise<{ root: string | undefined } | { error: NonNullable<IpcResponse['error']> }> {
	if (!commandRunsInProject(commandId)) {
		return { root: undefined };
	}
	const projects = (await window.projects.listProjects()).map((project) => project.root);
	const folders = window.projects.folders().map((folder) => normalizeProjectRoot(folder.root));
	const context = { currentRoot: window.projects.selectedRoot(), folders, projects };
	const resolved = commandTargetsDirectory(commandId)
		? resolveRequestDirectory(projectPath, context)
		: resolveRequestRoot(projectPath, context);
	if ('root' in resolved) {
		return resolved;
	}
	if (resolved.error === 'PROJECT_PATH_REQUIRED') {
		const candidates = initializeChoices(window.projects.folders(), await window.projects.listCandidates())
			.map((choice) => choice.dir)
			.filter((dir) => !hasProjectFile(dir));
		const variants = candidates.length > 0 ? ` Варианты:\n${candidates.join('\n')}` : '';
		return {
			error: {
				message: `Передайте в projectPath каталог, в котором создать packagedef.${variants}`,
				code: 'PROJECT_PATH_REQUIRED',
				details: { candidates },
			},
		};
	}
	if (resolved.error === 'WORKSPACE_MISMATCH') {
		return {
			error: {
				message: 'Путь projectPath лежит вне папок рабочей области VS Code',
				code: 'WORKSPACE_MISMATCH',
				details: { projectPath: resolved.projectPath, workspaceRoots: folders, projects },
			},
		};
	}
	return {
		error: {
			message:
				'Текущий проект не определён: передайте projectPath или сделайте проект текущим командой project.select',
			code: 'PROJECT_NOT_FOUND',
			details: { folders, projects },
		},
	};
}

/**
 * Выполняет команду синхронно через vscode.commands.executeCommand с флагом wait.
 *
 * Команда должна принимать аргумент CommandExecutionOptions и возвращать
 * StructuredCommandResult (или VRunnerExecutionResult — для обратной совместимости).
 * Если команда возвращает undefined (не реализовала sync-режим), возвращает понятное
 * сообщение агенту вместо тихого «Выполнено.».
 *
 * @param request — исходный IPC-запрос
 * @param window — окно канала
 * @param commandId — идентификатор команды
 * @param root — корень проекта вызова; undefined у команд окна
 * @param flags — флаги выполнения (wait, settingsFile, ibConnection и прочие)
 * @returns IPC-ответ со структурированным commandResult
 */
async function handleExecuteCommandSync(
	request: IpcRequest,
	window: IpcWindow,
	commandId: string,
	root: string | undefined,
	flags: CommandExecutionOptions
): Promise<IpcResponse> {
	const base = buildResponseBase(request.id);
	const startedAt = new Date().toISOString();
	const startMs = Date.now();

	try {
		// Команде уходят все присланные опции: канал владеет только ожиданием и корнем проекта
		const optsForCommand: CommandExecutionOptions = { ...flags, wait: true, projectPath: root };
		const rawResult = await runWithProject(root, async () => window.executeCommand(commandId, optsForCommand));
		const projectRoot = root ?? window.projects.selectedRoot();

		const finishedAt = new Date().toISOString();
		const durationMs = Date.now() - startMs;

		if (rawResult === undefined || rawResult === null) {
			log.warn(
				`sync: команда ${commandId} вернула undefined при wait: true — ` +
				'синхронный режим не реализован'
			);
			const fallback: StructuredCommandResultWithTiming = {
				success: false,
				exitCode: -1,
				stdout: '',
				stderr:
					`Команда ${commandId} не поддерживает wait: true. ` +
					'Используйте wait: false или реализуйте синхронный режим в команде.',
				startedAt,
				finishedAt,
				durationMs,
				projectRoot,
			};
			return {
				...base,
				result: { ok: true, commandResult: fallback, projectRoot },
			};
		}

		// Команда может вернуть StructuredCommandResult (новый формат) или VRunnerExecutionResult.
		// Оба формата имеют поля success, exitCode, stdout, stderr.
		const r = rawResult as VRunnerExecutionResult & Partial<StructuredCommandResult> & { data?: unknown };
		const structured: StructuredCommandResultWithTiming = {
			success: r.success,
			exitCode: typeof r.exitCode === 'number' ? r.exitCode : r.success ? 0 : 1,
			stdout: r.stdout ?? '',
			stderr: r.stderr ?? '',
			artifact: r.artifact,
			tests: r.tests,
			errors: r.errors,
			data: r.data,
			startedAt,
			finishedAt,
			durationMs,
			projectRoot,
		};

		return {
			...base,
			result: { ok: true, commandResult: structured, projectRoot },
		};
	} catch (error) {
		const message =
			error instanceof Error
				? error.message
				: 'Неизвестная ошибка при синхронном выполнении команды';
		log.error(`sync: ошибка ${commandId}: ${message}`);

		return {
			...base,
			error: { message, code: 'COMMAND_ERROR' },
		};
	}
}

/**
 * Обрабатывает запрос на исполнение команды.
 *
 * @param request - Запрос канала
 * @param params - Идентификатор команды и её аргументы
 * @param window - Окно канала
 * @returns Ответ канала: результат команды либо отказ
 */
export async function handleExecuteCommand(
	request: IpcRequest,
	params: IpcExecuteCommandParams,
	window: IpcWindow = extensionWindow()
): Promise<IpcResponse> {
	const base = buildResponseBase(request.id);

	// Канал в недоверенной папке не поднимается; проверка остаётся на случай,
	// когда он уже слушает, а команда приходит для другого окна
	if (!isWorkspaceTrusted()) {
		log.warn('папка не доверенная, команда агента не выполнена');
		return {
			...base,
			error: { message: WORKSPACE_TRUST_REQUIRED, code: 'WORKSPACE_NOT_TRUSTED' },
		};
	}

	if (typeof params.commandId !== 'string' || params.commandId.trim() === '') {
		return {
			...base,
			error: {
				message: 'Поле params.commandId должно быть непустой строкой',
				code: 'INVALID_COMMAND_ID',
			},
		};
	}

	// Канал исполняет только то, что сам и перечисляет: иначе по нему доступна
	// любая команда редактора, включая чужих расширений
	if (!isCommandExposedToMcp(params.commandId)) {
		log.warn(`Команда не опубликована агенту, исполнение отклонено: ${params.commandId}`);
		return {
			...base,
			error: {
				message: `Команда ${params.commandId} не публикуется агенту`,
				code: 'COMMAND_NOT_EXPOSED',
			},
		};
	}

	const commandId = params.commandId;
	const args = Array.isArray(params.args) ? params.args : [];
	const flags = extractCommandFlags(args);

	const requestedProjectPath =
		typeof params.projectPath === 'string' && params.projectPath.trim() !== ''
			? params.projectPath.trim()
			: undefined;

	const resolved = await resolveCommandRoot(window, commandId, requestedProjectPath);
	if ('error' in resolved) {
		return { ...base, error: resolved.error };
	}
	const { root } = resolved;
	const directory = root !== undefined && commandTargetsDirectory(commandId);
	const commandFlags: CommandExecutionOptions = directory ? { ...flags, projectPath: root, root } : flags;

	// Синхронный режим: wait: true и команда его поддерживает
	if (flags.wait === true && commandSupportsWait(commandId)) {
		return handleExecuteCommandSync(request, window, commandId, root, commandFlags);
	}

	// Стандартный режим: запуск в UI-терминале
	try {
		const commandArgs = directory ? [commandFlags, ...args.slice(1)] : args;
		const commandResult = await runWithProject(root, async () => window.executeCommand(commandId, ...commandArgs));

		return {
			...base,
			result: {
				ok: true,
				commandResult,
				projectRoot: root ?? window.projects.selectedRoot(),
			},
		};
	} catch (error) {
		const message =
			error instanceof Error ? error.message : 'Неизвестная ошибка при выполнении команды';
		log.error(
			`ошибка при выполнении команды ${commandId}: ${message}`
		);

		return {
			...base,
			error: {
				message,
				code: 'COMMAND_ERROR',
			},
		};
	}
}

/**
 * Описание команды для MCP: по нему агент выбирает инструмент.
 */
interface CommandDescriptor {
	/** Идентификатор команды. */
	id: string;
	/** Заголовок команды из package.json. */
	title?: string;
	/** Категория команды из package.json. */
	category?: string;
	/** Команда выполняется синхронно и возвращает результат. */
	supportsWait: boolean;
}

async function handleListCommands(request: IpcRequest): Promise<IpcResponse> {
	const base = buildResponseBase(request.id);
	const all = await vscode.commands.getCommands();
	const commands = all.filter(isCommandExposedToMcp);

	const titles = readManifestCommands();
	const descriptors: CommandDescriptor[] = commands.map((id) => ({
		id,
		// Описание для агента важнее заголовка: заголовок рассчитан на палитру,
		// где объект действия понятен из категории и места вызова
		...(agentCommandDescription(id) ?? titles.get(id)),
		supportsWait: commandSupportsWait(id),
	}));

	// commands оставлен для MCP-серверов прошлых версий: они читают только его
	return {
		...base,
		result: { commands, descriptors },
	};
}

function createResponseForError(id: unknown, error: unknown): IpcResponse {
	const base = buildResponseBase(id);
	if (error instanceof Error) {
		return {
			...base,
			error: {
				message: error.message,
			},
		};
	}

	return {
		...base,
		error: {
			message: 'Внутренняя ошибка IPC-сервера',
		},
	};
}

/**
 * Сервер канала: разбирает запросы и выполняет их.
 *
 * Один и тот же для TCP-канала и канала окна, отличаются они только токеном.
 *
 * @param token - Токен, без которого запрос не выполняется; null — без проверки
 * @param extensionId - Идентификатор расширения для ответа ping
 * @returns Сервер, который ещё не слушает
 */
function createServer(token: string | null, extensionId: string): net.Server {
	return net.createServer((socket) => {
		log.debug('новое соединение');

		let buffer = '';

		const writeResponse = (response: IpcResponse): void => {
			try {
				const payload = `${JSON.stringify(response)}\n`;
				socket.write(payload);
			} catch (error) {
				const message =
					error instanceof Error
						? error.message
						: 'Неизвестная ошибка при сериализации ответа';
				log.error(`ошибка при отправке ответа: ${message}`);
			}
		};

		// Декодер держит байты символа, разорванного между порциями: иначе кириллица на стыке портится
		const decoder = new StringDecoder('utf8');
		socket.on('data', (data: Buffer) => {
			buffer += decoder.write(data);
			let index = buffer.indexOf('\n');

			while (index !== -1) {
				const line = buffer.slice(0, index).trim();
				buffer = buffer.slice(index + 1);

				if (line !== '') {
					let request: IpcRequest;
					try {
						request = JSON.parse(line) as IpcRequest;
					} catch {
						writeResponse({
							...buildResponseBase(null),
							error: {
								message: 'Некорректный JSON',
								code: 'PARSE_ERROR',
							},
						});
						continue;
					}

					void (async () => {
						const method = request.method;

						if (token) {
							if (typeof request.token !== 'string') {
								writeResponse({
									...buildResponseBase(request.id),
									error: {
										message: 'Отсутствует токен аутентификации',
										code: 'UNAUTHORIZED',
									},
								});
								return;
							}

							const expected = Buffer.from(token, 'utf8');
							const actual = Buffer.from(request.token, 'utf8');
							if (expected.length !== actual.length || !crypto.timingSafeEqual(expected, actual)) {
								writeResponse({
									...buildResponseBase(request.id),
									error: {
										message: 'Неверный токен аутентификации',
										code: 'UNAUTHORIZED',
									},
								});
								return;
							}
						}

						try {
							if (method === 'ping') {
								const response = await handlePing(request, extensionId);
								writeResponse(response);
							} else if (method === 'executeCommand') {
								const response = await handleExecuteCommand(
									request,
									(request.params ?? {}) as IpcExecuteCommandParams
								);
								writeResponse(response);
							} else if (method === 'listCommands') {
								const response = await handleListCommands(request);
								writeResponse(response);
							} else {
								writeResponse({
									...buildResponseBase(request.id),
									error: {
										message: 'Неизвестный метод',
										code: 'UNKNOWN_METHOD',
										details: { method },
									},
								});
							}
						} catch (error) {
							writeResponse(createResponseForError(request.id, error));
						}
					})();
				}

				index = buffer.indexOf('\n');
			}
		});

		socket.on('error', (error) => {
			const message =
				error instanceof Error ? error.message : 'Неизвестная ошибка сокета';
			log.error(`ошибка сокета: ${message}`);
		});

		socket.on('close', () => {
			log.debug('соединение закрыто');
		});
	});
}

function listenServer(server: net.Server, config: IpcServerConfig): void {
	server.on('error', (error: unknown) => {
		if (error instanceof Error && (error as NodeJS.ErrnoException).code === 'EADDRINUSE') {
			const message = `Не удалось запустить IPC-сервер: порт ${
				config.port
			} уже используется. Измените настройку 1c-platform-tools.ipc.port.`;
			log.error(message);
			void vscode.window.showErrorMessage(message);
			return;
		}

		const message =
			error instanceof Error ? error.message : 'Неизвестная ошибка IPC-сервера';
		log.error(`ошибка сервера: ${message}`);
	});

	server.listen(config.port, config.host, () => {
		log.info(`сервер запущен на ${config.host}:${config.port}`);
		if (config.token === null) {
			log.warn('токен не задан: команды примет любой процесс этой машины, задайте 1c-platform-tools.ipc.token');
		}
	});
}

/**
 * Открывает канал по готовым настройкам.
 *
 * Единственное место, где канал начинает слушать порт: проверка доверия стоит
 * здесь, а не у подписок, поэтому другой вызов её не обойдёт. Канал исполняет
 * команды расширения, и в недоверенной папке он не открывается: иначе настройка
 * проекта решала бы это за пользователя.
 *
 * @param config - Настройки канала
 * @param extensionId - Идентификатор расширения для ответа ping
 * @returns Слушающий сервер либо null, если канал не открыт
 */
export function openIpcChannel(config: IpcServerConfig, extensionId: string): net.Server | null {
	if (!isWorkspaceTrusted()) {
		log.info('папка не доверенная, канал не открыт');
		return null;
	}
	if (!config.enabled) {
		log.debug('сервер отключен настройкой 1c-platform-tools.ipc.enabled');
		return null;
	}
	const server = createServer(config.token, extensionId);
	listenServer(server, config);
	return server;
}

/**
 * Поднимает TCP-канал по настройкам и заводит канал окна для MCP-сервера.
 *
 * TCP-канал нужен Cursor и внешним клиентам, MCP-сервер VS Code подключается к
 * каналу окна через API расширения.
 *
 * @param context - Контекст расширения
 * @returns Канал окна; открывается при первом запросе адреса
 */
export function startIpcServer(context: vscode.ExtensionContext): WindowChannel {
	const extensionId = 'yellow-hammer.1c-platform-tools';
	let config = readConfig();
	let activeServer: net.Server | null = null;

	const start = (): void => {
		activeServer = openIpcChannel(config, extensionId);
	};

	const stop = (): void => {
		if (activeServer) {
			activeServer.close();
			activeServer = null;
		}
	};

	start();

	const windowChannel = new WindowChannel((token) => createServer(token, extensionId));

	context.subscriptions.push(
		vscode.workspace.onDidChangeConfiguration((e) => {
			if (e.affectsConfiguration('1c-platform-tools.ipc')) {
				stop();
				config = readConfig();
				start();
			}
		}),
		onWorkspaceTrustGranted(() => {
			stop();
			config = readConfig();
			start();
		}),
		{ dispose: stop },
		windowChannel,
	);
	return windowChannel;
}
