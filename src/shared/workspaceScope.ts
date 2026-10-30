/**
 * Уровень записи настроек проекта.
 *
 * Модуль не зависит от VS Code: так его проверяют без окна редактора.
 */

/**
 * Писать ли настройку в папку, а не в файл рабочей области.
 *
 * В окне из нескольких папок значение папки перекрывает запись в `.code-workspace`.
 * Одна папка хранит настройки в своём `settings.json`, и уровень Workspace туда же и пишет.
 *
 * @param openFolderCount - Сколько папок в окне
 * @param rootLiesInFolder - Корень проекта лежит в одной из папок
 * @returns true, если писать на уровень папки
 */
export function writesToWorkspaceFolder(openFolderCount: number, rootLiesInFolder: boolean): boolean {
	return openFolderCount > 1 && rootLiesInFolder;
}
