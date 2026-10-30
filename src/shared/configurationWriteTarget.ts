/**
 * Уровень, на котором запись настройки проекта не перекроется папкой.
 */

import * as vscode from 'vscode';
import { workspaceFolderOf } from './workspaceProjects';
import { writesToWorkspaceFolder } from './workspaceScope';

/**
 * Куда писать настройку, чтобы её увидел `projectConfiguration(root)`.
 *
 * @param root - Корень проекта
 * @returns Уровень записи VS Code
 */
export function configurationWriteTarget(root: string): vscode.ConfigurationTarget {
	const folders = vscode.workspace.workspaceFolders ?? [];
	const inFolder = workspaceFolderOf(root, folders) !== undefined;
	return writesToWorkspaceFolder(folders.length, inFolder)
		? vscode.ConfigurationTarget.WorkspaceFolder
		: vscode.ConfigurationTarget.Workspace;
}

/**
 * Просит открыть папку, если окно пустое.
 *
 * Папки уже открыты, а `packagedef` нет: панели проекта не активны, отдельное
 * сообщение про отсутствие проекта не показываем.
 */
export function showWorkspaceRequired(): void {
	if ((vscode.workspace.workspaceFolders?.length ?? 0) > 0) {
		return;
	}
	void vscode.window.showErrorMessage('Откройте рабочую область для работы с проектом');
}
