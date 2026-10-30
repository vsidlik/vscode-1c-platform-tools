import * as vscode from 'vscode';
import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import { BaseCommand } from './baseCommand';
import { logger } from '../shared/logger';
import { showWorkspaceRequired } from '../shared/configurationWriteTarget';
import { readLaunchConfigurations } from '../shared/launchConfigurations';
import { currentRoot, workspaceFolderOf } from '../shared/workspaceProjects';

const log = logger.scope('tasks');

interface Task {
	label: string;
	type: string;
	command?: string;
	problemMatcher?: string[];
	[key: string]: any;
}

interface LaunchConfiguration {
	name: string;
	type: string;
	request: string;
	[key: string]: any;
}

/**
 * Команды для работы с задачами и конфигурациями запуска VS Code.
 *
 * tasks.json и launch.json лежат в папке рабочей области, в которой находится
 * текущий проект.
 */
export class WorkspaceTasksCommands extends BaseCommand {
	/** Папка рабочей области текущего проекта. */
	private workspaceFolder(): vscode.WorkspaceFolder | undefined {
		const root = currentRoot();
		return root === undefined ? undefined : workspaceFolderOf(root);
	}

	/**
	 * Получает задачи из tasks.json
	 *
	 * Загружает все задачи workspace из VS Code API и фильтрует их,
	 * оставляя только задачи workspace (исключая глобальные задачи).
	 *
	 * @returns Промис, который разрешается массивом задач workspace.
	 *          Возвращает пустой массив, если workspace не открыт или произошла ошибка
	 */
	async getTasks(): Promise<Task[]> {
		if (!this.workspaceFolder()) {
			return [];
		}

		try {
			const vscodeTasks = await vscode.tasks.fetchTasks();
			const tasks: Task[] = [];
			for (const vscodeTask of vscodeTasks) {
				const isWorkspaceTask = vscodeTask.scope !== vscode.TaskScope.Global;

				if (isWorkspaceTask) {
					const definition = vscodeTask.definition;
					tasks.push({
						label: vscodeTask.name,
						...definition
					});
				}
			}

			return tasks;
		} catch {
			return [];
		}
	}

	/**
	 * Конфигурации запуска папки текущего проекта.
	 *
	 * Берёт их из настроек VS Code: комментарии в `launch.json` сохраняются,
	 * секция `launch` файла `.code-workspace` видна вместе с файлом папки.
	 *
	 * @returns Промис, который разрешается массивом конфигураций запуска.
	 *          Пустой массив, если папки проекта нет
	 */
	async getLaunchConfigurations(): Promise<LaunchConfiguration[]> {
		const folder = this.workspaceFolder();
		if (!folder) {
			return [];
		}
		const inspected = vscode.workspace.getConfiguration('launch', folder.uri)
			.inspect<LaunchConfiguration[]>('configurations');
		return readLaunchConfigurations(inspected);
	}

	/**
	 * Запускает задачу
	 *
	 * Ищет задачу с указанным именем в workspace и запускает её.
	 * Если задача не найдена, пытается запустить конфигурацию отладки с таким же именем.
	 *
	 * @param taskLabel - Имя задачи для запуска
	 * @returns Промис, который разрешается после запуска задачи
	 * @throws {Error} Если произошла ошибка при запуске задачи или конфигурации
	 */
	async runTask(taskLabel: string): Promise<void> {
		if (!this.workspaceFolder()) {
			log.warn('Команда runTask вызвана без открытой рабочей области');
			showWorkspaceRequired();
			return;
		}

		try {
			const vscodeTasks = await vscode.tasks.fetchTasks();
			const vscodeTask = vscodeTasks.find(t =>
				t.name === taskLabel && t.scope !== vscode.TaskScope.Global
			);

			if (vscodeTask) {
				log.debug(`Запуск задачи: ${taskLabel}`);
				await vscode.tasks.executeTask(vscodeTask);
			} else {
				await this.runLaunchConfiguration(taskLabel);
			}
		} catch (error) {
			const errMsg = (error as Error).message;
			log.error(`Ошибка при запуске задачи "${taskLabel}": ${errMsg}`);
			vscode.window.showErrorMessage(`Ошибка при запуске задачи "${taskLabel}": ${errMsg}`);
		}
	}

