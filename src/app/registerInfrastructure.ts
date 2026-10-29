import * as vscode from 'vscode';
import { registerRunCommandFileWatcher } from '../shared/runCommandFromFileWatcher';
import { startChannelServer } from '../shared/channelServer';
import { WindowRegistration } from '../shared/windowRegistration';
import { workspaceProjectsSource } from '../features/projects/workspaceProjectsSource';
import { registerServiceFolderDecoration } from '../features/serviceFiles/serviceFolderDecoration';

/**
 * Регистрирует инфраструктурные сервисы расширения.
 *
 * @returns Запись окна в реестре окон для MCP-сервера
 */
export function registerInfrastructure(context: vscode.ExtensionContext): WindowRegistration {
	registerRunCommandFileWatcher(context);
	const windowRegistration = new WindowRegistration(startChannelServer(context), workspaceProjectsSource());
	context.subscriptions.push(windowRegistration);
	registerServiceFolderDecoration(context);
	return windowRegistration;
}
