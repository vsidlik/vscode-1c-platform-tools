/**
 * Пакет OneScript проекта: сборка и установка собранного пакета.
 *
 * `opm build` собирает пакет по `packagedef` в каталог сборки проекта
 * (`build/out/ospx` по умолчанию) под именем `<Имя>-<Версия>.ospx`. Собранный
 * файл ставится в движок проекта командой `opm install -f`: так его проверяют
 * так же, как пакет из хаба. Публикацию `opm push` расширение не делает: ей
 * нужен токен хаба, а канал выпуска opm выбирает по ветке, это шаг CI.
 * @module packageCommands
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { BaseCommand } from './baseCommand';
import { getBuildPackageCommandName, getInstallPackageCommandName } from '../features/tools/commandNames';
import { logger } from '../shared/logger';
import { readPackageManifest } from '../shared/oneScriptLayout';
import { PACKAGE_EXTENSION, packageFileName } from '../shared/packagedef';
import { BUILD_SUBDIRS } from '../shared/pathDefaults';
import { ensureWorkspaceTrusted } from '../shared/workspaceTrust';

const log = logger.scope('commands');

/**
 * Файл пакета из аргумента команды: путь, Uri или узел дерева артефактов.
 *
 * @param target - Первый аргумент команды
 * @returns Абсолютный путь к `.ospx` или undefined
 */
export function packageFileArgument(target: unknown): string | undefined {
	let file: string | undefined;
	if (typeof target === 'string') {
		file = target.trim();
	} else if (target instanceof vscode.Uri) {
		file = target.scheme === 'file' ? target.fsPath : undefined;
	} else if (typeof target === 'object' && target !== null) {
		const uri = (target as { resourceUri?: unknown }).resourceUri;
		file = uri instanceof vscode.Uri && uri.scheme === 'file' ? uri.fsPath : undefined;
	}
	return file && path.extname(file).toLowerCase() === PACKAGE_EXTENSION ? path.resolve(file) : undefined;
}

/**
 * Собранные пакеты каталога, новые первыми.
 *
 * @param dir - Каталог собранных пакетов
 * @returns Абсолютные пути
 */
async function builtPackages(dir: string): Promise<string[]> {
	let names: string[];
	try {
		names = await fs.readdir(dir);
	} catch {
		return [];
	}
	const files = names.filter((name) => path.extname(name).toLowerCase() === PACKAGE_EXTENSION).map((name) => path.join(dir, name));
	const stamped = await Promise.all(
		files.map(async (file) => ({ file, mtimeMs: (await fs.stat(file).catch(() => undefined))?.mtimeMs ?? 0 }))
	);
	return stamped.sort((left, right) => right.mtimeMs - left.mtimeMs).map((item) => item.file);
}

/**
 * Команды пакета OneScript.
 */
export class PackageCommands extends BaseCommand {
	/**
	 * Каталог собранных пакетов проекта.
	 *
	 * @param root - Корень проекта
	 */
	packagesDirectory(root: string): string {
		return path.resolve(root, this.vrunner.getOutPath(), BUILD_SUBDIRS.packages);
	}

	/**
	 * Собирает пакет: `opm build -o <каталог сборки>` в корне проекта.
	 *
	 * @returns Промис, который разрешается после запуска сборки
	 */
	async buildPackage(): Promise<void> {
		if (!ensureWorkspaceTrusted('сборка пакета OneScript')) {
			return;
		}
		const root = this.ensureWorkspace();
		if (!root || !(await this.ensureLocalOscriptAvailable())) {
			return;
		}
		const outDir = this.packagesDirectory(root);
		try {
			await fs.mkdir(outDir, { recursive: true });
		} catch (error) {
			const message = `Не удалось создать каталог сборки ${outDir}: ${(error as Error).message}`;
			log.error(message);
			void vscode.window.showErrorMessage(message);
			return;
		}
		this.vrunner.executeOpmInTerminal(['build', '-o', outDir], {
			cwd: root,
			name: getBuildPackageCommandName().title,
		});
	}

	/**
	 * Ставит собранный пакет в движок проекта: `opm install -f <файл>`.
	 *
	 * Без файла берёт собранный пакет из каталога сборки, при нескольких
	 * спрашивает, какой; пакет текущей версии из packagedef стоит первым.
	 *
	 * @param target - Файл пакета: путь, Uri или узел дерева артефактов
	 * @param ask - Спросить, какой пакет ставить, если их несколько; агенту не задаётся
	 * @returns Промис, который разрешается после запуска установки
	 */
	async installPackage(target?: unknown, ask = true): Promise<void> {
		if (!ensureWorkspaceTrusted('установка пакета OneScript')) {
			return;
		}
		const root = this.ensureWorkspace();
		if (!root) {
			return;
		}
		const file = packageFileArgument(target) ?? (await this.pickBuiltPackage(root, ask));
		if (file === undefined || !(await this.ensureLocalOscriptAvailable())) {
			return;
		}
		this.vrunner.executeOpmInTerminal(['install', '-f', file], {
			cwd: root,
			name: `${getInstallPackageCommandName().title} ${path.basename(file)}`,
		});
	}

	/**
	 * Собранный пакет из каталога сборки.
	 *
	 * @param root - Корень проекта
	 * @param ask - Спросить, если пакетов несколько; иначе берётся первый
	 * @returns Путь к пакету или undefined, если пакета нет или выбор отменён
	 */
	private async pickBuiltPackage(root: string, ask: boolean): Promise<string | undefined> {
		const files = await builtPackages(this.packagesDirectory(root));
		if (files.length === 0) {
			log.warn(`Собранного пакета нет в ${this.packagesDirectory(root)}`);
			if (!ask) {
				return undefined;
			}
			const build = getBuildPackageCommandName().title;
			const answer = await vscode.window.showInformationMessage('Собранного пакета нет.', build);
			if (answer === build) {
				await vscode.commands.executeCommand('1c-platform-tools.package.build');
			}
			return undefined;
		}
		const manifest = readPackageManifest(root);
		const current = manifest === undefined ? undefined : packageFileName(manifest);
		const ordered = [
			...files.filter((file) => path.basename(file) === current),
			...files.filter((file) => path.basename(file) !== current),
		];
		if (ordered.length === 1 || !ask) {
			return ordered[0];
		}
		const picked = await vscode.window.showQuickPick(
			ordered.map((file) => ({
				label: path.basename(file),
				description: path.basename(file) === current ? 'версия из packagedef' : undefined,
				file,
			})),
			{ title: getInstallPackageCommandName().title, placeHolder: 'Собранный пакет' }
		);
		return picked?.file;
	}
}
