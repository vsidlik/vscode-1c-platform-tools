/**
 * Раскладка проекта OneScript: описание пакета, каталоги исходного кода,
 * тестов, задач и зависимостей.
 *
 * Исходный код пакета ничем не размечен: каталоги берутся из файлов, которые
 * `packagedef` объявляет классами, модулями и исполняемыми файлами, а без таких
 * объявлений это `src`. Задачи и зависимости лежат там, где их ищет opm: `tasks`
 * и `oscript_modules` в корне проекта. Скриптовые тесты маркеров не имеют, их
 * каталог задаёт настройка, по умолчанию это каталог тестов проекта.
 *
 * Описание читается без ожидания и запоминается до изменения файла: его
 * спрашивают перед каждой командой.
 * @module oneScriptLayout
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { declaresPackageApi, parsePackagedef, type PackageManifest } from './packagedef';
import { DEFAULT_TESTING } from './pathDefaults';
import { projectConfiguration } from './projectConfiguration';
import { directoryKey, PROJECT_FILE, testsDirectoryName } from './projectLayout';
import { currentRoot } from './workspaceProjects';

/** Каталог зависимостей проекта: сюда их ставит `opm install -l`. */
export const MODULES_DIRECTORY = 'oscript_modules';

/** Каталог задач `opm run`. */
export const TASKS_DIRECTORY = 'tasks';

/** Каталог исходного кода, когда `packagedef` файлов не объявляет. */
const DEFAULT_SOURCES = 'src';

/** Раскладка проекта OneScript. */
export interface OneScriptLayout {
	/** Файл `packagedef`. */
	manifestFile: string;
	manifest: PackageManifest;
	/** Каталоги исходного кода пакета. */
	sources: string[];
	/** Каталог тестов. */
	tests: string;
	/** Каталог задач `opm run`. */
	tasks: string;
	/** Каталог зависимостей. */
	modules: string;
}

/** Прочитанные описания: ключ {@link directoryKey} корня. */
const manifests = new Map<string, { mtimeMs: number; size: number; manifest: PackageManifest }>();

/**
 * Описание пакета из `packagedef` корня.
 *
 * @param root - Корень проекта
 * @returns undefined, если файла нет или он не читается
 */
export function readPackageManifest(root: string): PackageManifest | undefined {
	const file = path.join(root, PROJECT_FILE);
	const key = directoryKey(root);
	let stat: fs.Stats;
	try {
		stat = fs.statSync(file);
	} catch {
		manifests.delete(key);
		return undefined;
	}
	const cached = manifests.get(key);
	if (cached?.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
		return cached.manifest;
	}
	let text: string;
	try {
		text = fs.readFileSync(file, 'utf8');
	} catch {
		return undefined;
	}
	const manifest = parsePackagedef(text);
	manifests.set(key, { mtimeMs: stat.mtimeMs, size: stat.size, manifest });
	return manifest;
}

/**
 * Каталоги исходного кода пакета: верхние каталоги объявленных файлов, без
 * объявлений `src`, если он есть.
 *
 * @param root - Корень проекта
 * @param manifest - Описание пакета
 */
export function packageSourceDirectories(root: string, manifest: PackageManifest): string[] {
	const directories = new Set<string>();
	for (const entry of [...manifest.classes, ...manifest.modules, ...manifest.executables]) {
		const [first, ...rest] = entry.file?.split('/') ?? [];
		if (rest.length > 0 && first !== '' && first !== '..' && !first.includes(':')) {
			directories.add(first);
		}
	}
	if (directories.size === 0 && fs.existsSync(path.join(root, DEFAULT_SOURCES))) {
		directories.add(DEFAULT_SOURCES);
	}
	return [...directories].sort().map((dir) => path.join(root, dir));
}

/**
 * Каталог тестов OneScript относительно корня проекта: настройка
 * `test.path.onescriptTests`, пустая значит каталог тестов проекта.
 *
 * @param root - Корень проекта, чьи настройки читаются
 */
export function oneScriptTestsPath(root: string | undefined = currentRoot()): string {
	const configured = projectConfiguration(root)
		.get<string>('test.path.onescriptTests', DEFAULT_TESTING.onescriptTestsPath)
		.trim();
	return configured.length > 0 ? configured : testsDirectoryName(root);
}

/**
 * Раскладка проекта OneScript.
 *
 * @param root - Корень проекта
 * @returns undefined, если в корне нет `packagedef`
 */
export function oneScriptLayout(root: string): OneScriptLayout | undefined {
	const manifest = readPackageManifest(root);
	if (manifest === undefined) {
		return undefined;
	}
	return {
		manifestFile: path.join(root, PROJECT_FILE),
		manifest,
		sources: packageSourceDirectories(root, manifest),
		tests: path.resolve(root, oneScriptTestsPath(root)),
		tasks: oneScriptTasksDirectory(root, manifest),
		modules: path.join(root, MODULES_DIRECTORY),
	};
}

/**
 * Каталог задач `opm run`: `Задачи` из packagedef, иначе `tasks`.
 *
 * @param root - Корень проекта
 * @param manifest - Описание пакета; по умолчанию читается из packagedef
 */
export function oneScriptTasksDirectory(root: string, manifest: PackageManifest | undefined = readPackageManifest(root)): string {
	return path.resolve(root, manifest?.tasks ?? TASKS_DIRECTORY);
}

/** Каталоги, по которым загрузчик библиотек OneScript находит классы и модули пакета. */
const PACKAGE_LOADER_DIRECTORIES = ['src/Классы', 'src/Модули', 'Классы', 'Модули', 'src/Classes', 'src/Modules', 'Classes', 'Modules'];

/**
 * Похож ли каталог без `packagedef` на пакет OneScript: в нём есть каталоги
 * классов или модулей загрузчика библиотек либо сценарии `.os` в корне или в `src`.
 *
 * @param dir - Каталог
 */
export function looksLikeOneScriptPackage(dir: string): boolean {
	if (PACKAGE_LOADER_DIRECTORIES.some((name) => fs.existsSync(path.join(dir, name)))) {
		return true;
	}
	return ['', DEFAULT_SOURCES].some((sub) => {
		try {
			return fs.readdirSync(path.join(dir, sub)).some((name) => name.toLowerCase().endsWith('.os'));
		} catch {
			return false;
		}
	});
}

/**
 * Собирается ли проект пакетом: `packagedef` объявляет классы, модули или исполняемый файл.
 *
 * @param root - Корень проекта
 */
export function isPackageProject(root: string): boolean {
	const manifest = readPackageManifest(root);
	return manifest !== undefined && declaresPackageApi(manifest);
}
