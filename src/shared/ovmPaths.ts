import * as path from 'node:path';
import * as os from 'node:os';

/**
 * Пути к инструментам OneScript, установленным через OVM (OneScript Version Manager).
 *
 * OVM ставит версии рядом, каждую в свой каталог `<каталог OVM>/<версия>`, а
 * `current` — симлинк на выбранную для всей машины (меняется командой `ovm use`).
 * Расположение детерминировано и не зависит от PATH, поэтому используется как
 * запасной источник, когда бинарь не найден в PATH (типично для VS Code,
 * запущенного из GUI, который не наследует PATH интерактивной оболочки).
 */

/** Каталог выбранной для машины версии внутри каталога OVM. */
export const OVM_CURRENT = 'current';

/**
 * Каталог установок OVM: переменная `OVM_INSTALL_PATH`, как у самого OVM, иначе
 * каталог данных пользователя.
 *
 * @param env - Окружение
 * @returns Абсолютный путь
 */
export function getOvmBaseDir(env: NodeJS.ProcessEnv = process.env): string {
	const configured = env.OVM_INSTALL_PATH?.trim();
	if (configured) {
		return configured;
	}
	return process.platform === 'win32'
		? path.join(env.LOCALAPPDATA || '', 'ovm')
		: path.join(os.homedir(), '.local', 'share', 'ovm');
}

/**
 * Корневой каталог активной версии OneScript из установки OVM.
 *
 * @returns Абсолютный путь к каталогу current OVM
 */
export function getOvmRootDir(): string {
	return path.join(getOvmBaseDir(), OVM_CURRENT);
}

/**
 * Возможные исполняемые файлы движка в каталоге установки.
 *
 * Сборка со своим рантаймом даёт `oscript.exe`, сборка под dotnet на Windows —
 * `oscript.bat`; на остальных ОС OVM кладёт в bin сценарий `oscript`.
 *
 * @param installDir - Каталог установки (с bin и lib)
 * @returns Пути в порядке приоритета
 */
export function getEngineBinaryCandidates(installDir: string): string[] {
	const bin = path.join(installDir, 'bin');
	return process.platform === 'win32'
		? [path.join(bin, 'oscript.exe'), path.join(bin, 'oscript.bat')]
		: [path.join(bin, 'oscript')];
}

/**
 * Каталог bin активной версии OneScript из установки OVM.
 *
 * @returns Абсолютный путь к каталогу bin OVM
 */
export function getOvmBinDir(): string {
	return path.join(getOvmRootDir(), 'bin');
}

/**
 * Полный путь к бинарю инструмента OneScript (oscript и т. п.) в установке OVM.
 * На Windows добавляется расширение `.exe`.
 *
 * @param name - Имя инструмента без расширения (например, 'oscript')
 * @returns Абсолютный путь к исполняемому файлу в каталоге bin OVM
 */
export function getOvmBinaryPath(name: string): string {
	const binary = process.platform === 'win32' ? `${name}.exe` : name;
	return path.join(getOvmBinDir(), binary);
}

/**
 * Возможные пути запускаемого файла opm в каталоге bin установки OneScript.
 *
 * В дистрибутиве OneScript opm — не exe, а обёртка над скриптом: на Windows
 * `opm.bat`, на остальных ОС — шелл-скрипт `opm`. На Windows проверяются
 * несколько расширений на случай различий между версиями дистрибутива.
 *
 * @param binDir - Каталог bin установки OneScript
 * @returns Пути-кандидаты к запускаемому файлу opm (в порядке приоритета)
 */
export function getOpmBinaryCandidates(binDir: string): string[] {
	if (process.platform === 'win32') {
		return [path.join(binDir, 'opm.bat'), path.join(binDir, 'opm.cmd'), path.join(binDir, 'opm.exe')];
	}
	return [path.join(binDir, 'opm')];
}

/**
 * Путь к скрипту opm внутри установки OneScript.
 *
 * Обёртка bin/opm(.bat) дистрибутива запускает `oscript <корень>/lib/opm/src/cmd/opm.os`.
 * Если обёртки в bin нет (наблюдается в установках OVM на Linux), opm можно
 * запустить напрямую через oscript по этому пути.
 *
 * @param installRoot - Корень установки OneScript (каталог с bin и lib)
 * @returns Абсолютный путь к opm.os
 */
export function getOpmScriptPath(installRoot: string): string {
	return path.join(installRoot, 'lib', 'opm', 'src', 'cmd', 'opm.os');
}

/**
 * Ставит каталог первым в PATH окружения дочернего процесса.
 *
 * Windows склеивает PATH как системная часть плюс пользовательская, поэтому
 * каталог другой установки OneScript может оказаться раньше выбранной. Обёртки
 * `opm.bat` и `vrunner.bat` запускают `oscript` по имени, и без этой подстановки
 * они увели бы работу в чужую установку.
 *
 * Имя переменной ищется без учёта регистра: на Windows это `Path`.
 *
 * @param env - Исходное окружение
 * @param binDir - Каталог, который должен искаться первым (undefined — не менять)
 * @returns Окружение с изменённым PATH
 */
export function withBinDirFirst(env: NodeJS.ProcessEnv, binDir: string | undefined): NodeJS.ProcessEnv {
	if (binDir === undefined || binDir === '') {
		return env;
	}
	const result: NodeJS.ProcessEnv = { ...env };
	const pathKey = Object.keys(result).find((key) => key.toUpperCase() === 'PATH') ?? 'PATH';
	const current = result[pathKey];
	result[pathKey] = current ? `${binDir}${path.delimiter}${current}` : binDir;
	return result;
}

/**
 * Имя переменной в окружении: на Windows регистр имён не важен, и прежнее имя
 * сохраняется, иначе у процесса оказались бы две переменные.
 *
 * @param env - Окружение
 * @param name - Искомое имя
 * @returns Имя, под которым переменная уже есть, либо искомое
 */
export function envName(env: NodeJS.ProcessEnv, name: string): string {
	const existing = process.platform === 'win32'
		? Object.keys(env).find((key) => key.toUpperCase() === name.toUpperCase())
		: undefined;
	return existing ?? name;
}

/**
 * Окружение дочернего процесса с выбранной установкой OneScript.
 *
 * Мало поставить её каталог первым в PATH: `ovm use` оставляет автозапуск cmd
 * `set PATH=%OVM_OSCRIPTBIN%;%PATH%`, и вложенный `cmd /c oscript`, которым
 * обёртки раннеров и vrunner запускают движок, взял бы установку из OVM. Та же
 * переменная, указывающая на выбранный каталог, автозапуск обезвреживает.
 * `OSCRIPTBIN` opm берёт каталогом команд приложений при установке пакета не в
 * проект: команда ложится рядом с движком, а не в `/usr/bin`, куда без прав не
 * пишется, как после `ovm use` на Linux и macOS.
 *
 * @param env - Исходное окружение
 * @param binDir - Каталог bin выбранной установки (undefined — не менять)
 * @returns Окружение для exec, spawn и задач
 */
export function withSelectedEngine(env: NodeJS.ProcessEnv, binDir: string | undefined): NodeJS.ProcessEnv {
	if (binDir === undefined || binDir === '') {
		return env;
	}
	const result = withBinDirFirst(env, binDir);
	result[envName(result, 'OVM_OSCRIPTBIN')] = binDir;
	result[envName(result, 'OSCRIPTBIN')] = binDir;
	return result;
}