	/**
	 * Запускает конфигурацию отладки
	 *
	 * Ищет конфигурацию отладки с указанным именем в launch.json и запускает её.
	 * Если конфигурация не найдена, показывает сообщение об ошибке.
	 *
	 * @param name - Имя конфигурации для запуска
	 * @returns Промис, который разрешается после запуска конфигурации
	 * @throws {Error} Если произошла ошибка при запуске конфигурации отладки
	 */
	async runLaunchConfiguration(name: string): Promise<void> {
		const folder = this.workspaceFolder();
		if (!folder) {
			log.warn('Команда runLaunchConfiguration вызвана без открытой рабочей области');
			showWorkspaceRequired();
			return;
		}

		const configs = await this.getLaunchConfigurations();
		const config = configs.find(c => c.name === name);

		if (!config) {
			log.warn(`Конфигурация отладки не найдена: ${name}`);
			vscode.window.showErrorMessage(`Конфигурация отладки "${name}" не найдена`);
			return;
		}

		try {
			log.debug(`Запуск конфигурации отладки: ${name}`);
			await vscode.debug.startDebugging(folder, config);
		} catch (error) {
			const errMsg = (error as Error).message;
			log.error(`Ошибка при запуске конфигурации "${name}": ${errMsg}`);
			vscode.window.showErrorMessage(`Ошибка при запуске конфигурации "${name}": ${errMsg}`);
		}
	}

	/**
	 * Открывает tasks.json для редактирования
	 *
	 * Открывает файл `.vscode/tasks.json` в редакторе VS Code.
	 * Если файл не существует, создает его с базовой структурой (version: '2.0.0', tasks: []).
	 *
	 * @returns Промис, который разрешается после открытия файла
	 * @throws {Error} Если не удалось создать директорию .vscode или записать файл
	 */
	async editTasks(): Promise<void> {
		const folder = this.workspaceFolder();
		if (!folder) {
			log.warn('Команда editTasks вызвана без открытой рабочей области');
			showWorkspaceRequired();
			return;
		}

		await this.openOrCreate(folder.uri.fsPath, 'tasks.json', { version: '2.0.0', tasks: [] });
	}

	/**
	 * Открывает launch.json для редактирования
	 *
	 * Открывает файл `.vscode/launch.json` в редакторе VS Code.
	 * Если файл не существует, создает его с базовой структурой (version: '0.2.0', configurations: []).
	 *
	 * @returns Промис, который разрешается после открытия файла
	 * @throws {Error} Если не удалось создать директорию .vscode или записать файл
	 */
	async editLaunchConfigurations(): Promise<void> {
		const folder = this.workspaceFolder();
		if (!folder) {
			log.warn('Команда editLaunchConfigurations вызвана без открытой рабочей области');
			showWorkspaceRequired();
			return;
		}

		await this.openOrCreate(folder.uri.fsPath, 'launch.json', { version: '0.2.0', configurations: [] });
	}

	/**
	 * Открывает файл из `.vscode` папки, создавая его с начальным содержимым.
	 *
	 * @param folderRoot - Корень папки рабочей области
	 * @param fileName - Имя файла в `.vscode`
	 * @param initial - Содержимое нового файла
	 */
	private async openOrCreate(folderRoot: string, fileName: string, initial: object): Promise<void> {
		const filePath = path.join(folderRoot, '.vscode', fileName);
		const uri = vscode.Uri.file(filePath);
		try {
			const doc = await vscode.workspace.openTextDocument(uri);
			await vscode.window.showTextDocument(doc);
		} catch {
			await fs.mkdir(path.dirname(filePath), { recursive: true });
			await fs.writeFile(filePath, JSON.stringify(initial, null, '\t'), 'utf8');
			const doc = await vscode.workspace.openTextDocument(uri);
			await vscode.window.showTextDocument(doc);
		}
	}
}
