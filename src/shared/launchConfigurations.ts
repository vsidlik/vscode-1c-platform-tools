/**
 * Конфигурации запуска из настроек VS Code.
 *
 * `launch.json` — JSONC: комментарий ломает `JSON.parse`. Секция `launch` файла
 * `.code-workspace` лежит на уровне рабочей области, а файл папки — на уровне папки.
 * Одноимённая конфигурация папки перекрывает конфигурацию рабочей области.
 */

/** Конфигурация запуска: имя нужно, чтобы папка перекрыла рабочую область. */
export interface LaunchConfigurationEntry {
	name?: string;
}

/**
 * Складывает конфигурации рабочей области и папки.
 *
 * @param workspace - Секция `launch` файла рабочей области или `launch.json` единственной папки
 * @param folder - `launch.json` папки в окне из нескольких папок
 * @returns Конфигурации; одно имя остаётся в одном экземпляре, побеждает папка
 */
export function mergeLaunchConfigurations<T extends LaunchConfigurationEntry>(
	workspace: readonly T[] | undefined,
	folder: readonly T[] | undefined
): T[] {
	const merged: T[] = [];
	const indexByName = new Map<string, number>();
	const add = (configs: readonly T[] | undefined): void => {
		if (!Array.isArray(configs)) {
			return;
		}
		for (const config of configs) {
			if (config === null || typeof config !== 'object') {
				continue;
			}
			const name = config.name;
			if (typeof name !== 'string' || name === '') {
				merged.push(config);
				continue;
			}
			const existing = indexByName.get(name);
			if (existing === undefined) {
				indexByName.set(name, merged.length);
				merged.push(config);
				continue;
			}
			merged[existing] = config;
		}
	};
	add(workspace);
	add(folder);
	return merged;
}

/**
 * Читает конфигурации из `inspect('configurations')`.
 *
 * @param inspected - Уровни настройки `launch.configurations`
 * @returns Конфигурации рабочей области и папки
 */
export function readLaunchConfigurations<T extends LaunchConfigurationEntry>(
	inspected: { workspaceValue?: T[]; workspaceFolderValue?: T[] } | undefined
): T[] {
	return mergeLaunchConfigurations(inspected?.workspaceValue, inspected?.workspaceFolderValue);
}
