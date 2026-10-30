/**
 * Наблюдатель за `HEAD` репозитория проекта.
 *
 * У обычного каталога `HEAD` лежит в `.git` корня. У worktree `.git` — файл,
 * а `HEAD` — в каталоге git-данных, часто вне проекта. Подпроект вовсе не
 * содержит `.git`: ветка читается у репозитория выше.
 */

import * as path from 'node:path';
import * as vscode from 'vscode';
import { gitHeadFile } from './gitHead';

/**
 * Следит за файлом `HEAD`, откуда читается `${gitBranch}`.
 *
 * @param root - Корень проекта
 * @param onChange - Что сделать, когда ветка сменилась
 * @returns Подписка; пустая, если проект вне репозитория
 */
export function watchGitHead(root: string, onChange: () => void): vscode.Disposable {
	const head = gitHeadFile(root);
	if (head === undefined) {
		return new vscode.Disposable(() => undefined);
	}
	const watcher = vscode.workspace.createFileSystemWatcher(
		new vscode.RelativePattern(path.dirname(head), path.basename(head))
	);
	return vscode.Disposable.from(
		watcher,
		watcher.onDidChange(onChange),
		watcher.onDidCreate(onChange),
		watcher.onDidDelete(onChange)
	);
}
