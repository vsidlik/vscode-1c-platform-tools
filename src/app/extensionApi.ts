import type { WindowRegistration } from '../shared/windowRegistration';

/**
 * API расширения для других расширений.
 *
 * Его читает 1C: Platform Tools MCP: MCP-сервер, который запускает VS Code,
 * получает окно, из которого запущен, и работает с ним.
 */
export interface PlatformToolsApi {
	/**
	 * Окно в реестре окон для MCP-сервера; при первом вызове открывается канал окна.
	 *
	 * @returns Идентификатор окна либо undefined, если папке не доверяют или
	 *   канал не открылся
	 */
	getMcpWindow(): Promise<string | undefined>;
}

/**
 * Собирает API расширения.
 *
 * @param registration - Запись окна в реестре окон
 * @returns API, которое возвращает активация
 */
export function createExtensionApi(registration: WindowRegistration): PlatformToolsApi {
	return {
		getMcpWindow: () => registration.windowId(),
	};
}
