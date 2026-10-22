/**
 * Поиск исходников OneScript для мутационного прогона.
 *
 * @module mutatosSources
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

/** Каталоги, в которых исходников проекта не бывает. */
const SKIPPED = ['oscript_modules', 'node_modules'];

/** Расширение файлов, которые мутирует mutatos. */
const SOURCE_EXTENSION = '.os';

/**
 * Каталоги исходников проекта: их получает mutatos аргументами `-d`.
 *
 * Раскладка пакета OneScript ничем не размечена, поэтому каталоги ищутся по
 * файлам `.os`: сначала `src`, иначе каталоги верхнего уровня, где такие файлы
 * есть. Каталоги тестов, сборки и зависимостей не берутся.
 *
 * @param root - Корень проекта
 * @param options.skip - Абсолютные каталоги тестов и результатов сборки
 * @returns Каталоги от ближнего к корню; пусто, если исходников нет
 */
export function findSourceDirectories(root: string, options: { skip: readonly string[] }): string[] {
	const skip = options.skip.map((dir) => path.resolve(dir));
	const source = path.join(root, 'src');
	if (hasSources(source, skip)) {
		return [source];
	}
	return topLevelDirectories(root).filter((dir) => hasSources(dir, skip));
}

/**
 * Имена каталогов верхнего уровня без файлов `.os`.
 *
 * @param root - Корень проекта
 */
export function topLevelWithoutOs(root: string): string[] {
	return topLevelDirectories(root)
		.filter((dir) => !hasSources(dir, []))
		.map((dir) => path.basename(dir));
}

/**
 * Каталоги верхнего уровня, кроме скрытых и заведомо чужих.
 *
 * @param root - Корень проекта
 */
function topLevelDirectories(root: string): string[] {
	let entries: fs.Dirent[];
	try {
		entries = fs.readdirSync(root, { withFileTypes: true });
	} catch {
		return [];
	}
	return entries
		.filter((entry) => entry.isDirectory() && !entry.name.startsWith('.') && !SKIPPED.includes(entry.name))
		.map((entry) => path.join(root, entry.name));
}

/**
 * Есть ли в каталоге файлы `.os`, не считая пропускаемых каталогов.
 *
 * @param dir - Каталог
 * @param skip - Абсолютные каталоги, куда не заходим
 */
function hasSources(dir: string, skip: readonly string[]): boolean {
	if (skip.some((skipped) => path.resolve(dir) === skipped)) {
		return false;
	}
	let entries: fs.Dirent[];
	try {
		entries = fs.readdirSync(dir, { withFileTypes: true });
	} catch {
		return false;
	}
	for (const entry of entries) {
		if (entry.isFile() && entry.name.toLowerCase().endsWith(SOURCE_EXTENSION)) {
			return true;
		}
	}
	return entries
		.filter((entry) => entry.isDirectory() && !entry.name.startsWith('.') && !SKIPPED.includes(entry.name))
		.some((entry) => hasSources(path.join(dir, entry.name), skip));
}
