/**
 * Каталоги исходного кода для команд md-sparrow над проектом целиком.
 * @module sourcePaths
 */

import type { ExternalKind, SourceFormat } from './projectLayout';
import { CONVENTIONAL_PATHS, projectPaths } from './projectPaths';

/** Каталоги исходного кода относительно рабочей области: общие каталоги и точные списки. */
export interface SourceDirs {
	cf: string;
	cfe: string;
	epf: string;
	erf: string;
	/** Каталоги расширений проекта, тестовых тоже, в том числе вложенные. */
	cfeDirs: string[];
	/** Каталоги внешних обработок, тестовых тоже, где бы они ни лежали. */
	epfDirs: string[];
	/** Каталоги внешних отчётов. */
	erfDirs: string[];
}

/**
 * Каталог объекта: у выгрузки это каталог с `<Имя>.xml`, у проекта EDT — каталог с `<Имя>.mdo`.
 *
 * @param external - Внешний объект из раскладки
 */
function externalObjectDir(external: { dir: string; format: SourceFormat; kind: ExternalKind; name: string }): string {
	if (external.format !== 'edt') {
		return external.dir;
	}
	const folder = external.kind === 'report' ? 'ExternalReports' : 'ExternalDataProcessors';
	return [external.dir, 'src', folder, external.name].join('/');
}

/** Каталог внешних объектов выгрузки конфигуратора; корень рабочей области таким не бывает. */
function designerContainer(container: string | undefined): string | undefined {
	return container === undefined || container === '.' ? undefined : container;
}

/**
 * Каталоги для команд md-sparrow, которые обходят проект целиком.
 *
 * Берутся из раскладки: конфигурация, расширения и внешние объекты точными
 * каталогами в обоих форматах; тестовые идут наравне с остальными. Чего в
 * рабочей области нет, то идёт привычным местом: пустой каталог md-sparrow пропускает.
 *
 * @param workspaceRoot - Корень рабочей области
 */
export async function detectedSourceDirs(workspaceRoot: string): Promise<SourceDirs> {
	const paths = await projectPaths(workspaceRoot);
	const externals = [...paths.processors, ...paths.reports, ...paths.testProcessors];
	return {
		cf: paths.configuration?.dir ?? CONVENTIONAL_PATHS.cf,
		cfe: paths.extensionsContainer ?? CONVENTIONAL_PATHS.cfe,
		// Общий каталог проектов EDT это корень рабочей области: его целиком не отдаём
		epf: designerContainer(paths.processorsContainer) ?? CONVENTIONAL_PATHS.epf,
		erf: designerContainer(paths.reportsContainer) ?? CONVENTIONAL_PATHS.erf,
		cfeDirs: [...paths.extensions, ...paths.testExtensions].map((extension) => extension.dir),
		epfDirs: externals.filter((external) => external.kind === 'processor').map(externalObjectDir),
		erfDirs: externals.filter((external) => external.kind === 'report').map(externalObjectDir),
	};
}
