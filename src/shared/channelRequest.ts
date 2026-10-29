/**
 * Разбор запросов канала окна: корень проекта вызова и флаги выполнения.
 *
 * Здесь решается, выполнится ли вызов агента и в каком проекте. Правила сверки
 * путей не читают состояние окна: папки, проекты и текущий корень передаются
 * явно и проверяются тестами.
 */
import * as path from 'node:path';
import type { CommandExecutionOptions } from './commandExecutionTypes';
import { deepestProject, normalizeProjectRoot } from './workspaceProjects';

/** Состояние окна, от которого зависит корень вызова. */
export interface RequestRootContext {
	/** Корень текущего проекта. */
	currentRoot: string | undefined;
	/** Корни папок рабочей области. */
	folders: readonly string[];
	/** Корни проектов окна после полного обнаружения. */
	projects: readonly string[];
}

/** Корень вызова либо причина отказа. */
export type RequestRoot =
	| { root: string }
	| { error: 'WORKSPACE_MISMATCH'; projectPath: string }
	| { error: 'PROJECT_NOT_FOUND' }
	| { error: 'PROJECT_PATH_REQUIRED' };

/**
 * Каталог из projectPath: относительный путь считается от текущего проекта,
 * путь вне папок рабочей области отклоняется.
 */
function requestTarget(
	projectPath: string,
	context: RequestRootContext
): { target: string } | { error: 'WORKSPACE_MISMATCH'; projectPath: string } | { error: 'PROJECT_NOT_FOUND' } {
	const { currentRoot } = context;
	if (!path.isAbsolute(projectPath) && currentRoot === undefined) {
		return { error: 'PROJECT_NOT_FOUND' };
	}
	const target = normalizeProjectRoot(
		path.isAbsolute(projectPath) ? projectPath : path.join(currentRoot as string, projectPath)
	);
	if (!deepestProject(context.folders.map((root) => ({ root })), target)) {
		return { error: 'WORKSPACE_MISMATCH', projectPath: target };
	}
	return { target };
}

/**
 * Корень проекта, в котором выполняется команда агента.
 *
 * Без projectPath это текущий проект. Относительный путь считается от текущего
 * проекта. Путь внутри папки рабочей области даёт самый глубокий проект, в
 * котором он лежит, а вне проектов сам путь. Путь вне папок отклоняется.
 *
 * @param projectPath - Путь из запроса, уже без пробелов по краям
 * @param context - Папки, проекты и текущий корень окна
 * @returns Корень в написании известного проекта либо отказ
 */
export function resolveRequestRoot(projectPath: string | undefined, context: RequestRootContext): RequestRoot {
	const { currentRoot } = context;
	if (projectPath === undefined) {
		return currentRoot === undefined ? { error: 'PROJECT_NOT_FOUND' } : { root: currentRoot };
	}
	const resolved = requestTarget(projectPath, context);
	if ('error' in resolved) {
		return resolved;
	}
	const { target } = resolved;
	return { root: deepestProject(context.projects.map((root) => ({ root })), target)?.root ?? target };
}

/**
 * Каталог, с которым работает команда инициализации проекта.
 *
 * В отличие от {@link resolveRequestRoot} путь не заменяется проектом, в котором
 * он лежит, и без projectPath текущий проект не подставляется.
 *
 * @param projectPath - Путь из запроса, уже без пробелов по краям
 * @param context - Папки, проекты и текущий корень окна
 * @returns Каталог либо отказ
 */
export function resolveRequestDirectory(projectPath: string | undefined, context: RequestRootContext): RequestRoot {
	if (projectPath === undefined) {
		return { error: 'PROJECT_PATH_REQUIRED' };
	}
	const resolved = requestTarget(projectPath, context);
	return 'error' in resolved ? resolved : { root: resolved.target };
}

/**
 * Извлекает флаги выполнения из первого элемента аргументов команды.
 *
 * MCP-сервер передаёт объект с флагами первым аргументом. Вызовы из UI и
 * старых клиентов приходят с другими аргументами: тогда флагов нет.
 *
 * @param args - Аргументы команды
 * @returns Флаги выполнения (пустой объект, если их нет)
 */
export function extractCommandFlags(args: unknown[]): CommandExecutionOptions {
	if (args.length === 0) {
		return {};
	}
	const first = args[0];
	if (typeof first === 'object' && first !== null && !Array.isArray(first)) {
		return first as CommandExecutionOptions;
	}
	return {};
}
