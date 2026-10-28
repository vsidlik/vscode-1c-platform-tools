import * as vscode from 'vscode';
import { registerRunCommandFileWatcher } from '../shared/runCommandFromFileWatcher';
import { startIpcServer } from '../shared/ipcServer';
import type { WindowChannel } from '../shared/windowChannel';
import { registerServiceFolderDecoration } from '../features/serviceFiles/serviceFolderDecoration';

/**
 * Регистрирует инфраструктурные сервисы расширения.
 *
 * @returns Канал окна для MCP-сервера
 */
export function registerInfrastructure(context: vscode.ExtensionContext): WindowChannel {
	registerRunCommandFileWatcher(context);
	const windowChannel = startIpcServer(context);
	registerServiceFolderDecoration(context);
	return windowChannel;
}
