import type { WindowChannel, WindowChannelEndpoint } from '../shared/windowChannel';

/**
 * API расширения для других расширений.
 *
 * Его читает 1C: Platform Tools MCP: адрес канала окна уходит MCP-серверу
 * переменными окружения, и агент работает с тем окном, в котором запущен.
 */
export interface PlatformToolsApi {
	/**
	 * Адрес канала окна для MCP-сервера; при первом вызове канал открывается.
	 *
	 * @returns Путь канала и токен сессии либо undefined, если папке не доверяют
	 *   или канал не открылся
	 */
	getMcpChannel(): Promise<WindowChannelEndpoint | undefined>;
}

/**
 * Собирает API расширения.
 *
 * @param channel - Канал окна для MCP-сервера
 * @returns API, которое возвращает активация
 */
export function createExtensionApi(channel: WindowChannel): PlatformToolsApi {
	return {
		getMcpChannel: () => channel.endpoint(),
	};
}
