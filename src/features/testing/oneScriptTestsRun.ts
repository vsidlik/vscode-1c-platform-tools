/**
 * Прогон тестов OneScript проекта задачей VS Code.
 *
 * Раннер, каталог тестов и каталог отчётов те же, что у панели тестирования,
 * движок — движок проекта. OneUnit ищет наборы и во вложенных каталогах (`-r`),
 * как в CI пакетов autumn-library; 1testrunner прогоняет каталог (`-runall`),
 * вложенные каталоги он не обходит. jUnit-отчёт подхватывает «Отчёт Allure».
 * @module oneScriptTestsRun
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { CommandExecutionOptions, StructuredCommandResult } from '../../shared/commandExecutionTypes';
import { logger } from '../../shared/logger';
import { notifyQuiet, notifyQuietFailure } from '../../shared/notify';
import { oneScriptTestsPath } from '../../shared/oneScriptLayout';
import { BUILD_SUBDIRS } from '../../shared/pathDefaults';
import type { VRunnerManager } from '../../shared/vrunnerManager';
import { buildProcessCommand } from '../../utils/commandUtils';
import { createVRunnerTask } from '../tasks/vrunnerTask';
import { getOneScriptTestsCommandName } from '../tools/commandNames';
import { oneScriptRunnerProgram, type OneScriptRunner } from './adapters/onescriptAdapter';
import { formatRunSummary, readRunSummary } from './runReportSummary';

const log = logger.scope('testing');

/** Аргументы раннера и отчёт, который он напишет. */
export interface OneScriptTestsCall {
	args: string[];
	/** Файл jUnit-отчёта */
	report: string;
}

/**
 * Аргументы прогона всех тестов каталога.
 *
 * @param kind - Раннер
 * @param testsDir - Абсолютный каталог тестов
 * @param reportsDir - Абсолютный каталог отчётов
 */
export function oneScriptTestsCall(kind: OneScriptRunner, testsDir: string, reportsDir: string): OneScriptTestsCall {
	if (kind === 'oneunit') {
		const report = path.join(reportsDir, 'oneunit.xml');
		return { args: ['execute', '-d', testsDir, '-r', '--junit', report], report };
	}
	// 1testrunner сам называет отчёт по каталогу набора
	return { args: ['-runall', testsDir, 'xddReportPath', reportsDir], report: path.join(reportsDir, `${path.basename(testsDir)}.xml`) };
}

/**
 * Прогоняет тесты OneScript проекта.
 *
 * @param vrunner - Менеджер инструментов проекта
 * @param root - Корень проекта
 * @param opts - Опции вызова; с `wait: true` возвращается итог по jUnit-отчёту
 * @returns Итог прогона при `wait: true`
 */
export async function runOneScriptTests(
	vrunner: VRunnerManager,
	root: string,
	opts?: CommandExecutionOptions
): Promise<StructuredCommandResult | void> {
	const title = getOneScriptTestsCommandName().title;
	const testsDir = path.resolve(root, oneScriptTestsPath(root));
	try {
		await fs.access(testsDir);
	} catch {
		const message = `Каталога тестов нет: ${path.relative(root, testsDir) || testsDir}`;
		log.warn(message);
		if (opts?.wait === true) {
			return { success: false, exitCode: 1, stdout: '', stderr: message };
		}
		void vscode.window.showWarningMessage(message);
		return;
	}
	const reportsDir = path.resolve(root, vrunner.getOutPath(), BUILD_SUBDIRS.onescript);
	await fs.mkdir(reportsDir, { recursive: true });
	const runner = oneScriptRunnerProgram(root);
	const call = oneScriptTestsCall(runner.kind, testsDir, reportsDir);
	const env = await vrunner.oneScriptEnv();
	const startedAt = Date.now();
	log.info(`${title}: ${runner.kind}, каталог ${testsDir}`);

	const exitCode = await new Promise<number>((resolve) => {
		const task = createVRunnerTask({
			name: title,
			command: buildProcessCommand(runner.file, call.args),
			cwd: root,
			env,
			root,
			exitCallback: resolve,
		});
		vscode.tasks.executeTask(task).then(undefined, (error: Error) => {
			log.error(`Задача тестов OneScript не запустилась: ${error.message}`);
			resolve(1);
		});
	});

	const stats = await readRunSummary(call.report, startedAt);
	const green = exitCode === 0 && stats !== undefined && stats.failed === 0 && stats.errors === 0;
	if (opts?.wait !== true) {
		if (green) {
			notifyQuiet(`${title}: тестов ${stats.total}, все прошли`);
		} else {
			notifyQuietFailure(stats ? `${title}: упало ${stats.failed + stats.errors} из ${stats.total}` : `${title}: отчёта нет, код ${exitCode}`);
		}
		return;
	}
	return {
		success: green,
		exitCode,
		stdout: stats ? formatRunSummary(stats) : '',
		stderr: stats ? '' : `Отчёт прогона не найден (ожидался: ${call.report}); код возврата ${exitCode}.`,
		artifact: stats ? call.report : undefined,
		...(stats ? { tests: stats } : {}),
	};
}
