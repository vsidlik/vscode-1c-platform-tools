/**
 * Чтение текущей ветки git по файлу `.git/HEAD`.
 *
 * Файл читается напрямую (без запуска git): мгновенно, синхронно и не требует
 * git в PATH. Поддерживаются обычный каталог `.git`, файл-ссылка `.git`
 * с `gitdir:` (worktree, подмодуль) и подпроект, у которого `.git` лежит выше.
 */

import * as path from 'node:path';
import * as fsSync from 'node:fs';
import { branchDirNameFromHead, parseGitHead } from './launchVariables';

/** Что лежит в каталоге: нет `.git`, сломанный `.git` или каталог git-данных. */
type GitProbe = { kind: 'absent' } | { kind: 'broken' } | { kind: 'dir'; path: string };

/**
 * `.git` в одном каталоге: каталог, файл `gitdir:` или ничего.
 *
 * Сломанный `.git` — граница репозитория: выше по дереву ветку не ищем.
 *
 * @param root - Каталог, в котором смотрим `.git`
 */
function probeGit(root: string): GitProbe {
	const dotGit = path.join(root, '.git');
	let stats: fsSync.Stats;
	try {
		stats = fsSync.statSync(dotGit);
	} catch {
		return { kind: 'absent' };
	}
	if (stats.isDirectory()) {
		return { kind: 'dir', path: dotGit };
	}
	// worktree/подмодуль: .git — файл вида `gitdir: <путь>`
	try {
		const content = fsSync.readFileSync(dotGit, 'utf8');
		const match = /^gitdir:\s*(.+)\s*$/m.exec(content);
		if (match) {
			const gitDir = match[1].trim();
			return { kind: 'dir', path: path.isAbsolute(gitDir) ? gitDir : path.join(root, gitDir) };
		}
	} catch {
		// нечитаемый .git — репозиторием не считаем, но и не перешагиваем
	}
	return { kind: 'broken' };
}

/**
 * Каталог git-данных проекта.
 *
 * Ищет `.git` в каталоге и выше: подпроект лежит внутри репозитория и своего
 * `.git` не имеет. Worktree и подмодуль по-прежнему разбираются по `gitdir:`.
 *
 * @param start - Корень проекта или каталог внутри него
 * @returns Абсолютный путь к каталогу git-данных или undefined вне репозитория
 */
export function resolveGitDirectory(start: string): string | undefined {
	let current = path.resolve(start);
	for (;;) {
		const probe = probeGit(current);
		if (probe.kind === 'dir') {
			return probe.path;
		}
		if (probe.kind === 'broken') {
			return undefined;
		}
		const parent = path.dirname(current);
		if (parent === current) {
			return undefined;
		}
		current = parent;
	}
}

/**
 * Файл `HEAD`, из которого читается имя ветки.
 *
 * @param start - Корень проекта
 * @returns Абсолютный путь к `HEAD` или undefined вне репозитория
 */
export function gitHeadFile(start: string): string | undefined {
	const gitDir = resolveGitDirectory(start);
	return gitDir === undefined ? undefined : path.join(gitDir, 'HEAD');
}

/**
 * Имя каталога текущей ветки git для подстановки `${gitBranch}`.
 *
 * Значение вычисляется на момент вызова — переключение ветки подхватывается
 * следующей командой без перезагрузки окна. Для отсоединённого HEAD
 * возвращаются первые 8 символов хэша коммита.
 *
 * @param root - Корень проекта
 * @returns Имя каталога ветки или undefined вне репозитория git
 */
export function readGitBranchDirName(root: string): string | undefined {
	const headFile = gitHeadFile(root);
	if (!headFile) {
		return undefined;
	}
	try {
		const head = fsSync.readFileSync(headFile, 'utf8');
		return branchDirNameFromHead(parseGitHead(head));
	} catch {
		return undefined;
	}
}
