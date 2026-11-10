(function () {
	'use strict';
	const vscode = acquireVsCodeApi();
	let model = withTypeCompositions(window.__INITIAL_DATA__ || {});
	const tabsRoot = document.getElementById('tabs');
	const contentRoot = document.getElementById('content');
	const statusEl = document.getElementById('status');
	const pageEl = document.getElementById('page');
	const dialogBackdrop = document.getElementById('dialogBackdrop');
	const dialogBoxEl = document.getElementById('dialogBox');
	const dialogTitleEl = document.getElementById('dialogTitle');
	const dialogBodyEl = document.getElementById('dialogBody');
	const dialogErrorEl = document.getElementById('dialogError');
	const dialogActionsEl = document.getElementById('dialogActions');
	const dialogOkBtn = document.getElementById('dialogOk');
	const dialogCancelBtn = document.getElementById('dialogCancel');
	const noticeEl = document.getElementById('notice');
	const validateBtn = document.getElementById('validateBtn');
	let saving = false;
	/**
	 * Фоновая запись текста запроса набора по концу правки: {key, text, autofill, stage: 'text' | 'fill'}; null — не
	 * идёт. Её ответ не закрывает окна и не пишет отказ в окно: запись была не их.
	 */
	let background = null;
	/** Правка пользователя, пришедшая во время фоновой записи: уходит следом за ней, а не получает «ещё сохраняется». */
	let deferred = null;
	/**
	 * Окно, из которого ушла правка в полёте (null — со страницы): удачный ответ закрывает окна, только если оно ещё
	 * открыто, а отказ пишется в окно, только если правка ушла из него. Правка со страницы, ждавшая фоновой записи
	 * текста запроса, не закрывает окно, открытое уже после неё (конструктор запроса, окно строки).
	 */
	let editOrigin = null;
	/** Проверка схемы в полёте: повторный запрос не шлётся, пока не пришёл ответ validation. */
	let validating = false;

	const BUSY = 'Предыдущая правка ещё сохраняется.';

	/**
	 * Вкладки в порядке конфигуратора; редактируемые видны всегда, остальные — пока не пусты. «Настройки» видны и без
	 * вариантов: первый вариант добавляется из пустой таблицы вариантов.
	 */
	const TABS = [
		{ id: 'dataSets', title: 'Наборы данных', count: () => list('dataSets').length, render: renderDataSets, always: true },
		{ id: 'links', title: 'Связи наборов данных', count: () => list('dataSetLinks').length, render: renderLinks, always: true },
		{
			id: 'calculated',
			title: 'Вычисляемые поля',
			count: () => list('calculatedFields').length,
			render: renderCalculated,
			always: true,
		},
		{ id: 'resources', title: 'Ресурсы', count: () => list('totalFields').length, render: renderResources, always: true },
		{ id: 'parameters', title: 'Параметры', count: () => list('parameters').length, render: renderParameters, always: true },
		{ id: 'nested', title: 'Вложенные схемы', count: () => list('nestedSchemas').length, render: renderNested },
		{ id: 'variants', title: 'Настройки', count: () => list('settingsVariants').length, render: renderVariants, always: true },
	];
	let activeTabId = 'dataSets';

	function list(key) {
		return Array.isArray(model[key]) ? model[key] : [];
	}

	function el(tag, className, text) {
		const node = document.createElement(tag);
		if (className) {
			node.className = className;
		}
		if (text !== undefined && text !== '') {
			node.textContent = text;
		}
		return node;
	}

	/**
	 * Имя с местами переноса на границах слов: перед заглавной буквой после строчной или цифры
	 * (АнализАктивности|Пользователей) и после точки, запятой, точки с запятой, открывающей скобки и подчёркивания
	 * (СправочникСсылка.|Пользователи). Места переноса — элементы wbr: знаков они не добавляют, и текст узла,
	 * доступное имя и копирование дают имя целиком.
	 */
	function setNameText(node, text) {
		const parts = String(text).split(/(?<=[a-zа-яё\d])(?=[A-ZА-ЯЁ])|(?<=[.,;(_])(?=[^\s.,;)])/u);
		node.textContent = parts.length > 1 ? '' : parts[0];
		for (let index = 1; index < parts.length; index++) {
			if (index === 1) {
				node.appendChild(document.createTextNode(parts[0]));
			}
			node.appendChild(document.createElement('wbr'));
			node.appendChild(document.createTextNode(parts[index]));
		}
		return node;
	}

	/** Как el, но текст — имя с местами переноса на границах слов (setNameText). */
	function nameEl(tag, className, text) {
		const node = el(tag, className);
		if (text !== undefined && text !== null && text !== '') {
			setNameText(node, text);
		}
		return node;
	}

	/**
	 * Пояснение к неочевидному элементу — всплывающей подсказкой и описанием для читалки, а не постоянным абзацем под
	 * ним. Одного title экранный диктор не читает, поэтому ещё aria-description.
	 */
	function setHint(node, text) {
		node.title = text;
		node.setAttribute('aria-description', text);
		return node;
	}

	function emptyNote(host, text) {
		host.appendChild(el('div', 'empty', text));
	}

	function setStatus(text, isError) {
		statusEl.textContent = text;
		statusEl.classList.toggle('save-status-error', Boolean(isError));
	}

	/**
	 * Шлёт правку панели; false — предыдущая правка ещё не ответила. Во время фоновой записи текста запроса одна
	 * правка встаёт в очередь за ней: действие сразу после ухода из поля запроса (щелчок по флажку, ОК окна) не
	 * должно спотыкаться о запись, которую пользователь не просил явно.
	 */
	function send(type, fields) {
		const origin = editSource();
		if (saving) {
			if (background && !deferred) {
				deferred = { type: type, fields: fields || {}, origin: origin };
				return true;
			}
			return false;
		}
		postEdit(type, fields);
		editOrigin = origin;
		return true;
	}

	/** Откуда уходит правка: верхнее окно стека или страница (null). */
	function editSource() {
		return dialogStack.depth() > 0 ? dialogStack.top() : null;
	}

	/** Отправка правки без проверки занятости: send, очередь за фоновой записью и сама фоновая запись. */
	function postEdit(type, fields) {
		saving = true;
		editOrigin = null;
		pendingVariant = affectedVariant(type, fields || {});
		setStatus('Сохраняем…', false);
		vscode.postMessage(Object.assign({ type: type }, fields || {}));
	}

	/** Новая правка сейчас получила бы отказ «ещё сохраняется» (за фоновой записью место в очереди есть). */
	function editBusy() {
		return saving && !(background && !deferred);
	}

	/** Шлёт панели сообщение-чтение без блокировки правок (ленивая загрузка варианта). */
	function post(type, fields) {
		vscode.postMessage(Object.assign({ type: type }, fields || {}));
	}

	function kindLabel(type) {
		if (type === 'query') {
			return 'Запрос';
		}
		if (type === 'object') {
			return 'Объект';
		}
		if (type === 'union') {
			return 'Объединение';
		}
		return '';
	}

	function dataSetNames() {
		return list('dataSets')
			.map((dataSet) => dataSet.name || '')
			.filter(Boolean);
	}

	/**
	 * Имя занято без учёта регистра — так их сверяет md-sparrow. own — прежнее имя переименовываемого:
	 * смена регистра своего же имени чужое не занимает.
	 */
	function nameTaken(names, name, own) {
		const key = String(name).toLowerCase();
		return names.some((taken) => taken !== own && String(taken).toLowerCase() === key);
	}

	/** Пути полей набора верхнего уровня (и папок): среди них уникален путь нового или переименованного поля. */
	function dataSetFieldPaths(setName) {
		const dataSet = list('dataSets').find((item) => item && item.name === setName);
		return (dataSet && Array.isArray(dataSet.fields) ? dataSet.fields : []).map((field) => field.dataPath || '').filter(Boolean);
	}

	/** Пути вычисляемых полей схемы: путь нового или переименованного поля уникален среди них. */
	function calculatedFieldPaths() {
		return list('calculatedFields')
			.map((field) => field.name || '')
			.filter(Boolean);
	}

	/** Пути всех полей схемы: подсказки для ресурсов и список группировок «рассчитывать по». */
	function fieldPaths() {
		const paths = [];
		function collect(dataSet) {
			for (const field of Array.isArray(dataSet.fields) ? dataSet.fields : []) {
				if (field.dataPath && field.kind !== 'folder' && field.kind !== 'nested') {
					paths.push(field.dataPath);
				}
			}
			for (const item of Array.isArray(dataSet.items) ? dataSet.items : []) {
				collect(item);
			}
		}
		for (const dataSet of list('dataSets')) {
			collect(dataSet);
		}
		for (const field of list('calculatedFields')) {
			if (field.name) {
				paths.push(field.name);
			}
		}
		const unique = [];
		for (const path of paths) {
			if (unique.indexOf(path) < 0) {
				unique.push(path);
			}
		}
		return unique.sort((a, b) => a.localeCompare(b, 'ru'));
	}

	function suggestName(base, taken) {
		let index = 1;
		while (taken.indexOf(base + index) >= 0) {
			index += 1;
		}
		return base + index;
	}

	// ---------- стек диалогов ----------

	/** Решения стека (dcs-editor-dialogs.js): порядок уровней, Escape, Tab, возврат фокуса. */
	const dialogRules = window.DcsDialogs;
	const dialogStack = dialogRules.createStack();
	/** Счётчик id заголовков вложенных окон: aria-labelledby требует id, уникальный в документе. */
	let dialogSerial = 0;

	/**
	 * Точка расширения для списка подсказки: пока список открыт, Escape закрывает только
	 * его, а не окно с недописанным выражением. Подсказка кладёт сюда {isOpen(), close()}.
	 */
	let escapePopup = null;

	/** Кандидаты в остановки Tab; скрытые и отключённые отсеивает isTabStop. */
	const FOCUSABLE = 'a[href], button, input, select, textarea, summary, [tabindex], [contenteditable="true"]';

	/** Каркас уровня 1 — разметка шаблона (dcs-editor.html); вложенные уровни собирает скрипт. */
	const baseShell = {
		root: dialogBackdrop,
		box: dialogBoxEl,
		titleEl: dialogTitleEl,
		bodyEl: dialogBodyEl,
		errorEl: dialogErrorEl,
		actionsEl: dialogActionsEl,
		buttonEls: {},
		level: null,
		nested: false,
		// Нарисованный заголовок (paintDialogTitle): перерисовка тела не трогает его без смены
		titleKey: null,
	};
	registerDialogButton(baseShell, 'ok', dialogOkBtn);
	registerDialogButton(baseShell, 'cancel', dialogCancelBtn);

	function registerDialogButton(shell, id, button) {
		shell.buttonEls[id] = button;
		button.addEventListener('click', () => {
			pressDialogButton(shell, id);
		});
	}

	/** Каркас вложенного уровня: та же структура, что у разметки уровня 1, но без её id. */
	function createDialogShell() {
		dialogSerial += 1;
		const root = el('div', 'dcs-dialog-backdrop dcs-dialog-nested');
		const box = el('div', 'dcs-dialog');
		box.setAttribute('role', 'dialog');
		box.setAttribute('aria-modal', 'true');
		box.tabIndex = -1;
		const titleEl = el('div', 'dcs-dialog-title');
		titleEl.id = 'dcsDialogTitle' + dialogSerial;
		box.setAttribute('aria-labelledby', titleEl.id);
		const bodyEl = el('div', 'dcs-dialog-body');
		const errorEl = el('div', 'dcs-dialog-error');
		errorEl.setAttribute('aria-live', 'polite');
		const actionsEl = el('div', 'dcs-dialog-actions');
		box.appendChild(titleEl);
		box.appendChild(bodyEl);
		box.appendChild(errorEl);
		box.appendChild(actionsEl);
		root.appendChild(box);
		return {
			root: root,
			box: box,
			titleEl: titleEl,
			bodyEl: bodyEl,
			errorEl: errorEl,
			actionsEl: actionsEl,
			buttonEls: {},
			level: null,
			nested: true,
			titleKey: null,
		};
	}

	/**
	 * Подвал по описанию кнопок. Кнопки переиспользуются по id: смена подписи («Далее >» → «ОК»)
	 * не пересоздаёт кнопку и не сбивает фокус; переставляются узлы, только если сменился состав.
	 */
	function renderDialogButtons(shell, buttons) {
		const active = document.activeElement;
		const wanted = buttons.map((button) => {
			let node = shell.buttonEls[button.id];
			if (!node) {
				node = el('button', '');
				node.type = 'button';
				registerDialogButton(shell, button.id, node);
			}
			node.className = button.primary ? 'primary-btn' : 'ghost-btn';
			node.textContent = button.label;
			node.disabled = button.disabled;
			// Недоступная, но фокусируемая кнопка: читалка слышит «недоступно», Tab её не теряет
			if (button.unavailable) {
				node.setAttribute('aria-disabled', 'true');
			} else {
				node.removeAttribute('aria-disabled');
			}
			return node;
		});
		const current = Array.from(shell.actionsEl.children);
		const same = current.length === wanted.length && wanted.every((node, index) => current[index] === node);
		if (same) {
			return;
		}
		shell.actionsEl.textContent = '';
		for (const node of wanted) {
			shell.actionsEl.appendChild(node);
		}
		// Перенос узла снимает с него фокус: возвращаем, если кнопка осталась в подвале
		if (active && wanted.indexOf(active) >= 0 && document.activeElement !== active) {
			active.focus();
		}
	}

	function pressDialogButton(shell, id) {
		const level = shell.level;
		// Подвал нижнего окна неактивен: отвечает только верхний уровень
		if (!level || level !== dialogStack.top()) {
			return;
		}
		const button = level.buttons.find((candidate) => candidate.id === id);
		// aria-disabled браузер не соблюдает сам: щелчок и Enter по такой кнопке доходят сюда
		if (!button || button.disabled || button.unavailable) {
			return;
		}
		if (!button.onClick) {
			cancelDialogLevel(level);
			return;
		}
		const result = button.onClick(level);
		// Обработчик мог закрыть окно или открыть другое на том же каркасе: ошибка — только живому уровню
		if (shell.level === level) {
			shell.errorEl.textContent = dialogRules.clickError(result);
		}
	}

	/**
	 * Заголовок уровня: текст, знак «*» изменённого окна (только для глаза) и скрытые с экрана слова
	 * для читалки — имя окна по aria-labelledby собирается из заголовка, и aria-hidden знак в него не
	 * входит. Перерисовывается только при смене: setTitle зовут на каждой перерисовке тела.
	 */
	function paintDialogTitle(shell, parts) {
		const key = parts.text + '\u0000' + parts.mark;
		if (shell.titleKey === key) {
			return;
		}
		shell.titleKey = key;
		shell.titleEl.textContent = parts.text;
		if (!parts.mark) {
			return;
		}
		const mark = el('span', 'dcs-dialog-modified', ' ' + parts.mark);
		mark.setAttribute('aria-hidden', 'true');
		shell.titleEl.appendChild(mark);
		shell.titleEl.appendChild(el('span', 'dcs-dialog-modified-spoken', ' (' + parts.spoken + ')'));
	}

	/**
	 * Открывает уровень поверх открытых. spec: {title, width: normal|wide|full, build(body, level),
	 * buttons: [{id, label, primary?, disabled?, unavailable?, onClick?(level)}], onCancel?(level),
	 * onClose?(level), returnFocus?}. Кнопка без onClick — «Отмена» уровня; onClick, вернувший строку,
	 * показывает её ошибкой; unavailable — недоступна, но фокусируема (aria-disabled). onCancel,
	 * вернувший false, оставляет окно открытым. Возвращает уровень: {body, setTitle(text, modified?),
	 * setError, setButtons, close, isOpen}; modified ставит после заголовка «*».
	 */
	function pushDialog(spec) {
		const normalized = dialogRules.normalizeSpec(spec);
		if (!dialogRules.canPush(dialogStack.depth())) {
			throw new Error('Диалог: открыто слишком много окон подряд.');
		}
		const active = document.activeElement;
		const shell = dialogStack.depth() === 0 ? baseShell : createDialogShell();
		const level = {
			shell: shell,
			body: shell.bodyEl,
			buttons: normalized.buttons,
			onCancel: normalized.onCancel,
			onClose: normalized.onClose,
			// Вызвавший элемент: на него вернётся фокус, когда окно закроется
			returnFocus: normalized.returnFocus || (active && active !== document.body ? active : null),
			setTitle: function (text, modified) {
				// Каркас уровня 1 переиспользуется: закрытый уровень не должен переписать заголовок нового окна
				if (shell.level === level) {
					paintDialogTitle(shell, dialogRules.titleParts(text || '', Boolean(modified)));
				}
			},
			setError: function (text) {
				if (shell.level === level) {
					shell.errorEl.textContent = text || '';
				}
			},
			setButtons: function (buttons) {
				level.buttons = dialogRules.normalizeButtons(buttons);
				if (shell.level === level) {
					renderDialogButtons(shell, level.buttons);
				}
			},
			close: function () {
				closeDialogLevels(dialogStack.indexOf(level));
			},
			isOpen: function () {
				return dialogStack.indexOf(level) >= 0;
			},
		};
		dialogStack.push(level);
		shell.level = level;
		// Ключ сбрасывается: заголовок нового окна пишется всегда, даже если совпал с прежним
		shell.titleKey = null;
		paintDialogTitle(shell, dialogRules.titleParts(normalized.title, false));
		shell.bodyEl.textContent = '';
		shell.errorEl.textContent = '';
		shell.box.classList.toggle('dcs-dialog-wide', normalized.width === 'wide');
		shell.box.classList.toggle('dcs-dialog-full', normalized.width === 'full');
		renderDialogButtons(shell, level.buttons);
		if (shell.nested) {
			document.body.appendChild(shell.root);
		} else {
			shell.root.classList.remove('hidden');
		}
		if (normalized.build) {
			try {
				normalized.build(shell.bodyEl, level);
			} catch (error) {
				// Недостроенное окно не оставляем: иначе страница так и останется неактивной
				closeDialogLevels(dialogStack.indexOf(level));
				throw error;
			}
		}
		if (!level.isOpen()) {
			return level;
		}
		// Фокус — в новое окно до inert и aria-hidden нижних уровней: на предке элемента с фокусом
		// браузер aria-hidden отклоняет. build мог сам поставить фокус в своё окно — тогда не трогаем
		if (!shell.box.contains(document.activeElement)) {
			focusDialogDefault(level);
		}
		applyDialogStates();
		return level;
	}

	/** Отмена пользователем (Escape, «Отмена»): onCancel может удержать окно, вернув false. */
	function cancelDialogLevel(level) {
		if (level.onCancel && !dialogRules.cancelAllowed(level.onCancel(level))) {
			return;
		}
		closeDialogLevels(dialogStack.indexOf(level));
	}

	/** Закрывает уровень index и всё над ним, затем возвращает фокус и активность оставшимся. */
	function closeDialogLevels(index) {
		if (index < 0 || index >= dialogStack.depth()) {
			return;
		}
		const active = document.activeElement;
		let focusLeft = !active || active === document.body;
		for (let position = index; position < dialogStack.depth(); position += 1) {
			if (dialogStack.at(position).shell.root.contains(active)) {
				focusLeft = true;
			}
		}
		const closed = dialogStack.truncate(index);
		for (const level of closed) {
			teardownDialogShell(level.shell);
		}
		applyDialogStates();
		restoreDialogFocus(closed, focusLeft);
		// onClose — после разборки: стек уже согласован, обработчик может открыть новое окно
		for (const level of closed) {
			if (level.onClose) {
				level.onClose(level);
			}
		}
	}

	function teardownDialogShell(shell) {
		// Поле уходит вместе с окном, а blur у удалённого узла браузер не обещает: список закрываем сами
		closeCompletionWithin(shell.root);
		// Сам список жил в этом окне — он нужен и дальше, поэтому возвращается на body до разборки окна
		releaseCompletionHost(shell.box);
		shell.level = null;
		shell.bodyEl.textContent = '';
		shell.errorEl.textContent = '';
		if (shell.nested) {
			shell.root.remove();
			return;
		}
		shell.root.classList.add('hidden');
		shell.box.classList.remove('dcs-dialog-wide', 'dcs-dialog-full');
		setDialogInert(shell.root, false);
	}

	/** Нижние уровни и страница под стеком неактивны и скрыты от читалок; верхний — активен. */
	function applyDialogStates() {
		const states = dialogRules.levelStates(dialogStack.depth());
		setDialogInert(pageEl, states.pageInert);
		states.levels.forEach((state, index) => {
			const shell = dialogStack.at(index).shell;
			shell.root.style.zIndex = String(state.zIndex);
			setDialogInert(shell.root, state.inert);
		});
	}

	function setDialogInert(node, inert) {
		node.inert = inert;
		if (inert) {
			node.setAttribute('aria-hidden', 'true');
		} else {
			node.removeAttribute('aria-hidden');
		}
	}

	function restoreDialogFocus(closed, focusLeft) {
		// Вкладку под окном могла перерисовать фоновая запись текста запроса (или правка, вставшая за ней в очередь):
		// вызвавший узел заменён новым с тем же ключом — фокус вернётся на него
		for (const level of closed) {
			level.returnFocus = liveFocusNode(level.returnFocus);
		}
		const top = dialogStack.top();
		const decision = dialogRules.focusAfterClose(
			closed,
			focusLeft,
			(node) => dialogFocusUsable(node, top),
			dialogStack.depth()
		);
		if (decision.kind === 'element') {
			decision.element.focus();
		} else if (decision.kind === 'top') {
			focusDialogDefault(top);
		}
	}

	/** Узел, убранный перерисовкой вкладки, — его преемник с тем же ключом (data-dcs-key); иначе сам узел. */
	function liveFocusNode(node) {
		if (!node || node.isConnected || typeof node.getAttribute !== 'function') {
			return node;
		}
		const key = node.getAttribute('data-dcs-key');
		return (key && focusTarget(key)) || node;
	}

	/** Вызвавший элемент жив и лежит в активной части: в верхнем окне или на странице без окон. */
	function dialogFocusUsable(node, top) {
		if (!node || typeof node.focus !== 'function' || node.disabled) {
			return false;
		}
		return (top ? top.shell.box : document.body).contains(node);
	}

	/** Фокус по умолчанию: первое поле формы, иначе само окно. */
	function focusDialogDefault(level) {
		const first = level.shell.bodyEl.querySelector('input, select, textarea');
		(first || level.shell.box).focus();
	}

	function isTabStop(node) {
		if (node.disabled || node.tabIndex < 0) {
			return false;
		}
		// Свёрнутые и скрытые блоки фокус не получают — браузер их тоже пропускает
		return node.getClientRects().length > 0;
	}

	/** Tab не уходит из верхнего окна: на краях обход заворачивается, внутри — браузерный. */
	function trapDialogTab(event) {
		const box = dialogStack.top().shell.box;
		const stops = Array.from(box.querySelectorAll(FOCUSABLE)).filter(isTabStop);
		const decision = dialogRules.tabTarget(stops.length, stops.indexOf(document.activeElement), event.shiftKey);
		if (!decision.prevent) {
			return;
		}
		event.preventDefault();
		(decision.index >= 0 ? stops[decision.index] : box).focus();
	}

	/** Диалог уровня 1 с подвалом «okLabel / Отмена»; открытие заменяет все окна. */
	function openBaseDialog(width, title, okLabel, build, onSubmit) {
		closeDialogLevels(0);
		return pushDialog({
			title: title,
			width: width,
			build: build,
			buttons: [
				// Пока предыдущая правка сохраняется, повторное нажатие не шлёт вторую и не трогает строку ошибки; за
				// фоновой записью текста запроса правка окна встаёт в очередь (editBusy)
				{
					id: 'ok',
					label: okLabel,
					primary: true,
					onClick: (level) => (editBusy() ? level.shell.errorEl.textContent : onSubmit()),
				},
				{ id: 'cancel', label: 'Отмена' },
			],
		});
	}

	function openDialog(title, okLabel, build, onSubmit) {
		return openBaseDialog('normal', title, okLabel, build, onSubmit);
	}

	/** Широкий диалог для форм с таблицами внутри (условное оформление). */
	function openWideDialog(title, okLabel, build, onSubmit) {
		return openBaseDialog('wide', title, okLabel, build, onSubmit);
	}

	/** Закрывает все окна: уровень 1 и всё над ним (после сохранения модель перечитана целиком). */
	function closeDialog() {
		closeDialogLevels(0);
	}

	function dialogOpen() {
		return dialogStack.depth() > 0;
	}

	/** Подтверждение удаления: мини-диалог вместо window.confirm (в webview он отключён). */
	function confirmRemove(question, submit) {
		openDialog(
			'Удаление',
			'Удалить',
			(body) => {
				body.appendChild(el('div', 'dcs-confirm-text', question));
			},
			submit
		);
	}

	document.addEventListener('keydown', (event) => {
		// Esc во время переноса отменяет перенос, а не окно: окно закроет следующий Esc
		if (event.key === 'Escape' && dragNow) {
			event.preventDefault();
			finishDrag(false, true);
			return;
		}
		// Набор через IME и клавиши, уже обработанные полем, окна не закрывают
		if (event.defaultPrevented || event.isComposing) {
			return;
		}
		if (event.key === 'Escape') {
			const action = dialogRules.escapeAction(dialogStack.depth(), Boolean(escapePopup && escapePopup.isOpen()));
			if (action === 'popup') {
				event.preventDefault();
				escapePopup.close();
			} else if (action === 'level') {
				event.preventDefault();
				cancelDialogLevel(dialogStack.top());
			}
			return;
		}
		if (event.key === 'Tab' && dialogOpen()) {
			trapDialogTab(event);
		}
	});

	// ---------- элементы форм ----------

	function formRow(host, labelText, control) {
		const row = el('div', 'dcs-form-row');
		const label = el('label', 'dcs-form-label', labelText);
		row.appendChild(label);
		row.appendChild(control);
		host.appendChild(row);
		return control;
	}

	function groupTitle(host, text) {
		host.appendChild(el('div', 'dcs-form-group', text));
	}

	function textInput(value) {
		const input = el('input', 'edit-input');
		input.type = 'text';
		input.value = value || '';
		return input;
	}

	function numberInput(value) {
		const input = el('input', 'edit-input dcs-input-number');
		input.type = 'number';
		input.min = '1';
		input.step = '1';
		input.value = typeof value === 'number' && value > 0 ? String(value) : '';
		return input;
	}

	function selectInput(options, value) {
		const select = el('select', 'edit-input');
		for (const option of options) {
			const node = document.createElement('option');
			node.value = option.value;
			node.textContent = option.label;
			select.appendChild(node);
		}
		select.value = value;
		return select;
	}

	function checkbox(labelText, checked) {
		const wrap = el('label', 'dcs-check');
		const input = el('input', 'edit-check');
		input.type = 'checkbox';
		input.checked = Boolean(checked);
		wrap.appendChild(input);
		wrap.appendChild(el('span', '', labelText));
		return { wrap: wrap, input: input };
	}

	function checkRow(host, boxes) {
		const row = el('div', 'dcs-check-row');
		for (const box of boxes) {
			row.appendChild(box.wrap);
		}
		host.appendChild(row);
	}

	// ---------- перетаскивание: чистые правила ----------

	/**
	 * Свой тип данных переноса строк редактора. Сброс без него (файл, текст из другого окна) зоны не принимают: оболочка
	 * webview VS Code отменяет dragover и drop на всём документе, и без этой проверки в зону «падало» бы что угодно.
	 */
	const DRAG_TYPE = 'application/x-dcs-row';

	/**
	 * Место сброса относительно строки под указателем: offset — от её верха, size — её высота. mode: 'line' — до или
	 * после (по половинам строки), 'into' — в саму строку, 'both' — края (по четверти) до и после, середина — в строку,
	 * 'zone' — строка не важна, перенос в список целиком (тогда 'end').
	 */
	function dropPlace(offset, size, mode) {
		if (mode === 'zone') {
			return 'end';
		}
		if (mode === 'into') {
			return 'into';
		}
		const share = size > 0 ? Math.min(Math.max(offset / size, 0), 1) : 0;
		if (mode === 'both') {
			return share < 0.25 ? 'before' : share >= 0.75 ? 'after' : 'into';
		}
		return share < 0.5 ? 'before' : 'after';
	}

	/**
	 * Номер, на котором окажется элемент списка из count элементов: from — его номер сейчас (-1 — новый: его добавят в
	 * конец и сдвинут на место), target — номер строки сброса (-1 — под строками, в конец), place — 'before' | 'after'.
	 * Перестановка считает номер после изъятия элемента; итог всегда в границах списка.
	 */
	function dropIndex(count, from, target, place) {
		const moving = from >= 0 && from < count;
		let to = target < 0 || target >= count ? count : place === 'after' ? target + 1 : target;
		if (moving && from < to) {
			to -= 1;
		}
		return Math.max(0, Math.min(to, moving ? count - 1 : count));
	}

	/**
	 * Принимает ли зона перенос: у неё есть обработчик для зоны-источника (zone.from[id]), перенос начат в том же окне
	 * (scope) и, если задано, проходит своё правило зоны accept(payload).
	 */
	function dropAccepted(zone, payload) {
		if (!zone || !payload || !zone.from || !Object.prototype.hasOwnProperty.call(zone.from, payload.zone)) {
			return false;
		}
		if (typeof zone.from[payload.zone] !== 'function' || zone.scope !== payload.scope) {
			return false;
		}
		return typeof zone.accept === 'function' ? Boolean(zone.accept(payload)) : true;
	}

	/**
	 * Вид места сброса в зоне для этого переноса: zone.place — строка или правило по переносу и ключу строки под
	 * указателем (key: null — строки нет или она ещё не найдена; так папка принимает «в строку», а поле — только до и
	 * после); по умолчанию 'line'.
	 */
	function dropMode(zone, payload, key) {
		const mode = typeof zone.place === 'function' ? zone.place(payload, key === undefined ? null : key) : zone.place;
		return mode === 'into' || mode === 'both' || mode === 'zone' ? mode : 'line';
	}

	/**
	 * Принимает ли строка зоны под указателем этот перенос: zone.rowAccept(payload, key) — правило по строке (узел
	 * структуры переставляется только среди соседей); без правила — любая строка.
	 */
	function dropRowAccepted(zone, payload, key) {
		return typeof zone.rowAccept === 'function' ? Boolean(zone.rowAccept(payload, key)) : true;
	}

	/** Курсор сброса: 'copy' — значение остаётся в источнике (добавить), иначе 'move' (убрать, переставить). */
	function dropEffect(zone, payload) {
		const effect = typeof zone.effect === 'function' ? zone.effect(payload) : zone.effect;
		return effect === 'copy' ? 'copy' : 'move';
	}

	/** Есть ли среди типов переноса (DataTransfer.types — массив или DOMStringList) свой тип. */
	function hasDragType(types) {
		return Boolean(types) && Array.prototype.indexOf.call(types, DRAG_TYPE) >= 0;
	}

	/*
	 * Правки дерева элементов списка «Настроек» по месту сброса: выбранные поля с папками, отбор с группами (И, ИЛИ, НЕ),
	 * сортировка. Чистые, на копии; адрес элемента — номера по уровням ([1, 0] — первый элемент в папке второй строки).
	 * Результат уходит той же правкой списка целиком (dcs/set-selection, set-filter, set-order), что у кнопок.
	 */

	/** Список уровня по адресу владельца ([] — верхний) в копии дерева; у владельца без вложений список создаётся. */
	function itemsLevel(items, parent) {
		let level = items;
		for (const index of parent) {
			const owner = level[index];
			if (!Array.isArray(owner.items)) {
				owner.items = [];
			}
			level = owner.items;
		}
		return level;
	}

	/**
	 * Куда встанет элемент по месту сброса: {parent — адрес владельца, index — номер вставки в его список до изъятия
	 * переносимого}. target — адрес строки сброса или null (под строками, пустой список: в конец верхнего уровня);
	 * place — 'before' | 'after' | 'into' (в папку или группу — последним) | 'end'.
	 */
	function itemsDropSlot(items, target, place) {
		if (!target || target.length === 0 || place === 'end') {
			return { parent: [], index: items.length };
		}
		if (place === 'into') {
			let level = items;
			for (const index of target) {
				const owner = level[index];
				level = owner && Array.isArray(owner.items) ? owner.items : [];
			}
			return { parent: target.slice(), index: level.length };
		}
		const last = target[target.length - 1];
		return { parent: target.slice(0, -1), index: place === 'after' ? last + 1 : last };
	}

	/** Новый элемент в место slot: {items — копия дерева с ним, pos — его адрес}. */
	function itemsInsert(items, slot, fresh) {
		const next = JSON.parse(JSON.stringify(items));
		const level = itemsLevel(next, slot.parent);
		const index = Math.max(0, Math.min(slot.index, level.length));
		level.splice(index, 0, fresh);
		return { items: next, pos: slot.parent.concat([index]) };
	}

	/**
	 * Перенос элемента с адреса from в место slot (itemsDropSlot): {items — копия дерева, pos — новый адрес}; null — место
	 * то же, или папку (группу) бросили в неё саму или во вложенную.
	 */
	function itemsMove(items, from, slot) {
		const depth = from.length - 1;
		if (slot.parent.length >= from.length && from.every((index, at) => slot.parent[at] === index)) {
			return null;
		}
		const next = JSON.parse(JSON.stringify(items));
		const moved = itemsLevel(next, from.slice(0, -1)).splice(from[depth], 1)[0];
		// Адрес места после изъятия: на уровне переносимого строки за ним поднялись на одну
		const parent = slot.parent.slice();
		let index = slot.index;
		if (from.slice(0, -1).every((value, at) => parent[at] === value)) {
			if (parent.length > depth && parent[depth] > from[depth]) {
				parent[depth] -= 1;
			} else if (parent.length === depth && index > from[depth]) {
				index -= 1;
			}
		}
		const level = itemsLevel(next, parent);
		index = Math.max(0, Math.min(index, level.length));
		const pos = parent.concat([index]);
		if (pos.length === from.length && pos.every((value, at) => value === from[at])) {
			return null;
		}
		level.splice(index, 0, moved);
		return { items: next, pos: pos };
	}

	/** Элемент по адресу без правки дерева; адреса нет — null. */
	function itemAtPos(items, pos) {
		let level = items;
		let item = null;
		for (const index of pos) {
			item = Array.isArray(level) ? level[index] || null : null;
			if (!item) {
				return null;
			}
			level = item.items;
		}
		return item;
	}

	/**
	 * Место сброса так, как его показывает линия (itemsDropSlot с поправкой): папки и группы раскрыты всегда, и линия
	 * «после» папки (группы) с вложенными идёт под её строкой — над первой вложенной. Элемент встаёт первым в неё, как при
	 * сбросе «до» её первой строки, а не за всем её содержимым, за много строк от линии. container(элемент) — папка или
	 * группа.
	 */
	function listDropSlot(items, target, place, container) {
		if (place === 'after' && target && target.length > 0 && typeof container === 'function') {
			const owner = itemAtPos(items, target);
			if (owner && container(owner) && Array.isArray(owner.items) && owner.items.length > 0) {
				return { parent: target.slice(), index: 0 };
			}
		}
		return itemsDropSlot(items, target, place);
	}

	/**
	 * Команды уровня — путь клавиатурой и одним щелчком к тому, что перенос мышью делает с папками и группами (WCAG 2.5.7):
	 * «Вынести из папки (группы)» — сразу за её строкой на уровень выше; null — строка на верхнем уровне.
	 */
	function itemsOutdentSlot(items, pos) {
		if (!pos || pos.length < 2) {
			return null;
		}
		return { parent: pos.slice(0, -2), index: pos[pos.length - 2] + 1 };
	}

	/**
	 * «В папку (группу) выше» — последним в соседнюю папку (группу) прямо над строкой, на её уровне; null — над строкой
	 * на этом уровне не папка (не группа) или строка первая.
	 */
	function itemsIndentSlot(items, pos, container) {
		if (!pos || pos.length === 0 || pos[pos.length - 1] === 0) {
			return null;
		}
		const above = pos.slice(0, -1).concat([pos[pos.length - 1] - 1]);
		const owner = itemAtPos(items, above);
		if (!owner || typeof container !== 'function' || !container(owner)) {
			return null;
		}
		return { parent: above, index: Array.isArray(owner.items) ? owner.items.length : 0 };
	}

	// ---------- перетаскивание: обвязка событий ----------

	/*
	 * Перенос мышью — дополнение к кнопкам > >> < << ↑ ↓, двойному щелчку и клавишам (WCAG 2.5.7): сброс зовёт то же
	 * действие, что кнопка, поэтому проверки, заметки и возврат фокуса у них общие.
	 * Пока никто не тащит, перенос ничего не стоит: у строки только атрибут draggable (у самой строки или у её ручки) и,
	 * у списков без своего ключа в разметке, запись WeakMap от строки к ключу; слушателей у строк и списков нет — пять на
	 * документе (слушатель конца переноса у источника — только на время переноса), а зона — запись WeakMap от контейнера
	 * списка к описанию. Сводки строк по ключу (дерево структуры, «Доступные поля») собираются при первом обращении за
	 * перенос, не на каждой отрисовке.
	 * Во время переноса dragover делает closest() и сравнение зоны; место вставки и подсветка считаются раз в кадр
	 * (requestAnimationFrame) и меняют только классы. Нагрузка — данные (зона, окно, ключ строки, вид), не узлы DOM.
	 * Ответы расширения, пришедшие во время переноса, ждут его конца (whenIdle): перерисовка не уберёт строку из-под
	 * указателя, а сброс сработает по той модели, которую пользователь видел.
	 */

	/** Контейнер списка → описание зоны (dragZone). */
	const dragZones = new WeakMap();
	/**
	 * Идущий перенос: {payload: {zone, scope, key, kind}, source — описание зоны-источника, row, zones, node — узел, за
	 * который тащат (у него слушатель конца переноса — до finishDrag)} или null.
	 */
	let dragNow = null;
	/** То, что ждёт конца переноса: ответы расширения и отложенные перерисовки — по порядку прихода. */
	let dragHeld = [];
	/** Перерисовки окон, которые просили отложенные ответы, пока они отдаются (rerenderSoon): каждая — один раз. */
	let heldRenders = null;
	/** Последняя точка dragover для подсветки в кадре: {zoneEl, target, x, y} или null. */
	let dragPoint = null;
	let dragFrame = 0;
	/** Подсвеченное сейчас: зона под указателем, строка и её класс места. */
	let dragShown = { zone: null, row: null, mark: '' };
	/** Зона, которой показано место сброса её способом (preview: каретка в тексте выражения), или null. */
	let dragPreview = null;

	/**
	 * Зона переноса — контейнер списка (дерево, сетка, поле выражения), его строки — прямые дети. spec: {id, scope?,
	 * keyOf(row) → ключ строки | null, drag?(key, source) → вид строки-источника ('' — не тащится; source — узел, за
	 * который тащат), from?: {idЗоныИсточника: (payload, target) → void | false} — сброс (false — ничего не
	 * изменилось), accept?(payload), place? — 'line' | 'into' | 'both' | 'zone' или правило по переносу, effect? —
	 * 'move' | 'copy' или правило, target?(event, node) — своё место сброса (поле выражения: позиция в тексте),
	 * preview?(x, y) — показать это место раз в кадр (x = null — указатель ушёл, перенос кончился), pick?(key) — строка
	 * этой зоны стала текущей, как от щелчка: перенос кончился без сброса, сброс ничего не изменил или скопировал
	 * строку в другой список, rowOf?(node, контейнер) → строка под узлом и rows?(контейнер) → строки по порядку — у
	 * таблицы, где строки не прямые дети зоны (зона — колонка с панелью и таблицей, строки — tr в tbody, шапка — tr в
	 * thead), rowAccept?(payload, key) — примет ли строка под указателем (иначе — курсор «нельзя», без линии),
	 * markRow?(key, place) — строка, у которой рисовать линию места, если не у строки сброса (дерево структуры: «после»
	 * раскрытого узла — под его последним видимым потомком, там, куда узел и встанет), или null}.
	 * place может зависеть от ключа строки: place(payload, key). Зоны регистрируются на каждой отрисовке: новый
	 * контейнер — новая запись, прежний уходит из документа вместе со своей.
	 */
	function dragZone(node, spec) {
		node.setAttribute('data-dnd-zone', spec.id);
		dragZones.set(node, spec);
		return node;
	}

	/**
	 * Зона у таблицы (вкладки схемы и «Настройки»): контейнер host целиком — панель пиктограмм, шапка, строки и место под
	 * ними, у пустого списка — его плашка. Строка — tr, ключ — по spec.keys (WeakMap tr → ключ); у шапки ключа нет, и
	 * сброс на неё или выше, на панель (она — вне прокрутки списка), ставит первым: узел над таблицей считается шапкой,
	 * по порядку в документе, а не по высоте — у прокрученного списка первая строка уходит выше панели. spec: {id, scope,
	 * head — tr шапки или null, rows() — tr строк по порядку, keys, drag?, pick?, from?, accept?, place?, effect?} (смысл
	 * — у dragZone).
	 */
	function tableDropZone(host, spec) {
		// Шапка и строки — один массив на зону, собранный при первом обращении (в переносе): кадр подсветки его не копирует.
		// Зона живёт одну отрисовку, а перерисовки во время переноса отложены — массив не устаревает
		let all = null;
		return dragZone(host, {
			id: spec.id,
			scope: spec.scope,
			keyOf: (row) => (spec.keys && spec.keys.has(row) ? spec.keys.get(row) : null),
			rowOf: (node) => {
				for (let current = node; current && current !== host; current = current.parentElement) {
					if (current.tagName === 'TR') {
						return current;
					}
				}
				return spec.head && nodeAbove(node, spec.head) ? spec.head : null;
			},
			rows: () => all || (all = (spec.head ? [spec.head] : []).concat(spec.rows ? spec.rows() : [])),
			drag: spec.drag,
			pick: spec.pick,
			from: spec.from,
			accept: spec.accept,
			place: spec.place,
			effect: spec.effect,
		});
	}

	/**
	 * Лежит ли узел в документе раньше other и не содержит его (панель пиктограмм над таблицей — да, обёртка таблицы с
	 * местом под строками — нет): одно сравнение позиций, без обхода строк.
	 */
	function nodeAbove(node, other) {
		if (!node || !other || typeof other.compareDocumentPosition !== 'function') {
			return false;
		}
		// 2 — DOCUMENT_POSITION_PRECEDING (узел раньше), 8 — DOCUMENT_POSITION_CONTAINS (узел — предок)
		const position = other.compareDocumentPosition(node);
		return (position & 2) !== 0 && (position & 8) === 0;
	}

	/** Зона под узлом: ближайший контейнер с data-dnd-zone (closest — без обхода строк). */
	function zoneNodeOf(node) {
		const found = node && typeof node.closest === 'function' ? node.closest('[data-dnd-zone]') : null;
		return found && dragZones.has(found) ? found : null;
	}

	/**
	 * Строка зоны под узлом — прямой ребёнок контейнера (в строке бывают ячейки, списки и флажки), у таблицы — по её
	 * правилу zone.rowOf (подъём от узла до tr: обход предков, не строк).
	 */
	function dragRowOf(node, zoneEl, zone) {
		if (zone && typeof zone.rowOf === 'function') {
			return zone.rowOf(node, zoneEl) || null;
		}
		for (let current = node; current && current !== zoneEl; current = current.parentElement) {
			if (current.parentElement === zoneEl) {
				return current;
			}
		}
		return null;
	}

	function dragKeyOf(zone, row) {
		const key = row && typeof zone.keyOf === 'function' ? zone.keyOf(row) : null;
		return key === undefined || key === null ? null : String(key);
	}

	/** Узел на неактивном уровне (inert): переносить можно только внутри верхнего окна. */
	function insideInert(node) {
		for (let current = node; current; current = current.parentElement) {
			if (current.inert) {
				return true;
			}
		}
		return false;
	}

	/** Сделать сейчас или, если идёт перенос, после него: ответы расширения и перерисовки по таймеру. */
	function whenIdle(fn) {
		if (dragNow) {
			dragHeld.push(fn);
			return;
		}
		fn();
	}

	function rethrowLater(error) {
		// Ошибка одного ответа не теряет остальные: она всплывёт отдельной задачей
		setTimeout(() => {
			throw error;
		}, 0);
	}

	/**
	 * Перерисовка окна по ответу расширения: сразу, а пока отдаются ответы, отложенные переносом, — одна на всех в
	 * конце (ответы метаданных, таблиц и описаний, пришедшие за время переноса, иначе перерисовали бы окно каждый).
	 */
	function rerenderSoon(fn) {
		if (typeof fn !== 'function') {
			return;
		}
		if (heldRenders) {
			heldRenders.add(fn);
			return;
		}
		fn();
	}

	function releaseHeld() {
		const held = dragHeld;
		dragHeld = [];
		if (held.length === 0) {
			return;
		}
		// Ответы применяются по порядку, а перерисовка окна, которую они просят, — одна, после всех
		heldRenders = new Set();
		try {
			for (const fn of held) {
				try {
					fn();
				} catch (error) {
					rethrowLater(error);
				}
			}
		} finally {
			const renders = heldRenders;
			heldRenders = null;
			renders.forEach((fn) => {
				try {
					fn();
				} catch (error) {
					rethrowLater(error);
				}
			});
		}
	}

	/** Строки зоны по порядку: прямые дети контейнера, у таблицы — zone.rows (шапка и строки tbody). */
	function zoneRows(zone, zoneEl) {
		return (typeof zone.rows === 'function' ? zone.rows(zoneEl) : zoneEl.children) || [];
	}

	/** Последняя строка списка с ключом: сброс под строками встаёт за ней, и линия рисуется у неё снизу. */
	function lastDragRow(zone, zoneEl) {
		const children = zoneRows(zone, zoneEl);
		for (let index = children.length - 1; index >= 0; index--) {
			if (dragKeyOf(zone, children[index]) !== null) {
				return children[index];
			}
		}
		return null;
	}

	/**
	 * Первая строка списка с ключом и лежит ли узел без ключа (row — шапка сетки) над ней: сброс на шапку встаёт перед
	 * первой строкой, а не в конец. Обход — до первой строки с ключом, то есть шапка и пустая строка, не весь список.
	 */
	function firstDragRow(zone, zoneEl, row) {
		const children = zoneRows(zone, zoneEl);
		let above = false;
		for (let index = 0; index < children.length; index++) {
			if (dragKeyOf(zone, children[index]) !== null) {
				return { row: children[index], above: above };
			}
			if (children[index] === row) {
				above = true;
			}
		}
		return { row: null, above: false };
	}

	/**
	 * Место сброса по точке: {key, place, row, mark} — строка под указателем (над первой строкой — она, под строками —
	 * последняя) и класс подсветки. Чтение раскладки (getBoundingClientRect строки) — в кадре подсветки и в самом сбросе.
	 */
	function dropSpotOf(zone, zoneEl, node, clientY, payload) {
		let mode = dropMode(zone, payload, null);
		if (mode === 'zone') {
			return { key: null, place: 'end', row: null, mark: '' };
		}
		const row = dragRowOf(node, zoneEl, zone);
		const key = dragKeyOf(zone, row);
		// Строка, которая этот перенос не примет (узел структуры у другого родителя): места нет, сброс — отмена
		if (!dropRowAccepted(zone, payload, key)) {
			return { key: key, place: 'none', row: null, mark: '' };
		}
		if (key !== null) {
			mode = dropMode(zone, payload, key);
		}
		if (key === null) {
			if (mode !== 'line') {
				return { key: null, place: 'end', row: null, mark: '' };
			}
			// Шапка сетки и отступ над строками — «первым», а не «в конец»: туда целятся, когда хотят поставить в начало
			const first = firstDragRow(zone, zoneEl, row);
			if (first.row && first.above) {
				// Шапка (и панель над таблицей): линия — у её нижнего края. Закреплённая шапка видна и в прокрученном списке,
				// а первая строка тогда ушла вверх, за край, и место сброса не было бы видно
				return { key: dragKeyOf(zone, first.row), place: 'before', row: row, mark: 'dcs-dnd-after' };
			}
			if (first.row && clientY < first.row.getBoundingClientRect().top) {
				return { key: dragKeyOf(zone, first.row), place: 'before', row: first.row, mark: 'dcs-dnd-before' };
			}
			const last = lastDragRow(zone, zoneEl);
			return { key: null, place: 'end', row: last, mark: last ? 'dcs-dnd-after' : '' };
		}
		const rect = row.getBoundingClientRect();
		const place = dropPlace(clientY - rect.top, rect.height, mode);
		// Линия — там, куда встанет строка, если это не край строки сброса (раскрытый узел дерева структуры)
		const shown = typeof zone.markRow === 'function' ? zone.markRow(key, place) : null;
		return { key: key, place: place, row: shown || row, mark: 'dcs-dnd-' + place };
	}

	/** Подсветка без сдвига раскладки: класс зоны под указателем и класс места у строки, только при смене. */
	function showDrop(zoneEl, row, mark) {
		const shown = dragShown;
		if (shown.zone !== zoneEl) {
			if (shown.zone) {
				shown.zone.classList.remove('dcs-dnd-over');
			}
			if (zoneEl) {
				zoneEl.classList.add('dcs-dnd-over');
			}
		}
		if (shown.row !== row || shown.mark !== mark) {
			if (shown.row && shown.mark) {
				shown.row.classList.remove(shown.mark);
			}
			if (row && mark) {
				row.classList.add(mark);
			}
		}
		dragShown = { zone: zoneEl, row: row, mark: mark };
	}

	/** Место сброса своим способом (preview) — у зоны под указателем; ушёл указатель — прежней зоне preview(null). */
	function showPreview(zone, point) {
		const shown = dragPreview;
		const next = zone && point && typeof zone.preview === 'function' ? zone : null;
		dragPreview = next;
		try {
			if (shown && shown !== next) {
				shown.preview(null, null);
			}
			if (next) {
				next.preview(point.x, point.y);
			}
		} catch (error) {
			rethrowLater(error);
		}
	}

	function paintDrop() {
		dragFrame = 0;
		const drag = dragNow;
		const point = dragPoint;
		if (!drag || !point || !point.zoneEl.isConnected) {
			showDrop(null, null, '');
			showPreview(null, null);
			return;
		}
		const zone = dragZones.get(point.zoneEl);
		if (!zone || typeof zone.target === 'function') {
			// Поле выражения: место — позиция в тексте, его показывает сама зона (каретка), строк у неё нет
			showDrop(point.zoneEl, null, '');
			showPreview(zone, point);
			return;
		}
		showPreview(null, null);
		const spot = dropSpotOf(zone, point.zoneEl, point.target, point.y, drag.payload);
		// Строка перенос не примет: ни рамки «под указателем», ни линии — как вне зон
		showDrop(spot.place === 'none' ? null : point.zoneEl, spot.row, spot.mark);
	}

	/** Подсветка — раз в кадр: dragover приходит чаще, чем экран успевает её показать. */
	function schedulePaint() {
		if (dragFrame) {
			return;
		}
		if (typeof window.requestAnimationFrame === 'function') {
			dragFrame = window.requestAnimationFrame(paintDrop);
		} else {
			paintDrop();
		}
	}

	/**
	 * Строка-источник становится текущей, как от щелчка: нажатие кнопки мыши уже дало ей фокус, а click после переноса
	 * браузер не шлёт. Без этого фокус стоял бы на одной строке, а выбор — на другой: клавиши (Delete, Enter) работали
	 * бы с первой, кнопки (<, ↑ ↓) — со второй.
	 */
	function pickSource(drag) {
		const zone = drag ? drag.source : null;
		if (!zone || typeof zone.pick !== 'function') {
			return;
		}
		try {
			zone.pick(drag.payload.key);
		} catch (error) {
			rethrowLater(error);
		}
	}

	/**
	 * Конец переноса: подсветка и метки снимаются; keepHeld — отложенное отдаст сам сброс, после своего действия; pick —
	 * перенос кончился без сброса (отмена, Esc, сброс мимо зон), и строка-источник становится текущей (pickSource).
	 */
	function finishDrag(keepHeld, pick) {
		const drag = dragNow;
		dragNow = null;
		dragPoint = null;
		if (dragFrame && typeof window.cancelAnimationFrame === 'function') {
			window.cancelAnimationFrame(dragFrame);
		}
		dragFrame = 0;
		showDrop(null, null, '');
		showPreview(null, null);
		if (drag) {
			// Слушатель конца у источника — только на время переноса: после finishDrag dragend делать нечего
			if (drag.node) {
				drag.node.removeEventListener('dragend', onDragEnd);
			}
			document.removeEventListener('pointerdown', onDragLost, true);
			document.removeEventListener('mousemove', onDragLost, true);
			if (drag.row) {
				drag.row.classList.remove('dcs-dnd-source');
			}
			for (const node of drag.zones) {
				node.classList.remove('dcs-dnd-can');
			}
		}
		if (!keepHeld) {
			releaseHeld();
			if (pick) {
				pickSource(drag);
			}
		}
	}

	/**
	 * Перенос кончился, а dragend не пришёл (например, исключение посреди начала переноса): во время переноса браузер
	 * не шлёт событий мыши, поэтому нажатие кнопки или движение без нажатой кнопки значит, что он кончился. Без этого
	 * ответы расширения ждали бы вечно, а правка висела бы на «Сохраняем…». Слушатели — только на время переноса
	 * (снимает finishDrag); строку не выбирают: щелчок, который пришёл, выбирает свою.
	 */
	function onDragLost(event) {
		if (!dragNow || (event.type === 'mousemove' && event.buttons !== 0)) {
			return;
		}
		finishDrag(false, false);
	}

	function onDragStart(event) {
		const source = event.target;
		const zoneEl = zoneNodeOf(source);
		// Чужой перенос (выделенный текст поля ввода, ссылка) — не наш: его не трогаем
		if (!zoneEl || !source || source.draggable !== true) {
			return;
		}
		const zone = dragZones.get(zoneEl);
		const row = dragRowOf(source, zoneEl, zone);
		const key = dragKeyOf(zone, row);
		// Пока правка сохраняется, перенос не начинается: ответ saved перечитал бы модель под переносом
		const kind = key !== null && typeof zone.drag === 'function' && !editBusy() && !insideInert(zoneEl) ? zone.drag(key, source) : '';
		if (!kind || !event.dataTransfer) {
			event.preventDefault();
			return;
		}
		const payload = { zone: zone.id, scope: zone.scope, key: key, kind: String(kind) };
		dragNow = { payload: payload, source: zone, row: row, zones: [], node: source };
		// Конец переноса доходит до источника, даже если сброс перерисовал список и строка ушла из документа. Слушатели
		// конца — сразу: исключение ниже не должно оставить перенос «идущим»
		source.addEventListener('dragend', onDragEnd);
		document.addEventListener('pointerdown', onDragLost, true);
		document.addEventListener('mousemove', onDragLost, true);
		event.dataTransfer.effectAllowed = 'copyMove';
		event.dataTransfer.setData(DRAG_TYPE, zone.id);
		row.classList.add('dcs-dnd-source');
		// Куда можно бросить — видно сразу: принимающие зоны верхнего окна получают тонкую рамку (один обход за перенос)
		for (const node of Array.from(document.querySelectorAll('[data-dnd-zone]'))) {
			if (dropAccepted(dragZones.get(node), payload) && !insideInert(node)) {
				node.classList.add('dcs-dnd-can');
				dragNow.zones.push(node);
			}
		}
	}

	function onDragOver(event) {
		const drag = dragNow;
		const zoneEl = drag ? zoneNodeOf(event.target) : null;
		const zone = zoneEl ? dragZones.get(zoneEl) : null;
		// Правило по строке есть только у зон, которым оно нужно: подъём до строки — обход предков, не строк
		const accepted = Boolean(zone) && dropAccepted(zone, drag.payload);
		const refused = accepted && typeof zone.rowAccept === 'function' && !dropRowAccepted(zone, drag.payload, dragKeyOf(zone, dragRowOf(event.target, zoneEl, zone)));
		if (!accepted || refused) {
			// Вне своих зон сброса нет: оболочка VS Code отменила dragover на всём документе, и без 'none' курсор обещал
			// бы сброс где угодно. Чужой перенос (файл, текст) — тоже 'none'
			if (event.dataTransfer) {
				event.dataTransfer.dropEffect = 'none';
			}
			if (drag && (dragShown.zone || dragPreview)) {
				dragPoint = null;
				schedulePaint();
			}
			return;
		}
		event.preventDefault();
		if (event.dataTransfer) {
			event.dataTransfer.dropEffect = dropEffect(zone, drag.payload);
		}
		dragPoint = { zoneEl: zoneEl, target: event.target, x: event.clientX, y: event.clientY };
		schedulePaint();
	}

	function onDragLeave() {
		// Указатель ушёл с узла: если он ушёл совсем (за окно), следующего dragover не будет — подсветка снимается в кадре
		if (dragNow) {
			dragPoint = null;
			schedulePaint();
		}
	}

	function onDrop(event) {
		const drag = dragNow;
		if (!drag) {
			// Чужой сброс (файл, текст): оболочка VS Code уже отменила действие браузера, редактору он не нужен
			return;
		}
		event.preventDefault();
		const zoneEl = zoneNodeOf(event.target);
		const zone = zoneEl ? dragZones.get(zoneEl) : null;
		if (!zone || !hasDragType(event.dataTransfer && event.dataTransfer.types) || insideInert(zoneEl) || !dropAccepted(zone, drag.payload)) {
			finishDrag(false, true);
			return;
		}
		const spot = typeof zone.target === 'function' ? zone.target(event, zoneEl) : dropSpotOf(zone, zoneEl, event.target, event.clientY, drag.payload);
		const payload = drag.payload;
		// Строку бросили на неё саму (нажатие с дрожью руки сдвинуло мышь за порог переноса): это щелчок, а не правка.
		// Строка, которая перенос не примет, — как сброс мимо зон
		if ((zone === drag.source && spot.key === payload.key) || spot.place === 'none') {
			finishDrag(false, true);
			return;
		}
		finishDrag(true);
		// Скопированная в другой список строка становится текущей до действия, как от двойного щелчка: фокус после
		// действия остаётся его (поле выражения забирает фокус вставкой)
		const copied = zone !== drag.source && dropEffect(zone, payload) === 'copy';
		let changed = true;
		try {
			if (copied) {
				pickSource(drag);
			}
			// То же действие, что у кнопки: перерисовка сразу, отложенные ответы — после него, по новой модели
			changed = zone.from[payload.zone](payload, { key: spot.key, place: spot.place, offset: spot.offset }) !== false;
		} finally {
			releaseHeld();
		}
		// Сброс ничего не изменил (строка встала на своё же место): выбор — за строкой, как от щелчка
		if (!changed && !copied) {
			pickSource(drag);
		}
	}

	function onDragEnd() {
		if (dragNow) {
			finishDrag(false, true);
		}
	}

	document.addEventListener('dragstart', onDragStart);
	document.addEventListener('dragover', onDragOver);
	document.addEventListener('dragleave', onDragLeave);
	document.addEventListener('drop', onDrop);
	document.addEventListener('dragend', onDragEnd);

	// ---------- команды-пиктограммы над списками ----------

	const SVG_NS = 'http://www.w3.org/2000/svg';

	/**
	 * Свои простые пиктограммы 16×16 из линий, не рисунки 1С и не codicons. Цвет — currentColor, поэтому
	 * пиктограмма следует теме, в том числе контрастной. Фигура — [тег, атрибуты]. Обводка и заливка заданы в
	 * стилях (.dcs-icon): атрибута style в разметке нет, CSP окна его не пропустил бы.
	 */
	const COMMAND_ICONS = Object.freeze({
		add: [['path', { d: 'M8 3v10M3 8h10' }]],
		// Лист за листом и плюс: новая строка — копия выбранной
		'add-copy': [
			['path', { d: 'M5.5 4.5v-2h8v8h-2' }],
			['rect', { x: '2.5', y: '5.5', width: '8', height: '8', rx: '1' }],
			['path', { d: 'M6.5 7.5v4M4.5 9.5h4' }],
		],
		edit: [['path', { d: 'M2.5 13.5l.8-3.2L10.6 3a1.4 1.4 0 0 1 2 0l.4.4a1.4 1.4 0 0 1 0 2l-7.3 7.3zM9.5 4.1l2.4 2.4' }]],
		delete: [['path', { d: 'M4 4l8 8M12 4l-8 8' }]],
		// Поле с текстом и курсор ввода: правка имени, а не свойств (у «Изменить» — карандаш)
		rename: [
			['rect', { x: '1.5', y: '4.5', width: '9', height: '7', rx: '1' }],
			['path', { d: 'M4 8h4M13 3v10M11.5 3h3M11.5 13h3' }],
		],
		replace: [['path', { d: 'M2.5 5.5h10M10 3l2.5 2.5L10 8M13.5 10.5h-10M6 8l-2.5 2.5L6 13' }]],
		up: [['path', { d: 'M8 13V3.5M4 7.5l4-4 4 4' }]],
		down: [['path', { d: 'M8 3v9.5M4 8.5l4 4 4-4' }]],
		// Строки с отступом и стрелка: строка — на уровень выше (влево) и в папку или группу над ней (вправо)
		outdent: [['path', { d: 'M14 3.5H7M14 8H9M14 12.5H7M5.5 5.5L3 8l2.5 2.5M3 8h4' }]],
		indent: [['path', { d: 'M14 3.5H7M14 8H9M14 12.5H7M2 5.5L4.5 8 2 10.5M1.5 8h3' }]],
		// Скобки со строками внутри: запрос в запросе
		'nested-query': [['path', { d: 'M5 2.5c-2.2 2.5-2.2 8.5 0 11M11 2.5c2.2 2.5 2.2 8.5 0 11M6.5 6h3M6.5 8h3M6.5 10h3' }]],
		// Таблица и скобки за ней: Таблица(параметры)
		'table-params': [
			['rect', { x: '1.5', y: '3.5', width: '8', height: '9', rx: '1' }],
			['path', { d: 'M1.5 6.5h8M5.5 6.5v6M12 4.5c-1.2 1.6-1.2 5.4 0 7M13.8 4.5c1.2 1.6 1.2 5.4 0 7' }],
		],
		// Строка и под ней две строки с отступом: новая группировка — уровень структуры «Настроек»
		group: [['path', { d: 'M2 3.5h7M4 3.5v8M4 7.5h2.5M4 11.5h2.5M8.5 7.5h5M8.5 11.5h5' }]],
		// Сетка: новая таблица
		table: [
			['rect', { x: '1.5', y: '2.5', width: '13', height: '11', rx: '1' }],
			['path', { d: 'M1.5 6h13M1.5 9.5h13M6 2.5v11' }],
		],
		// Столбики на оси: новая диаграмма
		chart: [['path', { d: 'M2 13.5h12M4.5 12V8M8 12V4M11.5 12V6.5' }]],
		// Палочка и искры: конструктор настроек по шагам
		wizard: [['path', { d: 'M2.5 13.5l7.5-7.5M11.5 1.5v3M10 3h3M13.5 6.5v2M12.5 7.5h2M5.5 2.5v2M4.5 3.5h2' }]],
		// Папка: папка выбранных полей и группа условий отбора
		folder: [['path', { d: 'M1.5 4v8.5h13V6H8L6.5 4z' }]],
		// Угловые скобки вокруг точки — как запись «<Авто>»
		auto: [
			['path', { d: 'M5 4.5L1.5 8 5 11.5M11 4.5L14.5 8 11 11.5' }],
			['circle', { cx: '8', cy: '8', r: '1.2' }],
		],
	});

	/** Пиктограмма команды: svg 16×16, скрытый от читалки (имя у кнопки). */
	function commandIcon(name) {
		const shapes = COMMAND_ICONS[name];
		if (!shapes) {
			throw new Error('нет пиктограммы «' + name + '»');
		}
		const svg = document.createElementNS(SVG_NS, 'svg');
		svg.setAttribute('class', 'dcs-icon');
		svg.setAttribute('viewBox', '0 0 16 16');
		svg.setAttribute('width', '16');
		svg.setAttribute('height', '16');
		svg.setAttribute('aria-hidden', 'true');
		svg.setAttribute('focusable', 'false');
		for (const shape of shapes) {
			const node = document.createElementNS(SVG_NS, shape[0]);
			for (const key of Object.keys(shape[1])) {
				node.setAttribute(key, shape[1][key]);
			}
			svg.appendChild(node);
		}
		return svg;
	}

	/**
	 * Кнопка-пиктограмма команды над списком, как у конфигуратора. spec:
	 * - icon — имя из COMMAND_ICONS; name — короткое название команды: оно и подсказка (title), и доступное
	 *   имя (aria-label), потому что видимой подписи у кнопки нет;
	 * - shortcut — клавиша, которой та же команда вызывается из списка (F2, Delete): в подсказке — после
	 *   названия в скобках. В доступное имя и aria-keyshortcuts она не идёт: клавиша работает в списке, а не
	 *   на самой кнопке. Без note описание для читалки — короткое «В списке — клавиша Delete» (shortcutSpoken):
	 *   иначе описанием стала бы подсказка целиком, и читалка повторила бы имя кнопки вместе с клавишей;
	 * - note — пояснение или причина недоступности: вторая строка подсказки и описание для читалки
	 *   (aria-description); spoken — своё, короче, описание для читалки вместо note;
	 * - unavailable — недоступна, но остаётся в обходе Tab (aria-disabled); щелчок и Enter доходят до onClick,
	 *   и тот решает сам — например, говорит, почему недоступна;
	 * - disabled — настоящий disabled: кнопка выпадает из обхода Tab;
	 * - className — классы кнопки; по умолчанию — классы кнопки панели ghost-btn и dcs-btn-small
	 */
	function iconButton(spec) {
		const node = el('button', (spec.className || 'ghost-btn dcs-btn-small') + ' dcs-icon-btn');
		node.type = 'button';
		node.appendChild(commandIcon(spec.icon));
		node.setAttribute('aria-label', spec.name);
		const head = spec.shortcut ? spec.name + ' (' + spec.shortcut + ')' : spec.name;
		node.title = spec.note ? head + '\n' + spec.note : head;
		const spoken = spec.spoken || spokenReason(spec.note, spec.unavailable) || shortcutSpoken(spec.shortcut);
		if (spoken) {
			node.setAttribute('aria-description', spoken);
		}
		if (spec.disabled) {
			node.disabled = true;
		}
		if (spec.unavailable) {
			node.setAttribute('aria-disabled', 'true');
		}
		node.addEventListener('click', spec.onClick);
		return node;
	}

	/**
	 * Описание для читалки у кнопки с клавишей списка и без пояснения: короткое, без имени кнопки. Без него описанием
	 * стал бы title («Удалить (Delete)»), и читалка сказала бы «Удалить, кнопка, Удалить (Delete)».
	 */
	function shortcutSpoken(shortcut) {
		return shortcut ? 'В списке — клавиша ' + shortcut : '';
	}

	/**
	 * Причина для читалки у недоступной кнопки: aria-disabled читалка сама называет «недоступно», поэтому начало причины
	 * «Недоступно: …» в описании не повторяется («…, кнопка, недоступно, строка уже первая»). Подсказка (title) для глаза —
	 * полная. У доступной кнопки пояснение — как есть.
	 */
	function spokenReason(note, unavailable) {
		const text = String(note || '');
		if (!unavailable) {
			return text;
		}
		const rest = text.replace(/^Недоступно[:,]?\s*/u, '');
		return rest.charAt(0).toUpperCase() + rest.slice(1);
	}

	/**
	 * Доступность и подсказка кнопки-пиктограммы без перерисовки — выбор строки списка «Настроек» меняет, можно ли
	 * двигать и удалять. Правила те же, что у iconButton: название и клавиша — в подсказке, причина — второй строкой
	 * и описанием для читалки, недоступная остаётся в обходе Tab (aria-disabled).
	 */
	function setIconState(node, name, shortcut, unavailable, note) {
		const head = shortcut ? name + ' (' + shortcut + ')' : name;
		node.title = note ? head + '\n' + note : head;
		const spoken = spokenReason(note, unavailable) || shortcutSpoken(shortcut);
		if (spoken) {
			node.setAttribute('aria-description', spoken);
		} else {
			node.removeAttribute('aria-description');
		}
		if (unavailable) {
			node.setAttribute('aria-disabled', 'true');
		} else {
			node.removeAttribute('aria-disabled');
		}
	}

	/**
	 * Панель пиктограмм над списком вкладки схемы: кнопки — описания для iconButton. У каждой ключ (закладка и название
	 * или spec.key): фокус на ней переживает перерисовку вкладки по ответу правки.
	 */
	function listToolbar(host, buttons) {
		const bar = el('div', 'dcs-list-toolbar');
		for (const spec of buttons) {
			bar.appendChild(keyed(iconButton(spec), spec.key || focusKey(['tool', activeTabId, spec.name])));
		}
		host.appendChild(bar);
		return bar;
	}

	/** Клавиши, которыми закрытый список листает значения (и тут же шлёт change в Chromium под Windows). */
	const SELECT_BROWSE_KEYS = ['ArrowDown', 'ArrowUp', 'Home', 'End', 'PageDown', 'PageUp'];

	/**
	 * Список-действие («+ Добавить параметр»): выбор имени сразу добавляет строку или открывает окно. В Chromium под
	 * Windows стрелки и буквы на закрытом списке меняют значение и сразу шлют change: листая имена с клавиатуры,
	 * пользователь получил бы действие для первого же. Поэтому change, пришедший от такой клавиши (в той же задаче, что и
	 * keydown), только выбирает имя, а действует Enter. Выбор мышью и в раскрытом списке (Alt+↓, F4, пробел) — сразу:
	 * раскрытый список ведёт клавиатуру сам, keydown до списка не доходит. onPick(value) получает непустое значение,
	 * список возвращается к первой строке-подсказке.
	 */
	function actionSelect(select, onPick) {
		let fromKey = false;
		const take = () => {
			const value = select.value;
			select.value = '';
			if (value) {
				onPick(value);
			}
		};
		select.addEventListener('keydown', (event) => {
			if (event.key === 'Enter') {
				if (select.value) {
					event.preventDefault();
					take();
				}
				return;
			}
			const printable = typeof event.key === 'string' && event.key.length === 1 && event.key !== ' ';
			if (!event.altKey && (SELECT_BROWSE_KEYS.indexOf(event.key) >= 0 || printable)) {
				// change от этой клавиши придёт в этой же задаче — до таймера
				fromKey = true;
				setTimeout(() => {
					fromKey = false;
				}, 0);
			}
		});
		select.addEventListener('change', () => {
			if (!fromKey) {
				take();
			}
		});
		// Имя, выбранное стрелками, не мешает выбору мышью (то же имя иначе не дало бы change) и не остаётся после ухода
		select.addEventListener('mousedown', () => {
			select.value = '';
		});
		select.addEventListener('blur', () => {
			select.value = '';
		});
	}

	/**
	 * Список значения, который пишет файл (значение параметра вывода в «Других настройках»): commit — по выбору мышью, Enter
	 * или уходу из списка, revert — по Esc. Стрелки, Home, End и буквы на закрытом списке в Chromium на Windows сразу дают
	 * change: так значения только листаются, как у actionSelect, — иначе первая же стрелка писала бы файл, а ответ
	 * перерисовывал панель под пользователем.
	 */
	function browseSelect(select, commit, revert) {
		let fromKey = false;
		let browsed = false;
		const finish = () => {
			if (browsed) {
				browsed = false;
				commit();
			}
		};
		select.addEventListener('keydown', (event) => {
			if (event.key === 'Enter') {
				if (browsed) {
					event.preventDefault();
					finish();
				}
				return;
			}
			if (event.key === 'Escape' && browsed) {
				event.preventDefault();
				browsed = false;
				revert();
				return;
			}
			const printable = typeof event.key === 'string' && event.key.length === 1 && event.key !== ' ';
			if (!event.altKey && (SELECT_BROWSE_KEYS.indexOf(event.key) >= 0 || printable)) {
				// change от этой клавиши придёт в этой же задаче — до таймера
				fromKey = true;
				setTimeout(() => {
					fromKey = false;
				}, 0);
			}
		});
		select.addEventListener('change', () => {
			if (fromKey) {
				browsed = true;
				return;
			}
			browsed = false;
			commit();
		});
		// Уход из списка заканчивает выбор; список, который убирает перерисовка, — нет
		select.addEventListener('blur', () => {
			if (!renderingContent && select.isConnected) {
				finish();
			}
		});
	}

	// ---------- подсветка запроса и выражений ----------

	/** Токенайзер подсветки (dcs-editor-highlight.js). */
	const highlighter = window.DcsHighlight;

	/** Пауза перерисовки после ввода: печать не должна ждать токенайзер на каждом символе. */
	const HIGHLIGHT_DEBOUNCE_MS = 120;

	/** Наполняет зеркало-pre токенами текста; спаны только у распознанных токенов. */
	function renderHighlight(pre, text) {
		pre.textContent = '';
		for (const token of highlighter.tokenize(text)) {
			if (token.type === 'text') {
				pre.appendChild(document.createTextNode(token.value));
			} else {
				const span = document.createElement('span');
				span.className = 'dcs-tok-' + token.type;
				span.textContent = token.value;
				pre.appendChild(span);
			}
		}
		// Хвостовой перевод строки pre схлопывает — добавка выравнивает высоту с textarea
		pre.appendChild(document.createTextNode('\n'));
	}

	/**
	 * Редактор кода с подсветкой: зеркало-pre за прозрачной textarea, скролл синхронный.
	 * Возвращает {box, input, flush}; на текстах больше лимита textarea остаётся обычной —
	 * редактирование важнее подсветки. flush() перерисовывает зеркало сразу, без паузы:
	 * подсказка меряет по нему каретку, а отстающее на 120 мс зеркало соврало бы.
	 */
	function codeEditor(value, className) {
		const input = el('textarea', className || 'dcs-expr');
		input.value = value || '';
		input.spellcheck = false;
		const wrap = el('div', 'dcs-hl-wrap');
		const box = el('div', 'dcs-hl-box');
		box.appendChild(wrap);
		const pre = el('pre', 'dcs-hl-pre');
		// Зеркало дублирует текст textarea: читалкам хватает самой textarea
		pre.setAttribute('aria-hidden', 'true');
		wrap.appendChild(pre);
		wrap.appendChild(input);
		const warn = el('div', 'dcs-hl-warn');
		box.appendChild(warn);
		let timer = 0;
		function syncScroll() {
			pre.scrollTop = input.scrollTop;
			pre.scrollLeft = input.scrollLeft;
		}
		function repaint() {
			timer = 0;
			const text = input.value;
			if (text.length > highlighter.HIGHLIGHT_LIMIT) {
				// Большой текст: зеркало дороже пользы, редактор остаётся простым
				wrap.classList.add('dcs-hl-off');
				pre.textContent = '';
				warn.textContent = '';
				return;
			}
			wrap.classList.remove('dcs-hl-off');
			renderHighlight(pre, text);
			warn.textContent = highlighter.delimiterWarning(text);
			syncScroll();
		}
		input.addEventListener('input', () => {
			if (timer) {
				clearTimeout(timer);
			}
			timer = setTimeout(repaint, HIGHLIGHT_DEBOUNCE_MS);
		});
		input.addEventListener('scroll', syncScroll);
		// Ctrl+/ — только у текста запроса (набор и окно «Запрос…»): у выражений СКД своё поле, и
		// строчный комментарий в одной строке выражения скорее сломал бы его, чем помог
		if (input.classList.contains('dcs-query')) {
			input.addEventListener('keydown', (event) => onCommentToggleKey(input, event));
		}
		repaint();
		function flush() {
			if (timer) {
				clearTimeout(timer);
				repaint();
				return;
			}
			// Значение могли записать без события input: зеркало догоняет текст, иначе метка встанет мимо
			if (!wrap.classList.contains('dcs-hl-off') && pre.textContent !== input.value + '\n') {
				repaint();
				return;
			}
			syncScroll();
		}
		codeEditorParts.set(input, { box: box, wrap: wrap, pre: pre, flush: flush });
		return { box: box, input: input, flush: flush };
	}

	/**
	 * Сочетание переключения комментариев: Ctrl+/ (Cmd+/ на mac). Клавиша сверяется и по символу, и по
	 * физической клавише: в русской раскладке на месте «/» стоит «.», а в немецкой «/» набирается с Shift.
	 */
	function isCommentToggleKey(event) {
		if (!(event.ctrlKey || event.metaKey) || event.altKey) {
			return false;
		}
		return event.key === '/' || (event.code === 'Slash' && !event.shiftKey);
	}

	/** Ctrl+/ в тексте запроса: строки выделения закомментировать или раскомментировать (DcsHighlight.toggleLineComments). */
	function onCommentToggleKey(input, event) {
		if (event.defaultPrevented || event.isComposing || !isCommentToggleKey(event)) {
			return;
		}
		event.preventDefault();
		// Текст набора внутри объединения только для чтения: правит его конструктор
		if (input.readOnly || input.disabled) {
			return;
		}
		const result = highlighter.toggleLineComments(input.value, input.selectionStart, input.selectionEnd);
		if (result.text === input.value) {
			return;
		}
		// Список подсказки стоял у прежней каретки: после правки строк он врал бы
		closeCompletionWithin(input);
		applyingCompletion = true;
		try {
			writeEditorText(input, result.replaceStart, result.replaceEnd, result.text, result.selStart, result.selEnd);
		} finally {
			applyingCompletion = false;
		}
	}

	/**
	 * Пишет правку отрезка [start, end) поля так, чтобы поле стало nextText, и ставит выделение.
	 * execCommand оставляет правку в истории поля (Ctrl+Z отменяет именно её, а не весь набранный
	 * текст) и сам шлёт input; там, где его нет или он не сработал, — прямая запись значения и input,
	 * чтобы подсветка и обработчики формы узнали о новом тексте так же, как о наборе.
	 */
	function writeEditorText(input, start, end, nextText, selStart, selEnd) {
		const tail = input.value.length - end;
		const inserted = nextText.slice(start, nextText.length - tail);
		if (typeof input.setSelectionRange === 'function') {
			input.setSelectionRange(start, end);
		}
		// Пустая правка пустого отрезка: delete по свёрнутой каретке стёр бы символ слева
		let done = start === end && inserted === '' && input.value === nextText;
		if (!done && typeof document.execCommand === 'function') {
			try {
				// Пустая вставка — удаление выделения: insertText с пустой строкой браузеры исполняют по-разному
				done = document.execCommand(inserted === '' ? 'delete' : 'insertText', false, inserted) && input.value === nextText;
			} catch (error) {
				done = false;
			}
		}
		if (!done) {
			input.value = nextText;
			input.dispatchEvent(new Event('input', { bubbles: true }));
		}
		if (typeof input.setSelectionRange === 'function') {
			input.setSelectionRange(selStart, selEnd);
		}
	}

	/**
	 * Поле выражения в диалоге: компактный редактор с подсветкой вместо однострочного input.
	 * scopeFn — место ввода для подсказки (attachCompletion); без него поле без подсказки.
	 */
	function expressionInput(host, labelText, value, scopeFn) {
		const editor = codeEditor(value, 'dcs-expr');
		formRow(host, labelText, editor.box);
		if (scopeFn) {
			attachCompletion(editor.input, scopeFn);
		}
		return editor.input;
	}

	// ---------- подсказка путей полей, параметров и функций ----------

	/** Чистая часть подсказки (dcs-editor-complete.js). */
	const completer = window.DcsComplete;

	/**
	 * Части редакторов кода по их textarea: подсказке нужны зеркало подсветки и flush, а наружу
	 * expressionInput отдаёт только саму textarea.
	 */
	const codeEditorParts = new WeakMap();

	/** Каталоги мест ввода: строятся при открытии списка и живут, пока не сменились модель или настройки варианта. */
	const completeCatalogs = new Map();

	/**
	 * Открытый список: привязка поля, каталог, контекст каретки, ранжированные строки, активная
	 * строка (индекс по всему списку) и начало нарисованного окна. null — список закрыт.
	 */
	let completeSession = null;

	/** Вставка выбранной строки сама порождает input: его разбор снова открыл бы только что закрытый список. */
	let applyingCompletion = false;

	/** Escape стека диалогов (escapeAction) закрывает сначала список, а не окно с недописанным выражением. */
	const completePopupHook = {
		isOpen: () => completeSession !== null,
		close: () => closeCompletion(),
	};

	/**
	 * Метрики textarea, которые нужны клону для замера каретки без зеркала (подсветка выключена):
	 * шрифт, отступы, рамка и правила переноса определяют, где окажется метка.
	 */
	const CARET_CLONE_STYLES = [
		'boxSizing',
		'width',
		'height',
		'paddingTop',
		'paddingRight',
		'paddingBottom',
		'paddingLeft',
		'borderTopWidth',
		'borderRightWidth',
		'borderBottomWidth',
		'borderLeftWidth',
		'borderStyle',
		'fontFamily',
		'fontSize',
		'fontWeight',
		'fontStyle',
		'lineHeight',
		'letterSpacing',
		'tabSize',
		'whiteSpace',
		'wordWrap',
		'overflowWrap',
		'textIndent',
	];

	/** Клавиши, которыми ходят по открытому списку (решение — nextActive модуля). */
	const COMPLETE_NAV_KEYS = ['ArrowDown', 'ArrowUp', 'PageDown', 'PageUp', 'Home', 'End'];

	/**
	 * Один список на документ: второй список рядом с первым читалка приняла бы за другой виджет.
	 * Живёт он с position: fixed — без окна на body, а при открытии из окна стека переезжает в верхний
	 * .dcs-dialog (placeCompletionHost): за пределами aria-modal Chromium под VoiceOver вырезает его из
	 * дерева доступности. Обрезки overflow окна fixed не боится, пока у предков окна нет transform,
	 * filter и contain — они сделали бы предка точкой отсчёта fixed (у .dcs-dialog-backdrop и
	 * .dcs-dialog их нет).
	 */
	const completeList = createCompleteList();
	/** Скрытая строка для читалки: «Вариантов: N» при открытии и перефильтровке. */
	const completeStatus = createCompleteStatus();

	function createCompleteList() {
		const listEl = el('div', 'dcs-complete hidden');
		listEl.id = 'dcsComplete';
		listEl.setAttribute('role', 'listbox');
		listEl.setAttribute('aria-label', 'Подсказка');
		// Выше любого уровня стека: окна поверх окон не должны закрывать список своего поля
		listEl.style.zIndex = String(dialogRules.POPUP_Z_INDEX);
		// Фокус остаётся в поле: иначе blur закрыл бы список раньше, чем щелчок по строке её вставит
		listEl.addEventListener('mousedown', (event) => {
			event.preventDefault();
		});
		document.body.appendChild(listEl);
		return listEl;
	}

	function createCompleteStatus() {
		const status = el('div', 'dcs-complete-status');
		status.id = 'dcsCompleteStatus';
		status.setAttribute('aria-live', 'polite');
		document.body.appendChild(status);
		return status;
	}

	function announceCompletion(text) {
		completeStatus.textContent = text;
	}

	/**
	 * Список и строка состояния — внутри верхнего окна стека, без окон — на body:
	 * aria-modal прячет от читалки всё вне окна, а список с полем должны читаться вместе. z-index
	 * списка (POPUP_Z_INDEX) и position: fixed при переезде не меняются.
	 */
	function placeCompletionHost() {
		const top = dialogStack.top();
		const host = top ? top.shell.box : document.body;
		if (completeList.parentNode !== host) {
			host.appendChild(completeList);
		}
		if (completeStatus.parentNode !== host) {
			host.appendChild(completeStatus);
		}
	}

	/** Уровень закрывается: список и строка уходят из его окна назад на body, а не вместе с окном из документа. */
	function releaseCompletionHost(box) {
		if (box.contains(completeList)) {
			document.body.appendChild(completeList);
		}
		if (box.contains(completeStatus)) {
			document.body.appendChild(completeStatus);
		}
	}

	/** Каталог места ввода; у разделов настроек — с пользовательскими полями активного варианта. */
	function completionCatalog(scope) {
		const key = String(scope || '');
		const settingsDto = key.indexOf('settings:') === 0 ? variantCache[activeVariantName()] || null : null;
		const cached = completeCatalogs.get(key);
		// Подписи типов зависят и от словаря (имена видов ссылок): пришёл словарь — каталог пересобирается
		if (cached && cached.model === model && cached.settings === settingsDto && cached.dictionary === typeDictionary) {
			return cached.catalog;
		}
		const catalog = completer.buildCatalog(model, settingsDto, key, completionTypeOptions());
		completeCatalogs.set(key, { model: model, settings: settingsDto, dictionary: typeDictionary, catalog: catalog });
		return catalog;
	}

	/**
	 * Подпись типа в строке подсказки — то же русское представление, что в колонке «Тип»: XML-имена
	 * md-sparrow (string, CatalogRef.Х) в UI не показываются.
	 */
	function completionTypeOptions() {
		return { typeText: (valueType) => typeLabelOf(valueType, '') };
	}

	function caretOf(input) {
		return typeof input.selectionStart === 'number' ? input.selectionStart : input.value.length;
	}

	function caretContext(input) {
		return completer.contextAt(input.value, caretOf(input));
	}

	// ---------- уровень «через точку» по типу ----------

	/** Дети по типу и вывод типов полей наборов-запросов (dcs-editor-field-types.js). */
	const fieldTypes = window.DcsFieldTypes;
	/** Разбор запроса для вывода типов (dcs-editor-query-model.js). */
	const queryModelApi = window.DcsQueryModel;
	/** Операции конструктора запроса над моделью (dcs-editor-query-edit.js). */
	const queryEditApi = window.DcsQueryEdit;

	/**
	 * Составы определяемых типов и характеристик (typeCompositions ответа md-sparrow) — к объектам
	 * типов ответа, один раз при приёме: дальше чистые функции читают type.compositions и раскрывают
	 * такие поля через точку и в связях. Зовётся в каждой точке, где приходит модель cf-dcs-info или
	 * описание cf-md-query-tables (начальная модель, ответ saved, queryTables, describeType); новую
	 * точку приёма надо подключить так же — это сверяет node-тест по тексту скрипта. Объявление
	 * функцией, а не через fieldTypes: начальная модель разбирается в первой строке скрипта.
	 */
	function withTypeCompositions(answer) {
		return window.DcsFieldTypes.attachTypeCompositions(answer);
	}

	/**
	 * Описания объектов конфигурации (cf-md-query-tables) по ключу объекта на время вкладки:
	 * правки схемы метаданные конфигурации не меняют, а каждое чтение — запуск jar. Состояния:
	 * loading — запрос ушёл, ready — описание есть, none — описания нет (не найден, ошибка).
	 */
	const describeCache = new Map();
	/**
	 * Отметка кэша описаний: растёт на каждый ответ, который кладёт в него готовое описание или «нет».
	 * По ней таблица констант конструктора (constantsQueryTable) знает, что типы её полей пора собрать заново.
	 */
	let describeStamp = 0;
	/** Макет вне выгрузки конфигурации: описывать нечего, запросы описаний не шлются. */
	let describeOutside = false;
	/**
	 * Список, который не открылся только потому, что описаний ещё нет: по ответу он открывается
	 * у того же поля и пути, если фокус и каретка остались там.
	 */
	let describeWaiting = null;
	/** Последний подсчёт детей по типу ждал описаний: так openCompletion отличает «ждём» от «пусто». */
	let describeWaited = false;
	/**
	 * Перерисовка доступных полей открытого конструктора настроек по ответу описания: его поля
	 * раскрываются реквизитами по типу. Ставит и снимает openSettingsWizard.
	 */
	let wizardRerender = null;
	/** Разборы текстов запросов наборов: текст меняется только правкой, а вывод зовётся на каждое нажатие. */
	const parsedQueries = new Map();
	const PARSED_QUERIES_LIMIT = 200;

	function parseQueryCached(text) {
		let parsed = parsedQueries.get(text);
		if (!parsed) {
			if (parsedQueries.size >= PARSED_QUERIES_LIMIT) {
				parsedQueries.clear();
			}
			parsed = queryModelApi.parse(text);
			parsedQueries.set(text, parsed);
		}
		return parsed;
	}

	/** Описание из кэша для модуля: undefined — ещё не загружено, null — описания нет. */
	function describeLookup(key) {
		if (describeOutside) {
			return null;
		}
		const entry = describeCache.get(key);
		if (!entry || entry.state === 'loading') {
			return undefined;
		}
		return entry.state === 'ready' ? entry.description : null;
	}

	function requestDescriptions(pending) {
		for (const item of pending) {
			if (describeOutside || describeCache.has(item.key)) {
				continue;
			}
			describeCache.set(item.key, { state: 'loading' });
			post('dcs/describe-type', item.request);
		}
	}

	/**
	 * Окружение extraChildrenFor: модель схемы, место ввода, кэш описаний и подпись типа. Одно на
	 * подсказку «через точку» и доступные поля конструктора настроек: реквизиты по типу у них
	 * должны совпадать строка в строку.
	 */
	function typeChildrenEnv(scope, ownTypes) {
		return {
			// Свой каталог с типами (окно выражения конструктора запроса): тип по полям схемы
			// не выводится, иначе алиас источника совпал бы с тёзкой-полем набора
			model: ownTypes ? {} : model,
			scope: scope,
			lookup: describeLookup,
			queryModel: queryModelApi,
			parse: parseQueryCached,
			typeText: (valueType) => typeLabelOf(valueType, ''),
		};
	}

	/**
	 * Точка расширения подсказки для поля ввода: дети по типу узла каталога (записанному или
	 * выведенному по запросу набора), недостающие описания — запросом панели.
	 */
	function typeChildrenProvider(binding) {
		return (owner, parentPath, info) => {
			const result = fieldTypes.extraChildrenFor(info, parentPath, typeChildrenEnv(binding.scopeFn(), binding.ownTypes));
			if (result.pending.length > 0) {
				describeWaited = true;
				requestDescriptions(result.pending);
			}
			return result.children;
		};
	}

	/**
	 * Пришло описание: открытый список пересчитывается на месте (активная строка остаётся, если
	 * она есть и после пересчёта), а не открывшийся из-за ожидания — открывается, если пользователь
	 * всё ещё стоит после той же точки.
	 */
	function onDescribed() {
		// Открытый конструктор настроек раскрывает поля по тем же описаниям: его реквизиты и
		// «Загрузка реквизитов…» пересчитываются до подсказки, у которой ниже ранние выходы
		rerenderSoon(wizardRerender);
		const session = completeSession;
		if (session) {
			// Верхний уровень детей по типу не берёт: его пересчёт только сбросил бы окно строк
			if (!session.ctx.parentPath) {
				return;
			}
			const active = session.ranked[session.active] ? session.ranked[session.active].item : null;
			openCompletion(session.binding, session.how, caretContext(session.input));
			const next = completeSession;
			if (next && active) {
				const index = next.ranked.findIndex((entry) => entry.item.path === active.path);
				if (index > 0) {
					moveCompletion(index);
				}
			}
			return;
		}
		const waiting = describeWaiting;
		describeWaiting = null;
		if (!waiting || !waiting.binding.input.isConnected || document.activeElement !== waiting.binding.input) {
			return;
		}
		const ctx = caretContext(waiting.binding.input);
		if (ctx.mode === waiting.mode && ctx.parentPath === waiting.parentPath) {
			openCompletion(waiting.binding, waiting.how, ctx);
		}
	}

	/**
	 * Подсказка у поля ввода: textarea редактора кода (codeEditor) или однострочное поле пути.
	 *
	 * scopeFn() → место ввода каталога (expr-calc, settings:filter, link-source:<набор>… — см.
	 * buildCatalog модуля); зовётся при каждом открытии, поэтому подсказка связи следует за
	 * набором, выбранным в форме. options: letters:false — буква не открывает список, только «&»,
	 * Ctrl+Пробел и «⋯» (текст запроса); extraChildren — свои дети по типу для уровня «через
	 * точку» (по умолчанию — по типу узла и описаниям объектов, typeChildrenProvider); more:false —
	 * без кнопки «⋯»; catalog — свой каталог места ввода (функция) вместо каталога по scope:
	 * конструктор настроек подаёт каталог своего шага, у нового варианта — без пользовательских
	 * полей текущего; ownTypes:true — дети по типу только по типам узлов своего каталога, без
	 * вывода по полям схемы (окно выражения конструктора запроса). drop: {title, label, empty, list,
	 * keys} — поле со списком (значения параметров виртуальной таблицы): вместо «⋯»
	 * кнопка «▾» (подсказка title, имя label, aria-expanded; повторное нажатие закрывает список), она
	 * и Alt+↓ открывают весь верхний уровень каталога (имя списка — list), а выбор заменяет всё
	 * значение поля, как выбор в списке поля конфигуратора; Alt+↑ закрывает список. Поле получает
	 * aria-keyshortcuts и описание keys для читалки. Ctrl+Пробел и набор при этом подсказывают у
	 * каретки — так в выражение вставляется параметр. Пустой список открывается со строкой empty, а
	 * не молчит.
	 */
	function attachCompletion(input, scopeFn, options) {
		if (!input || typeof scopeFn !== 'function') {
			return null;
		}
		const opts = options || {};
		const binding = {
			input: input,
			scopeFn: scopeFn,
			catalogFn: typeof opts.catalog === 'function' ? opts.catalog : null,
			ownTypes: opts.ownTypes === true,
			editor: codeEditorParts.get(input) || null,
			letters: opts.letters !== false,
			drop: opts.drop && typeof opts.drop === 'object' ? opts.drop : null,
			extraChildren: null,
			more: null,
		};
		binding.extraChildren = typeof opts.extraChildren === 'function' ? opts.extraChildren : typeChildrenProvider(binding);
		input.setAttribute('aria-autocomplete', 'list');
		input.setAttribute('aria-controls', completeList.id);
		input.setAttribute('aria-expanded', 'false');
		if (input.tagName !== 'TEXTAREA') {
			// Многострочному полю роль combobox не ставим: читалка потеряла бы у него ход по строкам
			input.setAttribute('role', 'combobox');
		}
		if (binding.drop) {
			// Роли combobox у редактора кода нет: что Alt+↓ раскрывает список, читалка узнаёт из описания поля
			input.setAttribute('aria-keyshortcuts', 'Alt+ArrowDown');
			if (binding.drop.keys) {
				const own = input.getAttribute('aria-description');
				input.setAttribute('aria-description', own ? own + ' ' + binding.drop.keys : binding.drop.keys);
			}
		}
		input.addEventListener('keydown', (event) => {
			onCompleteKeydown(binding, event);
		});
		input.addEventListener('input', (event) => {
			onCompleteInput(binding, event);
		});
		input.addEventListener('blur', () => {
			if (completeSession && completeSession.binding === binding) {
				closeCompletion();
			}
		});
		// Каретку сдвинули мышью или стрелкой вбок: список следует за словом или закрывается
		input.addEventListener('click', () => {
			syncCompletionCaret(binding);
		});
		input.addEventListener('keyup', (event) => {
			if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
				syncCompletionCaret(binding);
			}
		});
		if (opts.more !== false) {
			binding.more = addCompleteButton(binding);
		}
		return binding;
	}

	/**
	 * Кнопка «⋯» — тот же список для мыши и читалки, заодно обход Ctrl+Пробел, если сочетание занято
	 * раскладкой. У редактора кода она справа от поля, у однострочного — следующей за ним.
	 */
	function addCompleteButton(binding) {
		const drop = binding.drop;
		const button = el('button', 'struct-btn dcs-complete-more', drop ? '▾' : '⋯');
		button.type = 'button';
		button.title = drop ? drop.title : 'Подсказка (Ctrl+Пробел)';
		button.setAttribute('aria-label', drop ? drop.label : 'Показать подсказку');
		if (drop) {
			// Кнопка раскрывающегося списка: читалка слышит, открыт ли он (openCompletion/closeCompletion)
			button.setAttribute('aria-haspopup', 'listbox');
			button.setAttribute('aria-controls', completeList.id);
			button.setAttribute('aria-expanded', 'false');
		}
		// Фокус и каретка остаются в поле: список откроется у того места, где пишут
		button.addEventListener('mousedown', (event) => {
			event.preventDefault();
		});
		button.addEventListener('click', () => {
			if (drop && completeSession && completeSession.binding === binding) {
				// Как у раскрывающегося списка: второе нажатие «▾» закрывает его
				closeCompletion();
				binding.input.focus();
				return;
			}
			binding.input.focus();
			openCompletion(binding, drop ? 'drop' : 'full');
		});
		if (binding.editor) {
			binding.editor.box.classList.add('dcs-complete-host');
			binding.editor.box.appendChild(button);
		} else {
			placeAfterInput(binding.input, button);
		}
		return button;
	}

	/**
	 * Кнопка встаёт сразу за полем: соседство держит её скрытой вместе с полем (правило стилей
	 * для скрытого поля), а строка формы получает под неё третью колонку.
	 */
	function placeAfterInput(input, button) {
		const parent = input.parentNode;
		if (!parent) {
			// Поле ещё не вставлено в форму: вызывающий код вставит его тем же тиком
			Promise.resolve().then(() => {
				if (input.parentNode && !button.parentNode) {
					placeAfterInput(input, button);
				}
			});
			return;
		}
		parent.insertBefore(button, input.nextSibling);
		parent.classList.add('dcs-complete-host');
	}

	function onCompleteKeydown(binding, event) {
		if (event.isComposing) {
			return;
		}
		if ((event.key === ' ' || event.code === 'Space') && event.ctrlKey && !event.altKey && !event.metaKey) {
			// Явный вызов: список и при пустом начале слова, а если вариантов нет — сообщение читалке
			event.preventDefault();
			openCompletion(binding, 'explicit');
			return;
		}
		if (binding.drop && event.altKey && !event.ctrlKey && !event.metaKey && (event.key === 'ArrowDown' || event.key === 'ArrowUp')) {
			// Поле со списком: Alt+↓ раскрывает список значений, Alt+↑ его закрывает — как у раскрывающегося списка
			event.preventDefault();
			if (event.key === 'ArrowDown') {
				openCompletion(binding, 'drop');
			} else if (completeSession && completeSession.binding === binding) {
				closeCompletion();
			}
			return;
		}
		const session = completeSession;
		if (!session || session.binding !== binding) {
			return;
		}
		if (event.key === 'Escape') {
			// Закрывается только список: окно с недописанным выражением остаётся (стек видит defaultPrevented)
			event.preventDefault();
			event.stopPropagation();
			closeCompletion();
			return;
		}
		if (event.key === 'Tab' && event.shiftKey) {
			closeCompletion();
			return;
		}
		if ((event.key === 'Enter' || event.key === 'Tab') && !dropAccepts(session, event.key)) {
			// Нечего брать: пустой список, строка не выбрана или Tab по списку, который только посмотрели. Значение
			// не меняется; Enter закрывает список (окно его не видит), Tab уводит фокус дальше
			closeCompletion();
			if (event.key === 'Enter') {
				event.preventDefault();
				event.stopPropagation();
			}
			return;
		}
		if (event.key === 'Enter' || event.key === 'Tab') {
			event.preventDefault();
			event.stopPropagation();
			acceptCompletion(session.active);
			return;
		}
		if (COMPLETE_NAV_KEYS.indexOf(event.key) >= 0) {
			event.preventDefault();
			session.moved = true;
			moveCompletion(completer.nextActive(session.active, session.ranked.length, event.key));
		}
	}

	/**
	 * Берут ли Enter и Tab строку списка. Без активной строки (пустой список, у поля со списком — значение не совпало ни
	 * с одной строкой) — нет. Список поля со списком, раскрытый «▾» или Alt+↓ и не перефильтрованный набором, Tab берёт,
	 * только если строку выбрали стрелками: раскрыли посмотреть и ушли Tab — значение остаётся как было.
	 */
	function dropAccepts(session, key) {
		if (!session.ranked[session.active]) {
			return false;
		}
		return !(key === 'Tab' && session.ctx && session.ctx.whole && !session.moved);
	}

	function onCompleteInput(binding, event) {
		if (applyingCompletion || (event && event.isComposing)) {
			return;
		}
		const open = completeSession !== null && completeSession.binding === binding;
		const typed = event && event.inputType === 'insertText' && typeof event.data === 'string' ? event.data : '';
		const ctx = caretContext(binding.input);
		const action = completer.inputAction(open, typed, ctx, { letters: binding.letters });
		if (action === 'open') {
			openCompletion(binding, 'auto', ctx);
		} else if (action === 'refilter') {
			refreshCompletion(ctx);
		} else if (action === 'close') {
			closeCompletion();
		}
	}

	function syncCompletionCaret(binding) {
		if (!completeSession || completeSession.binding !== binding) {
			return;
		}
		const ctx = caretContext(binding.input);
		if (completer.inputAction(true, '', ctx, { letters: binding.letters }) === 'refilter') {
			refreshCompletion(ctx);
		} else {
			closeCompletion();
		}
	}

	function rankCompletion(binding, catalog, ctx, full) {
		return completer.rank(completer.childrenOf(catalog, ctx, binding.extraChildren), full ? '' : ctx.prefix);
	}

	/**
	 * Контекст списка поля со списком (attachCompletion, drop): верхний уровень каталога без фильтра, а выбор заменяет
	 * всё значение поля — где бы ни стояла каретка, хоть внутри строки.
	 */
	function wholeValueContext(input) {
		return { mode: 'path', parentPath: '', prefix: '', replaceStart: 0, replaceEnd: input.value.length, whole: true };
	}

	/**
	 * Строка списка поля со списком, совпадающая со значением поля (`&Имя` параметра, имя прочих строк). Нет такой (пусто,
	 * выражение, блок `{(&Имя)}`) — -1: ни одна строка не выбрана, как у поля со списком, чьё значение не из списка; ↓
	 * встаёт на первую.
	 */
	function dropActive(ranked, value) {
		const want = String(value || '')
			.trim()
			.toUpperCase();
		if (!want) {
			return -1;
		}
		return ranked.findIndex((entry) => {
			const item = entry.item || {};
			return ((item.kind === 'param' && item.bare !== true ? '&' : '') + String(item.name || '')).toUpperCase() === want;
		});
	}

	/**
	 * Открывает список у поля. how: auto — по вводу (пустой список молча не открывается), explicit —
	 * Ctrl+Пробел, full — «⋯»: весь уровень без фильтра, активна строка лучшего совпадения; drop —
	 * «▾» и Alt+↓ поля со списком: весь верхний уровень, активна строка значения поля (нет её — ни
	 * одна), выбор заменяет всё значение, пустой список показывается строкой binding.drop.empty.
	 * Переоткрытие со своим контекстом (knownCtx: пересчёт по описаниям) идёт от каретки, а не от
	 * всего значения.
	 */
	function openCompletion(binding, how, knownCtx) {
		const input = binding.input;
		if (input.readOnly || input.disabled || !input.isConnected) {
			return;
		}
		// До первого сообщения строки состояния: и «вариантов нет» должно прозвучать внутри окна
		placeCompletionHost();
		const drop = how === 'drop' && binding.drop !== null && !knownCtx;
		const ctx = drop ? wholeValueContext(input) : knownCtx || caretContext(input);
		if (ctx.mode === 'none') {
			closeCompletion();
			if (how !== 'auto') {
				announceCompletion('Внутри строки и комментария подсказки нет.');
			}
			return;
		}
		const catalog = binding.catalogFn ? binding.catalogFn() : completionCatalog(binding.scopeFn());
		const full = how === 'full' || drop;
		describeWaited = false;
		const ranked = rankCompletion(binding, catalog, ctx, full);
		// Детей по типу ещё нет, но описания уже запрошены: список откроется по ответу (onDescribed)
		describeWaiting = describeWaited && ranked.length === 0 ? { binding: binding, how: how, mode: ctx.mode, parentPath: ctx.parentPath } : null;
		if (ranked.length === 0 && !(drop && binding.drop.empty)) {
			closeCompletion();
			if (how !== 'auto') {
				announceCompletion(describeWaiting ? 'Загрузка реквизитов…' : completer.listSummary(0));
			}
			return;
		}
		if (completeSession && completeSession.binding !== binding) {
			closeCompletion();
		}
		escapePopup = completePopupHook;
		completeSession = {
			binding: binding,
			how: how,
			input: input,
			catalog: catalog,
			ctx: ctx,
			ranked: ranked,
			active: drop ? dropActive(ranked, input.value) : full ? completer.bestIndex(ranked, ctx.prefix) : 0,
			moved: false,
			start: 0,
			rows: [],
			empty: drop ? String(binding.drop.empty || '') : '',
		};
		input.setAttribute('aria-expanded', 'true');
		if (binding.drop && binding.more) {
			binding.more.setAttribute('aria-expanded', 'true');
		}
		renderCompletion();
	}

	/** Перефильтровка по свежему контексту: набор, удаление, сдвиг каретки внутри слова. */
	function refreshCompletion(knownCtx) {
		const session = completeSession;
		if (!session) {
			return;
		}
		if (!session.input.isConnected) {
			closeCompletion();
			return;
		}
		const ctx = knownCtx || caretContext(session.input);
		const ranked = ctx.mode === 'none' ? [] : rankCompletion(session.binding, session.catalog, ctx, false);
		if (ranked.length === 0) {
			closeCompletion();
			return;
		}
		session.ctx = ctx;
		session.ranked = ranked;
		session.active = 0;
		session.start = 0;
		// Список поля со списком, перефильтрованный набором, — уже подсказка у каретки: и пересчёт по описаниям
		// (onDescribed) должен идти от каретки, а не раскрывать снова весь список значений
		if (session.how === 'drop') {
			session.how = 'explicit';
		}
		renderCompletion();
	}

	function closeCompletion() {
		const session = completeSession;
		if (!session) {
			return;
		}
		completeSession = null;
		completeList.classList.add('hidden');
		completeList.textContent = '';
		announceCompletion('');
		session.input.setAttribute('aria-expanded', 'false');
		session.input.removeAttribute('aria-activedescendant');
		if (session.binding.drop && session.binding.more) {
			session.binding.more.setAttribute('aria-expanded', 'false');
		}
	}

	/** Закрывает список, если его поле лежит внутри node (окно закрывается, вкладка перерисовывается). */
	function closeCompletionWithin(node) {
		if (completeSession && node && node.contains(completeSession.input)) {
			closeCompletion();
		}
	}

	/** Рисует окно строк вокруг активной, подпись «строки a–b из N» и ставит список у каретки. */
	function renderCompletion() {
		const session = completeSession;
		const total = session.ranked.length;
		session.start = completer.windowStart(session.active, session.start, total, completer.MAX_ROWS);
		const end = Math.min(total, session.start + completer.MAX_ROWS);
		completeList.textContent = '';
		// Раскрытый список поля со списком читалка называет его словами («Параметры запроса»), прочие — «Подсказка»
		const drop = session.binding.drop;
		completeList.setAttribute('aria-label', session.ctx.whole && drop && drop.list ? drop.list : 'Подсказка');
		session.rows = [];
		for (let index = session.start; index < end; index += 1) {
			const row = completeRow(session.ranked[index], index);
			session.rows.push(row);
			completeList.appendChild(row);
		}
		// Пустой список поля со списком — своей строкой («В запросе ещё нет параметров…»), а не молчанием
		const note = total === 0 && session.empty ? session.empty : completer.windowNote(session.start, end, total);
		if (note) {
			// Счёт строк читалке уже сказан строкой состояния: подпись — для глаза
			const noteEl = el('div', 'dcs-complete-note', note);
			noteEl.setAttribute('aria-hidden', 'true');
			completeList.appendChild(noteEl);
		}
		markActiveRow();
		announceCompletion(total === 0 && session.empty ? session.empty : completer.listSummary(total));
		positionCompletion();
	}

	function completeRow(entry, index) {
		const parts = completer.rowParts(entry);
		const row = el('div', 'dcs-complete-row');
		row.id = 'dcsCompleteOption' + index;
		row.setAttribute('role', 'option');
		row.setAttribute('aria-selected', 'false');
		// Вид словом, а не только буквой и цветом: читалка прочтёт «поле Номенклатура, Товар»
		row.setAttribute('aria-label', completer.itemLabel(entry.item));
		const kind = el('span', 'dcs-complete-kind', parts.letter);
		kind.setAttribute('data-kind', entry.item.kind || 'field');
		kind.setAttribute('aria-hidden', 'true');
		row.appendChild(kind);
		row.appendChild(matchSpan('dcs-complete-name', parts.name));
		const detail = el('span', 'dcs-complete-detail');
		if (parts.title.length > 0) {
			detail.appendChild(matchSpan('dcs-complete-title', parts.title));
		}
		if (parts.typeText) {
			detail.appendChild(el('span', 'dcs-complete-type', parts.typeText));
		}
		row.appendChild(detail);
		// Состав определяемого типа строки: подпись в колонке типа короткая, состав — наведением и читалке
		describeComposition(row, typeCompositionOf(entry.item.valueType));
		row.addEventListener('click', () => {
			acceptCompletion(index);
		});
		return row;
	}

	function matchSpan(className, pieces) {
		const span = el('span', className);
		for (const piece of pieces) {
			if (piece.hit) {
				span.appendChild(el('span', 'dcs-complete-hit', piece.text));
			} else {
				span.appendChild(document.createTextNode(piece.text));
			}
		}
		return span;
	}

	function markActiveRow() {
		const session = completeSession;
		const activeRow = session.rows[session.active - session.start] || null;
		for (const row of session.rows) {
			const active = row === activeRow;
			row.classList.toggle('dcs-complete-active', active);
			row.setAttribute('aria-selected', active ? 'true' : 'false');
		}
		if (!activeRow) {
			session.input.removeAttribute('aria-activedescendant');
			return;
		}
		session.input.setAttribute('aria-activedescendant', activeRow.id);
		if (typeof activeRow.scrollIntoView === 'function') {
			activeRow.scrollIntoView({ block: 'nearest' });
		}
	}

	function moveCompletion(index) {
		const session = completeSession;
		if (!session || index < 0) {
			return;
		}
		session.active = index;
		// Вышли за нарисованное окно — окно сдвигается и перерисовывается, иначе меняется только отметка
		if (completer.windowStart(index, session.start, session.ranked.length, completer.MAX_ROWS) !== session.start) {
			renderCompletion();
			return;
		}
		markActiveRow();
	}

	/**
	 * Вставка строки index вместо набранного слова (applyItem модуля) и закрытие списка. Список поля со списком,
	 * открытый «▾» или Alt+↓ и не перефильтрованный набором, заменяет всё значение поля.
	 */
	function acceptCompletion(index) {
		const session = completeSession;
		if (!session) {
			return;
		}
		const entry = session.ranked[index];
		const input = session.input;
		const ctx = session.ctx && session.ctx.whole ? wholeValueContext(input) : caretContext(input);
		closeCompletion();
		if (!entry || ctx.mode === 'none') {
			return;
		}
		replaceCompletionText(input, ctx, completer.applyItem(input.value, ctx, entry.item));
	}

	/** Пишет вставку в поле (writeEditorText: правка остаётся в истории поля, Ctrl+Z отменяет только её). */
	function replaceCompletionText(input, ctx, result) {
		applyingCompletion = true;
		try {
			writeEditorText(input, ctx.replaceStart, ctx.replaceEnd, result.text, result.caret, result.caret);
		} finally {
			applyingCompletion = false;
		}
	}

	/** Ставит список у якоря: снизу от каретки, у края окна — сверху и с прижатием (placePopup модуля). */
	function positionCompletion() {
		const session = completeSession;
		if (!session) {
			return;
		}
		const anchor = completionAnchor(session.binding);
		const listEl = completeList;
		listEl.style.left = '0px';
		listEl.style.top = '0px';
		listEl.style.maxHeight = '';
		listEl.style.minWidth = anchor.width > 0 ? Math.round(anchor.width) + 'px' : '';
		// Размер списка известен только после раскладки: меряем невидимым, затем ставим на место
		listEl.style.visibility = 'hidden';
		listEl.classList.remove('hidden');
		const size = { width: listEl.offsetWidth || 0, height: listEl.offsetHeight || 0 };
		const place = completer.placePopup(anchor, size, { width: window.innerWidth || 0, height: window.innerHeight || 0 });
		listEl.style.left = Math.round(place.left) + 'px';
		listEl.style.top = Math.round(place.top) + 'px';
		listEl.style.maxHeight = place.maxHeight < size.height ? Math.floor(place.maxHeight) + 'px' : '';
		listEl.style.visibility = '';
	}

	/**
	 * Якорь списка. Однострочное поле — его нижний край во всю ширину (точное x каретки там не
	 * нужно). Редактор кода — прямоугольник каретки, прижатый к видимой части поля: каретка,
	 * ушедшая прокруткой за край textarea, не утащит список на другой конец окна.
	 */
	function completionAnchor(binding) {
		const box = binding.input.getBoundingClientRect();
		if (!binding.editor) {
			return { left: box.left, top: box.top, bottom: box.bottom, width: box.width };
		}
		const caret = caretRect(binding.editor, binding.input);
		if (!caret) {
			return { left: box.left, top: box.top, bottom: box.bottom, width: 0 };
		}
		const top = Math.min(Math.max(caret.top, box.top), box.bottom);
		const bottom = Math.min(Math.max(caret.bottom, top), box.bottom);
		const left = Math.min(Math.max(caret.left, box.left), box.right);
		return { left: left, top: top, bottom: bottom, width: 0 };
	}

	function caretRect(editor, input) {
		const caret = caretOf(input);
		// Сначала догоняем зеркало: перерисовка может и выключить его, если текст перерос лимит
		editor.flush();
		if (!editor.wrap.classList.contains('dcs-hl-off')) {
			return markerRectInMirror(editor.pre, caret);
		}
		return markerRectInClone(input, caret);
	}

	/**
	 * Каретка по метке в зеркале подсветки: у зеркала те же шрифт, отступы, перенос и прокрутка,
	 * что у textarea. Свёрнутый Range в начале строки даёт пустой прямоугольник, поэтому метка —
	 * временный span с невидимым символом; U+2060 (а не U+200B) не разрешает перенос внутри слова.
	 */
	function markerRectInMirror(pre, offset) {
		let rest = offset;
		let host = null;
		for (const node of Array.from(pre.childNodes)) {
			const textNode = node.nodeType === 3 ? node : node.firstChild;
			const length = node.textContent.length;
			if (rest <= length && textNode && textNode.nodeType === 3) {
				host = textNode;
				break;
			}
			rest -= length;
		}
		if (!host) {
			return null;
		}
		const marker = el('span', '', '⁠');
		const tail = host.splitText(rest);
		tail.parentNode.insertBefore(marker, tail);
		const rect = marker.getBoundingClientRect();
		const parent = marker.parentNode;
		marker.remove();
		// Разрезанный текстовый узел склеивается: зеркало остаётся тем, что нарисовала подсветка
		parent.normalize();
		return rect;
	}

	/** Та же метка на временном клоне textarea: подсветки нет (текст больше лимита). */
	function markerRectInClone(input, offset) {
		if (typeof window.getComputedStyle !== 'function') {
			return null;
		}
		const style = window.getComputedStyle(input);
		const box = input.getBoundingClientRect();
		const clone = el('div', '');
		for (const name of CARET_CLONE_STYLES) {
			clone.style[name] = style[name];
		}
		clone.style.position = 'fixed';
		clone.style.left = box.left + 'px';
		clone.style.top = box.top + 'px';
		clone.style.overflow = 'hidden';
		clone.style.visibility = 'hidden';
		clone.appendChild(document.createTextNode(input.value.slice(0, offset)));
		const marker = el('span', '', '⁠');
		clone.appendChild(marker);
		clone.appendChild(document.createTextNode(input.value.slice(offset) + '\n'));
		document.body.appendChild(clone);
		clone.scrollTop = input.scrollTop;
		clone.scrollLeft = input.scrollLeft;
		const rect = marker.getBoundingClientRect();
		clone.remove();
		return rect;
	}

	// Прокрутка окна или диалога уводит поле из-под списка: пересчитывать дороже, чем закрыть.
	// Прокрутка самого списка его не закрывает, а прокрутка поля лишь сдвигает его к каретке
	document.addEventListener(
		'scroll',
		(event) => {
			const session = completeSession;
			if (!session) {
				return;
			}
			const target = event.target;
			if (target === completeList || (target && typeof target === 'object' && completeList.contains(target))) {
				return;
			}
			if (target === session.input) {
				positionCompletion();
				return;
			}
			closeCompletion();
		},
		true
	);
	window.addEventListener('resize', () => {
		closeCompletion();
	});
	// Щелчок вне поля и списка закрывает список, даже если фокус остался на месте
	document.addEventListener(
		'mousedown',
		(event) => {
			const session = completeSession;
			if (!session) {
				return;
			}
			const target = event.target;
			if (target === session.input || target === session.binding.more || completeList.contains(target)) {
				return;
			}
			closeCompletion();
		},
		true
	);

	// ---------- строка-подсказка у фокуса с клавиатуры ----------

	/**
	 * Строка-подсказка у фокуса с клавиатуры. Название пиктограммы и полное имя обрезанной вертикальной
	 * вкладки конструктора запроса есть только в title, а его VS Code показывает при наведении мыши. Когда такая кнопка
	 * получает фокус с клавиатуры (:focus-visible), первая строка её title видна в строке у нижнего края окна:
	 * position: fixed — область прокрутки и края полосы вкладок её не обрезают, слой — над окнами и списком подсказки.
	 * Читалке строка не нужна (aria-hidden): у кнопки есть доступное имя. Уход фокуса и нажатие мыши её прячут.
	 */
	const focusHint = el('div', 'dcs-focus-hint hidden');
	focusHint.setAttribute('aria-hidden', 'true');
	focusHint.style.zIndex = String(dialogRules.POPUP_Z_INDEX + 1);
	document.body.appendChild(focusHint);

	/** Текст строки-подсказки для узла с фокусом: пиктограмма или вертикальная вкладка с фокусом с клавиатуры; иначе ''. */
	function focusHintText(target) {
		if (!target || typeof target.getAttribute !== 'function' || !target.title) {
			return '';
		}
		const icon = Boolean(target.classList) && target.classList.contains('dcs-icon-btn');
		const verticalTab = target.getAttribute('role') === 'tab' && typeof target.closest === 'function' && Boolean(target.closest('.dcs-qd-vtabs'));
		if (!icon && !verticalTab) {
			return '';
		}
		// Фокус щелчком мышью строку не показывает: мышь и так видит title
		if (typeof target.matches === 'function') {
			try {
				if (!target.matches(':focus-visible')) {
					return '';
				}
			} catch (error) {
				// Движок без :focus-visible: строка показывается при любом фокусе
			}
		}
		return String(target.title).split('\n')[0];
	}

	function hideFocusHint() {
		focusHint.textContent = '';
		focusHint.classList.add('hidden');
	}

	document.addEventListener('focusin', (event) => {
		const text = focusHintText(event && event.target);
		focusHint.textContent = text;
		focusHint.classList.toggle('hidden', !text);
	});
	document.addEventListener('focusout', hideFocusHint);
	document.addEventListener('pointerdown', hideFocusHint, true);

	// ---------- плашка итогов: автозаполнение и проверка схемы ----------

	function hideNotice() {
		noticeEl.className = 'dcs-notice hidden';
		noticeEl.textContent = '';
	}

	/** Показывает плашку с заголовком и строками; tone — ok, error или info. */
	function showNotice(tone, title, lines) {
		noticeEl.textContent = '';
		noticeEl.className = 'dcs-notice dcs-notice-' + tone;
		const head = el('div', 'dcs-notice-head');
		head.appendChild(el('span', 'dcs-notice-title', title));
		// Пиктограмма с именем словами: знак «×» читалка в живой области плашки произносила как «умножить»
		head.appendChild(iconButton({ icon: 'delete', name: 'Закрыть плашку', className: 'struct-btn', onClick: hideNotice }));
		noticeEl.appendChild(head);
		for (const line of lines) {
			noticeEl.appendChild(el('div', line.hint ? 'dcs-notice-line dcs-notice-hint' : 'dcs-notice-line', line.text));
		}
	}

	/** Строки плашки по итогу автозаполнения {added, skipped} из ответа мутации. */
	function autofillNoticeLines(result) {
		const added = Array.isArray(result.added) ? result.added : [];
		const skipped = Array.isArray(result.skipped) ? result.skipped : [];
		const lines = [];
		lines.push({ text: added.length > 0 ? 'Добавлено полей: ' + added.length + ' — ' + added.join(', ') : 'Новых полей нет: все поля выборки уже в наборе.' });
		for (const miss of skipped) {
			lines.push({ text: 'Пропущено: ' + (miss.expression || '') + ' — ' + (miss.reason || 'причина не названа') });
		}
		lines.push({ text: 'Типы полей не выводятся — задаются в свойствах поля.', hint: true });
		return lines;
	}

	/** Строки плашки по ответу dcs/apply-query: запрос записан, объявленные параметры, итог автозаполнения. */
	function queryAppliedNoticeLines(msg) {
		const lines = [{ text: 'Запрос записан.' }];
		if (msg.addedParameters.length > 0) {
			lines.push({ text: 'Объявлены параметры: ' + msg.addedParameters.join(', ') + '. Тип задаётся на вкладке «Параметры».' });
		}
		if (msg.autofill) {
			return lines.concat(autofillNoticeLines(msg.autofill));
		}
		return lines;
	}

	/**
	 * Строки плашки по вердикту строгой проверки: ошибки с позициями или «ошибок нет», затем предупреждения.
	 * Предупреждения на ok не влияют (схема читается и загружается): необъявленный &-параметр запроса, список значений
	 * старой записи, чьи представления потеряет загрузка, и флажок «Список параметров» у связи без параметра. Текст
	 * md-sparrow полный; вид (kind) нужен для подсказок, где такие места помечены, а у флажка без параметра — ещё и
	 * чтобы назвать связь номером таблицы (linkListFlagWarningLine).
	 */
	function validationNoticeLines(msg) {
		const errors = msg.errors;
		const warnings = msg.warnings;
		let lines;
		if (msg.ok) {
			lines = [{ text: 'Ошибок нет.' }];
		} else if (errors.length === 0) {
			lines = [{ text: 'Схема не прошла проверку, но ошибки валидатор не назвал.' }];
		} else {
			lines = errors.map((error) => {
				const place = typeof error.line === 'number' ? error.line + (typeof error.column === 'number' ? ':' + error.column : '') + ' — ' : '';
				return { text: place + (error.message || 'Ошибка без описания') };
			});
		}
		if (warnings.length === 0) {
			return lines;
		}
		lines.push({ text: 'Предупреждения (' + warnings.length + '):' });
		for (const warning of warnings) {
			if (warning.kind === 'linkListFlagWithoutParameter') {
				// Номер связи — как в таблице связей (с единицы), а не номер md-sparrow (с нуля)
				lines.push({ text: linkListFlagWarningLine(warning, list('dataSetLinks')) });
				continue;
			}
			lines.push({ text: typeof warning.message === 'string' && warning.message !== '' ? warning.message : 'Предупреждение без описания' });
		}
		if (warnings.some((warning) => warning.kind === 'valueListPresentationsLost')) {
			lines.push({ text: VALIDATION_LIST_PRESENTATIONS_HINT, hint: true });
		}
		if (warnings.some((warning) => warning.kind === 'linkListFlagWithoutParameter')) {
			lines.push({ text: VALIDATION_LINK_LIST_FLAG_HINT, hint: true });
		}
		return lines;
	}

	/**
	 * Подсказка к предупреждению о флажке «Список параметров» у связи без параметра (ключ link — номер связи с нуля).
	 * «Да» без параметра таблица связей помечает сама, по прочитанной модели; «нет» без параметра смысла связи не меняет
	 * (снятый флажок — то же, что «не задано»), и окно связи убирает его вместе с правкой.
	 */
	const VALIDATION_LINK_LIST_FLAG_HINT =
		'Связи с отмеченным флажком «Список параметров» без параметра помечены на вкладке «Связи наборов данных»: откройте связь и снимите флажок или задайте параметр. «Нет» без параметра смысла связи не меняет; окно связи убирает его вместе с любой правкой этой связи.';

	/**
	 * Подсказка к предупреждению о списке старой записи. Совет md-sparrow «уберите представления» окнами не выполнить:
	 * значение параметра схемы они не правят (смена типа лишь очищает неподходящее), а снятие флажка «Доступен список
	 * значений» уводит пометку, но не представления. Поэтому подсказка говорит, чем их всё же убрать: записью списка
	 * заново.
	 */
	const VALIDATION_LIST_PRESENTATIONS_HINT =
		'Такие списки помечены и на вкладке «Параметры». Ни окна правки, ни снятие флажка «Доступен список значений» представления не убирают: убрать их можно только записью списка заново без представлений.';

	/** Тон плашки проверки: ошибка, «ошибок нет» или — при предупреждениях без ошибок — нейтральный. */
	function validationNoticeTone(msg) {
		if (!msg.ok) {
			return 'error';
		}
		return msg.warnings.length > 0 ? 'info' : 'ok';
	}

	/**
	 * Проверка схемы ждёт правку в полёте: jar читает файл макета, и вердикт должен говорить о том, что пользователь
	 * видит. Текст запроса пишется по уходу из поля — то есть уже на нажатии «Проверить схему», и проверка, ушедшая
	 * сразу, читала бы макет, который в это время пишет cf-dcs-set-query (а за ним — заполнение полей).
	 */
	let validateQueued = false;

	validateBtn.addEventListener('click', () => {
		if (validating) {
			return;
		}
		validating = true;
		validateBtn.disabled = true;
		flushQueryEdits('nav');
		if (saving) {
			validateQueued = true;
			return;
		}
		post('dcs/validate');
	});

	/** Отложенная проверка схемы — когда канал правок свободен: ответ пришёл и следом ничего не ушло. */
	function runQueuedValidate() {
		if (validateQueued && !saving) {
			validateQueued = false;
			post('dcs/validate');
		}
	}

	// ---------- конструктор запроса ----------

	/** Последнее дерево объектов вкладки: показывается сразу, пока хост отвечает на сверку. */
	let qcGroups = null;
	let qcGroupsError = '';
	let qcGroupsLoading = false;
	/** Хост сказал, что дерева в его кэше нет и идёт загрузка с нуля: на большой выгрузке — минуты. */
	let qcGroupsCold = false;
	/** Перерисовка открытого уровня конструктора; null — уровень закрыт. */
	let qcRerender = null;

	/**
	 * Дерево объектов для открытия конструктора. Запрос уходит и при уже полученном дереве: кэш держит
	 * хост (по отпечатку Configuration.xml), и сверка с ним дешёвая, а без неё объект, добавленный при
	 * открытой вкладке, появился бы только после её переоткрытия. Пока ответа нет, показывается
	 * последнее полученное дерево.
	 */
	function requestMetadataGroups() {
		if (qcGroupsLoading) {
			return;
		}
		qcGroupsLoading = true;
		qcGroupsCold = false;
		if (!qcGroups) {
			qcGroupsError = '';
		}
		post('dcs/list-metadata');
	}

	/**
	 * Таблицы языка запросов объектов (cf-md-query-tables, сообщение dcs/query-tables) по ключу
	 * «язык|путь»: правки схемы метаданные конфигурации не меняют, а каждое чтение — запуск jar.
	 * Язык — в ключе: русский и английский ответы называют таблицы и стандартные реквизиты по-разному.
	 * Состояния: loading — запрос ушёл, ready — описание есть, error — описания нет (текст в error).
	 */
	const queryTablesCache = new Map();

	function queryTablesKey(relativePath, lang) {
		return (lang === 'en' ? 'en' : 'ru') + '|' + relativePath;
	}

	/** Описание объекта из кэша; нет в кэше — запрос панели, пока ответ не пришёл — состояние loading. */
	function requestQueryTables(relativePath, lang) {
		const key = queryTablesKey(relativePath, lang);
		let entry = queryTablesCache.get(key);
		if (!entry) {
			entry = { state: 'loading' };
			queryTablesCache.set(key, entry);
			post('dcs/query-tables', { relativePath: relativePath, lang: lang === 'en' ? 'en' : 'ru' });
		}
		return entry;
	}

	// ---------- списки и таблицы ----------

	/** Строка списка в общем виде панелей: имя, пояснение и правое значение. */
	function structItem(row) {
		const item = el('div', 'struct-item');
		const nameEl = el('span', 'struct-item-name', row.name || '');
		if (row.hint) {
			nameEl.title = row.hint;
		}
		item.appendChild(nameEl);
		if (row.value) {
			item.appendChild(el('span', 'struct-item-syn', row.value));
		}
		if (row.right) {
			item.appendChild(el('span', 'struct-item-syn ref-selected-mode', row.right));
		}
		return item;
	}

	function listSection(host, rows) {
		const section = el('div', 'struct-list');
		for (const row of rows) {
			section.appendChild(structItem(row));
		}
		host.appendChild(section);
	}

	function dataTable(host, headers) {
		const wrap = el('div', 'dcs-table-wrap');
		const table = el('table', 'dcs-table');
		const thead = document.createElement('thead');
		const headRow = document.createElement('tr');
		for (const header of headers) {
			headRow.appendChild(el('th', '', header));
		}
		thead.appendChild(headRow);
		table.appendChild(thead);
		const tbody = document.createElement('tbody');
		table.appendChild(tbody);
		wrap.appendChild(table);
		host.appendChild(wrap);
		return tbody;
	}

	function cell(tr, text, className) {
		const td = nameEl('td', className, text);
		tr.appendChild(td);
		return td;
	}

	/**
	 * Кнопки строки таблицы. action.svg — имя пиктограммы команды: кнопка рисуется iconButton, title — её полное
	 * название и доступное имя. action.unavailable и action.note — недоступна, но в обходе Tab (aria-disabled) с
	 * причиной; onClick тогда сам называет причину.
	 */
	function actionsCell(tr, actions) {
		const td = el('td', 'dcs-cell-actions');
		for (const action of actions) {
			const node = iconButton({
				icon: action.svg,
				name: action.title,
				note: action.note,
				onClick: action.onClick,
				disabled: Boolean(action.disabled),
				unavailable: Boolean(action.unavailable),
				className: action.danger ? 'struct-btn struct-btn-danger' : 'struct-btn',
			});
			// Ключ — для возврата фокуса после перерисовки вкладки (captureFocus)
			if (action.key) {
				keyed(node, action.key);
			}
			td.appendChild(node);
		}
		tr.appendChild(td);
	}

	// ---------- ограничения и роль поля ----------

	const RESTRICTION_FLAGS = [
		{ key: 'field', label: 'Поле' },
		{ key: 'condition', label: 'Условие' },
		{ key: 'group', label: 'Группировка' },
		{ key: 'order', label: 'Упорядочивание' },
	];

	function restrictionBoxes(host, restriction) {
		const inputs = {};
		const boxes = [];
		for (const flag of RESTRICTION_FLAGS) {
			const box = checkbox(flag.label, restriction && restriction[flag.key]);
			inputs[flag.key] = box.input;
			boxes.push(box);
		}
		checkRow(host, boxes);
		return inputs;
	}

	function restrictionOf(inputs) {
		return {
			field: inputs.field.checked,
			condition: inputs.condition.checked,
			group: inputs.group.checked,
			order: inputs.order.checked,
		};
	}

	function restrictionChanged(inputs, original) {
		const current = restrictionOf(inputs);
		const was = original || {};
		return RESTRICTION_FLAGS.some((flag) => current[flag.key] !== Boolean(was[flag.key]));
	}

	function roleSummary(role) {
		if (!role) {
			return '';
		}
		const parts = [];
		if (role.dimension) {
			parts.push('измерение');
		}
		if (role.required) {
			parts.push('обязательное');
		}
		if (typeof role.periodNumber === 'number' && role.periodNumber > 0) {
			parts.push('период ' + role.periodNumber + (role.periodType === 'Additional' ? ' (доп.)' : ''));
		}
		if (role.account) {
			parts.push('счёт');
		}
		if (role.balanceType === 'OpeningBalance') {
			parts.push('начальный остаток');
		} else if (role.balanceType === 'ClosingBalance') {
			parts.push('конечный остаток');
		} else if (role.balance) {
			parts.push('остаток');
		}
		if (role.accountField) {
			parts.push('поле счёта: ' + role.accountField);
		}
		if (role.ignoreNullValues) {
			parts.push('игнорировать NULL');
		}
		return parts.join(', ');
	}

	/** Поля роли из DTO: флажки и уточнения периода, остатка и счёта; setName — набор поля для подсказки «Поле счёта». */
	function roleForm(body, role, setName) {
		const dimension = checkbox('Измерение', role.dimension);
		const required = checkbox('Обязательное', role.required);
		const ignoreNull = checkbox('Игнорировать NULL', role.ignoreNullValues);
		const account = checkbox('Счёт', role.account);
		const balance = checkbox('Остаток', role.balance);
		checkRow(body, [dimension, required, ignoreNull, account, balance]);
		const periodNumber = formRow(body, 'Номер периода', numberInput(role.periodNumber));
		const periodType = formRow(
			body,
			'Тип периода',
			selectInput(
				[
					{ value: '', label: '' },
					{ value: 'Main', label: 'Основной' },
					{ value: 'Specify', label: 'Указывается' },
					{ value: 'Additional', label: 'Дополнительный' },
				],
				role.periodType || ''
			)
		);
		const balanceType = formRow(
			body,
			'Тип остатка',
			selectInput(
				[
					{ value: '', label: '' },
					{ value: 'None', label: 'Нет' },
					{ value: 'OpeningBalance', label: 'Начальный остаток' },
					{ value: 'ClosingBalance', label: 'Конечный остаток' },
				],
				role.balanceType || ''
			)
		);
		const accountField = formRow(body, 'Поле счёта', textInput(role.accountField));
		if (setName) {
			// Поле счёта — поле того же набора
			attachCompletion(accountField, () => 'field-of-set:' + setName);
		}

		// Снятые уточнения (пустой номер, тип, поле счёта) в payload не входят и в схеме не очищаются
		function current() {
			const value = {
				dimension: dimension.input.checked,
				required: required.input.checked,
				account: account.input.checked,
				balance: balance.input.checked,
				ignoreNullValues: ignoreNull.input.checked,
			};
			const raw = periodNumber.value.trim();
			if (raw !== '') {
				value.periodNumber = Number(raw);
			}
			if (periodType.value) {
				value.periodType = periodType.value;
			}
			if (balanceType.value) {
				value.balanceType = balanceType.value;
			}
			const field = accountField.value.trim();
			if (field) {
				value.accountField = field;
			}
			return value;
		}

		function changed() {
			const now = current();
			return (
				now.dimension !== Boolean(role.dimension) ||
				now.required !== Boolean(role.required) ||
				now.account !== Boolean(role.account) ||
				now.balance !== Boolean(role.balance) ||
				now.ignoreNullValues !== Boolean(role.ignoreNullValues) ||
				(now.periodNumber || 0) !== (role.periodNumber || 0) ||
				(now.periodType || '') !== (role.periodType || '') ||
				(now.balanceType || '') !== (role.balanceType || '') ||
				(now.accountField || '') !== (role.accountField || '')
			);
		}

		function validate() {
			const raw = periodNumber.value.trim();
			if (raw !== '' && (!Number.isInteger(Number(raw)) || Number(raw) < 1)) {
				return 'Укажите целый номер периода, от 1.';
			}
			return undefined;
		}

		return { current: current, changed: changed, validate: validate };
	}

	// ---------- тип значения: колонка «Тип» и окно «Тип значения» ----------

	/** Чистые функции типа (dcs-editor-types.js). */
	const typeRules = window.DcsTypes;

	/**
	 * Словарь окна типа (cf-dcs-type-dictionary) на время вкладки: правки схемы состав
	 * конфигурации не меняют, а чтение словаря — запуск jar по всей выгрузке.
	 */
	let typeDictionary = null;
	let typeDictionaryError = '';
	let typeDictionaryLoading = false;
	/** Перерисовка открытого окна типа по приходу словаря; живёт, пока открыт уровень окна. */
	let typeRerender = null;

	/**
	 * Столько объектов вида окно рисует за раз: в больших конфигурациях справочников тысячи,
	 * а нужный быстрее найти поиском, чем прокруткой.
	 */
	const TYPE_TREE_ROW_LIMIT = 300;

	/** Квалифицируемые примитивы в порядке панели квалификаторов. */
	const QUALIFIED_PRIMITIVES = ['xs:string', 'xs:decimal', 'xs:dateTime'];

	const ALLOWED_LENGTH_OPTIONS = [
		{ value: 'VARIABLE', label: 'Переменная' },
		{ value: 'FIXED', label: 'Фиксированная' },
	];

	const DATE_FRACTIONS_OPTIONS = [
		{ value: 'DATE', label: 'Дата' },
		{ value: 'TIME', label: 'Время' },
		{ value: 'DATE_TIME', label: 'Дата и время' },
	];

	function requestTypeDictionary() {
		if (typeDictionary || typeDictionaryLoading) {
			return;
		}
		typeDictionaryLoading = true;
		typeDictionaryError = '';
		post('dcs/type-dictionary');
	}

	/** Подпись типа по модулю типов; без типа — строка md-sparrow (valueTypePresentation, type). */
	function typeLabelOf(valueType, fallback) {
		return valueType ? typeRules.typePresentation(valueType, typeDictionary) : fallback || '';
	}

	/**
	 * Состав определяемых типов и характеристик для всплывающей подсказки и доступного описания:
	 * подпись остаётся «ОпределяемыйТип.X», а что за ним стоит, видно наведением и слышно читалке.
	 * Без типа или без состава — пусто.
	 */
	function typeCompositionOf(valueType) {
		return valueType ? typeRules.compositionTitle(valueType, typeDictionary) : '';
	}

	/**
	 * Состав — в title (к уже заданной подсказке узла — новой строкой) и в aria-description:
	 * только title экранный диктор не читает, а aria-description дополняет имя (aria-label), не заменяя его.
	 */
	function describeComposition(node, composition) {
		if (!composition) {
			return;
		}
		node.title = node.title ? node.title + '\n' + composition : composition;
		node.setAttribute('aria-description', composition);
	}

	/** Константа квалификатора к виду списка выбора: текст файла и имя константы — одно значение. */
	function qualifierConstant(value, fallback) {
		const text = String(value || '').trim();
		const map = { Variable: 'VARIABLE', Fixed: 'FIXED', Any: 'ANY', Nonnegative: 'NONNEGATIVE', Date: 'DATE', Time: 'TIME', DateTime: 'DATE_TIME' };
		return map[text] || text || fallback;
	}

	/**
	 * Ячейка «Тип» таблицы: подпись кнопкой, щелчок открывает окно типа (только на просмотр там,
	 * где правка недоступна). Без обработчика — подпись текстом.
	 */
	function typeCell(tr, valueType, fallback, what, onOpen) {
		const td = el('td', 'dcs-cell-type');
		const text = typeLabelOf(valueType, fallback);
		const composition = typeCompositionOf(valueType);
		if (!onOpen) {
			setNameText(td, text || '');
			describeComposition(td, composition);
			tr.appendChild(td);
			return td;
		}
		const button = nameEl('button', 'dcs-type-link', text || '—');
		button.type = 'button';
		const readOnly = Boolean(valueType && valueType.editable === false);
		if (readOnly) {
			button.classList.add('dcs-type-ro');
		}
		button.title = (text ? 'Тип значения: ' + text : 'Тип не задан') + (readOnly ? ' — правится в конфигураторе' : '');
		button.setAttribute('aria-label', 'Тип значения ' + what + ': ' + (text || 'не задан'));
		describeComposition(button, composition);
		button.addEventListener('click', onOpen);
		td.appendChild(button);
		tr.appendChild(td);
		return td;
	}

	/** Что увидит пользователь после очистки значения: подпись пустого значения или «пустое значение типа». */
	function clearingText(change) {
		if (change.blocked) {
			return 'Значение правится в конфигураторе: к новому типу его здесь не привести, тип не сохранится.';
		}
		if (change.value === null) {
			return 'Значение не подходит к новому типу и при сохранении будет снято: у такого типа нет одного пустого значения.';
		}
		const summary = valueSummary(change.value);
		return (
			'Значение не подходит к новому типу и при сохранении будет заменено ' +
			(summary ? 'значением «' + summary + '».' : 'пустым значением типа.')
		);
	}

	/** Прочитанное у параметра — то, с чем typeEditPayload сравнивает итог диалога. */
	function parameterOriginal(param) {
		return {
			valueType: param.valueType,
			value: param.valueTyped,
			valueListAllowed: param.valueListAllowed,
			availableAsField: param.availableAsField,
			denyIncompleteValues: param.denyIncompleteValues,
		};
	}

	/** Предупреждения о данных владельца, которые смена типа может рассогласовать. */
	function typeOwnerWarnings(owner) {
		const out = [];
		if (owner.hasAvailableValues) {
			out.push('У параметра записаны доступные значения: после смены типа проверьте их в конфигураторе.');
		}
		if (owner.hasInputParameters) {
			out.push('Записаны параметры редактирования: после смены типа проверьте их в конфигураторе.');
		}
		return out;
	}

	/**
	 * Окно «Тип значения» — уровень стека поверх открытых окон (из таблицы — уровень 1, из
	 * диалога поля или параметра — над ним). Окно правит свою копию типа: отмена её
	 * выбрасывает, ОК отдаёт итог в spec.onDone.
	 *
	 * spec: {title, valueType — прочитанный или выбранный у владельца тип, readOnlyReason? —
	 * только просмотр, warnings? — строки о данных владельца, parameter? — блок «Значение» и флажок
	 * «Доступен список значений» ({value, valueListAllowed}), onDone(edited, level) — строка
	 * ошибки или undefined}. edited: {valueType, valueListAllowed?}.
	 */
	function openTypeDialog(spec) {
		requestTypeDictionary();
		const source = spec.valueType || null;
		const sourceReadOnly = Boolean(source && source.editable === false);
		const readOnlyReason = spec.readOnlyReason || (sourceReadOnly ? source.readOnlyReason : '');
		const readOnly = readOnlyReason !== '';
		const parameter = spec.parameter || null;
		const state = {
			// Копия: поля квалификаторов пишут прямо в неё, прочитанная модель не трогается
			type: JSON.parse(JSON.stringify(source || { types: [], typeSets: [], typeIds: [] })),
			composite: typeRules.typeItems(source).length > 1,
			query: '',
			expanded: new Set(['primitives']),
			listAllowed: Boolean(parameter && parameter.valueListAllowed),
		};
		let platesHost;
		let compositeBox;
		let chipsHost;
		let treeHost;
		let qualifiersHost;
		let qualifiersSignature = null;
		let qualifierErrors = {};
		let changeWarnEl;
		let valueWarnEl;
		let summaryEl;
		let treeRows = [];

		function renderPlates() {
			platesHost.textContent = '';
			if (readOnly) {
				platesHost.appendChild(el('div', 'dcs-plate', 'Только просмотр: ' + readOnlyReason));
			}
			if (!typeDictionary && typeDictionaryError === '') {
				platesHost.appendChild(el('div', 'dcs-plate', 'Загрузка словаря типов…'));
			} else if (typeDictionaryError !== '') {
				const plate = el('div', 'dcs-plate dcs-plate-error', 'Словарь типов не загружен: ' + typeDictionaryError + ' Доступны только примитивы.');
				const retry = el('button', 'ghost-btn dcs-btn-small', 'Повторить');
				retry.type = 'button';
				retry.addEventListener('click', () => {
					typeDictionaryError = '';
					requestTypeDictionary();
					renderAll();
				});
				plate.appendChild(retry);
				platesHost.appendChild(plate);
			} else if (typeDictionary.configurationFound === false) {
				platesHost.appendChild(
					el(
						'div',
						'dcs-plate',
						'Макет вне выгрузки конфигурации: новыми можно выбрать только примитивы и «любую ссылку», записанные ссылочные типы — снять.'
					)
				);
			}
		}

		function toggle(value) {
			if (readOnly) {
				return;
			}
			state.type = typeRules.toggleType(state.type, value, state.composite);
			// Определяемый тип в составной не входит: флажок «Составной» при нём снят и заблокирован
			if (state.type.typeIds.length > 0) {
				state.composite = false;
			}
			selectionChanged();
		}

		function renderChips() {
			chipsHost.textContent = '';
			const items = typeRules.typeItems(state.type, typeDictionary);
			if (items.length === 0) {
				chipsHost.appendChild(el('span', 'dcs-ro-note', 'Тип не задан.'));
				return;
			}
			for (const item of items) {
				const chip = el('span', 'dcs-type-chip');
				chip.appendChild(nameEl('span', '', item.label));
				if (!readOnly) {
					// Снять можно и то, чего нет в дереве: записанную ссылку вне выгрузки, тип с чужим именем
					const remove = el('button', 'dcs-type-chip-remove', '×');
					remove.type = 'button';
					remove.title = 'Убрать «' + item.label + '»';
					remove.setAttribute('aria-label', 'Убрать тип ' + item.label);
					remove.addEventListener('click', () => {
						toggle(item.value);
					});
					chip.appendChild(remove);
				}
				chipsHost.appendChild(chip);
			}
		}

		function syncTreeChecks() {
			for (const row of treeRows) {
				if (row.input) {
					row.input.checked = typeRules.hasType(state.type, row.value);
					row.el.setAttribute('aria-checked', String(row.input.checked));
				}
			}
		}

		function focusTreeRow(index) {
			const row = treeRows[index];
			if (!row) {
				return;
			}
			for (const other of treeRows) {
				other.el.tabIndex = -1;
			}
			row.el.tabIndex = 0;
			row.el.focus();
		}

		function onTreeKey(event, index) {
			const row = treeRows[index];
			if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
				event.preventDefault();
				focusTreeRow(index + (event.key === 'ArrowDown' ? 1 : -1));
			} else if (event.key === 'ArrowRight' && row.node && !row.open) {
				event.preventDefault();
				setExpanded(row.key, true);
			} else if (event.key === 'ArrowLeft') {
				event.preventDefault();
				if (row.node && row.open) {
					setExpanded(row.key, false);
				} else if (row.parentKey) {
					focusTreeRow(treeRows.findIndex((candidate) => candidate.key === row.parentKey));
				}
			} else if (event.key === ' ' && row.input && !row.input.disabled) {
				event.preventDefault();
				toggle(row.value);
			}
		}

		function setExpanded(key, open) {
			if (open) {
				state.expanded.add(key);
			} else {
				state.expanded.delete(key);
			}
			renderTree(key);
		}

		function addTreeRow(spec, depth) {
			const rowEl = el('div', 'dcs-tree-row dcs-type-tree-row');
			rowEl.setAttribute('role', 'treeitem');
			// Строки дерева — соседи в DOM, без role=group: глубину читалке передаёт только aria-level
			rowEl.setAttribute('aria-level', String(depth + 1));
			rowEl.style.paddingLeft = 8 + depth * 18 + 'px';
			rowEl.tabIndex = treeRows.length === 0 ? 0 : -1;
			const row = { el: rowEl, key: spec.key, value: spec.value, node: Boolean(spec.node), open: Boolean(spec.open), parentKey: spec.parentKey || '' };
			const twist = el('span', 'dcs-tree-twist', spec.node ? (spec.open ? '▾' : '▸') : '');
			if (spec.node) {
				rowEl.setAttribute('aria-expanded', String(Boolean(spec.open)));
				twist.addEventListener('click', (event) => {
					event.stopPropagation();
					setExpanded(spec.key, !spec.open);
				});
			}
			rowEl.appendChild(twist);
			if (spec.value !== undefined) {
				const input = el('input', 'edit-check');
				input.type = 'checkbox';
				// В дереве одна остановка Tab — сама строка: флажок ставится пробелом или щелчком
				input.tabIndex = -1;
				input.checked = typeRules.hasType(state.type, spec.value);
				input.disabled = readOnly;
				input.setAttribute('aria-label', spec.checkLabel || spec.label);
				input.addEventListener('click', (event) => {
					event.stopPropagation();
				});
				input.addEventListener('change', () => {
					toggle(spec.value);
				});
				rowEl.setAttribute('aria-checked', String(input.checked));
				rowEl.appendChild(input);
				row.input = input;
			}
			rowEl.appendChild(nameEl('span', 'dcs-tree-label', spec.label));
			if (spec.hint) {
				rowEl.appendChild(nameEl('span', 'dcs-tree-name', spec.hint));
			}
			if (spec.count !== undefined) {
				rowEl.appendChild(el('span', 'dcs-tree-badge', String(spec.count)));
			}
			// Щелчок по узлу раскрывает его (флажок «любая ссылка вида» — свой щелчок), по строке — ставит флажок
			rowEl.addEventListener('click', () => {
				if (spec.node) {
					setExpanded(spec.key, !spec.open);
				} else if (row.input && !row.input.disabled) {
					toggle(spec.value);
				}
			});
			const index = treeRows.length;
			rowEl.addEventListener('keydown', (event) => {
				onTreeKey(event, index);
			});
			treeRows.push(row);
			treeHost.appendChild(rowEl);
		}

		/** Ключ строки дерева: по нему после перерисовки возвращается фокус. */
		function rowKey(value) {
			return 'type:' + (value && typeof value === 'object' ? String(value.typeId || '').toLowerCase() : String(value));
		}

		function renderTree(focusKey) {
			const active = document.activeElement;
			const activeRow = treeRows.find((row) => row.el === active);
			const keep = focusKey || (activeRow ? activeRow.key : '');
			treeHost.textContent = '';
			treeRows = [];
			const nodes = typeRules.typeTree(typeDictionary, state.query);
			if (nodes.length === 0) {
				treeHost.appendChild(el('div', 'dcs-plate', 'По запросу «' + state.query.trim() + '» типов нет.'));
				return;
			}
			for (const node of nodes) {
				if (node.kind === 'row') {
					addTreeRow({ key: node.key, value: node.value, label: node.label }, 0);
					continue;
				}
				const open = Boolean(node.open) || state.expanded.has(node.key);
				const nodeSpec = { key: node.key, label: node.label, node: true, open: open, count: node.total };
				if (node.kind === 'kind') {
					// Флажок у вида — «любая ссылка вида» (TypeSet), объекты вида — его строки
					nodeSpec.value = node.typeSet;
					nodeSpec.hint = node.platformName;
					nodeSpec.checkLabel = 'Любая ссылка вида «' + node.label + '»';
				}
				addTreeRow(nodeSpec, 0);
				if (!open) {
					continue;
				}
				const limit = Math.min(node.rows.length, TYPE_TREE_ROW_LIMIT);
				for (let index = 0; index < limit; index += 1) {
					const item = node.rows[index];
					addTreeRow({ key: rowKey(item.value), value: item.value, label: item.label, parentKey: node.key }, 1);
				}
				if (node.rows.length > limit) {
					treeHost.appendChild(
						el('div', 'dcs-type-more', 'Показаны первые ' + limit + ' из ' + node.rows.length + ' — уточните поиск.')
					);
				}
			}
			if (keep) {
				const index = treeRows.findIndex((row) => row.key === keep);
				if (index >= 0 && (focusKey || activeRow)) {
					focusTreeRow(index);
				}
			}
		}

		/** Числовое поле квалификатора; max — подсказка спиннеру, настоящую границу держит validateQualifiers. */
		function qualifierInput(host, label, value, field, onInput, max) {
			const input = el('input', 'edit-input dcs-input-number');
			input.type = 'number';
			input.min = '0';
			if (max !== undefined) {
				input.max = String(max);
			}
			input.step = '1';
			input.value = value === undefined || value === null ? '' : String(value);
			input.disabled = readOnly;
			input.addEventListener('input', () => {
				onInput(input.value.trim());
			});
			formRow(host, label, input);
			const error = el('div', 'dcs-type-qerror');
			error.setAttribute('aria-live', 'polite');
			host.appendChild(error);
			qualifierErrors[field] = { el: error, input: input };
			return input;
		}

		function qualifierSelect(host, label, options, value, field, onChange) {
			const select = selectInput(options, value);
			select.disabled = readOnly;
			select.addEventListener('change', () => {
				onChange(select.value);
			});
			formRow(host, label, select);
			const error = el('div', 'dcs-type-qerror');
			host.appendChild(error);
			qualifierErrors[field] = { el: error, input: select };
			return select;
		}

		/** Пишет поле квалификатора в копию типа: объект квалификатора новый — прочитанный не трогается. */
		function setQualifier(key, name, value) {
			const next = Object.assign({}, state.type[key] || {});
			next[name] = value;
			state.type[key] = next;
			qualifiersChanged();
		}

		/**
		 * Панель квалификаторов строится заново, только когда сменился состав отмеченных
		 * примитивов: иначе ввод длины перерисовывал бы поле под курсором.
		 */
		function renderQualifiers() {
			const present = QUALIFIED_PRIMITIVES.filter((type) => state.type.types.indexOf(type) >= 0);
			const signature = present.join('|');
			if (signature === qualifiersSignature) {
				return;
			}
			qualifiersSignature = signature;
			qualifiersHost.textContent = '';
			qualifierErrors = {};
			if (present.indexOf('xs:string') >= 0) {
				const q = state.type.stringQualifiers || {};
				groupTitle(qualifiersHost, 'Строка');
				qualifierInput(qualifiersHost, 'Длина (0 — неограниченная)', q.length, 'stringQualifiers.length', (value) => {
					setQualifier('stringQualifiers', 'length', value);
				});
				qualifierSelect(
					qualifiersHost,
					'Допустимая длина',
					ALLOWED_LENGTH_OPTIONS,
					qualifierConstant(q.allowedLength, 'VARIABLE'),
					'stringQualifiers.allowedLength',
					(value) => {
						setQualifier('stringQualifiers', 'allowedLength', value);
					}
				);
			}
			if (present.indexOf('xs:decimal') >= 0) {
				const q = state.type.numberQualifiers || {};
				groupTitle(qualifiersHost, 'Число');
				qualifierInput(
					qualifiersHost,
					'Разрядность',
					q.digits,
					'numberQualifiers.digits',
					(value) => {
						setQualifier('numberQualifiers', 'digits', value);
					},
					typeRules.MAX_DIGITS
				);
				qualifierInput(qualifiersHost, 'Дробная часть', q.fractionDigits, 'numberQualifiers.fractionDigits', (value) => {
					setQualifier('numberQualifiers', 'fractionDigits', value);
				});
				const sign = checkbox('Неотрицательное', qualifierConstant(q.allowedSign, 'ANY') === 'NONNEGATIVE');
				sign.input.disabled = readOnly;
				sign.input.addEventListener('change', () => {
					setQualifier('numberQualifiers', 'allowedSign', sign.input.checked ? 'NONNEGATIVE' : 'ANY');
				});
				checkRow(qualifiersHost, [sign]);
			}
			if (present.indexOf('xs:dateTime') >= 0) {
				const q = state.type.dateQualifiers || {};
				groupTitle(qualifiersHost, 'Дата');
				qualifierSelect(
					qualifiersHost,
					'Состав даты',
					DATE_FRACTIONS_OPTIONS,
					qualifierConstant(q.dateFractions, 'DATE_TIME'),
					'dateQualifiers.dateFractions',
					(value) => {
						setQualifier('dateQualifiers', 'dateFractions', value);
					}
				);
			}
		}

		/** Ошибки квалификаторов — у своего поля; общие (квалификатор без типа) — у первого поля вида. */
		function paintQualifierErrors() {
			const errors = typeRules.validateQualifiers(state.type);
			for (const field of Object.keys(qualifierErrors)) {
				const slot = qualifierErrors[field];
				const own = errors.find((error) => error.field === field || field.indexOf(error.field + '.') === 0);
				slot.el.textContent = own ? own.message : '';
				if (own) {
					slot.input.setAttribute('aria-invalid', 'true');
				} else {
					slot.input.removeAttribute('aria-invalid');
				}
			}
			return errors;
		}

		function paintComposite() {
			const items = typeRules.typeItems(state.type).length;
			compositeBox.input.checked = state.composite;
			// Выключить составной при нескольких типах — значит молча выбросить лишние: пусть снимут их сами
			compositeBox.input.disabled = readOnly || state.type.typeIds.length > 0 || (state.composite && items > 1);
			compositeBox.wrap.title =
				state.type.typeIds.length > 0
					? 'Определяемый тип в составной не входит'
					: state.composite && items > 1
						? 'Снимите лишние типы, чтобы выключить составной тип'
						: '';
		}

		function changed() {
			return !typeRules.sameType(source, state.type);
		}

		function paintChangeWarnings() {
			if (changeWarnEl) {
				const warnings = changed() ? spec.warnings || [] : [];
				changeWarnEl.textContent = warnings.join(' ');
			}
			if (valueWarnEl) {
				const change = changed() ? typeRules.valueClearing(state.type, parameter.value, typeDictionary) : null;
				valueWarnEl.textContent = change ? clearingText(change) : '';
			}
		}

		function paintSummary() {
			const text = typeRules.typePresentation(state.type, typeDictionary);
			summaryEl.textContent = 'Итог: ' + (text || 'тип не задан');
		}

		function qualifiersChanged() {
			paintQualifierErrors();
			paintSummary();
			paintChangeWarnings();
		}

		function selectionChanged() {
			renderChips();
			syncTreeChecks();
			renderQualifiers();
			paintQualifierErrors();
			paintComposite();
			paintChangeWarnings();
			paintSummary();
		}

		function renderAll() {
			renderPlates();
			renderTree();
			selectionChanged();
		}

		function build(body) {
			platesHost = el('div', 'dcs-type-plates');
			body.appendChild(platesHost);
			const toolbar = el('div', 'dcs-type-toolbar');
			const search = el('input', 'edit-input dcs-type-search');
			search.type = 'search';
			search.placeholder = 'Поиск типа';
			search.setAttribute('aria-label', 'Поиск типа по имени');
			search.addEventListener('input', () => {
				state.query = search.value;
				renderTree();
			});
			toolbar.appendChild(search);
			compositeBox = checkbox('Составной тип данных', state.composite);
			compositeBox.input.addEventListener('change', () => {
				state.composite = compositeBox.input.checked;
				paintComposite();
			});
			toolbar.appendChild(compositeBox.wrap);
			body.appendChild(toolbar);
			chipsHost = el('div', 'dcs-type-chips');
			chipsHost.setAttribute('aria-label', 'Выбранные типы');
			body.appendChild(chipsHost);
			treeHost = el('div', 'dcs-tree dcs-type-tree');
			treeHost.setAttribute('role', 'tree');
			treeHost.setAttribute('aria-label', 'Типы');
			body.appendChild(treeHost);
			qualifiersHost = el('div', 'dcs-type-qualifiers');
			body.appendChild(qualifiersHost);
			changeWarnEl = el('div', 'dcs-warn dcs-type-warn');
			body.appendChild(changeWarnEl);
			if (parameter) {
				groupTitle(body, 'Значение');
				const value = parameter.value;
				const current = value === undefined ? 'не задано' : valueSummary(value) || 'пустое';
				body.appendChild(el('div', 'dcs-type-value', 'Сейчас: ' + current));
				if (schemaListDropsNil(value)) {
					body.appendChild(el('div', 'dcs-warn dcs-list-nil-warn', SCHEMA_LIST_NIL_WARNING));
				}
				const presentationWarning = schemaListPresentationWarning(value, parameter.valueListAllowed, valueSummary);
				if (presentationWarning) {
					body.appendChild(el('div', 'dcs-warn dcs-list-presentation-warn', presentationWarning));
				}
				valueWarnEl = el('div', 'dcs-warn dcs-type-warn');
				valueWarnEl.setAttribute('aria-live', 'polite');
				body.appendChild(valueWarnEl);
				const listBox = checkbox('Доступен список значений', state.listAllowed);
				listBox.input.disabled = Boolean(spec.readOnlyReason);
				listBox.input.addEventListener('change', () => {
					state.listAllowed = listBox.input.checked;
				});
				checkRow(body, [listBox]);
			}
			summaryEl = el('div', 'dcs-type-summary');
			summaryEl.setAttribute('aria-live', 'polite');
			body.appendChild(summaryEl);
			renderAll();
		}

		function submit(level) {
			if (changed()) {
				const errors = paintQualifierErrors();
				if (errors.length > 0) {
					return errors[0].message;
				}
			}
			const edited = { valueType: state.type };
			if (parameter) {
				edited.valueListAllowed = state.listAllowed;
			}
			return spec.onDone(edited, level);
		}

		// Флажок списка у параметра правится и при типе вне словаря: только сам тип переносится эхом
		const okDisabled = readOnly && !(parameter && !spec.readOnlyReason);
		const level = pushDialog({
			title: spec.title,
			width: 'wide',
			build: build,
			buttons: [
				{ id: 'ok', label: 'ОК', primary: true, disabled: okDisabled, onClick: submit },
				{ id: 'cancel', label: okDisabled ? 'Закрыть' : 'Отмена' },
			],
			onClose: () => {
				if (typeRerender === renderAll) {
					typeRerender = null;
				}
			},
		});
		if (level.isOpen()) {
			typeRerender = renderAll;
		}
		return level;
	}

	/**
	 * ОК окна типа, открытого из таблицы: payload той же функцией, что у диалогов-владельцев; пустой —
	 * закрыть без записи. Отправку делает вызывающий литеральным send — по нему проверки сверяют типы
	 * сообщений с панелью.
	 */
	function submitTypeEdit(original, edited, sendEdit) {
		const result = typeRules.typeEditPayload(original, edited, typeDictionary);
		if (result.error) {
			return result.error;
		}
		if (Object.keys(result.payload).length === 0) {
			closeDialog();
			return undefined;
		}
		return sendEdit(result.payload) ? undefined : BUSY;
	}

	/** Окно типа поля набора из таблицы: правка уходит set-field, у вложенного набора — только просмотр. */
	function openFieldTypeDialog(setName, field, nestedSet) {
		const dataPath = field.dataPath || '';
		closeDialog();
		openTypeDialog({
			title: 'Тип значения поля «' + dataPath + '»',
			valueType: field.valueType,
			readOnlyReason: nestedSet
				? 'поле вложенного набора объединения: правятся поля наборов верхнего уровня.'
				: '',
			warnings: typeOwnerWarnings({ hasInputParameters: field.hasInputParameters }),
			onDone: (edited) =>
				submitTypeEdit({ valueType: field.valueType }, edited, (payload) =>
					send('dcs/set-field', { dataSet: setName, dataPath: dataPath, payload: payload })
				),
		});
	}

	/** Окно типа вычисляемого поля из таблицы: правка уходит set-calculated-field. */
	function openCalculatedTypeDialog(field) {
		const dataPath = field.name || '';
		closeDialog();
		openTypeDialog({
			title: 'Тип значения вычисляемого поля «' + dataPath + '»',
			valueType: field.valueType,
			onDone: (edited) =>
				submitTypeEdit({ valueType: field.valueType }, edited, (payload) =>
					send('dcs/set-calculated-field', { dataPath: dataPath, payload: payload })
				),
		});
	}

	/**
	 * Окно типа параметра из таблицы: тип, блок «Значение» (несовместимое с новым типом значение
	 * очищается) и флажок списка; правка уходит set-parameter.
	 */
	function openParameterTypeDialog(param) {
		const name = param.name || '';
		closeDialog();
		openTypeDialog({
			title: 'Тип значения параметра «' + name + '»',
			valueType: param.valueType,
			parameter: { value: param.valueTyped, valueListAllowed: param.valueListAllowed },
			warnings: typeOwnerWarnings(param),
			onDone: (edited) =>
				submitTypeEdit(parameterOriginal(param), edited, (payload) => send('dcs/set-parameter', { name: name, payload: payload })),
		});
	}

	/**
	 * Строка «Тип» в диалоге поля, вычисляемого поля или параметра: подпись и кнопка, которая
	 * открывает окно типа вторым уровнем стека. Выбранный тип живёт в строке до ОК владельца —
	 * мутацию шлёт он, одной правкой вместе с остальными полями формы.
	 *
	 * options: {title(), fallback?, readOnlyReason?, warnings?, onChange?}. Возвращает
	 * {valueType()} — текущий выбор (до правки — прочитанный тип).
	 */
	function typeRow(body, initial, options) {
		let current = initial;
		let touched = false;
		const box = el('div', 'dcs-type-row');
		const text = el('span', 'dcs-type-text');
		const readOnly = Boolean(options.readOnlyReason) || Boolean(initial && initial.editable === false);
		const button = el('button', 'ghost-btn dcs-btn-small', readOnly ? 'Просмотр…' : 'Изменить…');
		button.type = 'button';
		const buttonTitle = readOnly ? 'Показать тип значения' : 'Выбрать тип значения';
		box.appendChild(text);
		box.appendChild(button);
		formRow(body, 'Тип', box);
		function paint() {
			setNameText(text, typeLabelOf(current, touched ? '' : options.fallback) || 'не задан');
			// Состав определяемого типа — как у ячейки «Тип» таблиц: наведением на подпись и
			// описанием кнопки — подпись в порядок Tab не входит, и читалка услышит состав на кнопке
			text.title = '';
			button.title = buttonTitle;
			text.removeAttribute('aria-description');
			button.removeAttribute('aria-description');
			const composition = typeCompositionOf(current);
			describeComposition(text, composition);
			describeComposition(button, composition);
		}
		paint();
		button.addEventListener('click', () => {
			openTypeDialog({
				title: options.title(),
				valueType: current,
				readOnlyReason: options.readOnlyReason || '',
				warnings: options.warnings || [],
				onDone: (edited, level) => {
					current = edited.valueType;
					touched = true;
					paint();
					level.close();
					if (options.onChange) {
						options.onChange();
					}
					return undefined;
				},
			});
		});
		return {
			valueType: function () {
				return current;
			},
		};
	}

	// ---------- фокус после перерисовки вкладки схемы ----------

	/**
	 * Вкладка схемы рисуется заново целиком после каждой правки: ответ saved несёт новую модель. Узлы с ключом
	 * (data-dcs-key) — поля и флажки ячеек, кнопки, строки списков, текст запроса. После перерисовки фокус
	 * возвращается на узел с тем же ключом, если сама отрисовка его никуда не поставила (дерево наборов ставит
	 * фокус само). Недописанный текст поля, значение которого правка не меняла, переезжает в новое поле вместе с
	 * выделением: правка соседней строки не стирает набранное.
	 */
	const focusKeys = new Map();
	/** Значение, с которым поле ввода нарисовано: по нему видно, что пользователь начал его править. */
	const renderedValues = new WeakMap();
	/**
	 * Переименование, ответ на которое ещё не пришёл: ключи узлов строки содержат имя (путь поля), и после
	 * ответа узел с прежним ключом ищется под новым. {scope, from, to} — ключ вида «вид\nscope\nfrom\n…».
	 */
	let pendingRename = null;

	/** Ключ узла из частей; перевод строки в именах 1С не встречается. */
	function focusKey(parts) {
		return parts.map((part) => String(part)).join('\n');
	}

	function keyed(node, key) {
		node.setAttribute('data-dcs-key', key);
		focusKeys.set(key, node);
		if (node.tagName === 'INPUT' || node.tagName === 'TEXTAREA') {
			renderedValues.set(node, node.value);
		}
		return node;
	}

	/** Ключ после переименования: вторая часть — scope (набор), третья — прежнее имя; иначе null. */
	function renamedFocusKey(key, rename) {
		if (!rename || typeof key !== 'string') {
			return null;
		}
		const parts = key.split('\n');
		if (parts.length < 3 || parts[1] !== rename.scope || parts[2] !== rename.from) {
			return null;
		}
		parts[2] = rename.to;
		return parts.join('\n');
	}

	/** Что запомнить о фокусе до перерисовки: ключ, недописанное значение и выделение поля ввода. */
	function captureFocus(roots) {
		const active = document.activeElement;
		if (!active || active === document.body || typeof active.getAttribute !== 'function') {
			return null;
		}
		if (!roots.some((root) => root.contains(active))) {
			return null;
		}
		const key = active.getAttribute('data-dcs-key');
		if (!key) {
			return null;
		}
		const snap = { key: key };
		if ((active.tagName === 'INPUT' && active.type !== 'checkbox') || active.tagName === 'TEXTAREA') {
			snap.value = active.value;
			snap.rendered = renderedValues.has(active) ? renderedValues.get(active) : active.value;
			snap.start = active.selectionStart;
			snap.end = active.selectionEnd;
			snap.scrollTop = active.scrollTop || 0;
		}
		return snap;
	}

	/** Узел по ключу снимка: прежний ключ, а если строку переименовали — ключ под новым именем. */
	function focusTarget(key) {
		const node = focusKeys.get(key);
		if (node && node.isConnected) {
			return node;
		}
		const renamed = renamedFocusKey(key, pendingRename);
		const moved = renamed ? focusKeys.get(renamed) : null;
		return moved && moved.isConnected ? moved : null;
	}

	function restoreFocus(snap) {
		if (!snap) {
			return;
		}
		const now = document.activeElement;
		// Отрисовка сама поставила фокус (дерево наборов после стрелки): не спорим с ней
		if (now && now !== document.body && now.isConnected) {
			return;
		}
		const node = focusTarget(snap.key);
		if (!node || node.disabled) {
			return;
		}
		if (snap.value !== undefined && snap.value !== snap.rendered && renderedValues.get(node) === snap.rendered) {
			// Пользователь правил поле, а перерисовка пришла от другой правки: набранное остаётся
			node.value = snap.value;
		}
		node.focus();
		if (snap.start !== undefined && typeof node.setSelectionRange === 'function' && typeof snap.start === 'number') {
			const length = String(node.value).length;
			node.setSelectionRange(Math.min(snap.start, length), Math.min(snap.end, length));
		}
		if (snap.scrollTop) {
			node.scrollTop = snap.scrollTop;
		}
	}

	// ---------- кнопки переноса между списками ----------

	/**
	 * Столбец кнопок переноса между двумя списками (> >> < <<) — общий у конструктора запроса и вкладок схемы, чтобы
	 * вид и клавиатура были одни. Подпись — знак, смысл — в title и aria-label: у знака нет слова, которое читалка
	 * назвала бы. items: [{label, title, onClick, unavailable?, note?}]: unavailable — недоступна, но остаётся в обходе
	 * Tab (aria-disabled), щелчок доходит до onClick, и тот говорит, почему; note — вторая строка подсказки и описание
	 * для читалки (причина недоступности). Возвращает {box, buttons}.
	 */
	function transferButtons(host, items) {
		const box = el('div', 'dcs-qd-moves');
		const buttons = items.map((item) => {
			const node = el('button', 'ghost-btn dcs-qd-move', item.label);
			node.type = 'button';
			setTransferState(node, item.title, Boolean(item.unavailable), item.note || '');
			node.addEventListener('click', item.onClick);
			box.appendChild(node);
			return node;
		});
		host.appendChild(box);
		return { box: box, buttons: buttons };
	}

	/** Доступность и подсказка кнопки переноса: меняются без перерисовки (выбор в дереве). */
	function setTransferState(node, title, unavailable, note) {
		node.title = note ? title + '\n' + note : title;
		node.setAttribute('aria-label', title);
		if (note) {
			node.setAttribute('aria-description', spokenReason(note, unavailable));
		} else {
			node.removeAttribute('aria-description');
		}
		if (unavailable) {
			node.setAttribute('aria-disabled', 'true');
		} else {
			node.removeAttribute('aria-disabled');
		}
	}

	// ---------- дерево «Доступные поля» ----------

	/**
	 * Сколько уровней реквизитов по типу раскрывает дерево доступных полей под полем — как конструктор настроек
	 * (WIZARD_TYPE_DEPTH) и деревья полей конструктора запроса: глубже путь вводится в окне «Добавить поле…».
	 */
	const FIELD_TREE_TYPE_DEPTH = 3;

	/** Ключ строки дерева доступных полей: путь без учёта регистра — так сверяет пути платформа. */
	function fieldTreeKey(path) {
		return String(path || '').toLowerCase();
	}

	/**
	 * Дерево доступных полей по узлам каталога подсказки (DcsComplete.buildCatalog: {name, path, kind, title, children};
	 * kind field — поле набора, calc — вычисляемое, folder и path — папка и промежуточный узел пути). Общий компонент
	 * вкладок схемы: «Ресурсы», «Настройки», источник перетаскивания.
	 * - Одна остановка Tab — выбранная строка (без выбора — первая). ↑ ↓ Home End выбирают соседнюю строку без
	 *   перерисовки, → раскрывает (у раскрытой — к первому ребёнку), ← сворачивает (иначе — к родителю), Enter и двойной
	 *   щелчок — onActivate выбранной строки (повтор зажатого Enter — нет). Набора букв для поиска нет: у остальных деревьев редактора его тоже нет.
	 * - Состояние {selected, expanded: Set} — у вызывающего (spec.state): выбор и раскрытые ветки переживают перерисовку
	 *   вкладки. Строки с ключом (keyed) — фокус после перерисовки возвращается на ту же строку.
	 * - У вычисляемого поля — значок «f(x)» (свой текст, не рисунок 1С), в доступном имени — «вычисляемое поле».
	 * spec: {label, nodes, state, keyPrefix, empty, onActivate(node), onSelect?(node), note?(node) — пометка строки,
	 * pickable?(node) — выбирается ли узел полем (по умолчанию — поле набора и вычисляемое: у «Настроек» ещё ресурсы,
	 * параметры данных, системные и пользовательские поля); Enter у невыбираемого узла с детьми раскрывает его,
	 * decorate?(row, node) — крючок источника (атрибуты и обработчики строки), drag?: {id, scope, from?} — дерево как
	 * источник и зона переноса мышью: строка выбираемого узла получает атрибут draggable (вид переноса 'field'),
	 * from — сброс строк других списков на дерево (убрать, как «<»); строка, которую тащили, выбирается, как щелчком},
	 * typeChildren?(node) — реквизиты поля по типу {children, pending} или null (у «Настроек»: Контрагент → Контрагент.ИНН,
	 * не глубже FIELD_TREE_TYPE_DEPTH уровней), requestTypes?(pending) — прочитать недостающие описания (ответ перерисует
	 * дерево; до него под полем — «Загрузка реквизитов…»).
	 * Возвращает {element, selected() — узел или null, select(path, focus), focus(), nodeOf(ключ строки) — узел или null}.
	 */
	function fieldTree(host, spec) {
		const tree = el('div', 'dcs-tree dcs-qd-tree dcs-field-tree');
		tree.setAttribute('role', 'tree');
		tree.setAttribute('aria-label', spec.label);
		host.appendChild(tree);
		const state = spec.state;
		let rows = [];
		let items = new Map();
		// Строка дерева → её ключ (только у источника переноса) и ключ → строка (при первом обращении после отрисовки):
		// перенос и nodeOf узнают узел без обхода строк, а отрисовка их не строит
		const rowKeys = new WeakMap();
		let rowByKey = null;
		const rowOfKey = (key) => {
			if (!rowByKey) {
				rowByKey = new Map(rows.map((row) => [row.key, row]));
			}
			return rowByKey.get(key);
		};
		const pickable = (node) => (spec.pickable ? spec.pickable(node) : node.kind === 'field' || node.kind === 'calc');
		if (spec.drag) {
			// Слушателей у дерева и строк нет: зона — запись у обвязки документа, строке — только атрибут
			dragZone(tree, {
				id: spec.drag.id,
				scope: spec.drag.scope,
				keyOf: (row) => (rowKeys.has(row) ? rowKeys.get(row) : null),
				drag: (key) => {
					const row = rowOfKey(key);
					return row && pickable(row.node) ? 'field' : '';
				},
				pick: (key) => select(key, false),
				from: spec.drag.from,
				place: 'zone',
			});
		}

		/**
		 * Строки дерева по раскрытым веткам. typeDepth — уровень реквизитов по типу (у узлов каталога 0): у поля каталога
		 * реквизиты считаются сразу (spec.typeChildren кэширует), у свёрнутого реквизита стрелку решает его тип
		 * (typeExpandable) — без подсчёта детей на каждую строку. Реквизиты, чьих описаний ещё нет (pending), дают под
		 * раскрытым полем строку «Загрузка реквизитов…» (loading): она не остановка и не выбирается.
		 */
		function visibleRows() {
			const out = [];
			const walk = (nodes, depth, parent, typeDepth) => {
				for (const node of nodes || []) {
					const key = fieldTreeKey(node.path);
					const children = typeDepth === 0 && Array.isArray(node.children) ? node.children : [];
					const wanted = state.expanded.has(key);
					let typed = null;
					let typedExpandable = false;
					if (spec.typeChildren && typeDepth < FIELD_TREE_TYPE_DEPTH) {
						if (typeDepth > 0 && !wanted) {
							typedExpandable = node.typeExpandable === true;
						} else {
							typed = spec.typeChildren(node);
							typedExpandable = Boolean(typed) && (typed.children.length > 0 || typed.pending.length > 0);
						}
					}
					const expandable = children.length > 0 || typedExpandable;
					const open = expandable && wanted;
					out.push({ node: node, key: key, depth: depth, parent: parent, expandable: expandable, open: open });
					if (open) {
						walk(children, depth + 1, key, 0);
						if (typed) {
							walk(typed.children, depth + 1, key, typeDepth + 1);
							if (typed.pending.length > 0) {
								out.push({ loading: true, key: key + '#loading', depth: depth + 1, parent: key, pending: typed.pending });
							}
						}
					}
				}
			};
			walk(spec.nodes, 0, '', 0);
			return out;
		}

		function stopKey() {
			return rows.some((row) => row.key === state.selected) ? state.selected : rows.length > 0 ? rows[0].key : '';
		}

		function paint() {
			tree.textContent = '';
			const drawn = visibleRows();
			rows = drawn.filter((row) => !row.loading);
			items = new Map();
			rowByKey = null;
			if (rows.length === 0) {
				tree.tabIndex = -1;
				tree.appendChild(el('div', 'dcs-qd-empty', spec.empty || ''));
				return;
			}
			tree.removeAttribute('tabindex');
			const stop = stopKey();
			let index = -1;
			for (const row of drawn) {
				if (row.loading) {
					// Описания реквизитов ещё читаются: ответ перерисует дерево (spec.requestTypes)
					const info = el('div', 'dcs-tree-row dcs-wizard-row-info', 'Загрузка реквизитов…');
					info.style.paddingLeft = 4 + row.depth * 14 + 'px';
					info.setAttribute('role', 'treeitem');
					info.setAttribute('aria-level', String(row.depth + 1));
					info.setAttribute('aria-disabled', 'true');
					info.tabIndex = -1;
					tree.appendChild(info);
					if (spec.requestTypes) {
						spec.requestTypes(row.pending);
					}
					continue;
				}
				index += 1;
				paintRow(row, index, stop);
			}
		}

		function paintRow(row, index, stop) {
			const node = row.node;
			const selected = row.key === state.selected;
			const item = el('div', 'dcs-tree-row dcs-qd-row' + (selected ? ' dcs-tree-selected' : ''));
			item.setAttribute('role', 'treeitem');
			item.setAttribute('aria-level', String(row.depth + 1));
			item.setAttribute('aria-selected', String(selected));
			if (row.expandable) {
				item.setAttribute('aria-expanded', String(row.open));
			}
			item.tabIndex = row.key === stop ? 0 : -1;
			item.style.paddingLeft = 4 + row.depth * 14 + 'px';
			const calc = node.kind === 'calc';
			const note = spec.note ? spec.note(node) : '';
			const twist = el('span', 'dcs-tree-twist', row.expandable ? (row.open ? '▾' : '▸') : '');
			twist.setAttribute('aria-hidden', 'true');
			twist.addEventListener('click', (event) => {
				event.stopPropagation();
				if (row.expandable) {
					toggle(row, !row.open);
				}
			});
			item.appendChild(twist);
			const label = item.appendChild(nameEl('span', 'dcs-tree-label', node.name || node.path));
			// Полный путь — подсказкой у подписи, а не у строки: title строки читалка добавила бы к её имени описанием
			if (node.path && node.path !== (node.name || node.path)) {
				label.title = node.path;
			}
			if (calc) {
				const badge = el('span', 'dcs-field-badge', 'f(x)');
				badge.setAttribute('aria-hidden', 'true');
				badge.title = 'Вычисляемое поле';
				item.appendChild(badge);
			}
			if (node.title && node.title !== node.name) {
				item.appendChild(nameEl('span', 'dcs-tree-name', node.title));
			}
			if (note) {
				item.appendChild(nameEl('span', 'dcs-tree-name', note));
			}
			// Имя для читалки: значок «f(x)» скрыт, его смысл — словами
			const spoken = [node.name || node.path];
			if (node.title && node.title !== node.name) {
				spoken.push(node.title);
			}
			if (calc) {
				spoken.push('вычисляемое поле');
			}
			if (note) {
				spoken.push(note);
			}
			item.setAttribute('aria-label', spoken.join(', '));
			keyed(item, focusKey([spec.keyPrefix, row.key]));
			item.addEventListener('click', () => select(row.key, false));
			// Выбор идёт за фокусом: Tab в дерево выбирает строку-остановку, и «>» сразу знает, что переносить
			item.addEventListener('focus', () => {
				if (state.selected !== row.key) {
					select(row.key, false);
				}
			});
			item.addEventListener('dblclick', () => {
				select(row.key, false);
				activate(row);
			});
			item.addEventListener('keydown', (event) => onKey(event, row, index));
			if (spec.decorate) {
				spec.decorate(item, node);
			}
			if (spec.drag) {
				rowKeys.set(item, row.key);
				if (pickable(node)) {
					item.draggable = true;
				}
			}
			items.set(row.key, item);
			tree.appendChild(item);
		}

		function activate(row) {
			if (row.expandable && !pickable(row.node)) {
				// У папки действия нет: Enter раскрывает и сворачивает её, как в остальных деревьях
				toggle(row, !row.open);
				return;
			}
			spec.onActivate(row.node);
		}

		function toggle(row, open) {
			if (open) {
				state.expanded.add(row.key);
			} else {
				state.expanded.delete(row.key);
			}
			state.selected = row.key;
			paint();
			focusRow(row.key);
			if (spec.onSelect) {
				spec.onSelect(row.node);
			}
		}

		function focusRow(key) {
			const item = items.get(key);
			if (item) {
				item.focus();
			}
		}

		/** Выбор без перерисовки: классы, aria-selected и остановка Tab переезжают на новую строку. */
		function select(key, focus) {
			if (!items.has(key)) {
				return;
			}
			state.selected = key;
			for (const [rowKey, item] of items) {
				const on = rowKey === key;
				item.classList.toggle('dcs-tree-selected', on);
				item.setAttribute('aria-selected', String(on));
				item.tabIndex = on ? 0 : -1;
			}
			if (focus) {
				focusRow(key);
			}
			if (spec.onSelect) {
				const row = rows.find((candidate) => candidate.key === key);
				spec.onSelect(row ? row.node : null);
			}
		}

		function onKey(event, row, index) {
			if (event.defaultPrevented) {
				return;
			}
			let to = -1;
			if (event.key === 'ArrowDown') {
				to = Math.min(rows.length - 1, index + 1);
			} else if (event.key === 'ArrowUp') {
				to = Math.max(0, index - 1);
			} else if (event.key === 'Home') {
				to = 0;
			} else if (event.key === 'End') {
				to = rows.length - 1;
			} else if (event.key === 'ArrowRight') {
				event.preventDefault();
				if (row.expandable && !row.open) {
					toggle(row, true);
				} else if (row.open && rows[index + 1] && rows[index + 1].parent === row.key) {
					// Под раскрытым полем может быть только «Загрузка реквизитов…» — тогда шагать некуда
					select(rows[index + 1].key, true);
				}
				return;
			} else if (event.key === 'ArrowLeft') {
				event.preventDefault();
				if (row.open) {
					toggle(row, false);
				} else if (row.parent) {
					select(row.parent, true);
				}
				return;
			} else if (event.key === 'Enter') {
				event.preventDefault();
				// Повтор зажатой клавиши не активирует строку снова: на «Ресурсах» каждое Enter сразу пишет ресурс в файл
				if (event.repeat) {
					return;
				}
				select(row.key, false);
				activate(row);
				return;
			} else {
				return;
			}
			event.preventDefault();
			select(rows[to].key, true);
		}

		paint();
		return {
			element: tree,
			selected: () => {
				const row = rows.find((candidate) => candidate.key === state.selected);
				return row ? row.node : null;
			},
			select: (path, focus) => select(fieldTreeKey(path), Boolean(focus)),
			focus: () => focusRow(stopKey()),
			nodeOf: (key) => {
				const row = rowOfKey(key);
				return row ? row.node : null;
			},
		};
	}

	// ---------- вкладка «Наборы данных» ----------
	// Как в конфигураторе: слева дерево наборов (объединения раскрываются), справа — выбранный набор.

	/** Выбранный набор: имена от верхнего уровня; длиннее одного — набор внутри объединения. */
	let dataSetPath = [];
	/** Свёрнутые объединения дерева; ключ — путь имён через «/» (в именах 1С косой черты нет). */
	const collapsedSets = new Set();
	/** Набор, который выбрать после ответа правки: новый или переименованный. */
	let pendingDataSet = '';
	/** Вернуть фокус на выбранную строку дерева после перерисовки (навигация с клавиатуры). */
	let focusSetTree = false;
	/** Горизонтальная прокрутка таблицы полей: переживает перерисовку после правки флажка. */
	let fieldsScrollLeft = 0;

	function setKey(names) {
		return names.join('/');
	}

	function dataSetAt(names) {
		let items = list('dataSets');
		let found = null;
		for (const name of names) {
			found = items.find((candidate) => (candidate.name || '') === name) || null;
			if (!found) {
				return null;
			}
			items = Array.isArray(found.items) ? found.items : [];
		}
		return found;
	}

	/** Выбор переживает перечитку модели; пропавший набор уступает ближайшему предку или первому. */
	function ensureDataSetSelection() {
		// Набора ещё нет — ответ правки не пришёл (перерисовка от фоновой записи запроса): ждём ответа, его
		// обработчик и снимает pendingDataSet
		if (pendingDataSet && dataSetAt([pendingDataSet])) {
			dataSetPath = [pendingDataSet];
			pendingDataSet = '';
		}
		while (dataSetPath.length > 0 && !dataSetAt(dataSetPath)) {
			dataSetPath = dataSetPath.slice(0, -1);
		}
		if (dataSetPath.length === 0) {
			const first = list('dataSets').find((candidate) => candidate.name);
			dataSetPath = first ? [first.name] : [];
		}
	}

	/** Строки дерева в порядке показа: для стрелок вверх и вниз. */
	function visibleSetPaths() {
		const paths = [];
		function walk(items, prefix) {
			for (const item of items) {
				if (!item.name) {
					continue;
				}
				const names = prefix.concat([item.name]);
				paths.push(names);
				const children = Array.isArray(item.items) ? item.items : [];
				if (children.length > 0 && !collapsedSets.has(setKey(names))) {
					walk(children, names);
				}
			}
		}
		walk(list('dataSets'), []);
		return paths;
	}

	function selectDataSet(names, keepFocus) {
		// Правленый текст запроса записывается до смены набора: обычно его уже записал уход фокуса
		flushQueryEdits('nav');
		if (setKey(names) !== setKey(dataSetPath)) {
			fieldsScrollLeft = 0;
		}
		dataSetPath = names;
		focusSetTree = Boolean(keepFocus);
		renderContent();
	}

	function renderDataSets(host) {
		ensureDataSetSelection();
		const layout = el('div', 'dcs-sets');
		const side = el('div', 'dcs-sets-side');
		renderDataSetTree(side);
		renderDataSources(side);
		layout.appendChild(side);
		const body = el('div', 'dcs-sets-body');
		const selected = dataSetPath.length > 0 ? dataSetAt(dataSetPath) : null;
		if (selected) {
			renderDataSetBody(body, selected, dataSetPath.length > 1);
		} else {
			emptyNote(body, 'Наборов данных нет: добавьте набор кнопкой «+ Добавить» над деревом.');
		}
		layout.appendChild(body);
		host.appendChild(layout);
		// Прокрутку можно вернуть только элементу в документе
		const fieldsWrap = body.querySelector('.dcs-fields-wrap');
		if (fieldsWrap && fieldsScrollLeft > 0) {
			fieldsWrap.scrollLeft = fieldsScrollLeft;
		}
		if (focusSetTree) {
			focusSetTree = false;
			const row = side.querySelector('.dcs-tree-selected');
			if (row) {
				row.focus();
			}
		}
	}

	function renderDataSetTree(host) {
		const bar = el('div', 'dcs-tree-toolbar dcs-sets-toolbar');
		// Ключи панели и строк дерева: фокус на них переживает перерисовку вкладки по ответу правки
		bar.appendChild(keyed(addSetControl(), focusKey(['settool', 'add'])));
		const topName = dataSetPath.length === 1 ? dataSetPath[0] : '';
		const nestedHint = dataSetPath.length > 1 ? 'Наборы внутри объединения только просматриваются' : '';
		// Пиктограммы: название — в подсказке и доступном имени, клавиша дерева — только в подсказке; недоступные —
		// disabled
		bar.appendChild(
			keyed(
				iconButton({
					icon: 'rename',
					name: 'Переименовать выбранный набор',
					shortcut: 'F2',
					note: nestedHint,
					disabled: !topName,
					className: 'ghost-btn dcs-btn-small dcs-sets-icon',
					onClick: () => {
						if (topName) {
							openRenameDataSetDialog(topName);
						}
					},
				}),
				focusKey(['settool', 'rename'])
			)
		);
		bar.appendChild(
			keyed(
				iconButton({
					icon: 'delete',
					name: 'Удалить выбранный набор',
					shortcut: 'Delete',
					note: nestedHint,
					disabled: !topName,
					className: 'ghost-btn dcs-btn-small dcs-btn-danger dcs-sets-icon',
					onClick: () => {
						if (topName) {
							askRemoveDataSet(topName);
						}
					},
				}),
				focusKey(['settool', 'delete'])
			)
		);
		host.appendChild(bar);

		const tree = el('div', 'dcs-tree dcs-sets-tree');
		tree.setAttribute('role', 'tree');
		tree.setAttribute('aria-label', 'Наборы данных');
		const root = el('div', 'dcs-tree-row dcs-tree-root');
		root.appendChild(el('span', 'dcs-tree-twist', '▾'));
		root.appendChild(nameEl('span', 'dcs-tree-label', 'Наборы данных'));
		tree.appendChild(root);
		appendSetRows(tree, list('dataSets'), [], 1);
		host.appendChild(tree);
	}

	function appendSetRows(tree, items, prefix, depth) {
		for (const item of items) {
			if (!item.name) {
				continue;
			}
			const names = prefix.concat([item.name]);
			const key = setKey(names);
			const children = Array.isArray(item.items) ? item.items : [];
			const expandable = children.length > 0;
			const expanded = expandable && !collapsedSets.has(key);
			const selected = key === setKey(dataSetPath);
			const row = el('div', 'dcs-tree-row' + (selected ? ' dcs-tree-selected' : ''));
			row.style.paddingLeft = 8 + depth * 16 + 'px';
			// Одна точка входа в дерево с клавиатуры: фокусируется только выбранная строка
			row.tabIndex = selected ? 0 : -1;
			keyed(row, focusKey(['set', key]));
			row.setAttribute('role', 'treeitem');
			row.setAttribute('aria-selected', String(selected));
			if (expandable) {
				row.setAttribute('aria-expanded', String(expanded));
			}
			const twist = el('span', 'dcs-tree-twist', expandable ? (expanded ? '▾' : '▸') : '');
			if (expandable) {
				twist.addEventListener('click', (event) => {
					event.stopPropagation();
					toggleSet(key, expanded);
				});
			}
			row.appendChild(twist);
			row.appendChild(nameEl('span', 'dcs-tree-label', item.name));
			if (item.type) {
				row.appendChild(el('span', 'dcs-tree-name dcs-tree-kind', kindLabel(item.type).toLowerCase()));
			}
			const count = Array.isArray(item.fields) ? item.fields.length : 0;
			if (count > 0) {
				const badge = el('span', 'dcs-tree-badge', String(count));
				badge.title = 'Полей: ' + count;
				row.appendChild(badge);
			}
			row.addEventListener('click', () => {
				selectDataSet(names, false);
			});
			row.addEventListener('keydown', (event) => {
				onSetTreeKey(event, names, expandable, expanded);
			});
			tree.appendChild(row);
			if (expanded) {
				appendSetRows(tree, children, names, depth + 1);
			}
		}
	}

	function toggleSet(key, expanded) {
		if (expanded) {
			collapsedSets.add(key);
			// Выбор внутри сворачиваемого объединения переходит на само объединение
			if (setKey(dataSetPath).startsWith(key + '/')) {
				dataSetPath = key.split('/');
			}
		} else {
			collapsedSets.delete(key);
		}
		focusSetTree = true;
		renderContent();
	}

	function onSetTreeKey(event, names, expandable, expanded) {
		const key = setKey(names);
		if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
			event.preventDefault();
			const paths = visibleSetPaths();
			const index = paths.findIndex((candidate) => setKey(candidate) === key);
			const next = paths[index + (event.key === 'ArrowDown' ? 1 : -1)];
			if (next) {
				selectDataSet(next, true);
			}
		} else if (event.key === 'ArrowRight' && expandable && !expanded) {
			event.preventDefault();
			toggleSet(key, false);
		} else if (event.key === 'ArrowLeft') {
			event.preventDefault();
			if (expandable && expanded) {
				toggleSet(key, true);
			} else if (names.length > 1) {
				selectDataSet(names.slice(0, -1), true);
			}
		} else if (event.key === 'Delete' && names.length === 1) {
			event.preventDefault();
			askRemoveDataSet(names[0]);
		} else if (event.key === 'F2' && names.length === 1) {
			event.preventDefault();
			openRenameDataSetDialog(names[0]);
		}
	}

	function askRemoveDataSet(name) {
		confirmRemove('Удалить набор данных «' + name + '»?', () => {
			if (!send('dcs/remove-data-set', { name: name })) {
				return BUSY;
			}
			return undefined;
		});
	}

	/** Источники данных — под деревом: их немного, и правятся они не здесь. */
	function renderDataSources(host) {
		const sources = list('dataSources');
		if (sources.length === 0) {
			return;
		}
		const box = el('div', 'dcs-sets-sources');
		box.appendChild(el('div', 'dcs-sets-caption', 'Источники данных'));
		listSection(
			box,
			sources.map((source) => ({
				name: source.name || '',
				value: source.type || '',
				right: source.connectionString || '',
			}))
		);
		host.appendChild(box);
	}

	/** Меню добавления набора: вид выбирается пунктом, как в конфигураторе. */
	function addSetControl() {
		const select = el('select', 'edit-ref-add-select');
		const first = document.createElement('option');
		first.value = '';
		first.textContent = '+ Добавить';
		select.title = 'Добавить набор данных';
		select.appendChild(first);
		for (const kind of ['query', 'object', 'union']) {
			const option = document.createElement('option');
			option.value = kind;
			option.textContent = kindLabel(kind);
			select.appendChild(option);
		}
		// Стрелки на закрытом списке только выбирают вид, окно открывает Enter или выбор мышью (actionSelect)
		actionSelect(select, (type) => {
			openAddDataSetDialog(type);
		});
		return select;
	}

	function sourceOptions() {
		const names = list('dataSources')
			.map((source) => source.name || '')
			.filter(Boolean);
		if (names.length === 0) {
			names.push('ИсточникДанных1');
		}
		return names.map((name) => ({ value: name, label: name }));
	}

	function openAddDataSetDialog(type) {
		const names = dataSetNames();
		const options = sourceOptions();
		let nameInput;
		let sourceSelect;
		openDialog(
			'Новый набор данных: ' + kindLabel(type).toLowerCase(),
			'Добавить',
			(body) => {
				nameInput = formRow(body, 'Имя', textInput(suggestName('НаборДанных', names)));
				sourceSelect = formRow(body, 'Источник данных', selectInput(options, options[0].value));
			},
			() => {
				const name = nameInput.value.trim();
				if (!name) {
					return 'Укажите имя набора.';
				}
				if (nameTaken(names, name)) {
					return 'Набор с таким именем уже есть.';
				}
				if (!send('dcs/add-data-set', { name: name, dataSetType: type, dataSource: sourceSelect.value })) {
					return BUSY;
				}
				pendingDataSet = name;
				return undefined;
			}
		);
	}

	function openRenameDataSetDialog(name) {
		const names = dataSetNames();
		let nameInput;
		openDialog(
			'Переименование набора «' + name + '»',
			'Сохранить',
			(body) => {
				nameInput = formRow(body, 'Новое имя', textInput(name));
			},
			() => {
				const newName = nameInput.value.trim();
				if (!newName) {
					return 'Укажите имя набора.';
				}
				if (newName === name) {
					closeDialog();
					return undefined;
				}
				if (nameTaken(names, newName, name)) {
					return 'Набор с таким именем уже есть.';
				}
				if (!send('dcs/rename-data-set', { name: name, newName: newName })) {
					return BUSY;
				}
				if (dataSetPath[0] === name) {
					pendingDataSet = newName;
				}
				return undefined;
			}
		);
	}

	/** Содержимое выбранного набора; набор внутри объединения показывается только для чтения. */
	function renderDataSetBody(host, dataSet, nested) {
		const head = el('div', 'dcs-set-head');
		head.appendChild(nameEl('span', 'dcs-set-title', dataSet.name || ''));
		if (dataSet.type) {
			head.appendChild(el('span', 'dcs-kind', kindLabel(dataSet.type)));
		}
		host.appendChild(head);
		if (nested) {
			// Мутации md-sparrow адресуют наборы верхнего уровня: правка здесь испортила бы соседей
			host.appendChild(
				el(
					'div',
					'dcs-plate',
					'Набор внутри объединения «' +
						dataSetPath[0] +
						'» доступен только для просмотра: правятся наборы верхнего уровня.'
				)
			);
		} else {
			const props = dataSetProps(dataSet);
			if (props.childElementCount > 0) {
				host.appendChild(props);
			}
		}
		// Наборы объединения видны в дереве слева: строка нужна только пустому объединению
		if (dataSet.type === 'union' && !(Array.isArray(dataSet.items) && dataSet.items.some((item) => item && item.name))) {
			host.appendChild(el('div', 'dcs-sets-note', 'В объединении нет наборов.'));
		}
		host.appendChild(el('div', 'dcs-sets-caption', 'Поля'));
		renderFieldsTable(host, dataSet, nested);
		if (typeof dataSet.query === 'string') {
			renderQueryEditor(host, dataSet, nested);
		}
	}

	/**
	 * Текст запроса набора. Текст записывается, когда правка закончена, — поле теряет фокус (и перед сменой набора,
	 * закладки, открытием конструктора, уходом со страницы), а поля заполняются следом, если у набора включено
	 * «Автозаполнение».
	 * Правленый текст живёт в queryDrafts и переживает перерисовку; под полем — ошибки текста и отказ записи.
	 */
	function renderQueryEditor(host, dataSet, readOnly) {
		const setName = dataSet.name || '';
		const key = setKey(dataSetPath);
		host.appendChild(el('div', 'dcs-sets-caption', 'Запрос'));
		const draft = readOnly ? null : queryDrafts.get(key) || null;
		const editor = codeEditor(draft ? draft.text : dataSet.query, 'dcs-query');
		editor.input.readOnly = readOnly;
		editor.input.setAttribute('aria-label', 'Текст запроса набора ' + setName);
		host.appendChild(editor.box);
		// Ошибки текста и записи — первой строкой под полем, предупреждения проверки имён — за ними
		const status = el('div', 'dcs-query-status');
		status.id = 'dcsQueryStatus';
		editor.box.appendChild(status);
		const rebaseNames = attachNameCheck(editor.box, editor.input, dataSet.query);
		const described = [status.id];
		if (editor.input.getAttribute('aria-describedby')) {
			described.push(editor.input.getAttribute('aria-describedby'));
		}
		editor.input.setAttribute('aria-describedby', described.join(' '));
		if (readOnly) {
			// Текст набора внутри объединения правится только конструктором: он пишет запрос по пути
			// «Объединение/Дочерний» (dcs/apply-query), а поля такого набора остаются только для чтения
			renderQueryStatus(status, key, editor.input.value, false);
			const readOnlyActions = el('div', 'dcs-actions');
			readOnlyActions.appendChild(queryConstructorButton(dataSet, key, editor.input));
			host.appendChild(readOnlyActions);
			return;
		}
		keyed(editor.input, focusKey(['query', key]));
		// В тексте запроса подсказываются только &-параметры: буквы список не открывают,
		// иначе он всплывал бы на каждом слове ВЫБРАТЬ … ИЗ
		const completion = attachCompletion(editor.input, () => 'query', { letters: false });
		// «⋯» — следующая остановка Tab после поля: фокус на ней переживает перерисовку по ответу записи
		keyed(completion.more, focusKey(['qmore', key]));
		const autoFill = dataSet.autoFillFields === true;
		const repaint = () => renderQueryStatus(status, key, editor.input.value, autoFill, editor.input);
		repaint();
		queryStatusRefresh = { key: key, repaint: repaint, rebase: rebaseNames || null };
		let timer = 0;
		editor.input.addEventListener('input', () => {
			noteQueryDraft(key, editor.input.value);
			if (timer) {
				clearTimeout(timer);
			}
			timer = setTimeout(() => {
				timer = 0;
				if (status.isConnected) {
					repaint();
				}
			}, NAME_CHECK_DEBOUNCE_MS);
		});
		editor.input.addEventListener('blur', () => {
			// Поле, которое убирает перерисовка, правку не заканчивает: фокус вернётся в новое поле (restoreFocus)
			if (renderingContent || !editor.input.isConnected) {
				return;
			}
			// Окно потеряло фокус (щелчок в проводнике VS Code, другое приложение): браузер шлёт blur и полю, но правка
			// не закончена — пишется только текст, без заполнения полей и без повтора отклонённого
			const mode = windowHasFocus() ? 'edit' : 'passive';
			const emptyRefused = commitQueryDraft(key, mode);
			if (!status.isConnected) {
				return;
			}
			const state = repaint();
			if (mode !== 'edit' || !state) {
				return;
			}
			// Строка под полем живой областью не сделана (шумела бы при наборе): о том, что текст не ушёл или в нём
			// ошибка, читалка слышит один раз — при уходе из поля
			if (emptyRefused) {
				showNotice('error', 'Запрос не сохранён', [{ text: EMPTY_QUERY_PROBLEM }]);
			} else if (state.kind === 'parse') {
				announceCompletion('');
				announceCompletion(state.text);
			}
		});
		const actions = el('div', 'dcs-actions');
		actions.appendChild(queryConstructorButton(dataSet, setName, editor.input));
		host.appendChild(actions);
	}

	// ---------- запись текста запроса по концу правки ----------

	/**
	 * Правленый и ещё не записанный текст запроса по пути набора (setKey): {text, base, retry}. base — текст модели,
	 * от которого правка ушла: если модель сменила текст иначе (окно конструктора записало свой), черновик уступает.
	 * retry — запись просили, пока шла другая правка (вид конца правки: 'edit', 'nav', 'passive'): она уйдёт после ответа.
	 */
	const queryDrafts = new Map();
	/**
	 * Отказ записи текста или заполнения полей по пути набора: {text, message, refused}; виден под полем, пока текст тот
	 * же. refused — md-sparrow не принял сам текст: его повторяет только уход из поля внутри страницы (отказ мог быть
	 * временным: файл занят), а не уход из окна, смена набора или закладки.
	 */
	const queryErrors = new Map();
	/**
	 * Наборы, чей текст записан, а поля по нему при включённом «Автозаполнении» ещё не заполнены: текст ушёл при уходе
	 * из окна (в поле могло остаться недописанное «Т.Ном», а md-sparrow поля только добавляет — лишнее пришлось бы
	 * удалять руками), заполнение получило отказ, «Автозаполнение» только что включили. Заполнение уходит при следующем
	 * конце правки внутри страницы, у включённого флажка — сразу после его записи. {retry} — канал был занят: после ответа.
	 */
	const pendingFills = new Map();
	/** Выражения, которые заполнение пропустило в прошлый раз (по набору): те же причины плашкой не повторяются. */
	const lastFillSkips = new Map();
	/** Строка под полем открытого набора: {key, repaint, rebase(text) — записанный текст для проверки имён}. */
	let queryStatusRefresh = null;
	/** Идёт перерисовка содержимого вкладки: blur убираемого поля — не конец правки. */
	let renderingContent = false;

	const EMPTY_QUERY_PROBLEM = 'Запрос пуст — пустой текст не сохраняется.';

	/** Текст запроса набора по пути в текущей модели; null — набора нет или это не набор-запрос. */
	function queryTextAt(key) {
		const dataSet = key ? dataSetAt(key.split('/')) : null;
		return dataSet && typeof dataSet.query === 'string' ? dataSet.query : null;
	}

	/**
	 * Первая ошибка разбора текста (разборщик конструктора): {line, message} или null. Внутренняя ошибка разборщика —
	 * не ошибка текста: о ней молчим, а платформа и md-sparrow разберут текст сами.
	 */
	function queryParseProblem(text) {
		if (String(text).trim() === '') {
			return null;
		}
		const parsed = parseQueryCached(text);
		const first = parsed && parsed.diagnostics.find((item) => !item.internal);
		if (!first) {
			return null;
		}
		const line = typeof first.offset === 'number' ? text.slice(0, first.offset).split('\n').length : first.line || 1;
		return { line: line, message: String(first.message || '') };
	}

	/**
	 * Строка под полем: отказ записи этого текста, пустой текст или ошибка разбора; иначе пусто. kind — откуда: saved
	 * (отказ md-sparrow или пустой текст не ушёл), empty, parse.
	 */
	function queryStatusText(key, text, autoFill) {
		const error = queryErrors.get(key);
		if (error && error.text === text) {
			return { tone: 'error', text: error.message, kind: 'saved' };
		}
		if (String(text).trim() === '') {
			return queryDrafts.has(key) ? { tone: 'error', text: EMPTY_QUERY_PROBLEM, kind: 'empty' } : null;
		}
		const problem = queryParseProblem(text);
		if (problem) {
			const message = problem.message.replace(/[.\s]+$/, '');
			return {
				tone: 'error',
				text: 'Ошибка в запросе, строка ' + problem.line + ': ' + message + '.' + (autoFill ? ' Поля по нему не заполняются, пока ошибка есть.' : ''),
				kind: 'parse',
			};
		}
		return null;
	}

	/** Строка под полем и признак aria-invalid поля: ошибка видна глазу и слышна читалке на самом поле. */
	function renderQueryStatus(line, key, text, autoFill, input) {
		const state = queryStatusText(key, text, autoFill);
		line.textContent = state ? state.text : '';
		line.className = 'dcs-query-status' + (state ? ' dcs-query-status-' + state.tone : '');
		if (input) {
			if (state && state.tone === 'error') {
				input.setAttribute('aria-invalid', 'true');
			} else {
				input.removeAttribute('aria-invalid');
			}
		}
		return state;
	}

	/** Строка под полем открытого набора по новому состоянию (отказ записи, ответ). */
	function refreshQueryStatus(key) {
		if (queryStatusRefresh && queryStatusRefresh.key === key) {
			queryStatusRefresh.repaint();
		}
	}

	/** Набранный текст — черновик набора; текст модели черновиком не считается, пока его не пишет фоновая запись. */
	function noteQueryDraft(key, text) {
		const current = queryTextAt(key);
		if (current === null) {
			return;
		}
		const draft = queryDrafts.get(key);
		// Пока уходит прежняя правка этого текста, черновик держится и при возврате к тексту модели: ответ сменит
		// модель на отправленный текст, и только черновик помнит, что пользователь вернул старый
		if (text === current && !(background && background.key === key)) {
			queryDrafts.delete(key);
			return;
		}
		if (draft) {
			draft.text = text;
		} else {
			queryDrafts.set(key, { text: text, base: current, retry: false });
		}
	}

	/** Сила конца правки: отложенная запись (retry) уходит с самым сильным из тех, что о ней просили. */
	const COMMIT_RANK = { passive: 0, nav: 1, edit: 2 };

	/**
	 * Конец правки текста набора: записать черновик, если текст изменился. Пустой текст не уходит (md-sparrow его не
	 * примет) — под полем причина, черновик остаётся. Занятый канал откладывает запись до ответа (retry). Запись —
	 * сообщение setQuery; при «Автозаполнении» за ним — dcs/autofill-fields, но только если в тексте нет ошибки
	 * разбора. mode — откуда конец правки:
	 * - 'edit' (по умолчанию) — поле потеряло фокус внутри страницы: отклонённый текст уходит снова (отказ мог быть
	 *   временным), а без черновика уходит отложенное заполнение (pendingFills);
	 * - 'nav' — смена набора или закладки, «Конструктор…», «Проверить схему»: то же, но отклонённый и с тех пор не
	 *   изменённый текст не повторяется — иначе каждая стрелка в дереве наборов слала бы тот же отказ;
	 * - 'passive' — уход из окна, скрытие и закрытие страницы: правка не закончена, пишется только текст (набранное не
	 *   теряется), поля заполнятся при следующем конце правки; отклонённый текст не повторяется.
	 * Возвращает true, если пустой текст не ушёл (вызывающий скажет об этом).
	 */
	function commitQueryDraft(key, mode) {
		const how = mode === 'nav' || mode === 'passive' ? mode : 'edit';
		const draft = queryDrafts.get(key);
		if (!draft) {
			if (how !== 'passive') {
				startPendingFill(key);
			}
			return false;
		}
		const refusal = queryErrors.get(key);
		if (how !== 'edit' && refusal && refusal.refused && refusal.text === draft.text) {
			return false;
		}
		const current = queryTextAt(key);
		if (current === null) {
			queryDrafts.delete(key);
			return false;
		}
		if (draft.text === current && !(background && background.key === key)) {
			queryDrafts.delete(key);
			queryErrors.delete(key);
			if (how !== 'passive') {
				startPendingFill(key);
			}
			return false;
		}
		if (draft.text.trim() === '') {
			queryErrors.set(key, { text: draft.text, message: EMPTY_QUERY_PROBLEM });
			refreshQueryStatus(key);
			return true;
		}
		if (background && background.key === key && background.text === draft.text) {
			return false;
		}
		if (saving) {
			if (!draft.retry || COMMIT_RANK[how] > COMMIT_RANK[draft.retry]) {
				draft.retry = how;
			}
			return false;
		}
		draft.retry = false;
		const dataSet = dataSetAt(key.split('/'));
		const fill = Boolean(dataSet && dataSet.autoFillFields === true) && !queryParseProblem(draft.text);
		// Новый текст заполнит сам (или его заполнение отложится заново): прежнее отложенное заполнение не нужно
		pendingFills.delete(key);
		background = {
			key: key,
			text: draft.text,
			autofill: fill && how !== 'passive',
			fillLater: fill && how === 'passive',
			stage: 'text',
		};
		postEdit('setQuery', { dataSet: key, text: draft.text });
		setStatus('Сохраняем запрос…', false);
		return false;
	}

	/**
	 * Отложенное заполнение набора (pendingFills): уходит фоновой записью, если «Автозаполнение» включено, текст
	 * модели не пуст и разбирается; канал занят — после ответа. Черновик набора заполнит сам, когда уйдёт.
	 */
	function startPendingFill(key) {
		const pending = pendingFills.get(key);
		if (!pending || queryDrafts.has(key)) {
			return;
		}
		const dataSet = dataSetAt(key.split('/'));
		const text = dataSet && typeof dataSet.query === 'string' ? dataSet.query : '';
		if (!dataSet || dataSet.autoFillFields !== true || text.trim() === '' || queryParseProblem(text)) {
			pendingFills.delete(key);
			return;
		}
		if (saving) {
			pending.retry = true;
			return;
		}
		pendingFills.delete(key);
		background = { key: key, text: text, autofill: true, fillLater: false, stage: 'fill' };
		postEdit('dcs/autofill-fields', { dataSet: key });
		setStatus('Заполняем поля из запроса…', false);
	}

	/**
	 * Записать все черновики (перед сменой набора, закладки, конструктором, проверкой схемы, уходом со страницы). mode —
	 * как у commitQueryDraft: 'nav' — переход внутри страницы, 'passive' — уход со страницы или из окна.
	 */
	function flushQueryEdits(mode) {
		for (const key of Array.from(queryDrafts.keys())) {
			commitQueryDraft(key, mode);
		}
	}

	/** Отложенные записи (retry) и заполнения — после ответа той правки, что занимала канал. */
	function retryQueryDrafts() {
		for (const [key, draft] of Array.from(queryDrafts)) {
			if (draft.retry && !saving) {
				commitQueryDraft(key, draft.retry);
			}
		}
		for (const [key, pending] of Array.from(pendingFills)) {
			if (pending.retry && !saving) {
				startPendingFill(key);
			}
		}
	}

	/**
	 * Модель без текста запроса набора key (набор верхнего уровня): если, кроме текста, ничего не поменялось, вкладку
	 * перерисовывать незачем. null — сравнить нельзя (набор внутри объединения, модель не разобрать): перерисовать.
	 */
	function modelShapeWithoutQuery(source, key) {
		if (!source || typeof source !== 'object' || !key || key.indexOf('/') >= 0) {
			return null;
		}
		const sets = Array.isArray(source.dataSets)
			? source.dataSets.map((item) => (item && item.name === key ? Object.assign({}, item, { query: null }) : item))
			: source.dataSets;
		try {
			return JSON.stringify(Object.assign({}, source, { dataSets: sets }));
		} catch (error) {
			return null;
		}
	}

	/**
	 * Черновики после новой модели: записанный (модель — его текст) и ушедший набор забываются; черновик, чей набор
	 * получил другой текст не от него (ОК конструктора), уступает — конструктор начинал с этого черновика.
	 */
	function reconcileQueryDrafts() {
		for (const [key, draft] of Array.from(queryDrafts)) {
			const current = queryTextAt(key);
			if (current === null || current === draft.text || current !== draft.base) {
				queryDrafts.delete(key);
			}
		}
		for (const key of Array.from(queryErrors.keys())) {
			if (queryTextAt(key) === null) {
				queryErrors.delete(key);
			}
		}
		for (const key of Array.from(pendingFills.keys())) {
			if (queryTextAt(key) === null) {
				pendingFills.delete(key);
			}
		}
	}

	/**
	 * Ответ фоновой записи: модель и черновики обновляются, окна (например, конструктор, открытый сразу после ухода из
	 * поля) остаются открытыми. Вкладка перерисовывается, только если модель поменялась не одним текстом этого набора
	 * (заполнение добавило поля); иначе обновляются строка под полем и проверка имён — перерисовка заменила бы узел с
	 * фокусом, и читалка заново назвала бы его. Отказ — под полем этого набора и плашкой (её слышит читалка, а из поля
	 * пользователь уже ушёл). После текста при «Автозаполнении» уходит заполнение полей, затем — правка, вставшая в
	 * очередь, или отложенная запись.
	 */
	function onBackgroundSaved(msg) {
		const job = background;
		if (!msg.ok) {
			background = null;
			const error = String(msg.error || 'Ошибка сохранения');
			const head = job.stage === 'text' ? 'Запрос не сохранён' : 'Поля из запроса не заполнены';
			queryErrors.set(job.key, { text: job.text, message: head + ': ' + error, refused: job.stage === 'text' });
			if (job.stage === 'fill') {
				// Заполнение повторит следующий конец правки, менять текст ради него не нужно
				pendingFills.set(job.key, { retry: false });
			}
			setStatus(error, true);
			showNotice('error', head, [{ text: error }]);
			afterBackground(false, job.key);
			return;
		}
		if (job.stage === 'text') {
			queryErrors.delete(job.key);
			const draft = queryDrafts.get(job.key);
			if (draft) {
				// Модель станет отправленным текстом: набранное после отправки остаётся черновиком от него
				draft.base = job.text;
			}
			if (job.fillLater) {
				pendingFills.set(job.key, { retry: false });
			}
		}
		let changed = false;
		if (msg.model) {
			const before = modelShapeWithoutQuery(model, job.key);
			model = withTypeCompositions(msg.model);
			pruneVariantCache();
			reconcileQueryDrafts();
			pruneFieldPathDrafts();
			const after = modelShapeWithoutQuery(model, job.key);
			changed = before === null || after === null || before !== after;
		}
		if (job.stage === 'text' && job.autofill) {
			job.stage = 'fill';
			postEdit('dcs/autofill-fields', { dataSet: job.key });
			setStatus('Заполняем поля из запроса…', false);
			repaintAfterBackground(changed, job.key);
			return;
		}
		background = null;
		if (job.stage === 'fill' && msg.autofill) {
			const added = Array.isArray(msg.autofill.added) ? msg.autofill.added : [];
			const skipped = Array.isArray(msg.autofill.skipped) ? msg.autofill.skipped : [];
			// Итог — плашкой, но только когда есть новости: запись идёт на каждый уход из поля, и одни и те же пропуски
			// (выражение без псевдонима) не повторяются после каждой правки
			const skips = JSON.stringify(skipped.map((miss) => String((miss && miss.expression) || '')));
			const newSkips = skipped.length > 0 && lastFillSkips.get(job.key) !== skips;
			lastFillSkips.set(job.key, skips);
			if (added.length > 0 || newSkips) {
				showNotice('ok', 'Заполнение из запроса', autofillNoticeLines(msg.autofill));
			}
		}
		setStatus('Сохранено', false);
		afterBackground(changed, job.key);
	}

	/**
	 * После ответа фоновой записи: перерисовка вкладки, если модель поменялась не одним текстом набора key; иначе —
	 * строка под полем и записанный текст для проверки имён (по нему она запрашивает недостающие описания таблиц).
	 */
	function repaintAfterBackground(changed, key) {
		if (changed) {
			renderAfterBackground();
			return;
		}
		if (queryStatusRefresh && queryStatusRefresh.key === key) {
			queryStatusRefresh.repaint();
			if (queryStatusRefresh.rebase) {
				const text = queryTextAt(key);
				if (text !== null) {
					queryStatusRefresh.rebase(text);
				}
			}
		}
	}

	/**
	 * Кнопка мыши нажата: перерисовка по ответу фоновой записи ждёт отпускания. Запись уходит по уходу фокуса, то есть
	 * на нажатии кнопки мыши; перерисовка до отпускания убрала бы узел под курсором, и щелчок (другой набор,
	 * «Конструктор…») пропал бы. Если отпускание не пришло (кнопку отпустили за окном) — перерисовка через 1,5 с.
	 */
	let pointerHeld = false;
	let renderHeld = false;
	let renderHeldTimer = 0;

	function renderAfterBackground() {
		if (pointerHeld) {
			renderHeld = true;
			if (!renderHeldTimer) {
				renderHeldTimer = setTimeout(releasePointer, 1500);
			}
			return;
		}
		renderTabs();
		renderContent();
	}

	function releasePointer() {
		pointerHeld = false;
		if (renderHeldTimer) {
			clearTimeout(renderHeldTimer);
			renderHeldTimer = 0;
		}
		if (renderHeld) {
			renderHeld = false;
			// После click того же нажатия: он уже дошёл до своего узла. Начало переноса тоже отпускает кнопку
			// (pointercancel) — тогда перерисовка ждёт конца переноса
			setTimeout(() => {
				whenIdle(() => {
					renderTabs();
					renderContent();
				});
			}, 0);
		}
	}

	document.addEventListener(
		'pointerdown',
		() => {
			pointerHeld = true;
		},
		true
	);
	document.addEventListener('pointerup', releasePointer, true);
	document.addEventListener('pointercancel', releasePointer, true);

	function afterBackground(changed, key) {
		repaintAfterBackground(changed, key);
		const next = deferred;
		deferred = null;
		if (next) {
			postEdit(next.type, next.fields);
			editOrigin = next.origin || null;
			return;
		}
		retryQueryDrafts();
	}

	// Уход со страницы (закрытие вкладки, скрытие окна): правленый текст записывается, если канал ещё жив, — только
	// текст, без заполнения полей (commitQueryDraft, 'passive')
	window.addEventListener('pagehide', () => flushQueryEdits('passive'));
	window.addEventListener('blur', () => flushQueryEdits('passive'));
	document.addEventListener('visibilitychange', () => {
		if (document.visibilityState === 'hidden') {
			flushQueryEdits('passive');
		}
	});

	/** Пауза перепроверки имён после ввода: разбор и проверка не должны идти на каждом символе. */
	const NAME_CHECK_DEBOUNCE_MS = 400;
	/** Сколько предупреждений проверки имён строка под текстом набора показывает поштучно: остальные — числом. */
	const NAME_CHECK_SHOWN = 5;
	/** Перепроверка строки под текстом открытого набора (ответы описаний и дерева); null — строки на экране нет. */
	let nameCheckRefresh = null;
	let nameCheckTimer = 0;

	/**
	 * Ответ описания или дерева мог дать проверке имён недостающее: строка под текстом набора
	 * перепроверяется — одной перепроверкой на пачку ответов, они приходят подряд.
	 */
	function scheduleNameCheck() {
		if (!nameCheckRefresh || nameCheckTimer) {
			return;
		}
		nameCheckTimer = setTimeout(() => {
			nameCheckTimer = 0;
			if (nameCheckRefresh) {
				nameCheckRefresh();
			}
		}, HIGHLIGHT_DEBOUNCE_MS);
	}

	/**
	 * Строка проверки имён по метаданным под текстом набора: неизвестная таблица, поле или алиас — с
	 * номером строки текста. Только предупреждение: сохранению запроса оно не мешает. Пересчёт — по
	 * паузе в наборе и по ответам описаний; текст, который не разбирается, не проверяется. Недостающие
	 * описания запрашиваются только для сохранённого текста: правленый черновик проверяется по тому, что
	 * уже прочитано, иначе каждая пауза в наборе слала бы запросы по недописанным именам таблиц.
	 * savedText — записанный текст набора: поле может открыться с черновиком, и черновик
	 * остаётся черновиком и после перерисовки.
	 */
	function attachNameCheck(box, input, savedText) {
		if (!nameCheckAvailable) {
			return null;
		}
		let saved = typeof savedText === 'string' ? savedText : input.value;
		const line = el('div', 'dcs-query-names');
		// Читалка слышит предупреждения, встав в поле текста; объявлять каждую перепроверку при наборе — шум
		line.id = 'dcsQueryNames';
		input.setAttribute('aria-describedby', line.id);
		box.appendChild(line);
		let timer = 0;
		function refresh() {
			timer = 0;
			if (!line.isConnected) {
				if (nameCheckRefresh === refresh) {
					nameCheckRefresh = null;
				}
				return;
			}
			renderNameCheck(line, input.value, input.value === saved ? 'later' : false);
		}
		input.addEventListener('input', () => {
			if (timer) {
				clearTimeout(timer);
			}
			timer = setTimeout(refresh, NAME_CHECK_DEBOUNCE_MS);
		});
		nameCheckRefresh = refresh;
		renderNameCheck(line, input.value, input.value === saved ? 'later' : false);
		// Текст записан без перерисовки вкладки (ответ фоновой записи): он больше не черновик, и проверка просит описания
		return (text) => {
			saved = text;
			if (timer) {
				clearTimeout(timer);
			}
			refresh();
		};
	}

	function renderNameCheck(line, text, ask) {
		line.textContent = '';
		const parsed = text.trim() !== '' ? parseQueryCached(text) : null;
		const problems = parsed && parsed.diagnostics.length === 0 ? queryNameProblems(parsed.model, [], { quiet: true, ask: ask }) : [];
		if (problems.length === 0) {
			return;
		}
		line.appendChild(
			el('div', 'dcs-query-names-title', 'Проверка имён по метаданным (' + problems.length + '): запрос можно сохранить, но платформа может его не принять.')
		);
		const several = parsed.model.statements.length > 1;
		for (const problem of problems.slice(0, NAME_CHECK_SHOWN)) {
			const where =
				typeof problem.offset === 'number'
					? 'строка ' + (text.slice(0, problem.offset).split('\n').length) + ': '
					: several
						? 'запрос пакета ' + (problem.statement + 1) + ': '
						: '';
			line.appendChild(el('div', '', where + problem.message));
		}
		if (problems.length > NAME_CHECK_SHOWN) {
			line.appendChild(el('div', '', 'И ещё ' + (problems.length - NAME_CHECK_SHOWN) + ' — все видны в конструкторе запроса на вкладке «Таблицы и поля».'));
		}
	}

	/**
	 * Кнопка «Конструктор…» набора-запроса. Многостраничный конструктор (dcs-editor-query-dialog.js)
	 * подключается после этого скрипта, поэтому ищется при нажатии, а не при отрисовке.
	 */
	function queryConstructorButton(dataSet, path, queryInput) {
		const construct = el('button', 'ghost-btn dcs-btn-small', 'Конструктор…');
		construct.type = 'button';
		construct.title = 'Конструктор запроса: таблицы и поля по вкладкам, запись текста по ОК.';
		keyed(construct, focusKey(['qbuild', path]));
		construct.addEventListener('click', () => {
			// Конструктор открывается над тем текстом, что в поле; правленый текст до этого уходит в запись:
			// фоновая запись не закрывает окно, а ОК конструктора встаёт в очередь за ней
			flushQueryEdits('nav');
			const dialog = window.DcsQueryDialog;
			if (dialog) {
				dialog.open({ dataSet: path, text: queryInput.value, autoFill: dataSet.autoFillFields === true });
				return;
			}
			showNotice('error', 'Конструктор запроса', [{ text: 'Конструктор запроса не загрузился: откройте вкладку схемы заново.' }]);
		});
		return construct;
	}

	/** Свойства набора уходят сразу по изменению (set-data-set-props). */
	function dataSetProps(dataSet) {
		const setName = dataSet.name || '';
		const box = el('div', 'dcs-props');
		const sourceNames = list('dataSources')
			.map((source) => source.name || '')
			.filter(Boolean);
		if (dataSet.dataSource && sourceNames.indexOf(dataSet.dataSource) < 0) {
			sourceNames.unshift(dataSet.dataSource);
		}
		if (sourceNames.length > 0) {
			const wrap = el('label', 'dcs-prop');
			wrap.appendChild(el('span', 'dcs-prop-label', 'Источник данных'));
			const options = sourceNames.map((name) => ({ value: name, label: name }));
			if (!dataSet.dataSource) {
				options.unshift({ value: '', label: '' });
			}
			const select = selectInput(options, dataSet.dataSource || '');
			// Ключи свойств: фокус на них переживает перерисовку по ответу правки (и фоновой записи текста запроса)
			keyed(select, focusKey(['setprop', setName, 'source']));
			select.addEventListener('change', () => {
				if (!select.value || !send('dcs/set-data-set-props', { name: setName, payload: { dataSource: select.value } })) {
					select.value = dataSet.dataSource || '';
				}
			});
			wrap.appendChild(select);
			box.appendChild(wrap);
		}
		if (dataSet.type === 'query' || typeof dataSet.autoFillFields === 'boolean') {
			const auto = checkbox('Автозаполнение', dataSet.autoFillFields);
			keyed(auto.input, focusKey(['setprop', setName, 'auto']));
			auto.input.addEventListener('change', () => {
				if (!send('dcs/set-data-set-props', { name: setName, payload: { autoFillFields: auto.input.checked } })) {
					auto.input.checked = Boolean(dataSet.autoFillFields);
					return;
				}
				if (auto.input.checked && dataSet.type === 'query') {
					// Включённое «Автозаполнение» сразу заполняет поля из записанного текста (после ответа на флажок): иначе
					// поля появились бы только после правки текста
					pendingFills.set(setName, { retry: true });
				}
			});
			box.appendChild(auto.wrap);
		}
		if (dataSet.type === 'object' || typeof dataSet.objectName === 'string') {
			const wrap = el('label', 'dcs-prop');
			wrap.appendChild(el('span', 'dcs-prop-label', 'Имя объекта'));
			const input = textInput(dataSet.objectName);
			keyed(input, focusKey(['setprop', setName, 'object']));
			input.addEventListener('change', () => {
				const value = input.value.trim();
				if (value === (dataSet.objectName || '')) {
					return;
				}
				if (!send('dcs/set-data-set-props', { name: setName, payload: { objectName: value } })) {
					input.value = dataSet.objectName || '';
				}
			});
			wrap.appendChild(input);
			box.appendChild(wrap);
		}
		return box;
	}

	function fieldKindText(field) {
		if (field.kind === 'folder') {
			return 'папка';
		}
		if (field.kind === 'nested') {
			return 'вложенный набор';
		}
		return field.field || '';
	}

	function editableField(field) {
		return (!field.kind || field.kind === 'field') && typeof field.dataPath === 'string' && field.dataPath !== '';
	}

	/**
	 * Флажки ограничений в таблице полей: в шапке — названия целиком, как у
	 * конфигуратора (label; сокращения читались бы как отдельные слова), name — название в подсказке и доступном имени
	 * флажка, смысл — в title заголовка и флажка. Таблица шире окна прокручивается вбок внутри рамки.
	 */
	const RESTRICTION_COLUMNS = [
		{ key: 'field', label: 'Поле', name: 'Поле', hint: 'нельзя выбрать в выбранные поля' },
		{ key: 'condition', label: 'Условие', name: 'Условие', hint: 'нельзя использовать в отборе' },
		{ key: 'group', label: 'Группа', name: 'Группа', hint: 'нельзя группировать' },
		{ key: 'order', label: 'Упорядочивание', name: 'Упорядочивание', hint: 'нельзя упорядочивать' },
	];

	/** Две группы флажков: ограничение самого поля и его реквизитов (полей через точку). */
	const RESTRICTION_GROUPS = [
		{ key: 'useRestriction', title: 'Ограничение поля', subject: 'поле' },
		{ key: 'attributeUseRestriction', title: 'Ограничение реквизитов', subject: 'реквизиты поля' },
	];

	/** Подсказка флажка: «Ограничение поля: Условие — поле нельзя использовать в отборе». */
	function restrictionHint(group, column) {
		return group.title + ': ' + column.name + ' — ' + group.subject + ' ' + column.hint;
	}

	/**
	 * Проверка пути к данным в ячейке и в окне поля — одна: пустой путь и путь, который уже есть в наборе (без
	 * учёта регистра, как сверяет md-sparrow; смена регистра своего пути разрешена). undefined — путь подходит.
	 */
	function fieldPathProblem(paths, dataPath, original) {
		if (!dataPath) {
			return 'Укажите путь к данным.';
		}
		if (dataPath !== (original || '') && nameTaken(paths, dataPath, original)) {
			return 'Поле с таким путём к данным уже есть в наборе.';
		}
		return undefined;
	}

	/**
	 * Путь к данным, набранный в ячейке и не принятый проверкой или md-sparrow: {text, problem, refused} живут до
	 * исправления или Esc — перерисовка от другой правки их не стирает. refused — путь отклонил md-sparrow: уход из
	 * ячейки его заново не шлёт, Enter — шлёт. Ключ — набор и прежний путь (focusKey).
	 */
	const fieldPathDrafts = new Map();
	let cellErrorCount = 0;
	/** Путь из ячейки, ответ на который ещё не пришёл: {draftKey, value} — отказ md-sparrow покажется под ячейкой. */
	let pendingPathCommit = null;

	/** Черновики пути полей, которых в модели больше нет (переименовано окном, удалено, набор переименован). */
	function pruneFieldPathDrafts() {
		for (const draftKey of Array.from(fieldPathDrafts.keys())) {
			const parts = draftKey.split('\n');
			if (dataSetFieldPaths(parts[0]).indexOf(parts.slice(1).join('\n')) < 0) {
				fieldPathDrafts.delete(draftKey);
			}
		}
	}

	/**
	 * Окно с фокусом: щелчок в VS Code вне панели или переход в другое приложение дают полю blur (а то и change), но
	 * правка в ячейке или в тексте запроса от этого не закончена. Без document.hasFocus (заглушки) — окно с фокусом.
	 */
	function windowHasFocus() {
		return typeof document.hasFocus !== 'function' || document.hasFocus() !== false;
	}

	/**
	 * Автозаголовок из пути, как его строит платформа: «ЧасовРаботы» → «Часов работы»;
	 * аббревиатуры остаются заглавными («СуммаНДС» → «Сумма НДС»).
	 */
	function autoTitle(dataPath) {
		return String(dataPath || '')
			.split('.')
			.map((part) => {
				const words = part
					.replace(/_/g, ' ')
					.replace(/([a-zа-яё0-9])([A-ZА-ЯЁ])/g, '$1 $2')
					.replace(/([A-ZА-ЯЁ]+)([A-ZА-ЯЁ][a-zа-яё])/g, '$1 $2')
					.trim()
					.split(/\s+/);
				return words
					.map((word, index) => (index > 0 && /^[A-ZА-ЯЁ][a-zа-яё0-9]*$/.test(word) ? word.toLowerCase() : word))
					.join(' ');
			})
			.join('.');
	}

	/** Правка в строке таблицы: занятый канал откатывает значение и говорит об этом в строке статуса. */
	function sendInline(type, fields, revert) {
		if (send(type, fields)) {
			return true;
		}
		revert();
		setStatus(BUSY, true);
		// Строка состояния — не живая область: отказ слышен читалке так
		announceCompletion(BUSY);
		return false;
	}

	/** Путь из ячейки не ушёл — канал занят: набранное остаётся в ячейке, Enter или уход из неё пошлют его снова. */
	const PATH_BUSY = 'Не отправлено: предыдущая правка ещё сохранялась. Нажмите Enter ещё раз.';

	function headCell(tr, text, opts) {
		const th = el('th', opts.className || '', text);
		if (opts.rowSpan) {
			th.rowSpan = opts.rowSpan;
		}
		if (opts.colSpan) {
			th.colSpan = opts.colSpan;
		}
		if (opts.title) {
			th.title = opts.title;
		}
		if (opts.label) {
			th.setAttribute('aria-label', opts.label);
		}
		tr.appendChild(th);
	}

	/** Таблица полей набора; правятся обычные поля, папки и вложенные наборы только показываются. */
	function renderFieldsTable(host, dataSet, readOnly) {
		const setName = dataSet.name || '';
		const fields = Array.isArray(dataSet.fields) ? dataSet.fields : [];
		if (!readOnly) {
			listToolbar(host, [{ icon: 'add', name: 'Добавить поле…', onClick: () => openFieldDialog(setName, null) }]);
		}
		if (fields.length === 0) {
			emptyNote(host, readOnly ? 'Полей нет.' : 'Полей нет: добавьте поле или заполните поля из запроса.');
		} else {
			const wrap = el('div', 'dcs-table-wrap dcs-fields-wrap');
			const table = el('table', 'dcs-table dcs-fields-table');
			const thead = document.createElement('thead');
			const top = document.createElement('tr');
			const sub = document.createElement('tr');
			// Колонка «Поле» закреплена слева: на узком окне таблица прокручивается вбок внутри своей рамки,
			// а имя поля строки остаётся на виду
			headCell(top, 'Поле', { rowSpan: 2, className: 'dcs-col-pin' });
			for (const title of ['Путь к данным', 'Заголовок', 'Тип']) {
				headCell(top, title, { rowSpan: 2 });
			}
			for (const group of RESTRICTION_GROUPS) {
				headCell(top, group.title, { colSpan: RESTRICTION_COLUMNS.length, className: 'dcs-th-group dcs-col-sep' });
				RESTRICTION_COLUMNS.forEach((column, index) => {
					// Группу читалка называет заголовком над колонками: в своём заголовке колонки — только название
					headCell(sub, column.label, {
						className: 'dcs-th-check' + (index === 0 ? ' dcs-col-sep' : ''),
						title: restrictionHint(group, column),
					});
				});
			}
			headCell(top, 'Роль', { rowSpan: 2, className: 'dcs-col-sep' });
			headCell(top, '', { rowSpan: 2 });
			thead.appendChild(top);
			thead.appendChild(sub);
			table.appendChild(thead);
			const tbody = document.createElement('tbody');
			for (const field of fields) {
				tbody.appendChild(fieldRow(setName, field, readOnly || !editableField(field), readOnly));
			}
			// Стрелки вверх и вниз в поле или флажке ячейки — та же колонка соседней строки, как в таблице
			// конфигуратора; влево и вправо у флажков — соседний флажок строки
			tbody.addEventListener('keydown', onFieldCellKey);
			fieldRowStops(tbody, setName);
			table.appendChild(tbody);
			wrap.appendChild(table);
			wrap.addEventListener('scroll', () => {
				fieldsScrollLeft = wrap.scrollLeft;
			});
			wrap.addEventListener('focusin', (event) => {
				revealFromUnderPin(wrap, event && event.target);
			});
			host.appendChild(wrap);
		}
	}

	/** Строка таблицы полей с остановкой Tab: {set, path} — переживает перерисовку вкладки. */
	let fieldsRowStop = { set: '', path: '' };

	/**
	 * Доступные поля ввода, флажки и кнопки строки таблицы полей (все они — прямые дети своих ячеек). Недоступные
	 * (флажки папки) в обход Tab и так не входят: строка только с ними остановкой не становится.
	 */
	function fieldRowControls(tr) {
		return Array.from(tr.children).flatMap((td) =>
			Array.from(td.children).filter((node) => (node.tagName === 'INPUT' || node.tagName === 'BUTTON') && !node.disabled)
		);
	}

	/**
	 * Одна строка таблицы полей в обходе Tab: у остальных строк поля, флажки и кнопки получают tabIndex −1, и Tab после
	 * последней кнопки строки уходит из таблицы, а не проходит все строки по 13 остановок. Строку меняют стрелки вверх
	 * и вниз (onFieldCellKey) и щелчок — остановка идёт за фокусом.
	 */
	function fieldRowStops(tbody, setName) {
		const rows = Array.from(tbody.children);
		const usable = rows.filter((tr) => fieldRowControls(tr).length > 0);
		const remembered = fieldsRowStop.set === setName ? rows.find((tr) => tr.getAttribute('data-dcs-row') === fieldsRowStop.path && fieldRowControls(tr).length > 0) : null;
		const apply = (stop) => {
			for (const tr of rows) {
				for (const control of fieldRowControls(tr)) {
					control.tabIndex = tr === stop ? 0 : -1;
				}
			}
		};
		apply(remembered || usable[0] || null);
		tbody.addEventListener('focusin', (event) => {
			const tr = event && event.target ? rowOf(event.target) : null;
			if (!tr || rows.indexOf(tr) < 0 || fieldRowControls(tr).indexOf(event.target) < 0) {
				return;
			}
			fieldsRowStop = { set: setName, path: tr.getAttribute('data-dcs-row') || '' };
			apply(tr);
		});
	}

	/**
	 * Колонка «Поле» закреплена и непрозрачна: поле ввода, которое лежит под ней (таблица прокручена вбок), браузер не
	 * прокручивает — оно в области прокрутки, только закрыто. Фокус в такое поле сдвигает таблицу так, чтобы оно было видно.
	 */
	function revealFromUnderPin(wrap, target) {
		const tr = target ? rowOf(target) : null;
		const pin = tr && tr.children ? tr.children[0] : null;
		if (!pin || pin === target.parentElement || typeof target.getBoundingClientRect !== 'function' || typeof pin.getBoundingClientRect !== 'function') {
			return;
		}
		const box = target.getBoundingClientRect();
		const edge = pin.getBoundingClientRect();
		if (box.left < edge.right) {
			wrap.scrollLeft = Math.max(0, (wrap.scrollLeft || 0) - (edge.right - box.left + 4));
		}
	}

	/**
	 * Строка поля; nestedSet — набор внутри объединения: тип там виден, но открывается только на просмотр.
	 * Путь к данным, заголовок и флажки ограничений правятся прямо в строке, остальное — в окне поля, его
	 * открывает карандаш.
	 */
	function fieldRow(setName, field, readOnly, nestedSet) {
		const tr = document.createElement('tr');
		const dataPath = field.dataPath || '';
		tr.setAttribute('data-dcs-row', dataPath);
		cell(tr, fieldKindText(field), 'dcs-col-pin');
		const pathTd = el('td', 'dcs-cell-title dcs-cell-path');
		if (readOnly) {
			setNameText(pathTd, dataPath);
		} else {
			fieldPathEditor(pathTd, setName, dataPath);
		}
		tr.appendChild(pathTd);
		const titleTd = el('td', 'dcs-cell-title');
		if (readOnly) {
			setNameText(titleTd, field.title || '');
		} else {
			fieldTitleEditor(titleTd, setName, field);
		}
		tr.appendChild(titleTd);
		// У папки и поля-вложенного набора своего типа нет: подпись без окна
		const typeTd = typeCell(
			tr,
			field.valueType,
			field.valueTypePresentation,
			'поля ' + dataPath,
			editableField(field)
				? () => {
						openFieldTypeDialog(setName, field, Boolean(nestedSet));
					}
				: null
		);
		if (typeTd.children[0] && typeTd.children[0].tagName === 'BUTTON') {
			keyed(typeTd.children[0], focusKey(['ftype', setName, dataPath]));
			// ↑ ↓ и на кнопке типа — та же колонка соседней строки (onFieldCellKey), как в полях и флажках
			typeTd.children[0].setAttribute('data-dcs-col', 'type');
		}
		for (const group of RESTRICTION_GROUPS) {
			restrictionCells(tr, setName, field, group, readOnly);
		}
		cell(tr, roleSummary(field.role), 'dcs-col-sep');
		if (readOnly) {
			cell(tr, '');
		} else {
			actionsCell(tr, [
				{
					svg: 'edit',
					title: 'Свойства поля: путь, заголовок, тип, ограничения, роль',
					key: focusKey(['fedit', setName, dataPath]),
					onClick: () => {
						openFieldDialog(setName, field);
					},
				},
				{
					svg: 'delete',
					title: 'Удалить поле',
					danger: true,
					key: focusKey(['fdel', setName, dataPath]),
					onClick: () => {
						confirmRemove('Удалить поле «' + dataPath + '»?', () => {
							if (!send('dcs/remove-field', { dataSet: setName, dataPath: dataPath })) {
								return BUSY;
							}
							return undefined;
						});
					},
				},
			]);
			// Кнопки строки — тоже колонки для ↑ ↓: из конца строки в соседнюю без Shift+Tab назад
			const rowButtons = tr.children[tr.children.length - 1].children;
			['edit', 'delete'].forEach((col, at) => {
				if (rowButtons[at]) {
					rowButtons[at].setAttribute('data-dcs-col', col);
				}
			});
		}
		return tr;
	}

	/**
	 * Правка в ячейке уходит по Enter или уходу из поля (change). Enter фокус не снимает: после ответа строка
	 * перерисуется, и фокус вернётся в ту же ячейку. Пока ответ не пришёл, тот же текст второй раз не шлётся:
	 * Enter, а за ним уход из поля дали бы две правки, и вторая получила бы «ещё сохраняется».
	 */
	function cellCommitter(commit) {
		let sent = null;
		return (value) => {
			if (sent !== null && value === sent && saving) {
				return;
			}
			sent = commit(value) ? value : null;
		};
	}

	/** Заголовок поля в ячейке: пусто — автозаголовок платформы, он виден подсказкой в поле, как в конфигураторе. */
	function fieldTitleEditor(td, setName, field) {
		const dataPath = field.dataPath || '';
		const original = field.title || '';
		const input = el('input', 'dcs-cell-input');
		input.type = 'text';
		input.value = original;
		input.placeholder = autoTitle(dataPath);
		input.title = 'Заголовок поля; пусто — автозаголовок';
		input.setAttribute('aria-label', 'Заголовок поля ' + dataPath);
		input.setAttribute('data-dcs-col', 'title');
		keyed(input, focusKey(['ftitle', setName, dataPath]));
		const commit = cellCommitter((value) => {
			if (value === original) {
				return false;
			}
			// Канал занят — набранное не откатывается: оно уйдёт по Enter или уходу из ячейки
			return sendInline('dcs/set-field', { dataSet: setName, dataPath: dataPath, payload: { title: value } }, () => undefined);
		});
		input.addEventListener('keydown', (event) => {
			if (event.isComposing) {
				return;
			}
			if (event.key === 'Enter') {
				event.preventDefault();
				commit(input.value.trim());
			} else if (event.key === 'Escape' && input.value !== original) {
				// Esc откатывает набранное; без правки он остаётся клавишей страницы
				event.preventDefault();
				input.value = original;
			}
		});
		// Уход в другое окно правку не заканчивает: недописанный заголовок не пишется (windowHasFocus)
		input.addEventListener('change', () => {
			if (windowHasFocus()) {
				commit(input.value.trim());
			}
		});
		// Набранное, перенесённое перерисовкой в новое поле (restoreFocus), change при уходе может не дать: браузер сверяет
		// значение с тем, что было при получении фокуса. Уход из поля коммитит и сам; поле, которое убирает перерисовка, — нет
		input.addEventListener('blur', () => {
			if (!renderingContent && input.isConnected && windowHasFocus()) {
				commit(input.value.trim());
			}
		});
		td.appendChild(input);
	}

	/**
	 * Путь к данным в ячейке: тот же dcs/set-field с newDataPath, что и окно поля,
	 * и та же проверка (fieldPathProblem). Отказ проверки виден под полем и связан с ним (aria-invalid,
	 * aria-describedby); набранный текст остаётся для исправления и ничего не уходит. Esc возвращает прежний путь.
	 */
	function fieldPathEditor(td, setName, original) {
		const draftKey = focusKey([setName, original]);
		const draft = fieldPathDrafts.get(draftKey) || null;
		const input = el('input', 'dcs-cell-input');
		input.type = 'text';
		input.value = draft ? draft.text : original;
		input.spellcheck = false;
		input.title = 'Путь к данным: имя поля в схеме';
		input.setAttribute('aria-label', 'Путь к данным поля ' + original);
		input.setAttribute('data-dcs-col', 'path');
		keyed(input, focusKey(['fpath', setName, original]));
		const error = el('div', 'dcs-cell-error');
		error.id = 'dcsCellError' + ++cellErrorCount;
		// Причина появляется у поля, на котором фокус: описание (aria-describedby) читалка заново не читает, живая область — да
		error.setAttribute('aria-live', 'polite');
		td.appendChild(input);
		td.appendChild(error);
		function showProblem(problem, refused) {
			error.textContent = problem || '';
			if (problem) {
				input.setAttribute('aria-invalid', 'true');
				input.setAttribute('aria-describedby', error.id);
				fieldPathDrafts.set(draftKey, refused ? { text: input.value, problem: problem, refused: true } : { text: input.value, problem: problem });
			} else {
				input.removeAttribute('aria-invalid');
				input.removeAttribute('aria-describedby');
				fieldPathDrafts.delete(draftKey);
			}
		}
		if (draft) {
			showProblem(draft.problem, draft.refused);
		}
		const commit = cellCommitter((value) => {
			if (value === original) {
				showProblem('');
				input.value = original;
				return false;
			}
			const problem = fieldPathProblem(dataSetFieldPaths(setName), value, original);
			if (problem) {
				showProblem(problem);
				return false;
			}
			if (!send('dcs/set-field', { dataSet: setName, dataPath: original, payload: { newDataPath: value } })) {
				// Канал занят: набранное остаётся в ячейке с причиной под ней (не отказ md-sparrow — уход из ячейки пошлёт
				// его снова). Ожидание ответа другой правки (pendingRename, pendingPathCommit) не трогается
				showProblem(PATH_BUSY);
				return false;
			}
			showProblem('');
			// Ответ перерисует таблицу: ключи строки содержат путь, и фокус ищется под новым
			pendingRename = { scope: setName, from: original, to: value };
			pendingPathCommit = { draftKey: draftKey, value: value };
			return true;
		});
		/** Конец правки без Enter: путь, который md-sparrow уже отклонил, заново не шлётся; уход в другое окно — не конец. */
		const commitOnLeave = () => {
			const refused = fieldPathDrafts.get(draftKey);
			if (!windowHasFocus() || (refused && refused.refused && refused.text === input.value.trim())) {
				return;
			}
			commit(input.value.trim());
		};
		input.addEventListener('keydown', (event) => {
			if (event.isComposing) {
				return;
			}
			if (event.key === 'Enter') {
				event.preventDefault();
				commit(input.value.trim());
			} else if (event.key === 'Escape' && (input.value !== original || fieldPathDrafts.has(draftKey))) {
				event.preventDefault();
				input.value = original;
				showProblem('');
			}
		});
		input.addEventListener('change', commitOnLeave);
		// Уход из поля коммитит и сам, как у заголовка (fieldTitleEditor): change после перерисовки может не прийти
		input.addEventListener('blur', () => {
			if (!renderingContent && input.isConnected) {
				commitOnLeave();
			}
		});
	}

	/** Строка таблицы, в которой лежит узел ячейки. */
	function rowOf(node) {
		let row = node;
		while (row && row.tagName !== 'TR') {
			row = row.parentElement;
		}
		return row;
	}

	/** Поле или флажок строки с колонкой col (data-dcs-col), доступные для фокуса. */
	function cellControl(row, col) {
		const walk = (node) => {
			for (const child of Array.from(node.children || [])) {
				if (typeof child.getAttribute === 'function' && child.getAttribute('data-dcs-col') === col && !child.disabled) {
					return child;
				}
				const found = walk(child);
				if (found) {
					return found;
				}
			}
			return null;
		};
		return walk(row);
	}

	function onFieldCellKey(event) {
		if (event.defaultPrevented || event.isComposing || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) {
			return;
		}
		const target = event.target;
		const col = target && typeof target.getAttribute === 'function' ? target.getAttribute('data-dcs-col') : null;
		const row = col ? rowOf(target) : null;
		if (!row || !row.parentElement) {
			return;
		}
		let next = null;
		if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
			const rows = Array.from(row.parentElement.children);
			const step = event.key === 'ArrowDown' ? 1 : -1;
			for (let k = rows.indexOf(row) + step; k >= 0 && k < rows.length && !next; k += step) {
				next = cellControl(rows[k], col);
			}
		} else if ((event.key === 'ArrowLeft' || event.key === 'ArrowRight') && target.type === 'checkbox') {
			const flags = [];
			for (const group of RESTRICTION_GROUPS) {
				for (const column of RESTRICTION_COLUMNS) {
					flags.push('flag:' + group.key + ':' + column.key);
				}
			}
			const step = event.key === 'ArrowRight' ? 1 : -1;
			for (let k = flags.indexOf(col) + step; k >= 0 && k < flags.length && !next; k += step) {
				next = cellControl(row, flags[k]);
			}
		} else {
			return;
		}
		// Край таблицы: клавиша гасится, чтобы поле не прыгало кареткой в начало или конец
		event.preventDefault();
		if (next) {
			next.focus();
		}
	}

	/** Четыре флажка ограничения; правка уходит всем ограничением, как из диалога поля. */
	function restrictionCells(tr, setName, field, group, readOnly) {
		const key = group.key;
		const current = field[key] || {};
		RESTRICTION_COLUMNS.forEach((column, index) => {
			const td = el('td', 'dcs-cell-check' + (index === 0 ? ' dcs-col-sep' : ''));
			const box = el('input', 'edit-check');
			box.type = 'checkbox';
			box.checked = Boolean(current[column.key]);
			box.disabled = readOnly;
			box.title = restrictionHint(group, column);
			box.setAttribute('aria-label', group.title + ' «' + (field.dataPath || '') + '»: ' + column.name);
			box.setAttribute('aria-description', group.subject + ' ' + column.hint);
			box.setAttribute('data-dcs-col', 'flag:' + key + ':' + column.key);
			keyed(box, focusKey(['fflag', setName, field.dataPath || '', key, column.key]));
			box.addEventListener('change', () => {
				const next = {};
				for (const flag of RESTRICTION_COLUMNS) {
					next[flag.key] = Boolean(current[flag.key]);
				}
				next[column.key] = box.checked;
				const payload = {};
				payload[key] = next;
				sendInline('dcs/set-field', { dataSet: setName, dataPath: field.dataPath || '', payload: payload }, () => {
					box.checked = !box.checked;
				});
			});
			td.appendChild(box);
			tr.appendChild(td);
		});
	}

	function openFieldDialog(setName, field) {
		const original = field || {};
		let pathInput;
		let fieldInput;
		let titleInput;
		let useBoxes;
		let attrBoxes;
		let role;
		let typeChoice = null;
		openDialog(
			field ? 'Поле «' + (original.dataPath || '') + '»' : 'Новое поле набора «' + setName + '»',
			field ? 'Сохранить' : 'Добавить',
			(body) => {
				pathInput = formRow(body, 'Путь к данным', textInput(original.dataPath));
				fieldInput = formRow(body, 'Поле', textInput(original.field));
				titleInput = formRow(body, 'Заголовок', textInput(original.title));
				if (field) {
					// Новое поле add-field пишет без типа (операция его не принимает): тип — у созданного поля
					typeChoice = typeRow(body, original.valueType, {
						title: () => 'Тип значения поля «' + (pathInput.value.trim() || original.dataPath || '') + '»',
						fallback: original.valueTypePresentation,
						warnings: typeOwnerWarnings({ hasInputParameters: original.hasInputParameters }),
					});
					groupTitle(body, 'Ограничение поля');
					useBoxes = restrictionBoxes(body, original.useRestriction);
					groupTitle(body, 'Ограничение реквизитов');
					attrBoxes = restrictionBoxes(body, original.attributeUseRestriction);
					groupTitle(body, 'Роль');
					role = roleForm(body, original.role || {}, setName);
				}
			},
			() => {
				const dataPath = pathInput.value.trim();
				const fieldName = fieldInput.value.trim();
				const title = titleInput.value.trim();
				// Та же проверка, что у пути в ячейке таблицы
				const pathProblem = fieldPathProblem(dataSetFieldPaths(setName), dataPath, original.dataPath);
				if (pathProblem) {
					return pathProblem;
				}
				if (!field) {
					if (!fieldName) {
						return 'Укажите поле.';
					}
					const payload = { dataPath: dataPath, field: fieldName };
					if (title) {
						payload.title = title;
					}
					if (!send('dcs/add-field', { dataSet: setName, payload: payload })) {
						return BUSY;
					}
					return undefined;
				}
				const roleError = role.validate();
				if (roleError) {
					return roleError;
				}
				const payload = {};
				if (dataPath !== (original.dataPath || '')) {
					payload.newDataPath = dataPath;
				}
				// Фокус после ответа вернётся на карандаш строки уже под новым путём
				pendingRename = payload.newDataPath ? { scope: setName, from: original.dataPath || '', to: dataPath } : null;
				if (fieldName && fieldName !== (original.field || '')) {
					payload.field = fieldName;
				}
				if (title !== (original.title || '')) {
					payload.title = title;
				}
				if (restrictionChanged(useBoxes, original.useRestriction)) {
					payload.useRestriction = restrictionOf(useBoxes);
				}
				if (restrictionChanged(attrBoxes, original.attributeUseRestriction)) {
					payload.attributeUseRestriction = restrictionOf(attrBoxes);
				}
				if (role.changed()) {
					payload.role = role.current();
				}
				const typed = typeRules.typeEditPayload({ valueType: original.valueType }, { valueType: typeChoice.valueType() });
				if (typed.error) {
					return typed.error;
				}
				Object.assign(payload, typed.payload);
				if (Object.keys(payload).length === 0) {
					closeDialog();
					return undefined;
				}
				if (!send('dcs/set-field', { dataSet: setName, dataPath: original.dataPath || '', payload: payload })) {
					return BUSY;
				}
				return undefined;
			}
		);
	}

	// ---------- вкладка «Связи наборов данных» ----------

	/**
	 * Обязательность связи (required) загрузка схемы в платформу 8.3.27 (ibcmd) не хранит ни при каком
	 * составе связи: ни у простой, ни с параметром, списком параметра, условием или выражением начала.
	 * md-sparrow на required=true отказывает, а false снимает элемент. Поэтому колонки и флажка у новой
	 * связи нет; флажок появляется только у связи, где он уже записан в файле, и только чтобы его снять.
	 */
	const LINK_REQUIRED_REASON = 'загрузка схемы в платформу этот флажок не хранит';

	function linkTitle(link) {
		return '«' + (link.source || '') + ' → ' + (link.destination || '') + '»';
	}

	/**
	 * Однозначное имя связи: номер строки таблицы, наборы и выражения. Между одной парой наборов связей
	 * бывает несколько (по разным выражениям), и одной пары «источник → приёмник» мало.
	 */
	function linkLabel(link, index) {
		return (
			'№' +
			(index + 1) +
			' ' +
			linkTitle(link) +
			' (' +
			(link.sourceExpression || '') +
			' = ' +
			(link.destinationExpression || '') +
			')'
		);
	}

	/** Флажок «Обязательная связь» в окне — только у связи, где он уже записан: снять можно, поставить нельзя. */
	function linkRequiredOffered(link) {
		return Boolean(link) && link.required === true;
	}

	/** Что окно шлёт о флажке: false — только снятие записанного; иначе ничего (true md-sparrow отклонит). */
	function linkRequiredChange(link, checked) {
		return linkRequiredOffered(link) && !checked ? false : undefined;
	}

	/**
	 * Флажок «Список параметров» хранится только вместе с параметром связи: у связи без параметра загрузка схемы в
	 * платформу (8.3.27) отбрасывает и «да», и «нет», а md-sparrow на «да» без параметра отказывает. Поэтому без
	 * параметра флажок в окне снят и недоступен; исключение — «да», уже записанное в файле у связи без параметра: его
	 * окно показывает, чтобы снять.
	 */
	const LINK_LIST_FLAG_REASON = 'без параметра связи загрузка схемы в платформу этот флажок не хранит';

	/** Параметр связи задан: непустой после обрезки пробелов (пустой и из пробелов md-sparrow считает «нет параметра»). */
	function linkParameterSet(parameter) {
		return typeof parameter === 'string' && parameter.trim() !== '';
	}

	/** У связи без параметра записано «да»: флажок в окне — только чтобы снять. */
	function linkListFlagLegacy(link) {
		return Boolean(link) && link.parameterListAllowed === true && !linkParameterSet(link.parameter);
	}

	/**
	 * Доступен ли флажок «Список параметров» при значении поля «Параметр» parameter: с параметром — да; без параметра —
	 * только у связи с записанным «да» без параметра (снять можно, поставить заново — лишь вернуть как было).
	 */
	function linkListFlagOffered(link, parameter) {
		return linkParameterSet(parameter) || linkListFlagLegacy(link);
	}

	/**
	 * Флажок «Список параметров» новой связи: уходит только отмеченный (true) и только с параметром. Снятый не шлётся: у
	 * связи с параметром «нет» (false) пишет сам md-sparrow, как его хранит платформа, а у связи без параметра флага нет.
	 */
	function linkListFlagNew(checked, parameter) {
		return checked && linkParameterSet(parameter) ? true : undefined;
	}

	/**
	 * Что окно правки шлёт о флажке «Список параметров» (undefined — ничего). parameter — поле «Параметр» после правки,
	 * checked — флажок, edited — уходит ли правка других свойств связи.
	 * С параметром: «не задано» и «нет» — одно значение, снятый флажок; отмеченный уходит как true, снятый у записанного
	 * «да» — как false (недостающее «нет» md-sparrow дописывает сам при настоящей правке).
	 * Без параметра true не уходит никогда (загрузка его не хранит, md-sparrow отказывает), а записанный флаг (любой)
	 * убирается null: при снятии параметра; при снятии записанного «да» без параметра (не снятое «да» остаётся, как
	 * флажок «Обязательная связь»); «нет» без параметра — вместе с настоящей правкой связи, так что окно, закрытое без
	 * изменений, файл не меняет.
	 */
	function linkListFlagChange(link, parameter, checked, edited) {
		const recorded = link ? link.parameterListAllowed : undefined;
		if (linkParameterSet(parameter)) {
			return checked !== Boolean(recorded) ? checked : undefined;
		}
		if (recorded !== true && recorded !== false) {
			return undefined;
		}
		if (linkParameterSet(link.parameter)) {
			return null;
		}
		if (recorded === true) {
			return checked ? undefined : null;
		}
		return edited ? null : undefined;
	}

	/** Текст плашки над таблицей связей: у каких связей записано «да» без параметра; пусто — плашки нет. */
	function linkListFlagPlate(links) {
		const labels = [];
		links.forEach((link, index) => {
			if (linkListFlagLegacy(link)) {
				labels.push(linkLabel(link, index));
			}
		});
		if (labels.length === 0) {
			return '';
		}
		return (
			(labels.length === 1 ? 'У связи ' : 'У связей ') +
			labels.join(', ') +
			' флажок «Список параметров» записан без параметра: ' +
			LINK_LIST_FLAG_REASON +
			'. Откройте связь (строка с пометкой «без параметра») и снимите флажок или задайте параметр.'
		);
	}

	/**
	 * Строка плашки «Проверить схему» о флажке «Список параметров» без параметра. Связь названа так же, как в таблице и
	 * плашке над ней (linkLabel, номер с единицы); номер в тексте md-sparrow и ключ link считаются с нуля. Если связи с
	 * таким номером в прочитанной модели нет или модель с вердиктом расходится (параметр задан, флага нет, значение флага
	 * не то, что назвал md-sparrow), — текст md-sparrow как есть.
	 */
	function linkListFlagWarningLine(warning, links) {
		const message =
			warning && typeof warning.message === 'string' && warning.message !== '' ? warning.message : 'Предупреждение без описания';
		const index = warning ? warning.link : undefined;
		if (!Number.isInteger(index) || index < 0 || !Array.isArray(links) || index >= links.length) {
			return message;
		}
		const link = links[index];
		const recorded = link ? link.parameterListAllowed : undefined;
		if ((recorded !== true && recorded !== false) || linkParameterSet(link.parameter)) {
			return message;
		}
		const named = /parameterListAllowed=(true|false)/.exec(message);
		if (named && (named[1] === 'true') !== recorded) {
			return message;
		}
		return (
			'Связь ' +
			linkLabel(link, index) +
			': флажок «Список параметров» («' +
			(recorded ? 'да' : 'нет') +
			'») записан без параметра — ' +
			LINK_LIST_FLAG_REASON +
			'.'
		);
	}

	/** Текст плашки над таблицей связей: у каких связей (по linkLabel) записан флажок; пусто — плашки нет. */
	function linkRequiredPlate(links) {
		const labels = [];
		links.forEach((link, index) => {
			if (linkRequiredOffered(link)) {
				labels.push(linkLabel(link, index));
			}
		});
		if (labels.length === 0) {
			return '';
		}
		return (
			(labels.length === 1 ? 'У связи ' : 'У связей ') +
			labels.join(', ') +
			' записан флажок «Обязательная связь»: ' +
			LINK_REQUIRED_REASON +
			'. Откройте связь (строка с пометкой «обязательная») и снимите флажок.'
		);
	}

	function renderLinks(host) {
		const links = list('dataSetLinks');
		const toolbar = [{ icon: 'add', name: 'Добавить связь…', onClick: () => openLinkDialog(null, -1) }];
		if (links.length === 0) {
			listToolbar(host, toolbar);
			emptyNote(host, 'Связей между наборами нет.');
		} else {
			const plate = linkRequiredPlate(links);
			if (plate) {
				host.appendChild(el('div', 'dcs-plate dcs-plate-warn', plate));
			}
			const listPlate = linkListFlagPlate(links);
			if (listPlate) {
				host.appendChild(el('div', 'dcs-plate dcs-plate-warn', listPlate));
			}
			listToolbar(host, toolbar);
			const tbody = dataTable(host, [
				'Источник',
				'Приёмник',
				'Выражение источника',
				'Выражение приёмника',
				'Параметр',
				'Список параметров',
				'Условие связи',
				'Начальное значение',
				'',
			]);
			links.forEach((link, index) => {
				const tr = document.createElement('tr');
				const sourceTd = cell(tr, link.source || '');
				if (linkRequiredOffered(link)) {
					// Пометка строки: плашка называет связь номером, а здесь видно, какую строку открыть
					const mark = el('span', 'dcs-us-badge dcs-link-required-mark', 'обязательная');
					const why = 'Записан флажок «Обязательная связь»: ' + LINK_REQUIRED_REASON + '. Откройте связь и снимите флажок.';
					mark.title = why;
					mark.setAttribute('aria-label', why);
					sourceTd.appendChild(mark);
				}
				cell(tr, link.destination || '');
				cell(tr, link.sourceExpression || '');
				cell(tr, link.destinationExpression || '');
				cell(tr, link.parameter || '');
				const listTd = cell(tr, link.parameterListAllowed ? '✓' : '', 'dcs-cell-check');
				if (linkListFlagLegacy(link)) {
					// Пометка строки с «да» без параметра: плашка называет связь номером, здесь видно, какую открыть
					const mark = el('span', 'dcs-us-badge dcs-link-list-flag-mark', 'без параметра');
					const why = 'Флажок «Список параметров» записан без параметра: ' + LINK_LIST_FLAG_REASON + '. Откройте связь и снимите флажок или задайте параметр.';
					mark.title = why;
					mark.setAttribute('aria-label', why);
					listTd.appendChild(mark);
				}
				cell(tr, link.linkConditionExpression || '');
				cell(tr, link.startExpression || '');
				actionsCell(tr, [
					{
						svg: 'edit',
						title: 'Править',
						onClick: () => {
							openLinkDialog(link, index);
						},
					},
					{
						svg: 'delete',
						title: 'Удалить',
						danger: true,
						onClick: () => {
							confirmRemove('Удалить связь ' + linkLabel(link, index) + '?', () => {
								if (!send('dcs/remove-link', { index: index })) {
									return BUSY;
								}
								return undefined;
							});
						},
					},
				]);
				tbody.appendChild(tr);
			});
		}
	}

	function openLinkDialog(link, index) {
		const original = link || {};
		const names = dataSetNames();
		for (const extra of [original.source, original.destination]) {
			if (extra && names.indexOf(extra) < 0) {
				names.push(extra);
			}
		}
		const options = names.map((name) => ({ value: name, label: name }));
		let sourceSelect;
		let destinationSelect;
		let sourceExpr;
		let destinationExpr;
		let parameterInput;
		let listBox;
		let requiredBox;
		let conditionInput;
		let startInput;
		openDialog(
			link ? 'Связь наборов данных' : 'Новая связь наборов данных',
			link ? 'Сохранить' : 'Добавить',
			(body) => {
				sourceSelect = formRow(body, 'Источник связи', selectInput(options, original.source || names[0] || ''));
				destinationSelect = formRow(
					body,
					'Приёмник связи',
					selectInput(options, original.destination || names[1] || names[0] || '')
				);
				// Наборы связи читаются при каждом открытии списка: подсказка следует за выбором в форме
				sourceExpr = expressionInput(body, 'Выражение источника', original.sourceExpression, () => 'link-source:' + sourceSelect.value);
				destinationExpr = expressionInput(
					body,
					'Выражение приёмника',
					original.destinationExpression,
					() => 'link-dest:' + destinationSelect.value
				);
				parameterInput = formRow(body, 'Параметр', textInput(original.parameter));
				attachCompletion(parameterInput, () => 'param-name');
				listBox = checkbox('Список параметров', original.parameterListAllowed);
				// Флажок обязательности — только у связи, где он уже записан: снять можно, поставить нельзя
				requiredBox = linkRequiredOffered(link) ? checkbox('Обязательная связь', true) : null;
				checkRow(body, requiredBox ? [listBox, requiredBox] : [listBox]);
				// Флажок списка следует за полем «Параметр»: без параметра — снят и недоступен (кроме записанного «да» без
				// параметра — его можно снять); выбор, сделанный при параметре, возвращается, когда параметр снова задан
				let listChoice = listBox.input.checked;
				const syncListBox = () => {
					const offered = linkListFlagOffered(link, parameterInput.value);
					if (offered && listBox.input.disabled) {
						listBox.input.checked = listChoice;
					} else if (!offered && !listBox.input.disabled) {
						listChoice = listBox.input.checked;
						listBox.input.checked = false;
					}
					listBox.input.disabled = !offered;
					if (offered) {
						listBox.input.title = '';
						listBox.input.removeAttribute('aria-description');
					} else {
						const why = 'Флажок доступен, когда задан параметр: ' + LINK_LIST_FLAG_REASON;
						listBox.input.title = why;
						listBox.input.setAttribute('aria-description', why);
					}
				};
				syncListBox();
				parameterInput.addEventListener('input', syncListBox);
				if (linkListFlagLegacy(link)) {
					const listWarn = el(
						'div',
						'dcs-warn',
						'Флажок «Список параметров» записан раньше без параметра, но ' + LINK_LIST_FLAG_REASON + ': снимите его или задайте параметр.'
					);
					listWarn.id = 'dcsLinkListFlagWarn';
					listBox.input.setAttribute('aria-describedby', listWarn.id);
					body.appendChild(listWarn);
				}
				if (requiredBox) {
					const warn = el(
						'div',
						'dcs-warn',
						'Флажок «Обязательная связь» записан раньше, но ' + LINK_REQUIRED_REASON + ': снимите его.'
					);
					// Причина читается экранным диктором вместе с флажком, а не отдельной строкой
					warn.id = 'dcsLinkRequiredWarn';
					requiredBox.input.setAttribute('aria-describedby', warn.id);
					body.appendChild(warn);
				}
				const bothSets = () => 'link-both:' + sourceSelect.value + '|' + destinationSelect.value;
				conditionInput = expressionInput(body, 'Условие связи', original.linkConditionExpression, bothSets);
				startInput = expressionInput(body, 'Начальное значение', original.startExpression, bothSets);
			},
			() => {
				const source = sourceSelect.value;
				const destination = destinationSelect.value;
				if (!source || !destination) {
					return 'Укажите наборы данных связи.';
				}
				const sourceExpression = sourceExpr.value.trim();
				const destinationExpression = destinationExpr.value.trim();
				const parameter = parameterInput.value.trim();
				const condition = conditionInput.value.trim();
				const start = startInput.value.trim();
				if (!link) {
					if (!sourceExpression || !destinationExpression) {
						return 'Заполните выражения источника и приёмника.';
					}
					const payload = {
						sourceDataSet: source,
						destinationDataSet: destination,
						sourceExpression: sourceExpression,
						destinationExpression: destinationExpression,
					};
					if (parameter) {
						payload.parameter = parameter;
					}
					const listFlag = linkListFlagNew(listBox.input.checked, parameter);
					if (listFlag !== undefined) {
						payload.parameterListAllowed = listFlag;
					}
					if (condition) {
						payload.linkConditionExpression = condition;
					}
					if (start) {
						payload.startExpression = start;
					}
					if (!send('dcs/add-link', { payload: payload })) {
						return BUSY;
					}
					return undefined;
				}
				const payload = {};
				if (source !== (original.source || '')) {
					payload.sourceDataSet = source;
				}
				if (destination !== (original.destination || '')) {
					payload.destinationDataSet = destination;
				}
				if (sourceExpression !== (original.sourceExpression || '')) {
					payload.sourceExpression = sourceExpression;
				}
				if (destinationExpression !== (original.destinationExpression || '')) {
					payload.destinationExpression = destinationExpression;
				}
				if (parameter !== (original.parameter || '')) {
					payload.parameter = parameter;
				}
				if (condition !== (original.linkConditionExpression || '')) {
					payload.linkConditionExpression = condition;
				}
				if (start !== (original.startExpression || '')) {
					payload.startExpression = start;
				}
				// Уходит только снятие: true md-sparrow отклонит, а без правки флажка required не шлётся вовсе
				const required = linkRequiredChange(link, Boolean(requiredBox && requiredBox.input.checked));
				if (required !== undefined) {
					payload.required = required;
				}
				// Флажок списка — последним: «нет», записанное без параметра, убирается только вместе с настоящей правкой
				const listFlag = linkListFlagChange(link, parameter, listBox.input.checked, Object.keys(payload).length > 0);
				if (listFlag !== undefined) {
					payload.parameterListAllowed = listFlag;
				}
				if (Object.keys(payload).length === 0) {
					closeDialog();
					return undefined;
				}
				if (!send('dcs/set-link', { index: index, payload: payload })) {
					return BUSY;
				}
				return undefined;
			}
		);
	}

	// ---------- вкладка «Вычисляемые поля» ----------

	function renderCalculated(host) {
		const fields = list('calculatedFields');
		listToolbar(host, [{ icon: 'add', name: 'Добавить вычисляемое поле…', onClick: () => openCalculatedDialog(null) }]);
		if (fields.length === 0) {
			emptyNote(host, 'Вычисляемых полей нет.');
		} else {
			const tbody = dataTable(host, ['Путь к данным', 'Выражение', 'Заголовок', 'Тип', '']);
			for (const field of fields) {
				const tr = document.createElement('tr');
				cell(tr, field.name || '');
				cell(tr, field.value || '');
				cell(tr, field.title || '');
				typeCell(tr, field.valueType, '', 'вычисляемого поля ' + (field.name || ''), () => {
					openCalculatedTypeDialog(field);
				});
				actionsCell(tr, [
					{
						svg: 'edit',
						title: 'Править',
						onClick: () => {
							openCalculatedDialog(field);
						},
					},
					{
						svg: 'delete',
						title: 'Удалить',
						danger: true,
						onClick: () => {
							confirmRemove('Удалить вычисляемое поле «' + (field.name || '') + '»?', () => {
								if (!send('dcs/remove-calculated-field', { dataPath: field.name || '' })) {
									return BUSY;
								}
								return undefined;
							});
						},
					},
				]);
				tbody.appendChild(tr);
			}
		}
	}

	function openCalculatedDialog(field) {
		const original = field || {};
		let pathInput;
		let exprInput;
		let titleInput;
		let typeChoice = null;
		openDialog(
			field ? 'Вычисляемое поле «' + (original.name || '') + '»' : 'Новое вычисляемое поле',
			field ? 'Сохранить' : 'Добавить',
			(body) => {
				pathInput = formRow(body, 'Путь к данным', textInput(original.name));
				exprInput = expressionInput(body, 'Выражение', original.value, () => 'expr-calc');
				titleInput = formRow(body, 'Заголовок', textInput(original.title));
				// Новое поле add-calculated-field пишет без типа: операция его не принимает
				if (field) {
					typeChoice = typeRow(body, original.valueType, {
						title: () => 'Тип значения вычисляемого поля «' + (pathInput.value.trim() || original.name || '') + '»',
					});
				}
			},
			() => {
				const dataPath = pathInput.value.trim();
				const expression = exprInput.value.trim();
				const title = titleInput.value.trim();
				if (!dataPath) {
					return 'Укажите путь к данным.';
				}
				if (dataPath !== (original.name || '') && nameTaken(calculatedFieldPaths(), dataPath, original.name)) {
					return 'Вычисляемое поле с таким путём к данным уже есть.';
				}
				if (!field) {
					if (!expression) {
						return 'Укажите выражение.';
					}
					if (!send('addCalculatedField', { dataPath: dataPath, expression: expression, title: title })) {
						return BUSY;
					}
					return undefined;
				}
				const payload = {};
				if (dataPath !== (original.name || '')) {
					payload.newDataPath = dataPath;
				}
				if (expression !== (original.value || '')) {
					payload.expression = expression;
				}
				if (title !== (original.title || '')) {
					payload.title = title;
				}
				const typed = typeRules.typeEditPayload({ valueType: original.valueType }, { valueType: typeChoice.valueType() });
				if (typed.error) {
					return typed.error;
				}
				Object.assign(payload, typed.payload);
				if (Object.keys(payload).length === 0) {
					closeDialog();
					return undefined;
				}
				if (!send('dcs/set-calculated-field', { dataPath: original.name || '', payload: payload })) {
					return BUSY;
				}
				return undefined;
			}
		);
	}

	// ---------- вкладка «Ресурсы» ----------

	function totalFieldPath(item) {
		return item.name || '';
	}

	function totalFieldExpression(item) {
		return item.value || '';
	}

	/**
	 * Состояние закладки «Ресурсы» между перерисовками: дерево доступных полей (выбор, раскрытые ветки), выбранная строка
	 * таблицы ресурсов и признак «вернуть фокус на выбранную строку» (после удаления клавишей Delete в таблице).
	 */
	const resourceUi = { tree: { selected: '', expanded: new Set() }, selected: 0 };

	/** Ресурс считается по полю набора или вычисляемому полю: папку и промежуточный узел пути выбрать нельзя. */
	function resourcePickable(node) {
		return Boolean(node) && (node.kind === 'field' || node.kind === 'calc');
	}

	/** Узлы «Доступных полей» ресурса: поля всех наборов и вычисляемые — каталог подсказки поля ресурса (total-field). */
	function resourceFieldNodes() {
		return completer.buildCatalog(model, null, 'total-field', completionTypeOptions()).nodes;
	}

	// Имя говорит, какое выражение запишется: «>» и «>>» пишут файл сразу, без окна
	const RESOURCE_ADD_TITLE = 'Добавить ресурс Сумма(поле) по выбранному полю';
	const RESOURCE_ADD_ALL_TITLE = 'Добавить ресурсы Сумма(поле) по всем числовым полям';
	const RESOURCE_TREE_HINT = 'Enter и двойной щелчок по полю добавляют ресурс Сумма(поле).';
	/** Сколько полей плашка «>>» называет по имени (как проверка имён запроса): дальше — «и ещё N». */
	const RESOURCE_NAMES_SHOWN = 5;
	const RESOURCE_PICK_NOTE = 'Выберите поле в «Доступных полях» (не папку).';
	/** «>>» без полей в дереве: добавить нечего, пока в схеме не появятся поля наборов или вычисляемые. */
	const RESOURCE_NO_FIELDS_NOTE = 'Недоступно: полей нет.';
	/** «>>», пока типы полей ждут описаний объектов: ничего не пишется — деление по недочитанному типу было бы догадкой. */
	const RESOURCE_TYPES_LOADING = 'Типы полей ещё читаются из метаданных — нажмите «>>» ещё раз через мгновение.';

	/**
	 * Выражение ресурса по умолчанию — Сумма(<путь поля>). Путь вставляется как есть, без
	 * квадратных скобок: помощника «поле в выражении СКД» у редактора нет, подсказка выражений тоже вставляет пути как есть
	 * (пути полей в выгрузках — идентификаторы через точку).
	 */
	function resourceExpression(path) {
		return 'Сумма(' + path + ')';
	}

	/**
	 * Вид типа поля для ресурса: numeric, other, mixed или unknown (DcsFieldTypes.numericKind по строгому типу
	 * resourceFieldType: записанный тип, колонка запроса набора по метаданным; тип известен, только если его знает каждый
	 * набор с этим полем) либо waiting — тип зависит от описаний объектов, которые ещё не прочитаны (они в pending).
	 * type — известный тип (для подписи в предупреждении).
	 */
	function resourceFieldKind(node) {
		const result = fieldTypes.resourceFieldType(model, node.path, node.kind, describeLookup, {
			queryModel: queryModelApi,
			parse: parseQueryCached,
		});
		if (result.state === 'waiting') {
			return { kind: 'waiting', type: null, pending: result.pending };
		}
		return { kind: result.state === 'known' ? fieldTypes.numericKind(result.type) : 'unknown', type: result.type, pending: [] };
	}

	/**
	 * Годится ли путь поля в выражение Сумма(<путь>) как есть (DcsFieldTypes.plainFieldPath: сегменты — идентификаторы,
	 * первый — не слово языка).
	 */
	function resourcePathPlain(path) {
		return fieldTypes.plainFieldPath(path);
	}

	/**
	 * Строки плашки после «>»: что добавлено; если тип поля известен и в нём нет числа — что Сумма по такому полю,
	 * вероятно, сломает формирование отчёта и чем её заменить; если путь в выражении может прочитаться не как поле — что
	 * выражение стоит проверить. Составной тип с числом и неизвестный тип не предупреждаются: Сумма по ним может
	 * считаться. plain — годится ли путь в выражение как есть (resourcePathPlain).
	 */
	function resourceAddedLines(path, expression, typing, plain) {
		const lines = [{ text: 'Добавлен ресурс ' + expression + '.' }];
		if (typing.kind === 'other') {
			const label = typeLabelOf(typing.type, '');
			lines.push({
				text:
					'Поле «' + path + '» не числовое' + (label ? ' (' + label + ')' : '') + ': при формировании отчёта Сумма по нему выдаст ошибку. ' +
					'Замените выражение, например на Количество(' + path + ').',
			});
		}
		if (plain === false) {
			lines.push({ text: 'Путь «' + path + '» в выражении может прочитаться не как поле: проверьте выражение ресурса.' });
		}
		return lines;
	}

	/**
	 * Что добавит «>>»: поля дерева «Доступные поля» (поля наборов и вычисляемые, в порядке дерева, без повторов), по
	 * которым ещё нет ресурса, с известным числовым типом. kindOf(узел) — вид типа поля (resourceFieldKind), plainOf(путь)
	 * — годится ли путь в выражение как есть (resourcePathPlain). add — пути полей к добавлению; unknown — поля без
	 * известного типа, unsafe — поля с путём, который выражение может прочитать не как поле (их «>>» пропускает, «>»
	 * добавит); pending — описания объектов, без которых тип ещё не известен (тогда «>>» их ждёт и ничего не пишет). Поля
	 * с известным нечисловым или составным типом в план не входят.
	 */
	function resourceAddAllPlan(nodes, taken, kindOf, plainOf) {
		const plan = { add: [], unknown: [], unsafe: [], pending: [] };
		const seen = new Set(taken);
		const walk = (level) => {
			for (const node of level) {
				const key = resourcePickable(node) ? fieldTreeKey(node.path) : '';
				if (key && !seen.has(key)) {
					seen.add(key);
					const typing = plainOf(node.path) ? kindOf(node) : { kind: 'unsafe' };
					if (typing.kind === 'numeric') {
						plan.add.push(node.path);
					} else if (typing.kind === 'unknown') {
						plan.unknown.push(node.path);
					} else if (typing.kind === 'unsafe') {
						plan.unsafe.push(node.path);
					} else if (typing.kind === 'waiting') {
						plan.pending.push(...typing.pending);
					}
				}
				walk(Array.isArray(node.children) ? node.children : []);
			}
		};
		walk(nodes);
		return plan;
	}

	/** Пути полей для плашки: первые RESOURCE_NAMES_SHOWN через запятую, остальные — числом. */
	function resourceNameList(paths) {
		const shown = paths.slice(0, RESOURCE_NAMES_SHOWN).join(', ');
		return paths.length > RESOURCE_NAMES_SHOWN ? shown + ' и ещё ' + (paths.length - RESOURCE_NAMES_SHOWN) : shown;
	}

	/**
	 * Итог «>>» для плашки: какие ресурсы добавлены (или что полей с известным числовым типом без ресурса нет) и какие
	 * поля пропущены — без известного типа и с путём, который выражение может прочитать не как поле. Поля названы по
	 * имени, как в итоге автозаполнения: без имён совет «добавьте кнопкой «>»» не к чему приложить.
	 */
	function resourceAddAllLines(added, unknown, unsafe) {
		const lines = [
			{ text: added.length > 0 ? 'Добавлено ресурсов: ' + added.length + ' — ' + resourceNameList(added) + '.' : 'Полей с известным числовым типом без ресурса нет.' },
		];
		if (unknown.length > 0) {
			lines.push({ text: 'Пропущены поля без известного типа: ' + resourceNameList(unknown) + ' — их можно добавить кнопкой «>».' });
		}
		if (unsafe.length > 0) {
			lines.push({
				text: 'Пропущены поля, путь которых в выражении может прочитаться не как поле: ' + resourceNameList(unsafe) + ' — добавьте их кнопкой «>» и проверьте выражение.',
			});
		}
		return lines;
	}

	/**
	 * Есть ли уже у поля ресурс с тем же выражением (без учёта регистра и пробелов) и пустым «Рассчитывать по»: второй
	 * такой ничего не даёт, а запись сразу в файл отменяется только «<». Ресурс по тому же полю с другим выражением или
	 * своими группировками — не повтор.
	 */
	function resourceRepeats(totals, path, expression) {
		const same = (value) => String(value || '').replace(/\s+/g, '').toUpperCase();
		return totals.some(
			(item) =>
				fieldTreeKey(totalFieldPath(item)) === fieldTreeKey(path) &&
				same(totalFieldExpression(item)) === same(expression) &&
				!(Array.isArray(item.groups) && item.groups.some(Boolean))
		);
	}

	/**
	 * Плашка итога правки «Ресурсов» после удачного ответа (resourceReply): у «>» строки собираются по модели ответа —
	 * описания, пришедшие, пока правка сохранялась, уже дают предупреждение о нечисловом поле; у «>>» — названные поля
	 * плана. У окна «Новый ресурс» плашки нет (null): итог виден по окну.
	 */
	function resourceReplyNotice(reply) {
		if (reply.add) {
			const plain = resourcePathPlain(reply.add.path);
			const lines = resourceAddedLines(reply.add.path, reply.add.expression, resourceFieldKind({ path: reply.add.path, kind: reply.add.kind }), plain);
			return { tone: lines.length > 1 ? 'info' : 'ok', lines: lines };
		}
		if (reply.batch) {
			return { tone: 'ok', lines: resourceAddAllLines(reply.batch.add, reply.batch.unknown, reply.batch.unsafe) };
		}
		return null;
	}

	/**
	 * Отказ пакета «>>» называет ресурс номером операции («Операция 3 (cf-dcs-add-total-field): …» от md-sparrow, «Ресурсы
	 * не добавлены: ресурс 3 — …» от проверки панели), а список операций пользователь не видел: номер заменяется полем
	 * плана. Пакет атомарен — не записан ни один ресурс, это и говорит начало текста. Прочие отказы — как есть.
	 */
	function resourceRefusalText(reply, error) {
		const paths = reply && reply.batch ? reply.batch.add : null;
		const match = paths ? /^(?:Операция (\d+) \(cf-dcs-add-total-field\): |Ресурсы не добавлены: ресурс (\d+) — )/.exec(String(error || '')) : null;
		const path = match ? paths[Number(match[1] || match[2]) - 1] : undefined;
		return path === undefined ? error : 'Ресурсы не добавлены: ресурс по полю «' + path + '» — ' + String(error).slice(match[0].length);
	}

	/** Есть ли в дереве «Доступные поля» хоть одно поле, по которому можно добавить ресурс. */
	function hasResourceFields(nodes) {
		return nodes.some((node) => resourcePickable(node) || hasResourceFields(Array.isArray(node.children) ? node.children : []));
	}

	/**
	 * Итог правки «Ресурсов», который применить после ответа saved: row — строка таблицы, которую выбрать (новый ресурс
	 * встаёт в конец); add {path, kind, expression} — ресурс «>» (плашку соберёт resourceReplyNotice по модели ответа);
	 * batch {add, unknown, unsafe} — план «>>» (плашка и имя поля в отказе); без них — окно «Новый ресурс», плашки нет.
	 * Отказ итог сбрасывает: выбор остаётся прежним, причину объявляет общий ответ отказа.
	 */
	let resourceReply = null;

	/** Повтор клавиши Enter, зажатой на «>» или «>>», не жмёт кнопку снова: каждое нажатие сразу пишет ресурс в файл. */
	function ignoreEnterRepeat(button) {
		button.addEventListener('keydown', (event) => {
			if (event.key === 'Enter' && event.repeat) {
				event.preventDefault();
			}
		});
	}

	/**
	 * Закладка «Ресурсы» как в конфигураторе: слева дерево «Доступные поля» (поля наборов и вычисляемые, у вычисляемых —
	 * «f(x)»), посередине кнопки переноса, справа таблица ресурсов «Поле | Выражение | Рассчитывать по…». «>», Enter,
	 * двойной щелчок по полю и перенос поля на таблицу сразу добавляют ресурс Сумма(<поле>), без окна; «>>» — то же по
	 * всем полям с известным числовым типом одним пакетом. «Добавить ресурс…»
	 * открывает пустое окно нового ресурса. «<» и «<<» удаляют выбранный и все ресурсы после подтверждения: правка пишется
	 * в файл сразу, отмены на вкладках схемы нет.
	 */
	function renderResources(host) {
		const totals = list('totalFields');
		resourceUi.selected = Math.max(0, Math.min(resourceUi.selected, totals.length - 1));
		const layout = el('div', 'dcs-res');
		const left = el('div', 'dcs-res-col');
		left.appendChild(el('div', 'dcs-qd-col-head', 'Доступные поля'));
		const taken = new Set(totals.map((item) => fieldTreeKey(totalFieldPath(item))));
		let addButton = null;
		const syncAdd = (node) => {
			if (addButton) {
				setTransferState(addButton, RESOURCE_ADD_TITLE, !resourcePickable(node), resourcePickable(node) ? '' : RESOURCE_PICK_NOTE);
			}
		};
		const nodes = resourceFieldNodes();
		const tree = fieldTree(left, {
			label: 'Доступные поля',
			nodes: nodes,
			state: resourceUi.tree,
			keyPrefix: 'resavail',
			empty: 'Полей нет: здесь будут поля наборов и вычисляемые поля.',
			note: (node) => (resourcePickable(node) && taken.has(fieldTreeKey(node.path)) ? 'ресурс' : ''),
			pickable: resourcePickable,
			onActivate: (node) => addResourceFor(node),
			onSelect: syncAdd,
			// Перенос мышью: ресурс, брошенный на «Доступные поля», удаляется, как «<» (с вопросом): сначала он выбран,
			// как щелчком, — после ответа и после отмены вопроса выбор не уходит на другой ресурс
			drag: {
				id: 'resavail',
				scope: 'schema',
				from: {
					resgrid: (payload) => {
						const index = Number(payload.key);
						if (table) {
							table.pick(payload.key);
						} else {
							resourceUi.selected = index;
						}
						removeResource(index, '');
					},
				},
			},
		});
		layout.appendChild(left);
		const removeNote = totals.length === 0 ? 'Недоступно: ресурсов нет.' : '';
		// «>>» недоступна, только когда полей нет вовсе; иначе нажатие объясняет итог, даже если добавить нечего
		const noFields = !hasResourceFields(nodes);
		const moves = transferButtons(layout, [
			{ label: '>', title: RESOURCE_ADD_TITLE, onClick: () => addResourceFor(tree.selected()) },
			{
				label: '>>',
				title: RESOURCE_ADD_ALL_TITLE,
				unavailable: noFields,
				note: noFields ? RESOURCE_NO_FIELDS_NOTE : '',
				onClick: () => (noFields ? showNotice('info', 'Ресурсы', [{ text: RESOURCE_NO_FIELDS_NOTE }]) : addAllResources(nodes, taken)),
			},
			{ label: '<', title: 'Удалить выбранный ресурс', unavailable: totals.length === 0, note: removeNote, onClick: () => removeResource(resourceUi.selected, '') },
			{ label: '<<', title: 'Удалить все ресурсы', unavailable: totals.length === 0, note: removeNote, onClick: removeAllResources },
		]);
		moves.buttons.forEach((button) => keyed(button, focusKey(['resmove', button.textContent])));
		addButton = moves.buttons[0];
		ignoreEnterRepeat(moves.buttons[0]);
		ignoreEnterRepeat(moves.buttons[1]);
		syncAdd(tree.selected());
		// Enter и двойной щелчок по строке пишут ресурс без окна: это сказано подсказкой дерева, а не постоянным текстом
		setHint(tree.element, RESOURCE_TREE_HINT);
		// Типы полей для «>» и «>>» читаются заранее, после отрисовки: к нажатию описания обычно уже в кэше — предупреждение
		// о нечисловом поле и план «>>» не ждут их. Уже запрошенное (вкладкой набора, подсказкой) повторно не шлётся
		setTimeout(() => requestDescriptions(resourceAddAllPlan(nodes, new Set(), resourceFieldKind, resourcePathPlain).pending), HIGHLIGHT_DEBOUNCE_MS);
		const right = el('div', 'dcs-res-col');
		right.appendChild(el('div', 'dcs-qd-col-head', 'Ресурсы'));
		listToolbar(right, [{ icon: 'add', name: 'Добавить ресурс…', onClick: () => openTotalFieldDialog(null, -1) }]);
		let table = null;
		if (totals.length === 0) {
			emptyNote(right, 'Ресурсов нет: выберите поле в «Доступных полях» и нажмите «>».');
		} else {
			table = resourceGrid(right, totals);
		}
		// Перенос мышью: поле, брошенное в колонку ресурсов, — то же, что «>» (ресурс Сумма(<поле>) сразу, без окна);
		// строку ресурса тащат за ячейку поля обратно на «Доступные поля». Порядка ресурсов операция не знает: новый ресурс
		// встаёт в конец, внутри списка — без сброса
		tableDropZone(right, {
			id: 'resgrid',
			scope: 'schema',
			head: table ? table.head : null,
			rows: () => (table ? table.rows : []),
			keys: table ? table.keys : null,
			drag: () => 'resource',
			pick: table ? table.pick : undefined,
			from: {
				resavail: (payload) => {
					const node = tree.nodeOf(payload.key);
					if (!resourcePickable(node)) {
						return false;
					}
					addResourceFor(node);
					return undefined;
				},
			},
			place: 'zone',
			effect: 'copy',
		});
		layout.appendChild(right);
		host.appendChild(layout);
		if (focusResourceRow) {
			focusResourceRow = false;
			// Удалён последний ресурс — строк нет: фокус на «<», она есть всегда (без ресурсов — недоступна с причиной)
			const row = focusKeys.get(focusKey(['resrow', resourceUi.selected])) || focusKeys.get(focusKey(['resmove', '<']));
			if (row) {
				row.focus();
			}
		}
	}

	/** Канал правок занят: ресурс не отправлен — сказать об этом в строке состояния и читалке (строка — не живая область). */
	function resourceBusy() {
		setStatus(BUSY, true);
		announceCompletion(BUSY);
	}

	/**
	 * «>», Enter, двойной щелчок по полю и перенос поля на таблицу: ресурс Сумма(<поле>) сразу, без окна, — та же правка
	 * dcs/add-total-field, что у «Добавить» окна нового ресурса («Рассчитывать по» пусто — по всем группировкам), и тот же
	 * отказ. Ресурсов по одному полю бывает несколько, но если у поля уже есть ровно такой ресурс (то же выражение, по всем
	 * группировкам), второй не пишется: плашка говорит, что он есть, и как добавить ресурс с другим «Рассчитывать по», —
	 * так лишний ресурс не появится и от случайного повторного нажатия. После ответа выбран новый ресурс, фокус остаётся,
	 * где был (на «>» или строке дерева: их ключи переживают перерисовку), плашка говорит, что добавлено, а у поля с
	 * известным нечисловым типом и у пути, который выражение может прочитать не как поле, — предупреждает. По папке —
	 * подсказка, что выбрать.
	 */
	function addResourceFor(node) {
		if (!resourcePickable(node)) {
			showNotice('info', 'Ресурсы', [{ text: RESOURCE_PICK_NOTE }]);
			return;
		}
		const expression = resourceExpression(node.path);
		if (resourceRepeats(list('totalFields'), node.path, expression)) {
			showNotice('info', 'Ресурсы', [
				{ text: 'Ресурс ' + expression + ' уже есть. Второй ресурс по этому полю нужен с другим «Рассчитывать по» — его добавьте окном «Добавить ресурс…».' },
			]);
			return;
		}
		const typing = resourceFieldKind(node);
		if (typing.kind === 'waiting') {
			// Тип ждёт описаний: ресурс добавляется сразу, а описания читаются — плашка ответа соберётся уже по ним, если
			// они успеют прийти, пока правка сохраняется
			requestDescriptions(typing.pending);
		}
		if (!send('dcs/add-total-field', { payload: { dataPath: node.path, expression: expression } })) {
			resourceBusy();
			return;
		}
		resourceReply = { row: list('totalFields').length, add: { path: node.path, kind: node.kind, expression: expression } };
	}

	/**
	 * «>>»: ресурсы Сумма(<поле>) по всем полям с известным числовым типом, по которым ещё нет ресурса, — одним пакетом
	 * dcs/add-total-fields (все или ни одного). Поля без типа и с путём, который выражение может прочитать не как поле,
	 * пропускаются, плашка их называет; пока типы ждут описаний, ничего не пишется. После ответа выбран первый новый
	 * ресурс, фокус остаётся на «>>», плашка называет добавленные; отказ называет поле, а не номер операции пакета.
	 */
	function addAllResources(nodes, taken) {
		const plan = resourceAddAllPlan(nodes, taken, resourceFieldKind, resourcePathPlain);
		if (plan.pending.length > 0) {
			requestDescriptions(plan.pending);
			showNotice('info', 'Ресурсы', [{ text: RESOURCE_TYPES_LOADING }]);
			return;
		}
		if (plan.add.length === 0) {
			showNotice('info', 'Ресурсы', resourceAddAllLines([], plan.unknown, plan.unsafe));
			return;
		}
		const payloads = plan.add.map((path) => ({ dataPath: path, expression: resourceExpression(path) }));
		if (!send('dcs/add-total-fields', { payloads: payloads })) {
			resourceBusy();
			return;
		}
		resourceReply = { row: list('totalFields').length, batch: { add: plan.add, unknown: plan.unknown, unsafe: plan.unsafe } };
	}

	/**
	 * Удаление ресурса после вопроса. from — откуда: 'grid' — клавиша Delete в таблице, 'row' — кнопка «Удалить» строки,
	 * '' — «<» или перенос мышью. После ответа выбор остаётся на том же месте — на следующем ресурсе (последний — на новом
	 * последнем). Фокус на строку ставит только удачный ответ (replyFocus.resources): из таблицы — всегда, с кнопки
	 * последней строки — потому что после ответа её нет (без строк — на «<»). Нажатая «<» фокус сохраняет: её ключ
	 * переживает перерисовку, и повторное нажатие не требует Shift+Tab.
	 */
	function removeResource(index, from) {
		const item = list('totalFields')[index];
		if (!item) {
			showNotice('info', 'Ресурсы', [{ text: 'Ресурсов нет.' }]);
			return;
		}
		confirmRemove('Удалить ресурс «' + totalFieldPath(item) + '»?', () => {
			if (!send('dcs/remove-total-field', { index: index })) {
				return BUSY;
			}
			replyFocus.resources = from === 'grid' || (from === 'row' && index === list('totalFields').length - 1);
			return undefined;
		});
	}

	/** «<<»: все ресурсы одним пакетом (dcs/remove-total-fields): частичного удаления не бывает. */
	function removeAllResources() {
		const totals = list('totalFields');
		if (totals.length === 0) {
			showNotice('info', 'Ресурсы', [{ text: 'Ресурсов нет.' }]);
			return;
		}
		confirmRemove('Удалить все ресурсы (' + totals.length + ')?', () => {
			if (!send('dcs/remove-total-fields', { indexes: totals.map((item, index) => index) })) {
				return BUSY;
			}
			resourceUi.selected = 0;
			return undefined;
		});
	}

	/**
	 * Таблица ресурсов — сетка с одной остановкой Tab на строках: строка выбирается щелчком и стрелками (↑ ↓ Home End),
	 * Enter открывает её окно, Delete удаляет. Кнопки строки доступны с клавиатуры только у выбранной строки (как в
	 * сетках конструктора запроса). Многострочное выражение видно в строке целиком: переносы строк сохраняются. Возвращает
	 * для переноса мышью {head — строка шапки, rows — строки, keys — строка → номер ресурса, pick(номер) — выбрать, как
	 * щелчком}; строку тащат за ячейку поля (в строке кнопки).
	 */
	function resourceGrid(host, totals) {
		const wrap = el('div', 'dcs-table-wrap');
		const table = el('table', 'dcs-table dcs-res-table');
		table.setAttribute('role', 'grid');
		table.setAttribute('aria-label', 'Ресурсы');
		const thead = document.createElement('thead');
		const head = document.createElement('tr');
		head.setAttribute('role', 'row');
		for (const title of ['Поле', 'Выражение', 'Рассчитывать по…', '']) {
			const th = el('th', '', title);
			th.setAttribute('role', 'columnheader');
			if (!title) {
				th.setAttribute('aria-label', 'Команды строки');
			}
			head.appendChild(th);
		}
		thead.appendChild(head);
		table.appendChild(thead);
		const tbody = document.createElement('tbody');
		const rows = [];
		const keys = new WeakMap();
		const controlsOfRow = (tr) => Array.from(tr.children).flatMap((td) => Array.from(td.children).filter((node) => node.tagName === 'BUTTON'));
		const setStop = (index, focus) => {
			resourceUi.selected = index;
			rows.forEach((tr, at) => {
				const on = at === index;
				tr.classList.toggle('dcs-tree-selected', on);
				tr.setAttribute('aria-selected', String(on));
				tr.tabIndex = on ? 0 : -1;
				for (const control of controlsOfRow(tr)) {
					control.tabIndex = on ? 0 : -1;
				}
			});
			if (focus && rows[index]) {
				rows[index].focus();
			}
		};
		totals.forEach((item, index) => {
			const tr = document.createElement('tr');
			tr.setAttribute('role', 'row');
			keyed(tr, focusKey(['resrow', index]));
			const cells = [
				cell(tr, totalFieldPath(item)),
				cell(tr, totalFieldExpression(item), 'dcs-res-expr'),
				cell(tr, Array.isArray(item.groups) ? item.groups.join(', ') : ''),
			];
			// Ручка переноса — ячейка поля: у строки только атрибут, слушатели — у документа
			cells[0].draggable = true;
			keys.set(tr, String(index));
			for (const td of cells) {
				td.setAttribute('role', 'gridcell');
			}
			// Имя строки заменяет её ячейки для читалки: в нём все три колонки
			const groups = Array.isArray(item.groups) ? item.groups.filter(Boolean) : [];
			tr.setAttribute(
				'aria-label',
				totalFieldPath(item) + ': ' + totalFieldExpression(item).replace(/\s+/g, ' ') + (groups.length > 0 ? '; рассчитывать по: ' + groups.join(', ') : '')
			);
			actionsCell(tr, [
				{
					svg: 'edit',
					title: 'Править',
					key: focusKey(['resedit', index]),
					onClick: () => {
						openTotalFieldDialog(item, index);
					},
				},
				{
					svg: 'delete',
					title: 'Удалить',
					danger: true,
					key: focusKey(['resdel', index]),
					onClick: () => removeResource(index, 'row'),
				},
			]);
			tr.children[tr.children.length - 1].setAttribute('role', 'gridcell');
			tr.addEventListener('click', (event) => {
				if (!event || !event.target || event.target === tr || event.target.tagName === 'TD') {
					setStop(index, false);
				}
			});
			// Фокус в кнопку строки пришёл щелчком: остановка Tab переезжает в эту строку
			tr.addEventListener('focusin', () => {
				if (resourceUi.selected !== index) {
					setStop(index, false);
				}
			});
			tr.addEventListener('keydown', (event) => {
				if (event.target !== tr || event.defaultPrevented) {
					return;
				}
				let to = -1;
				if (event.key === 'ArrowDown') {
					to = Math.min(totals.length - 1, index + 1);
				} else if (event.key === 'ArrowUp') {
					to = Math.max(0, index - 1);
				} else if (event.key === 'Home') {
					to = 0;
				} else if (event.key === 'End') {
					to = totals.length - 1;
				} else if (event.key === 'Enter') {
					event.preventDefault();
					openTotalFieldDialog(item, index);
					return;
				} else if (event.key === 'Delete') {
					event.preventDefault();
					removeResource(index, 'grid');
					return;
				} else {
					return;
				}
				event.preventDefault();
				setStop(to, true);
			});
			rows.push(tr);
			tbody.appendChild(tr);
		});
		table.appendChild(tbody);
		wrap.appendChild(table);
		host.appendChild(wrap);
		setStop(resourceUi.selected, false);
		return { head: head, rows: rows, keys: keys, pick: (key) => setStop(Number(key), false) };
	}

	/**
	 * Окно ресурса: правка выбранного и новый ресурс («Добавить ресурс…» — поле и выражение пустые, их вводит
	 * пользователь). Ресурс Сумма(<поле>) без окна добавляет «>» (addResourceFor) той же правкой dcs/add-total-field. Поле,
	 * выбранное в «Доступных полях», окно не подставляет — как «Добавить поле…» в «Настройках».
	 */
	function openTotalFieldDialog(item, index) {
		const original = item || {};
		const originalGroups = Array.isArray(original.groups) ? original.groups : [];
		let pathInput;
		let exprInput;
		const groupBoxes = [];
		openDialog(
			item ? 'Ресурс «' + totalFieldPath(original) + '»' : 'Новый ресурс',
			item ? 'Сохранить' : 'Добавить',
			(body) => {
				pathInput = formRow(body, 'Поле', textInput(totalFieldPath(original)));
				// Подсказка — пути полей наборов и вычисляемых полей
				attachCompletion(pathInput, () => 'total-field');
				const known = fieldPaths();
				exprInput = expressionInput(body, 'Выражение', totalFieldExpression(original), () => 'expr-total');
				groupTitle(body, 'Рассчитывать по');
				const groupOptions = known.slice();
				for (const group of originalGroups) {
					if (groupOptions.indexOf(group) < 0) {
						groupOptions.push(group);
					}
				}
				if (groupOptions.length > 0) {
					const listEl = el('div', 'dcs-check-list');
					// Что значит «ничего не отмечено» — подсказкой у группы флажков, а не абзацем под ней
					listEl.setAttribute('role', 'group');
					listEl.setAttribute('aria-label', 'Рассчитывать по');
					setHint(listEl, 'Без отметок ресурс считается по всем группировкам.');
					for (const group of groupOptions) {
						const box = checkbox(group, originalGroups.indexOf(group) >= 0);
						groupBoxes.push({ name: group, input: box.input });
						listEl.appendChild(box.wrap);
					}
					body.appendChild(listEl);
				} else {
					emptyNote(body, 'Полей нет: ресурс считается по всем группировкам.');
				}
			},
			() => {
				const dataPath = pathInput.value.trim();
				const expression = exprInput.value.trim();
				if (!dataPath) {
					return 'Укажите поле.';
				}
				if (!expression) {
					return 'Укажите выражение.';
				}
				const groups = groupBoxes.filter((box) => box.input.checked).map((box) => box.name);
				if (!item) {
					const payload = { dataPath: dataPath, expression: expression };
					if (groups.length > 0) {
						payload.groups = groups;
					}
					if (!send('dcs/add-total-field', { payload: payload })) {
						return BUSY;
					}
					// Новый ресурс встаёт в конец таблицы: после удачного ответа выбрана его строка (итог виден по окну — без плашки)
					resourceReply = { row: list('totalFields').length };
					return undefined;
				}
				const payload = {};
				if (dataPath !== totalFieldPath(original)) {
					payload.dataPath = dataPath;
				}
				if (expression !== totalFieldExpression(original)) {
					payload.expression = expression;
				}
				const sameGroups =
					groups.length === originalGroups.length && originalGroups.every((group) => groups.indexOf(group) >= 0);
				if (!sameGroups) {
					payload.groups = groups;
				}
				if (Object.keys(payload).length === 0) {
					closeDialog();
					return undefined;
				}
				if (!send('dcs/set-total-field', { index: index, payload: payload })) {
					return BUSY;
				}
				return undefined;
			}
		);
	}

	// ---------- вкладка «Параметры» ----------

	function useLabel(use) {
		if (use === 'Always') {
			return 'Всегда';
		}
		if (use === 'Auto') {
			return 'Авто';
		}
		return use || '';
	}

	/**
	 * Список значений параметра схемы, где «Неопределено» стоит рядом с другими значениями. Загрузка схемы в
	 * платформу 8.3.27 (ibcmd) такой элемент отбрасывает и оставляет одни заданные значения (одиночный хранит),
	 * а md-sparrow такой список не пишет; прочитанный из файла показывается с предупреждением, сам список редактор
	 * не правит.
	 */
	function schemaListDropsNil(value) {
		const items = value && value.list && Array.isArray(value.list.items) ? value.list.items : [];
		return items.length > 1 && items.some((item) => Boolean(item && item.value && item.value.nil));
	}

	const SCHEMA_LIST_NIL_WARNING =
		'«Неопределено» рядом с другими значениями списка загрузка схемы в платформу отбрасывает: после загрузки останутся только заданные значения.';

	/** Текст плашки над таблицей параметров: у каких параметров такой список; пусто — плашки нет. */
	function schemaListNilPlate(params) {
		const names = params.filter((param) => schemaListDropsNil(param.valueTyped)).map((param) => '«' + (param.name || '') + '»');
		if (names.length === 0) {
			return '';
		}
		return (names.length === 1 ? 'У параметра ' : 'У параметров ') + names.join(', ') + ' в списке значений ' + SCHEMA_LIST_NIL_WARNING;
	}

	/**
	 * Элементы списка значений параметра схемы старой записи, чьи представления потеряет загрузка: пусто — потерь
	 * нет. Старая запись — список одним значением v8:ValueListType с представлениями элементов; платформа хранит
	 * список повторяющимися значениями без представлений, и загрузка схемы в 8.3.27 (параметр с признаком «Доступен
	 * список значений») такой список разворачивает, а представления молча теряет. Редактор старую запись не
	 * переписывает, а предупреждает. Правило — как у предупреждения valueListPresentationsLost строгой проверки
	 * md-sparrow: признак списка, значение-список и непустое представление хотя бы у одного элемента. У формы
	 * платформы представлений не бывает, поэтому ложного предупреждения правило не даёт; список без представлений
	 * загрузка разворачивает без потерь, а без признака списка редактор о таком списке молчит.
	 */
	function schemaListPresentedItems(value, valueListAllowed) {
		if (valueListAllowed !== true || !value || value.type !== 'v8:ValueListType') {
			return [];
		}
		const items = value.list && Array.isArray(value.list.items) ? value.list.items : [];
		return items.filter((item) => Boolean(item) && typeof item.presentation === 'string' && item.presentation !== '');
	}

	/** Сколько элементов с представлениями называет предупреждение; остальные — числом, как у md-sparrow. */
	const SCHEMA_LIST_NAMED_ITEMS = 3;

	/**
	 * Что будет с таким списком при загрузке и в файле. Значения не теряются — пугать ими незачем. Если среди них
	 * ещё и «Неопределено» рядом с другими (schemaListDropsNil), останутся только заданные: его загрузка отбрасывает,
	 * и «Значения останутся» спорило бы с соседним предупреждением. many — о нескольких списках (плашка).
	 */
	function schemaListPresentationLoss(dropsNil, many) {
		return (
			'загрузка схемы в платформу развернёт ' +
			(many ? 'их' : 'его') +
			' в отдельные значения, а представления потеряет. ' +
			(dropsNil ? 'Заданные значения' : 'Значения') +
			' останутся; в файле ' +
			(many ? 'такие списки хранятся' : 'такой список хранится') +
			' как есть.'
		);
	}

	/**
	 * Предупреждение ячейки значения, диалога параметра и окна типа: элементы с представлениями и что с ними
	 * сделает загрузка; пусто — предупреждать не о чем. describe(value) — сводка значения элемента (valueSummary).
	 */
	function schemaListPresentationWarning(value, valueListAllowed, describe) {
		const items = schemaListPresentedItems(value, valueListAllowed);
		if (items.length === 0) {
			return '';
		}
		const named = items
			.slice(0, SCHEMA_LIST_NAMED_ITEMS)
			.map((item) => (describe(item.value) || 'пустое') + ' — «' + item.presentation + '»');
		const rest = items.length > SCHEMA_LIST_NAMED_ITEMS ? ' и ещё ' + (items.length - SCHEMA_LIST_NAMED_ITEMS) : '';
		return (
			'Список значений записан старой формой, с представлениями элементов (' +
			named.join(', ') +
			rest +
			'): ' +
			schemaListPresentationLoss(schemaListDropsNil(value), false)
		);
	}

	/** Текст плашки над таблицей параметров: у каких параметров старый список с представлениями; пусто — плашки нет. */
	function schemaListPresentationPlate(params) {
		const marked = params.filter((param) => schemaListPresentedItems(param.valueTyped, param.valueListAllowed).length > 0);
		if (marked.length === 0) {
			return '';
		}
		const names = marked.map((param) => '«' + (param.name || '') + '»');
		const dropsNil = marked.some((param) => schemaListDropsNil(param.valueTyped));
		if (names.length === 1) {
			return 'Список значений параметра ' + names[0] + ' записан старой формой, с представлениями элементов: ' + schemaListPresentationLoss(dropsNil, false);
		}
		return 'Списки значений параметров ' + names.join(', ') + ' записаны старой формой, с представлениями элементов: ' + schemaListPresentationLoss(dropsNil, true);
	}

	/** Предупреждения ячейки «Значение» параметра схемы: «Неопределено» среди значений и старый список с представлениями. */
	function schemaValueWarnings(param, describe) {
		const warnings = [];
		if (schemaListDropsNil(param.valueTyped)) {
			warnings.push(SCHEMA_LIST_NIL_WARNING);
		}
		const presentations = schemaListPresentationWarning(param.valueTyped, param.valueListAllowed, describe);
		if (presentations) {
			warnings.push(presentations);
		}
		return warnings;
	}

	function renderParameters(host) {
		const params = list('parameters');
		const toolbar = [{ icon: 'add', name: 'Добавить параметр…', onClick: () => openParameterDialog(null) }];
		if (params.length === 0) {
			listToolbar(host, toolbar);
			emptyNote(host, 'Параметров нет.');
		} else {
			for (const plate of [schemaListNilPlate(params), schemaListPresentationPlate(params)]) {
				if (plate) {
					host.appendChild(el('div', 'dcs-plate dcs-plate-warn', plate));
				}
			}
			listToolbar(host, toolbar);
			const tbody = dataTable(host, [
				'Имя',
				'Заголовок',
				'Тип',
				'Значение',
				'Выражение',
				'Использование',
				'Ограничение доступности',
				'',
			]);
			for (const param of params) {
				const tr = document.createElement('tr');
				cell(tr, param.name || '');
				cell(tr, param.title || '');
				typeCell(tr, param.valueType, param.type, 'параметра ' + (param.name || ''), () => {
					openParameterTypeDialog(param);
				});
				const valueTd = cell(tr, param.valueTyped ? valueSummary(param.valueTyped) : param.valuePresentation || '');
				const valueWarnings = schemaValueWarnings(param, valueSummary);
				if (valueWarnings.length > 0) {
					valueTd.title = valueWarnings.join('\n');
					valueTd.setAttribute('aria-description', valueWarnings.join(' '));
				}
				cell(tr, param.expression || '');
				cell(tr, useLabel(param.use));
				cell(tr, param.useRestriction ? '✓' : '', 'dcs-cell-check');
				actionsCell(tr, [
					{
						svg: 'edit',
						title: 'Править',
						onClick: () => {
							openParameterDialog(param);
						},
					},
					{
						svg: 'delete',
						title: 'Удалить',
						danger: true,
						onClick: () => {
							confirmRemove('Удалить параметр «' + (param.name || '') + '»?', () => {
								if (!send('dcs/remove-parameter', { name: param.name || '' })) {
									return BUSY;
								}
								return undefined;
							});
						},
					},
				]);
				tbody.appendChild(tr);
			}
		}
	}

	function openParameterDialog(param) {
		const original = param || {};
		const names = list('parameters')
			.map((item) => item.name || '')
			.filter(Boolean);
		let nameInput;
		let titleInput;
		let exprInput;
		let useSelect;
		let restrictionBox;
		let typeChoice;
		let listBox = null;
		let asFieldBox = null;
		let denyBox = null;
		/** Что окажется в payload по текущему выбору: тип, очистка значения, признаки параметра. */
		function typedPayload() {
			if (!param) {
				// add-parameter принимает тип, но не признаки: их правят у созданного параметра
				return typeRules.typeEditPayload({}, { valueType: typeChoice.valueType() });
			}
			return typeRules.typeEditPayload(
				parameterOriginal(original),
				{
					valueType: typeChoice.valueType(),
					valueListAllowed: listBox.input.checked,
					availableAsField: asFieldBox.input.checked,
					denyIncompleteValues: denyBox.input.checked,
				},
				typeDictionary
			);
		}
		openDialog(
			param ? 'Параметр «' + (original.name || '') + '»' : 'Новый параметр',
			param ? 'Сохранить' : 'Добавить',
			(body) => {
				nameInput = formRow(body, 'Имя', textInput(original.name));
				titleInput = formRow(body, 'Заголовок', textInput(original.title));
				let valueWarn = null;
				typeChoice = typeRow(body, original.valueType, {
					title: () => 'Тип значения параметра «' + (nameInput.value.trim() || original.name || '') + '»',
					fallback: original.type,
					warnings: typeOwnerWarnings(original),
					onChange: () => {
						if (valueWarn) {
							const change = typedPayload().valueChange;
							valueWarn.textContent = change ? clearingText(change) : '';
						}
					},
				});
				if (param) {
					const value = original.valueTyped;
					const valueBox = el('div', 'dcs-type-value-box');
					valueBox.appendChild(
						el('span', 'dcs-type-value', value === undefined ? 'не задано' : valueSummary(value) || 'пустое')
					);
					if (schemaListDropsNil(value)) {
						valueBox.appendChild(el('div', 'dcs-warn dcs-list-nil-warn', SCHEMA_LIST_NIL_WARNING));
					}
					const presentationWarning = schemaListPresentationWarning(value, original.valueListAllowed, valueSummary);
					if (presentationWarning) {
						valueBox.appendChild(el('div', 'dcs-warn dcs-list-presentation-warn', presentationWarning));
					}
					valueWarn = el('div', 'dcs-warn dcs-type-warn');
					valueWarn.setAttribute('aria-live', 'polite');
					valueBox.appendChild(valueWarn);
					formRow(body, 'Значение', valueBox);
				}
				// Сам параметр в своём выражении не предлагается: у нового — по набранному имени
				exprInput = expressionInput(
					body,
					'Выражение',
					original.expression,
					() => 'expr-param:' + (original.name || nameInput.value.trim())
				);
				useSelect = formRow(
					body,
					'Использование',
					selectInput(
						[
							{ value: 'Auto', label: 'Авто' },
							{ value: 'Always', label: 'Всегда' },
						],
						original.use === 'Always' ? 'Always' : 'Auto'
					)
				);
				restrictionBox = checkbox('Ограничение доступности', original.useRestriction);
				if (param) {
					// Умолчания признаков — как пишет md-sparrow: отсутствие в файле — умолчание
					const defaults = typeRules.PARAMETER_FLAG_DEFAULTS;
					const flag = (key) => (typeof original[key] === 'boolean' ? original[key] : defaults[key]);
					listBox = checkbox('Доступен список значений', flag('valueListAllowed'));
					asFieldBox = checkbox('Доступен как поле', flag('availableAsField'));
					denyBox = checkbox('Запрещать незаполненные значения', flag('denyIncompleteValues'));
					checkRow(body, [restrictionBox, listBox, asFieldBox, denyBox]);
				} else {
					checkRow(body, [restrictionBox]);
				}
			},
			() => {
				const name = nameInput.value.trim();
				const title = titleInput.value.trim();
				const expression = exprInput.value.trim();
				if (!name) {
					return 'Укажите имя параметра.';
				}
				const typed = typedPayload();
				if (typed.error) {
					return typed.error;
				}
				if (!param) {
					// Имена параметров в запросе регистра не различают: «размер» и «Размер» — один параметр
					if (names.some((taken) => taken.toLowerCase() === name.toLowerCase())) {
						return 'Параметр с таким именем уже есть.';
					}
					const payload = { name: name };
					if (title) {
						payload.title = title;
					}
					if (expression) {
						payload.expression = expression;
					}
					if (useSelect.value === 'Always') {
						payload.use = 'Always';
					}
					if (restrictionBox.input.checked) {
						payload.useRestriction = true;
					}
					if (typed.payload.valueType) {
						payload.valueType = typed.payload.valueType;
					}
					if (!send('dcs/add-parameter', { payload: payload })) {
						return BUSY;
					}
					return undefined;
				}
				const payload = {};
				if (name !== (original.name || '')) {
					// Как при добавлении — без учёта регистра; смена регистра своего же имени не занимает чужое
					if (names.some((taken) => taken !== original.name && taken.toLowerCase() === name.toLowerCase())) {
						return 'Параметр с таким именем уже есть.';
					}
					payload.newName = name;
				}
				if (title !== (original.title || '')) {
					payload.title = title;
				}
				if (expression !== (original.expression || '')) {
					payload.expression = expression;
				}
				if (useSelect.value !== (original.use === 'Always' ? 'Always' : 'Auto')) {
					payload.use = useSelect.value;
				}
				if (restrictionBox.input.checked !== Boolean(original.useRestriction)) {
					payload.useRestriction = restrictionBox.input.checked;
				}
				Object.assign(payload, typed.payload);
				if (Object.keys(payload).length === 0) {
					closeDialog();
					return undefined;
				}
				if (!send('dcs/set-parameter', { name: original.name || '', payload: payload })) {
					return BUSY;
				}
				return undefined;
			}
		);
	}

	// ---------- вкладка «Вложенные схемы» (только просмотр) ----------

	function renderNested(host) {
		const nested = list('nestedSchemas');
		if (nested.length === 0) {
			emptyNote(host, 'Вложенных схем нет.');
			return;
		}
		listSection(host, nested.map((item) => ({ name: item.name || '', value: item.value || '' })));
	}

	// ---------- вкладка «Настройки»: варианты, дерево структуры, панели узла ----------

	/** Настройки загруженных вариантов по имени (ленивая загрузка dcs/load-variant). */
	const variantCache = {};
	/** Ошибки загрузки вариантов по имени. */
	const variantErrors = {};
	/** Варианты, дерево которых уже развёрнуто при первом показе. */
	const seededVariants = {};
	/** Вариант, ответ dcs/load-variant по которому ещё не пришёл. */
	let variantLoading = '';
	/** Вариант правки в полёте: если ответ saved не принёс его настройки, кэш сбрасывается. */
	let pendingVariant = '';
	/** Путь узла, который выделить после удачной правки структуры. */
	let pendingSelect = null;

	/**
	 * Состояние вкладки «Настройки»: активный вариант, выделенный узел, панель и развёрнутость дерева.
	 * Живёт вне модели и переживает перерисовку. nodePath — путь контракта: шаги {list, index},
	 * [] — корень; ключи развёрнутости — JSON пути. Псевдо-узлы «Колонки/Строки/Точки/Серии»
	 * помечаются последним шагом с index −1 — наружу такой шаг не уходит.
	 */
	const uiState = { variant: '', nodePath: [], panel: 'selection', expanded: new Set(), showInaccessibleParams: false };

	/**
	 * Флажки «вернуть фокус после перерисовки» — для навигации с клавиатуры: стрелка в таблице вариантов или в дереве
	 * перерисовывает вкладку, и фокус должен встать на новую строку.
	 */
	let focusVariantRow = false;
	let focusStructureRow = false;
	/** Ключ состояния списка панели (listStateKey), строке которого вернуть фокус в этой отрисовке. */
	let focusListPanel = '';
	/**
	 * Фокус, который вернуть после ответа правки, отправленной с клавиатуры: удаление варианта, узла или строки списка
	 * клавишей Delete, переименование варианта из таблицы. Ставится при отправке, в флажки отрисовки переходит только
	 * удачным ответом saved и после его отрисовки гаснет; отказ, смена варианта, узла и вкладки узла его сбрасывают.
	 * Иначе флажок сработал бы на первой же чужой отрисовке (щелчок по другому узлу до ответа) или пережил бы ответ.
	 */
	const replyFocus = { variant: false, structure: false, list: '', fallback: '', resources: false };
	/** Вернуть фокус на выбранную строку таблицы «Ресурсов» (или «<») в этой отрисовке: удаление из таблицы. */
	let focusResourceRow = false;

	function clearReplyFocus() {
		replyFocus.variant = false;
		replyFocus.structure = false;
		replyFocus.list = '';
		replyFocus.fallback = '';
		replyFocus.resources = false;
	}

	/**
	 * Удаление строки кнопкой в строке, когда ключи кнопок — по номеру строки: после ответа фокус вернётся на ту же
	 * кнопку, теперь у строки-преемника. Удалена последняя строка — преемника нет: запасной фокус — та же кнопка у
	 * предыдущей строки, а без строк — команда над списком (emptyKey).
	 */
	function rowRemovalFocus(keyOf, index, emptyKey) {
		replyFocus.fallback = index > 0 ? keyOf(index - 1) : emptyKey;
	}
	/**
	 * Выбранная строка списка панели узла по ключу «вариант, путь узла, панель»: {key — адрес строки (JSON позиции в
	 * дереве элементов), index — её номер среди видимых строк}. Номер — запасной выбор, если строки с адресом больше нет.
	 */
	const settingsListUi = new Map();
	/** Дерево «Доступные поля» панелей «Выбранные поля», «Отбор» и «Сортировка»: выбор и раскрытые ветки на раздел. */
	const settingsAvailUi = {
		selection: { selected: '', expanded: new Set() },
		filter: { selected: '', expanded: new Set() },
		order: { selected: '', expanded: new Set() },
	};

	const NODE_LISTS = ['structure', 'columns', 'rows', 'points', 'series'];
	const PSEUDO_TITLES = { columns: 'Колонки', rows: 'Строки', points: 'Точки', series: 'Серии' };

	/** Подпись Items — «Без иерархии», как в мастере настроек. */
	const GROUP_TYPE_OPTIONS = [
		{ value: 'Items', label: 'Без иерархии' },
		{ value: 'Hierarchy', label: 'Иерархия' },
		{ value: 'HierarchyOnly', label: 'Только иерархия' },
	];

	/** Дополнение периода: все значения DataCompositionPeriodAdditionType из core XSD. */
	const PERIOD_ADDITION_LABELS = {
		None: 'Нет',
		Year: 'Год',
		HalfYear: 'Полугодие',
		Quarter: 'Квартал',
		Month: 'Месяц',
		TenDays: 'Декада',
		Week: 'Неделя',
		Day: 'День',
		Hour: 'Час',
		Minute: 'Минута',
		Second: 'Секунда',
		YearSinceBeginOfPeriod: 'Год с начала периода',
		HalfYearSinceBeginOfPeriod: 'Полугодие с начала периода',
		QuarterSinceBeginOfPeriod: 'Квартал с начала периода',
		MonthSinceBeginOfPeriod: 'Месяц с начала периода',
		WeekSinceBeginOfPeriod: 'Неделя с начала периода',
		DaySinceBeginOfPeriod: 'День с начала периода',
		HourSinceBeginOfPeriod: 'Час с начала периода',
		MinuteSinceBeginOfPeriod: 'Минута с начала периода',
		YearSinceBeginOfPeriod445: 'Год с начала периода 4-4-5',
		HalfYearSinceBeginOfPeriod445: 'Полугодие с начала периода 4-4-5',
		QuarterSinceBeginOfPeriod445: 'Квартал с начала периода 4-4-5',
		MonthSinceBeginOfPeriod445: 'Месяц с начала периода 4-4-5',
	};

	const PLACEMENT_OPTIONS = [
		{ value: 'Auto', label: 'Авто' },
		{ value: 'Horizontally', label: 'Горизонтально' },
		{ value: 'Vertically', label: 'Вертикально' },
		{ value: 'SpecialColumn', label: 'Отдельная колонка' },
		{ value: 'Together', label: 'Вместе' },
	];

	const ORDER_TYPE_OPTIONS = [
		{ value: 'Asc', label: 'По возрастанию' },
		{ value: 'Desc', label: 'По убыванию' },
	];

	/** Нулевая дата платформы: такая граница дополнения периода считается пустой. */
	const DCS_ZERO_DATE = '0001-01-01T00:00:00';

	/**
	 * Панели узла по его виду (root — корень «Отчет») в порядке вкладок конфигуратора: Параметры,
	 * Выбранные поля, Отбор, Сортировка, Условное оформление, Пользовательские поля, Другие настройки. «Поля
	 * группировки» есть только у группировки — первыми, на месте «Параметров», которых у неё нет.
	 */
	const NODE_PANELS = [
		{ id: 'groupFields', title: 'Поля группировки', kinds: ['group'], render: renderGroupFieldsPanel },
		{ id: 'dataParameters', title: 'Параметры', kinds: ['root'], render: renderDataParametersPanel },
		{ id: 'selection', title: 'Выбранные поля', kinds: ['root', 'group', 'table', 'chart'], render: renderSelectionPanel },
		{ id: 'filter', title: 'Отбор', kinds: ['root', 'group'], render: renderFilterPanel },
		{ id: 'order', title: 'Сортировка', kinds: ['root', 'group'], render: renderOrderPanel },
		{ id: 'appearance', title: 'Условное оформление', kinds: ['root', 'group', 'table', 'chart'], render: renderAppearancePanel },
		{ id: 'userFields', title: 'Пользовательские поля', kinds: ['root'], render: renderUserFieldsPanel },
		{ id: 'output', title: 'Другие настройки', kinds: ['root', 'group', 'table', 'chart'], render: renderOutputPanel },
	];

	/** Панель по умолчанию, пока пользователь не выбрал другую, и когда выбранной у узла нет. */
	const DEFAULT_NODE_PANEL = 'selection';

	/**
	 * Вариант, настройки которого затрагивает правка (повторяет выбор панели):
	 * если ответ saved не принесёт его настройки, кэш сбрасывается и вариант перечитается лениво.
	 */
	function affectedVariant(type, fields) {
		if (typeof fields.variant === 'string') {
			return fields.variant;
		}
		if (type === 'dcs/add-settings-variant' || type === 'dcs/remove-settings-variant') {
			return fields.name || '';
		}
		if (type === 'dcs/set-settings-variant-props') {
			const payload = fields.payload || {};
			return (typeof payload.newName === 'string' && payload.newName) || fields.name || '';
		}
		return '';
	}

	function pathKey(path) {
		return JSON.stringify(path);
	}

	function cloneItems(items) {
		return JSON.parse(JSON.stringify(items));
	}

	function sectionItems(section) {
		return section && Array.isArray(section.items) ? section.items : [];
	}

	/** Узел по пути от корня настроек; корень — сами настройки. Для псевдо-шага (index −1) узла нет. */
	function nodeAt(settings, path) {
		let node = settings;
		for (const step of path) {
			const items = node && Array.isArray(node[step.list]) ? node[step.list] : null;
			if (!items || step.index < 0 || step.index >= items.length) {
				return null;
			}
			node = items[step.index];
		}
		return node;
	}

	/** Путь псевдо-узла «Колонки/Строки/Точки/Серии»: последний шаг помечен index −1. */
	function isPseudoPath(path) {
		return path.length > 0 && path[path.length - 1].index === -1;
	}

	function nodeKindAt(settings, path) {
		if (isPseudoPath(path)) {
			return 'pseudo';
		}
		if (path.length === 0) {
			return 'root';
		}
		const node = nodeAt(settings, path);
		return node ? node.kind : 'group';
	}

	/** Активный вариант: выбранный, а если его в модели больше нет — первый. */
	function activeVariantName() {
		const names = list('settingsVariants')
			.map((item) => item.name || '')
			.filter(Boolean);
		if (names.indexOf(uiState.variant) < 0) {
			uiState.variant = names[0] || '';
		}
		return uiState.variant;
	}

	/**
	 * Выбор варианта строкой таблицы вариантов: выделение — на «Отчет», дерево развёрнуто заново. Вкладка узла не
	 * меняется: листая варианты стрелками, удобно смотреть одну и ту же вкладку.
	 */
	function selectVariant(name) {
		// Ответ правки, отправленной с клавиатуры до смены варианта, фокус уже не переносит
		clearReplyFocus();
		uiState.variant = name;
		uiState.nodePath = [];
		uiState.expanded = new Set();
		delete seededVariants[name];
		renderContent();
	}

	function requestVariant(name) {
		if (variantLoading === name) {
			return;
		}
		variantLoading = name;
		post('dcs/load-variant', { variant: name });
	}

	/** Первый показ варианта: дерево структуры разворачивается целиком. */
	function seedExpanded(settings) {
		uiState.expanded.add(pathKey([]));
		function walk(node, path) {
			const kind = path.length === 0 ? 'root' : node.kind;
			if (kind === 'table' || kind === 'chart') {
				uiState.expanded.add(pathKey(path));
				for (const listName of kind === 'table' ? ['columns', 'rows'] : ['points', 'series']) {
					uiState.expanded.add(pathKey(path.concat([{ list: listName, index: -1 }])));
					const items = Array.isArray(node[listName]) ? node[listName] : [];
					items.forEach((child, index) => walk(child, path.concat([{ list: listName, index: index }])));
				}
				return;
			}
			const items = Array.isArray(node.structure) ? node.structure : [];
			if (items.length > 0) {
				uiState.expanded.add(pathKey(path));
			}
			items.forEach((child, index) => walk(child, path.concat([{ list: 'structure', index: index }])));
		}
		walk(settings, []);
	}

	/** Разворачивает предков пути, чтобы выделенный узел был виден. */
	function expandTo(path) {
		uiState.expanded.add(pathKey([]));
		for (let i = 0; i < path.length; i++) {
			const prefix = path.slice(0, i);
			uiState.expanded.add(pathKey(prefix));
			if (path[i].list !== 'structure') {
				uiState.expanded.add(pathKey(prefix.concat([{ list: path[i].list, index: -1 }])));
			}
		}
	}

	/** Кэш вариантов, которых больше нет в модели (удалены или переименованы), выбрасывается. */
	function pruneVariantCache() {
		const names = list('settingsVariants').map((item) => item.name || '');
		for (const key of Object.keys(variantCache)) {
			if (names.indexOf(key) < 0) {
				delete variantCache[key];
				delete seededVariants[key];
				delete variantErrors[key];
			}
		}
	}

	/** Подсказки путей полей настроек: поля наборов, вычисляемые, ресурсы и доступные параметры. */
	function settingsFieldPaths() {
		const paths = fieldPaths();
		function push(path) {
			if (path && paths.indexOf(path) < 0) {
				paths.push(path);
			}
		}
		for (const total of list('totalFields')) {
			push(total.name || '');
		}
		for (const param of list('parameters')) {
			// Платформа пишет availableAsField только со значением false: без ключа параметр доступен
			if (param.availableAsField !== false && param.name) {
				push('ПараметрыДанных.' + param.name);
			}
		}
		return paths.sort((a, b) => a.localeCompare(b, 'ru'));
	}

	/**
	 * Подсказка путей полей настроек у поля ввода. section — раздел настроек (selection, filter, group, order) для
	 * ограничений использования полей; без него — any.
	 */
	function attachFieldList(input, section) {
		attachCompletion(input, () => 'settings:' + (section || 'any'));
	}

	function optionLabel(options, value, fallback) {
		for (const option of options) {
			if (option.value === value) {
				return option.label;
			}
		}
		return value || fallback;
	}

	function groupTypeLabel(value) {
		return optionLabel(GROUP_TYPE_OPTIONS, value, 'Без иерархии');
	}

	function periodAdditionLabel(value) {
		return PERIOD_ADDITION_LABELS[value] || value || 'Нет';
	}

	function placementLabel(value) {
		return optionLabel(PLACEMENT_OPTIONS, value, 'Авто');
	}

	function periodAdditionOptions() {
		return Object.keys(PERIOD_ADDITION_LABELS).map((value) => ({ value: value, label: PERIOD_ADDITION_LABELS[value] }));
	}

	/** Подпись поля группировки в дереве: суффиксы иерархии и дополнения периода. */
	function groupFieldLabel(groupField) {
		let label = groupField.field || '<Авто>';
		if (groupField.groupType === 'Hierarchy') {
			label += ' (иерархия)';
		} else if (groupField.groupType === 'HierarchyOnly') {
			label += ' (только иерархия)';
		}
		const period = groupField.periodAdditionType;
		if (period && period !== 'None') {
			label += ' (' + periodAdditionLabel(period).toLowerCase() + ')';
		}
		return label;
	}

	/** Подпись группировки: поля через запятую, без полей — детальные записи. */
	function groupLabel(node) {
		const fields = Array.isArray(node.groupFields) ? node.groupFields : [];
		if (fields.length === 0) {
			return '<Детальные записи>';
		}
		return fields.map(groupFieldLabel).join(', ');
	}

	function nodeLabel(node) {
		if (node.kind === 'table') {
			return 'Таблица';
		}
		if (node.kind === 'chart') {
			return 'Диаграмма';
		}
		if (node.kind === 'nestedObject') {
			return 'Вложенный отчёт: ' + (node.objectID || '');
		}
		return groupLabel(node);
	}

	/** Бейджи заполненности секций узла: отбор, сортировка, поля, оформление, другие настройки. */
	function sectionBadges(node) {
		const badges = [];
		const filterCount = sectionItems(node.filter).length;
		if (filterCount > 0) {
			badges.push({ text: 'О', hint: 'Отбор: ' + filterCount });
		}
		const orderCount = sectionItems(node.order).length;
		if (orderCount > 0) {
			badges.push({ text: 'С', hint: 'Сортировка: ' + orderCount });
		}
		const selection = sectionItems(node.selection);
		if (selection.length > 0 && !(selection.length === 1 && selection[0].kind === 'auto')) {
			badges.push({ text: 'ВП', hint: 'Выбранные поля: ' + selection.length });
		}
		const appearanceCount = sectionItems(node.conditionalAppearance).length;
		if (appearanceCount > 0) {
			badges.push({ text: 'УО', hint: 'Условное оформление: ' + appearanceCount });
		}
		const outputCount = sectionItems(node.outputParameters).length;
		if (outputCount > 0) {
			badges.push({ text: 'ДН', hint: 'Другие настройки: ' + outputCount });
		}
		return badges;
	}

	function countDescendants(node) {
		let count = 0;
		for (const listName of NODE_LISTS) {
			const items = Array.isArray(node[listName]) ? node[listName] : [];
			for (const child of items) {
				count += 1 + countDescendants(child);
			}
		}
		return count;
	}

	/** Команды вариантов, для которых у md-sparrow нет операции: кнопки есть, как у конфигуратора, но недоступны. */
	const VARIANT_COPY_NOTE = 'Недоступно: варианты копируют в конфигураторе.';
	const VARIANT_MOVE_NOTE = 'Недоступно: порядок вариантов меняют в конфигураторе.';
	const WIZARD_NOTE = 'Собрать структуру, выбранные поля и порядок варианта по шагам: список, таблица или диаграмма';

	/** Причина недоступной команды «Настроек» — плашкой: щелчок по ней не должен пропадать молча. */
	function settingsNotice(title, text) {
		showNotice('info', title, [{ text: text }]);
	}

	/**
	 * Вкладка «Настройки» как в конфигураторе: слева сверху — таблица вариантов «Имя
	 * варианта | Представление», справа сверху — дерево структуры, под ними на всю ширину — строка «Настройки: <узел>» и
	 * вкладки узла. Высоты — около 40 и 60 % окна (стили .dcs-setv-*); на узком окне всё встаёт столбиком.
	 */
	function renderVariants(host) {
		const variants = list('settingsVariants');
		const name = activeVariantName();
		const layout = el('div', 'dcs-setv');
		const top = el('div', 'dcs-setv-top');
		const variantPane = el('div', 'dcs-setv-pane');
		renderVariantList(variantPane, variants, name);
		top.appendChild(variantPane);
		const structurePane = el('div', 'dcs-setv-pane');
		top.appendChild(structurePane);
		layout.appendChild(top);
		const bottom = el('div', 'dcs-setv-bottom');
		layout.appendChild(bottom);
		host.appendChild(layout);
		const settings = name ? loadedVariantSettings(structurePane, name) : null;
		if (!name) {
			emptyNote(structurePane, 'Вариантов настроек нет.');
		}
		if (settings) {
			if (!seededVariants[name]) {
				seededVariants[name] = true;
				seedExpanded(settings);
			}
			ensureValidSelection(settings);
			renderStructureTree(structurePane, settings, name);
			renderNodePanels(bottom, settings, name);
		} else {
			// Вкладок узла нет (вариант грузится или не загрузился): пустой низ не держит высоту
			bottom.classList.add('dcs-setv-bottom-idle');
		}
		// Стрелка в таблице вариантов или в дереве перерисовала вкладку: фокус — на новой строке, а не на прежней. Строки
		// нет (удалён последний вариант) — на «Добавить вариант…»: фокус не должен уходить в никуда
		if (focusVariantRow) {
			focusVariantRow = false;
			const row = focusKeys.get(focusKey(['varrow', name]));
			if (row && row.isConnected) {
				focusGridRow(row);
			} else {
				focusKeyed(focusKey(['vartool', 'add']));
			}
		}
		if (focusStructureRow) {
			focusStructureRow = false;
			focusKeyed(focusKey(['node', pathKey(uiState.nodePath)]));
		}
	}

	function focusKeyed(key) {
		const node = focusKeys.get(key);
		if (node && node.isConnected) {
			node.focus();
		}
	}

	/** Настройки варианта; пока их нет — плашка загрузки (и запрос) или ошибки с повтором, результат null. */
	function loadedVariantSettings(host, name) {
		if (variantErrors[name]) {
			const plate = el('div', 'dcs-plate dcs-plate-error');
			plate.appendChild(el('div', '', 'Вариант не загружен. ' + variantErrors[name]));
			const retry = el('button', 'ghost-btn dcs-btn-small', 'Повторить');
			retry.type = 'button';
			retry.addEventListener('click', () => {
				delete variantErrors[name];
				renderContent();
			});
			plate.appendChild(retry);
			host.appendChild(plate);
			return null;
		}
		const settings = variantCache[name];
		if (!settings) {
			// Ленивая загрузка: содержимое варианта придёт сообщением {type: 'variant'}
			requestVariant(name);
			host.appendChild(el('div', 'dcs-plate', 'Загружаем настройки варианта…'));
			return null;
		}
		return settings;
	}

	/**
	 * Таблица вариантов: строка выбирает вариант. Одна остановка Tab — строка
	 * выбранного варианта; ↑ ↓ Home End выбирают соседний, Enter и F2 — «Свойства варианта…», Delete — удаление. Над
	 * таблицей — пиктограммы: добавить, скопировать, удалить, выше, ниже, свойства и конструктор настроек. Копирования
	 * и перестановки вариантов у md-sparrow нет — эти кнопки недоступны с причиной.
	 */
	function renderVariantList(host, variants, name) {
		const current = variants.find((item) => (item.name || '') === name) || null;
		const none = current ? '' : 'Недоступно: вариантов нет.';
		const loaded = Boolean(current && variantCache[name]);
		// Причина недоступности конструктора — по состоянию: вариантов нет, вариант не загрузился, ещё грузится
		let wizardBlocked = '';
		if (!current) {
			wizardBlocked = none;
		} else if (variantErrors[name]) {
			wizardBlocked = 'Недоступно: вариант не загружен.';
		} else if (!loaded) {
			wizardBlocked = 'Недоступно, пока настройки варианта загружаются.';
		}
		const tools = [
			{ id: 'add', icon: 'add', name: 'Добавить вариант…', run: openAddVariantDialog },
			{ id: 'copy', icon: 'add-copy', name: 'Скопировать вариант', note: VARIANT_COPY_NOTE },
			{ id: 'delete', icon: 'delete', name: 'Удалить вариант', shortcut: 'Delete', danger: true, note: none, run: () => removeVariant(name, variants.length) },
			{ id: 'up', icon: 'up', name: 'Переместить вариант выше', note: VARIANT_MOVE_NOTE },
			{ id: 'down', icon: 'down', name: 'Переместить вариант ниже', note: VARIANT_MOVE_NOTE },
			{ id: 'props', icon: 'edit', name: 'Свойства варианта…', shortcut: 'Enter', note: none, run: () => openVariantPropsDialog(current) },
		];
		const bar = el('div', 'dcs-list-toolbar');
		for (const tool of tools) {
			const node = iconButton({
				icon: tool.icon,
				name: tool.name,
				shortcut: tool.shortcut,
				note: tool.note,
				unavailable: Boolean(tool.note),
				className: tool.danger ? 'ghost-btn dcs-btn-small dcs-btn-danger' : undefined,
				onClick: () => {
					if (tool.note) {
						settingsNotice(tool.name, tool.note);
					} else {
						tool.run();
					}
				},
			});
			bar.appendChild(keyed(node, focusKey(['vartool', tool.id])));
		}
		// Мастер собирает план по прочитанным настройкам: пока вариант не загружен, строить не из чего. Недоступная кнопка
		// остаётся в обходе Tab, как соседние: причина — в подсказке, у читалки и плашкой по щелчку
		const wizardBtn = iconButton({
			icon: 'wizard',
			name: 'Конструктор настроек…',
			note: wizardBlocked || WIZARD_NOTE,
			unavailable: Boolean(wizardBlocked),
			onClick: () => {
				if (wizardBlocked) {
					settingsNotice('Конструктор настроек…', wizardBlocked);
				} else {
					startSettingsWizard(uiState.variant);
				}
			},
		});
		bar.appendChild(keyed(wizardBtn, focusKey(['vartool', 'wizard'])));
		host.appendChild(bar);
		if (variants.length === 0) {
			emptyNote(host, 'Вариантов нет: добавьте вариант кнопкой «Добавить вариант…».');
			return;
		}
		const wrap = el('div', 'dcs-table-wrap dcs-setv-scroll');
		const table = el('table', 'dcs-table dcs-setv-grid');
		table.setAttribute('role', 'grid');
		table.setAttribute('aria-label', 'Варианты отчета');
		const thead = document.createElement('thead');
		const head = document.createElement('tr');
		head.setAttribute('role', 'row');
		for (const title of ['Имя варианта', 'Представление']) {
			const th = el('th', '', title);
			th.setAttribute('role', 'columnheader');
			head.appendChild(th);
		}
		thead.appendChild(head);
		table.appendChild(thead);
		const tbody = document.createElement('tbody');
		const names = variants.map((item) => item.name || '');
		variants.forEach((item, index) => {
			const variantName = item.name || '';
			const selected = variantName === name;
			const tr = document.createElement('tr');
			tr.className = selected ? 'dcs-tree-selected' : '';
			tr.setAttribute('role', 'row');
			tr.setAttribute('aria-selected', String(selected));
			tr.tabIndex = selected ? 0 : -1;
			keyed(tr, focusKey(['varrow', variantName]));
			cell(tr, variantName).setAttribute('role', 'gridcell');
			cell(tr, item.value || '').setAttribute('role', 'gridcell');
			tr.addEventListener('click', () => {
				pickVariant(variantName, false);
			});
			tr.addEventListener('dblclick', () => {
				openVariantPropsDialog(item, true);
			});
			tr.addEventListener('keydown', (event) => {
				onVariantKey(event, names, index, item);
			});
			tbody.appendChild(tr);
		});
		table.appendChild(tbody);
		wrap.appendChild(table);
		host.appendChild(wrap);
	}

	function onVariantKey(event, names, index, item) {
		if (event.defaultPrevented) {
			return;
		}
		let to = -1;
		if (event.key === 'ArrowDown') {
			to = Math.min(names.length - 1, index + 1);
		} else if (event.key === 'ArrowUp') {
			to = Math.max(0, index - 1);
		} else if (event.key === 'Home') {
			to = 0;
		} else if (event.key === 'End') {
			to = names.length - 1;
		} else if (event.key === 'Enter' || event.key === 'F2') {
			event.preventDefault();
			openVariantPropsDialog(item, true);
			return;
		} else if (event.key === 'Delete') {
			event.preventDefault();
			removeVariant(item.name || '', names.length, true);
			return;
		} else {
			return;
		}
		event.preventDefault();
		pickVariant(names[to], true);
	}

	/** Выбор варианта строкой таблицы; focus — с клавиатуры: после перерисовки фокус встанет на его строку. */
	function pickVariant(variantName, focus) {
		if (variantName === uiState.variant) {
			if (focus) {
				focusKeyed(focusKey(['varrow', variantName]));
			}
			return;
		}
		focusVariantRow = Boolean(focus);
		selectVariant(variantName);
	}

	// ---------- варианты настроек: добавление, свойства, удаление ----------

	function openAddVariantDialog() {
		const names = list('settingsVariants').map((item) => item.name || '');
		let nameInput;
		let presentationInput;
		openDialog(
			'Новый вариант настроек',
			'Добавить',
			(body) => {
				nameInput = formRow(body, 'Имя', textInput(suggestName('Вариант', names)));
				presentationInput = formRow(body, 'Представление', textInput(''));
			},
			() => {
				const name = nameInput.value.trim();
				if (!name) {
					return 'Укажите имя варианта.';
				}
				// Без учёта регистра, как md-sparrow и «В новый вариант…»: иначе отказ пришёл бы только после круга до jar
				if (names.some((taken) => taken.toLowerCase() === name.toLowerCase())) {
					return 'Вариант с таким именем уже есть.';
				}
				const fields = { name: name };
				const presentation = presentationInput.value.trim();
				if (presentation) {
					fields.payload = { presentation: presentation };
				}
				if (!send('dcs/add-settings-variant', fields)) {
					return BUSY;
				}
				return undefined;
			}
		);
	}

	/**
	 * Свойства варианта; fromGrid — из таблицы (Enter, F2, двойной щелчок): после ответа фокус — на строке варианта под
	 * новым именем (прежней строки с ключом старого имени в новой таблице нет).
	 */
	function openVariantPropsDialog(variant, fromGrid) {
		const currentName = variant.name || '';
		const names = list('settingsVariants').map((item) => item.name || '');
		let nameInput;
		let presentationInput;
		openDialog(
			'Свойства варианта «' + currentName + '»',
			'Сохранить',
			(body) => {
				nameInput = formRow(body, 'Имя', textInput(currentName));
				presentationInput = formRow(body, 'Представление', textInput(variant.value));
				// Предупреждение о переименовании — только пока имя меняют; живая область: читалка слышит его, как только
				// имя стало другим
				const renameWarn = el('div', 'dcs-warn');
				renameWarn.setAttribute('aria-live', 'polite');
				body.appendChild(renameWarn);
				nameInput.addEventListener('input', () => {
					renameWarn.textContent =
						nameInput.value.trim() !== currentName ? 'На имя варианта могут ссылаться код конфигурации и сохранённые настройки пользователей.' : '';
				});
			},
			() => {
				const newName = nameInput.value.trim();
				if (!newName) {
					return 'Укажите имя варианта.';
				}
				const payload = {};
				if (newName !== currentName) {
					// Смена регистра своего же имени не занимает чужое
					if (names.some((taken) => taken !== currentName && taken.toLowerCase() === newName.toLowerCase())) {
						return 'Вариант с таким именем уже есть.';
					}
					payload.newName = newName;
				}
				const presentation = presentationInput.value.trim();
				if (presentation !== (variant.value || '')) {
					payload.presentation = presentation;
				}
				if (Object.keys(payload).length === 0) {
					closeDialog();
					return undefined;
				}
				if (!send('dcs/set-settings-variant-props', { name: currentName, payload: payload })) {
					return BUSY;
				}
				replyFocus.variant = Boolean(fromGrid);
				return undefined;
			}
		);
	}

	/** Удаление варианта с подтверждением; fromGrid — клавишей Delete в таблице: после ответа фокус — на строке выбранного варианта. */
	function removeVariant(name, total, fromGrid) {
		let question = 'Удалить вариант настроек «' + name + '»?';
		if (total === 1) {
			question += ' Это последний вариант: отчёт останется без настроек по умолчанию.';
		}
		confirmRemove(question, () => {
			if (!send('dcs/remove-settings-variant', { name: name })) {
				return BUSY;
			}
			replyFocus.variant = Boolean(fromGrid);
			return undefined;
		});
	}

	// ---------- конструктор настроек: мастер «Список / Таблица / Диаграмма» ----------

	/** Расчёты мастера без DOM (dcs-editor-settings-wizard.js): распознавание, план пакета, предпросмотр, проверки. */
	const wizardRules = window.DcsSettingsWizard;

	/** Виды строк каталога, которые выбираются полем; папки, группы полей и промежуточные узлы пути — нет. */
	const WIZARD_PICK_KINDS = ['field', 'calc', 'total', 'dataParam', 'userField', 'system'];

	/**
	 * Что берёт «>>»: поля наборов (и в папках), вычисляемые поля и ресурсы. Параметры данных,
	 * системные и пользовательские поля добавляются по одному — целиком их в отчёт не выводят.
	 */
	const WIZARD_BULK_KINDS = ['field', 'calc', 'total'];

	/**
	 * Доступные поля, которые раскрываются реквизитами по типу: поля наборов, вычисляемые поля и
	 * параметры данных. Ресурс не раскрывается: его путь — путь поля набора, и реквизиты взялись бы у
	 * поля, а не у итога. У пользовательских и системных полей типа в схеме нет.
	 */
	const WIZARD_TYPE_KINDS = ['field', 'calc', 'dataParam'];

	/**
	 * Сколько уровней реквизитов по типу раскрывается под полем — как в деревьях полей конструктора
	 * запроса: дальше список разрастается без пользы. Путь глубже вводится в «Другое поле…», его
	 * подсказка предела не знает.
	 */
	const WIZARD_TYPE_DEPTH = 3;

	/** Цель, куда «>» кладёт поле, пока не выбрана другая: «Таблицы» нужны реже строк и точек. */
	const WIZARD_DEFAULT_TARGET = { list: 'levels', table: 'rows', chart: 'points' };

	/** Раздел настроек шага: каталог подсказки и ограничения использования полей у них общие. */
	const WIZARD_SECTIONS = { fields: 'selection', groups: 'group', order: 'order' };

	const WIZARD_SECTION_WORDS = { fields: 'выбранных полях', groups: 'группировках', order: 'порядке' };

	const WIZARD_RESTRICTION_FLAGS = { fields: 'field', groups: 'group', order: 'order' };

	/** Чем отличается вид отчёта: подсказка карточки шага «Тип отчёта» и описание её переключателя для читалки. */
	const WIZARD_TYPE_HINTS = {
		list: 'Записи друг под другом; группировки — вложенные уровни с итогами, последним — детальные записи.',
		table: 'Перекрёстная таблица: группировки по строкам и колонкам, в ячейках — ресурсы.',
		chart: 'Диаграмма по ресурсам: группировки дают её точки и серии.',
	};

	/** Вложенность группировок цели — подсказка её списка. */
	const WIZARD_NESTING_HINT = 'Сверху вниз — вложенность: следующее поле группируется внутри предыдущего.';

	/** Классы строк предпросмотра по виду строки previewLines: литералами, чтобы их видели проверки стилей. */
	const WIZARD_PREVIEW_CLASSES = {
		root: 'dcs-wizard-preview-row dcs-wizard-preview-root',
		group: 'dcs-wizard-preview-row',
		details: 'dcs-wizard-preview-row dcs-wizard-preview-details',
		container: 'dcs-wizard-preview-row dcs-wizard-preview-container',
		target: 'dcs-wizard-preview-row dcs-wizard-preview-target',
		empty: 'dcs-wizard-preview-row dcs-wizard-preview-empty',
	};

	/** Ключ дубля пути: без учёта регистра, ё и е — разные буквы (так и в путях платформы). */
	function wizardKey(path) {
		return String(path || '').toLowerCase();
	}

	/** Ключ поиска: ещё и ё = е — так ищут люди. */
	function wizardFold(text) {
		return wizardKey(text).replace(/ё/g, 'е');
	}

	/**
	 * Каталоги доступных полей шагов — те же, что у подсказки путей настроек (dcs-editor-complete.js):
	 * поля наборов с папками, вычисляемые, ресурсы, параметры данных, системные и пользовательские поля;
	 * запрещённые в разделе поля каталог уже убрал. any — для проверки пути, введённого вручную.
	 */
	function wizardCatalogs(settingsDto) {
		// Подписи типов — как у подсказки: каталоги шагов питают и её строки («Другое поле…»)
		const typeOptions = completionTypeOptions();
		return {
			fields: completer.buildCatalog(model, settingsDto, 'settings:selection', typeOptions),
			groups: completer.buildCatalog(model, settingsDto, 'settings:group', typeOptions),
			order: completer.buildCatalog(model, settingsDto, 'settings:order', typeOptions),
			any: completer.buildCatalog(model, settingsDto, 'settings:any', typeOptions),
		};
	}

	/**
	 * Реквизиты поля по типу: {children, pending} — общее у «Доступных полей» конструктора настроек и панелей
	 * «Настроек». chain — узлы каталога от корня до поля (у реквизита — цепочка его поля, дальше путь идёт
	 * по типам), scope — место ввода подсказки (settings:<раздел>), flag — ограничение раздела: реквизиты поля, у которого
	 * они запрещены в разделе (attributeRestrict), не предлагаются, как у подсказки. Свои пути набора («Контрагент.ИНН» в
	 * схеме) остаются строками каталога. Описания здесь не запрашиваются — pending лишь говорит, что тип или реквизиты ещё
	 * не известны. fieldIndex — поля наборов по пути для вывода типа: живёт у вызывающего, пока модель та же.
	 */
	function typeAttributeLevel(node, chain, scope, flag, fieldIndex) {
		const entry = { children: [], pending: [] };
		if (chain.length === 0 || chain.some((item) => item.attributeRestrict && item.attributeRestrict[flag])) {
			return entry;
		}
		const env = typeChildrenEnv(scope, false);
		env.fieldIndex = fieldIndex;
		const result = fieldTypes.extraChildrenFor({ mode: 'path', chain: chain }, node.path, env);
		const own = new Set((node.children || []).map((child) => wizardKey(child.name)));
		entry.pending = result.pending;
		entry.children = result.children
			.filter((spec) => spec && spec.name && !own.has(wizardKey(spec.name)))
			.map((spec) => ({
				name: spec.name,
				path: node.path + '.' + spec.name,
				kind: 'field',
				title: spec.title || '',
				typeText: spec.typeText || '',
				valueType: spec.valueType || null,
				typeExpandable: Boolean(spec.expandable),
				children: [],
				typeChain: chain,
			}));
		return entry;
	}

	/** Узлы каталога по ключу пути. */
	function wizardNodeIndex(catalog) {
		const index = new Map();
		const walk = (nodes) => {
			for (const node of nodes) {
				index.set(wizardKey(node.path), node);
				walk(node.children || []);
			}
		};
		walk(catalog.nodes || []);
		return index;
	}

	function wizardPickable(node, step) {
		if (!node || node.restricted || WIZARD_PICK_KINDS.indexOf(node.kind) < 0) {
			return false;
		}
		// Группировать по ресурсу нельзя: его итог считается по группировкам, а не наоборот
		return !(step === 'groups' && node.kind === 'total');
	}

	/** Сводка подтверждения: что из варианта заменит конструктор (replacementSummary модуля). */
	function wizardSummaryText(summary) {
		const parts = [];
		if (summary.nodes > 0) {
			const kinds = [];
			if (summary.groups > 0) {
				kinds.push('группировок ' + summary.groups);
			}
			if (summary.tables > 0) {
				kinds.push('таблиц ' + summary.tables);
			}
			if (summary.charts > 0) {
				kinds.push('диаграмм ' + summary.charts);
			}
			if (summary.nestedObjects > 0) {
				kinds.push('вложенных отчётов ' + summary.nestedObjects);
			}
			parts.push('структуру — узлов ' + summary.nodes + (kinds.length > 0 ? ' (' + kinds.join(', ') + ')' : ''));
		}
		if (summary.selection > 0) {
			parts.push('выбранные поля (' + summary.selection + ')');
		}
		if (summary.order > 0) {
			parts.push('порядок (' + summary.order + ')');
		}
		return 'Конструктор соберёт заново ' + parts.join(', ') + '.';
	}

	/**
	 * Вход в конструктор (кнопка строки вариантов и подсказка у пустой структуры). Непустой вариант —
	 * сначала подтверждение «Заменить / В новый вариант… / Отмена»; пустой заменять нечем — сразу шаги.
	 */
	function startSettingsWizard(variantName) {
		const settings = variantCache[variantName];
		if (!settings) {
			return;
		}
		if (editBusy()) {
			setStatus(BUSY, true);
			return;
		}
		const state = wizardRules.initialWizardState(settings);
		const summary = wizardRules.replacementSummary(settings);
		closeDialog();
		if (summary.empty) {
			openSettingsWizard({ variant: variantName, settings: settings, state: state });
			return;
		}
		pushDialog({
			title: 'Конструктор настроек: вариант «' + variantName + '»',
			build: (body) => {
				body.appendChild(el('div', 'dcs-confirm-text', wizardSummaryText(summary)));
				if (summary.userSettings > 0) {
					body.appendChild(
						el(
							'div',
							'dcs-warn dcs-wizard-confirm-line',
							'У заменяемых узлов есть пользовательские настройки (' + summary.userSettings + '): они пропадут, если структура изменится.'
						)
					);
				}
				if (!state.recognized) {
					body.appendChild(
						el(
							'div',
							'dcs-warn dcs-wizard-confirm-line',
							'Структура не похожа на собранную конструктором (' + state.reason + '): при ОК она будет собрана заново целиком.'
						)
					);
				}
				body.appendChild(
					el(
						'div',
						'struct-hint dcs-wizard-confirm-line',
						'Останутся как были: отбор, параметры, условное оформление и пользовательские поля варианта. Неизменённое в структуре не пересобирается.'
					)
				);
			},
			buttons: [
				{
					id: 'replace',
					label: 'Заменить',
					primary: true,
					onClick: () => {
						closeDialog();
						openSettingsWizard({ variant: variantName, settings: settings, state: state });
						return undefined;
					},
				},
				{
					id: 'newVariant',
					label: 'В новый вариант…',
					onClick: () => {
						openWizardNewVariant(settings, state);
						return undefined;
					},
				},
				{ id: 'cancel', label: 'Отмена' },
			],
		});
	}

	/** Имя нового варианта: непустое и не совпадает с существующими без учёта регистра. */
	function wizardVariantNameProblem(name, names) {
		if (!name) {
			return 'Укажите имя варианта.';
		}
		const key = wizardKey(name);
		if (names.some((existing) => wizardKey(existing) === key)) {
			return 'Вариант с таким именем уже есть.';
		}
		return '';
	}

	/**
	 * «В новый вариант…»: имя и представление нового варианта. Шаги открываются с настройками
	 * текущего — их удобно взять за основу, а сам текущий вариант пакет не трогает.
	 */
	function openWizardNewVariant(settings, state) {
		const names = list('settingsVariants').map((item) => item.name || '');
		let nameInput;
		let presentationInput;
		pushDialog({
			title: 'Новый вариант настроек',
			build: (body) => {
				// Что шаги начаты с текущего варианта, а он не изменится, говорит плашка первого шага мастера
				nameInput = formRow(body, 'Имя', textInput(suggestName('Вариант', names)));
				presentationInput = formRow(body, 'Представление', textInput(''));
			},
			buttons: [
				{
					id: 'ok',
					label: 'Далее >',
					primary: true,
					onClick: () => {
						const name = nameInput.value.trim();
						const problem = wizardVariantNameProblem(name, names);
						if (problem) {
							return problem;
						}
						const presentation = presentationInput.value.trim();
						closeDialog();
						openSettingsWizard({
							variant: name,
							settings: settings,
							state: state,
							newVariant: { presentation: presentation },
						});
						return undefined;
					},
				},
				{ id: 'cancel', label: 'Отмена' },
			],
		});
	}

	/**
	 * Окно конструктора — широкий уровень стека с шагами «Тип отчёта · Поля · Группировки · Порядок ·
	 * (Тип диаграммы)», подвалом «< Назад / Далее > / ОК / Отмена» и живым предпросмотром справа.
	 * ОК доступна на любом шаге: план строит planWizardOperations модуля, правки уходят одним
	 * сообщением dcs/settings-wizard; нет изменений — окно закрывается без записи. Поля в доступных
	 * раскрываются реквизитами по типу, описания объектов читаются по раскрытию, их ответ
	 * перерисовывает окно (wizardRerender).
	 *
	 * ctx: {variant — куда пишет пакет; settings — прочитанные настройки текущего варианта (по ним
	 * план находит изменённое; у нового варианта — только основа шагов); state — начальное состояние
	 * (initialWizardState); newVariant?: {presentation} — путь «В новый вариант…»}.
	 */
	function openSettingsWizard(ctx) {
		const wz = JSON.parse(JSON.stringify(ctx.state));
		// Пользовательские поля живут в варианте: у нового варианта их нет, предлагать их нечестно
		const catalogs = wizardCatalogs(ctx.newVariant ? null : ctx.settings);
		const indexes = {
			fields: wizardNodeIndex(catalogs.fields),
			groups: wizardNodeIndex(catalogs.groups),
			order: wizardNodeIndex(catalogs.order),
			any: wizardNodeIndex(catalogs.any),
		};
		const resourceKeys = new Set(list('totalFields').map((total) => wizardKey(total.name || '')));
		const ui = {
			step: 'type',
			search: { fields: '', groups: '', order: '' },
			expanded: { fields: new Set(), groups: new Set(), order: new Set() },
			avail: { fields: '', groups: '', order: '' },
			chosen: { fields: -1, order: -1 },
			groupSel: { target: '', index: -1 },
			target: Object.assign({}, WIZARD_DEFAULT_TARGET),
			// Пути «Другого поля…», которых нет в каталоге: предупреждение, пока они в списках
			manual: new Map(),
		};
		const hosts = {};
		const keyed = new Map();
		let availRows = new Map();
		let chosenRows = new Map();
		// Выделение строки выбранных по ключу: стрелки на клавиатуре выделяют соседнюю строку тем же путём, что щелчок
		let chosenSelectors = new Map();
		let level = null;
		// Реквизиты по типу, раз посчитанные: перерисовка идёт на каждое действие, а вывод типа поля
		// набора-запроса разбирает его текст. Новое описание (describeStamp) или модель сбрасывают кэш
		let typeCache = new Map();
		let typeCacheStamp = -1;
		let typeCacheModel = null;
		// Поля наборов, разложенные по пути для вывода типа (dataSetFieldType): живут, пока модель та же
		let typeFieldIndex = new Map();
		// Нарисованные реквизиты по ключу пути: «>» по выделенному реквизиту (в индексе каталога его нет)
		const typeNodes = { fields: new Map(), groups: new Map(), order: new Map() };

		function planState() {
			return {
				type: wz.type,
				selection: wz.selection,
				order: wz.order,
				groupings: wz.groupings,
				details: wz.details,
				chartType: wz.chartType,
			};
		}

		/** Элемент с ключом: после перерисовки фокус возвращается на элемент с тем же ключом. */
		function keyedEl(node, key) {
			node.setAttribute('data-wizard-key', key);
			keyed.set(key, node);
			return node;
		}

		function keepFocus(redraw) {
			const active = document.activeElement;
			const key = active && typeof active.getAttribute === 'function' ? active.getAttribute('data-wizard-key') : null;
			redraw();
			if (key && document.activeElement !== active) {
				const next = keyed.get(key);
				if (next && next.isConnected) {
					next.focus();
				}
			}
		}

		function setNote(text) {
			if (hosts.note) {
				hosts.note.textContent = text || '';
			}
		}

		function steps() {
			return wizardRules.stepsFor(wz.type);
		}

		function stepIndex() {
			return steps().findIndex((item) => item.id === ui.step);
		}

		function goStep(id) {
			ui.step = id;
			level.setError('');
			keepFocus(renderAll);
			const active = document.activeElement;
			// Кнопка «Далее >» на последнем шаге гаснет: фокус уходит на ОК, а не в никуда
			if (!active || active === document.body || active.disabled) {
				level.shell.buttonEls.ok.focus();
			}
		}

		function footer() {
			const index = stepIndex();
			const all = steps();
			return [
				{
					id: 'back',
					label: '< Назад',
					disabled: index <= 0,
					onClick: () => {
						goStep(all[index - 1].id);
						return undefined;
					},
				},
				{
					id: 'next',
					label: 'Далее >',
					disabled: index >= all.length - 1,
					onClick: () => {
						goStep(all[index + 1].id);
						return undefined;
					},
				},
				{ id: 'ok', label: 'ОК', primary: true, onClick: submit },
				{ id: 'cancel', label: 'Отмена' },
			];
		}

		// ---- реквизиты по типу ----

		function typeCapable(node) {
			return Boolean(node && WIZARD_TYPE_KINDS.indexOf(node.kind) >= 0);
		}

		/** Узлы каталога шага от корня до node — по префиксам пути: у каталога есть узел на каждый префикс. */
		function catalogChain(step, node) {
			const chain = [];
			let prefix = '';
			for (const segment of String(node.path).split('.')) {
				prefix = prefix ? prefix + '.' + segment : segment;
				const found = indexes[step].get(wizardKey(prefix));
				if (!found) {
					return [];
				}
				chain.push(found);
			}
			return chain;
		}

		/**
		 * Реквизиты поля по типу (typeAttributeLevel) с кэшем по шагу и пути. Цепочка передаётся готовой, а поля
		 * наборов разложены по пути (fieldIndex): поиск узла и поля по списку на каждую строку сделал бы отрисовку
		 * тысяч полей квадратичной. Описания читает только раскрытие.
		 */
		function typeLevel(step, node) {
			if (typeCacheStamp !== describeStamp || typeCacheModel !== model) {
				if (typeCacheModel !== model) {
					typeFieldIndex = new Map();
				}
				typeCache = new Map();
				typeCacheStamp = describeStamp;
				typeCacheModel = model;
			}
			const cacheKey = step + '\u0000' + wizardKey(node.path);
			let entry = typeCache.get(cacheKey);
			if (entry) {
				return entry;
			}
			entry = typeAttributeLevel(node, node.typeChain || catalogChain(step, node), 'settings:' + WIZARD_SECTIONS[step], WIZARD_RESTRICTION_FLAGS[step], typeFieldIndex);
			typeCache.set(cacheKey, entry);
			return entry;
		}

		/**
		 * Реквизит по пути «Другого поля…»: родитель — поле каталога шага или такой же реквизит, последний
		 * сегмент — среди его детей по типу. Глубина не ограничена: предел дерева — про ширину списка, а
		 * путь пользователь назвал сам. request — прочитать недостающие описания (путь назван явно, это
		 * не чтение впрок); по ответу предупреждение «нет среди полей схемы» пересчитывается.
		 */
		function typeNodeByPath(step, path, request) {
			const dot = path.lastIndexOf('.');
			if (dot <= 0) {
				return null;
			}
			const parentPath = path.slice(0, dot);
			const parent = indexes[step].get(wizardKey(parentPath)) || typeNodeByPath(step, parentPath, request);
			if (!typeCapable(parent)) {
				return null;
			}
			const found = typeLevel(step, parent);
			if (request) {
				requestDescriptions(found.pending);
			}
			const want = wizardKey(path.slice(dot + 1));
			return found.children.find((child) => wizardKey(child.name) === want) || null;
		}

		/** Ответ описания (onDescribed): реквизиты по типу и предупреждения «Другого поля…» пересчитываются. */
		function onWizardDescribed() {
			if (hosts.avail && hosts.avail.isConnected) {
				keepFocus(() => renderAvail(ui.step));
			}
			if (hosts.preview && hosts.preview.isConnected) {
				redrawSide();
			}
		}

		// ---- выбранное в списках шагов ----

		/** Ключи уже выбранного на шаге: дубль в одной цели кнопка не добавляет. */
		function takenKeys(step, target) {
			if (step === 'fields') {
				return new Set(wizardRules.selectedFieldNames(wz.selection, true).map(wizardKey));
			}
			if (step === 'order') {
				return new Set(wz.order.filter((item) => item && item.kind !== 'auto' && item.field).map((item) => wizardKey(item.field)));
			}
			return new Set((wz.groupings[target || ui.target[wz.type]] || []).map((field) => wizardKey(field.field)));
		}

		/** Поле есть в списках шага (у группировок — в любой цели вида отчёта). */
		function presentOnStep(step, key) {
			if (step !== 'groups') {
				return takenKeys(step).has(key);
			}
			return wizardRules.TARGETS[wz.type].some((target) => takenKeys('groups', target).has(key));
		}

		/**
		 * Добавить поля в список шага (у группировок — в активную цель): «>», «>>», двойной щелчок, Enter, «Другое поле…» и
		 * перенос мышью. at — номер вставки (место сброса); без него — в конец. Дубль в той же цели не добавляется.
		 */
		function addPaths(step, paths, at) {
			const target = ui.target[wz.type];
			const taken = takenKeys(step, target);
			const added = [];
			const repeated = [];
			const listRef = step === 'fields' ? wz.selection : step === 'order' ? wz.order : wz.groupings[target];
			let next = typeof at === 'number' ? at : -1;
			for (const path of paths) {
				const key = wizardKey(path);
				if (taken.has(key)) {
					repeated.push(path);
					continue;
				}
				taken.add(key);
				added.push(path);
				const index = next >= 0 ? Math.min(next, listRef.length) : listRef.length;
				if (next >= 0) {
					next = index + 1;
				}
				if (step === 'fields') {
					listRef.splice(index, 0, { kind: 'field', field: path });
					ui.chosen.fields = index;
				} else if (step === 'order') {
					listRef.splice(index, 0, { kind: 'field', field: path, orderType: 'Asc' });
					ui.chosen.order = index;
				} else {
					listRef.splice(index, 0, { field: path });
					ui.groupSel = { target: target, index: index };
				}
			}
			if (added.length === 0) {
				setNote(repeated.length > 0 ? 'Уже выбрано: «' + repeated.join('», «') + '».' : 'Нечего добавить.');
			} else if (repeated.length > 0) {
				setNote('Добавлено: ' + added.length + '; уже были выбраны: ' + repeated.length + '.');
			} else {
				setNote(added.length === 1 ? 'Добавлено: «' + added[0] + '».' : 'Добавлено полей: ' + added.length + '.');
			}
			keepFocus(redrawLists);
		}

		function addSelectedAvail(step) {
			const node = indexes[step].get(ui.avail[step]) || typeNodes[step].get(ui.avail[step]);
			if (!node) {
				setNote('Выделите поле в списке доступных.');
				return;
			}
			if (!wizardPickable(node, step)) {
				setNote('«' + node.name + '» — группа полей: раскройте её и выберите поле.');
				return;
			}
			addPaths(step, [node.path]);
		}

		function matchesSearch(node, query) {
			return (
				query === '' ||
				wizardFold(node.name).indexOf(query) >= 0 ||
				wizardFold(node.path).indexOf(query) >= 0 ||
				wizardFold(node.title).indexOf(query) >= 0
			);
		}

		function hiddenOnStep(node, step) {
			return step === 'groups' && node.kind === 'total';
		}

		function addAllAvail(step) {
			const query = wizardFold(ui.search[step].trim());
			const paths = [];
			const walk = (nodes) => {
				for (const node of nodes) {
					if (hiddenOnStep(node, step)) {
						continue;
					}
					if (WIZARD_BULK_KINDS.indexOf(node.kind) >= 0 && !node.restricted) {
						// Реквизиты поля («Контрагент.ИНН») целиком не берутся: только само поле
						if (matchesSearch(node, query)) {
							paths.push(node.path);
						}
						continue;
					}
					if (node.kind === 'folder' || node.kind === 'path') {
						walk(node.children || []);
					}
				}
			};
			walk(catalogs[step].nodes || []);
			if (paths.length === 0) {
				setNote('Добавлять целиком нечего: параметры, системные и пользовательские поля добавляются по одному.');
				return;
			}
			addPaths(step, paths);
		}

		function chosenList(step) {
			if (step === 'fields') {
				return wz.selection;
			}
			if (step === 'order') {
				return wz.order;
			}
			// Выделение могло остаться в цели другого вида отчёта: такие списки сейчас не видны
			return wizardRules.TARGETS[wz.type].indexOf(ui.groupSel.target) >= 0 ? wz.groupings[ui.groupSel.target] : null;
		}

		function chosenIndex(step) {
			return step === 'groups' ? ui.groupSel.index : ui.chosen[step];
		}

		function setChosenIndex(step, index) {
			if (step === 'groups') {
				ui.groupSel.index = index;
			} else {
				ui.chosen[step] = index;
			}
		}

		/** Папки и «Авто» выбранных полей и порядка мастер не показывает полями — они закреплены. */
		function pinnedItem(step, item) {
			return step !== 'groups' && Boolean(item) && (item.kind === 'auto' || item.kind === 'folder');
		}

		function removeChosen(step, all) {
			if (all) {
				if (step === 'groups') {
					const target = ui.target[wz.type];
					wz.groupings[target] = [];
					ui.groupSel = { target: target, index: -1 };
				} else if (step === 'fields') {
					wz.selection = wz.selection.filter((item) => pinnedItem(step, item));
					ui.chosen.fields = -1;
				} else {
					wz.order = wz.order.filter((item) => pinnedItem(step, item));
					ui.chosen.order = -1;
				}
				setNote('Список очищен' + (step === 'groups' ? '' : ': папки и «Авто» остались на местах') + '.');
				keepFocus(redrawLists);
				return;
			}
			const items = chosenList(step);
			const index = chosenIndex(step);
			if (!items || index < 0 || index >= items.length) {
				setNote('Выделите строку в списке выбранных.');
				return;
			}
			if (pinnedItem(step, items[index])) {
				setNote('Папки и «Авто» конструктор не убирает: они остаются, как были.');
				return;
			}
			const removed = items.splice(index, 1)[0];
			setChosenIndex(step, Math.min(index, items.length - 1));
			setNote('Убрано: «' + (removed.field || '') + '».');
			keepFocus(redrawLists);
		}

		/** Сдвиг выделенной строки выбранных: ↑ ↓ — на одну, перенос мышью — сразу на место сброса. */
		function moveChosen(step, delta) {
			const items = chosenList(step);
			const index = chosenIndex(step);
			const to = index + delta;
			if (!items || index < 0 || to < 0 || to >= items.length) {
				return;
			}
			items.splice(to, 0, items.splice(index, 1)[0]);
			setChosenIndex(step, to);
			// Кнопка ↑↓ не перерисовывается и остаётся в фокусе: повторное нажатие двигает строку дальше
			keepFocus(redrawLists);
		}

		/**
		 * Поле группировки — в другую цель (Строки ↔ Колонки, Точки ↔ Серии, Таблицы ↔ …) на место at, переносом мышью.
		 * Переносится сам элемент: тип группировки (иерархия) остаётся, а не сбрасывается, как у «<» и снова «>». Дубль в цели
		 * не переносится; true — перенесено.
		 */
		function transferGroup(from, index, to, at) {
			const source = wz.groupings[from];
			const item = source ? source[index] : null;
			if (!item) {
				return false;
			}
			if (takenKeys('groups', to).has(wizardKey(item.field))) {
				setNote('Уже выбрано: «' + item.field + '» есть в «' + wizardRules.TARGET_LABELS[to] + '».');
				return false;
			}
			source.splice(index, 1);
			const list = wz.groupings[to];
			const place = Math.max(0, Math.min(at, list.length));
			list.splice(place, 0, item);
			ui.target[wz.type] = to;
			ui.groupSel = { target: to, index: place };
			setNote('Перенесено: «' + item.field + '» в «' + wizardRules.TARGET_LABELS[to] + '».');
			keepFocus(redrawLists);
			return true;
		}

		/**
		 * Кнопки «⇑» и «⇓» шага «Группировки»: выделенная группировка — последней в предыдущую или следующую цель, с её типом
		 * (transferGroup — то же, что перенос мышью в другую цель). Без них перенос с типом был бы только мышью.
		 */
		function transferSelected(delta) {
			const targets = wizardRules.TARGETS[wz.type];
			const from = ui.groupSel.target;
			const at = targets.indexOf(from);
			const items = at >= 0 ? wz.groupings[from] : null;
			if (!items || ui.groupSel.index < 0 || ui.groupSel.index >= items.length) {
				setNote('Выделите строку в списке выбранных.');
				return;
			}
			const to = targets[at + delta];
			if (!to) {
				setNote('Недоступно: «' + wizardRules.TARGET_LABELS[from] + '» — ' + (delta < 0 ? 'первая' : 'последняя') + ' цель.');
				return;
			}
			transferGroup(from, ui.groupSel.index, to, wz.groupings[to].length);
		}

		// ---- перенос мышью: зоны списков шага; сброс зовёт те же действия, что кнопки > < ↑ ↓ ----

		/** Ключ строки списка мастера по её data-wizard-key: часть после префикса или null. */
		function wizardRowKey(row, prefix) {
			const key = typeof row.getAttribute === 'function' ? row.getAttribute('data-wizard-key') : null;
			return key && key.indexOf(prefix) === 0 ? key.slice(prefix.length) : null;
		}

		/** Номер строки сброса в списке выбранных (ключ — номер); -1 — под строками. */
		function wizardDropRow(target) {
			return target && target.key !== null && target.key !== undefined ? Number(target.key) : -1;
		}

		/** Фокус — на строку выбранных с ключом key: её нажали мышью, а прежний номер теперь у соседней строки. */
		function focusChosen(key) {
			const node = keyed.get(key);
			if (node && node.isConnected) {
				node.focus();
			}
		}

		/** Узел доступного поля по ключу строки (каталог или раскрытый реквизит), если его можно выбрать. */
		function availNode(step, key) {
			const node = indexes[step].get(key) || typeNodes[step].get(key);
			return node && wizardPickable(node, step) ? node : null;
		}

		/**
		 * «Доступные поля» шага — источник (поле тащат в выбранные, как «>») и зона «убрать»: строка выбранных, брошенная
		 * сюда, убирается, как «<» и двойной щелчок; папки и «Авто» конструктор не убирает — их сюда не бросить.
		 */
		function availDropZone(host, step) {
			const from = {};
			if (step === 'groups') {
				for (const target of wizardRules.TARGETS[wz.type]) {
					from['wzgrp:' + target] = (payload) => {
						ui.groupSel = { target: target, index: Number(payload.key) };
						ui.target[wz.type] = target;
						removeChosen('groups', false);
					};
				}
			} else {
				from.wzchosen = (payload) => {
					ui.chosen[step] = Number(payload.key);
					removeChosen(step, false);
				};
			}
			dragZone(host, {
				id: 'wzavail',
				scope: 'wizard',
				keyOf: (row) => wizardRowKey(row, 'avail:'),
				drag: (key) => (availNode(step, key) ? 'field' : ''),
				pick: (key) => selectAvail(step, key),
				from: from,
				accept: (payload) => payload.kind !== 'pinned',
				place: 'zone',
			});
		}

		/**
		 * Список выбранных полей или порядка: поле из доступных встаёт в место сброса (тот же addPaths, что «>», с номером),
		 * строка переставляется сразу на место (тот же сдвиг, что ↑ ↓). Строку со списком направления тащат за имя.
		 */
		function chosenDropZone(listEl, step) {
			const items = step === 'fields' ? wz.selection : wz.order;
			dragZone(listEl, {
				id: 'wzchosen',
				scope: 'wizard',
				keyOf: (row) => wizardRowKey(row, 'chosen:'),
				drag: (key) => (items[Number(key)] ? (pinnedItem(step, items[Number(key)]) ? 'pinned' : 'field') : ''),
				pick: (key) => {
					const select = chosenSelectors.get('chosen:' + key);
					if (select) {
						select();
					}
				},
				from: {
					wzavail: (payload, target) => {
						const node = availNode(step, payload.key);
						if (!node) {
							return false;
						}
						addPaths(step, [node.path], dropIndex(items.length, -1, wizardDropRow(target), target.place));
						return undefined;
					},
					wzchosen: (payload, target) => {
						const from = Number(payload.key);
						const to = dropIndex(items.length, from, wizardDropRow(target), target.place);
						if (to === from) {
							return false;
						}
						ui.chosen[step] = from;
						moveChosen(step, to - from);
						focusChosen('chosen:' + to);
						return undefined;
					},
				},
				effect: (payload) => (payload.zone === 'wzavail' ? 'copy' : 'move'),
			});
		}

		/**
		 * Список цели группировок (Группировки; Таблицы, Строки, Колонки; Таблицы, Точки, Серии): поле из доступных — в место
		 * сброса этой цели (как щелчок по заголовку цели и «>»), перестановка внутри цели (как ↑ ↓) и перенос из другой цели с
		 * типом группировки (transferGroup). Строку тащат за имя: в ней список типа группировки. Зона — вся цель (box), с её
		 * заголовком: сброс на заголовок ставит первым (как щелчок по нему и «>» на место 0), у пустой цели это и есть
		 * главное место сброса.
		 */
		function targetDropZone(box, head, listEl, target) {
			const prefix = 'chosen:' + target + ':';
			// Заголовок и строки — один массив на зону, при первом обращении в переносе (перерисовки в нём отложены)
			let rows = null;
			const from = {
				wzavail: (payload, spot) => {
					const node = availNode('groups', payload.key);
					if (!node) {
						return false;
					}
					ui.target[wz.type] = target;
					addPaths('groups', [node.path], dropIndex(wz.groupings[target].length, -1, wizardDropRow(spot), spot.place));
					return undefined;
				},
			};
			for (const other of wizardRules.TARGETS[wz.type]) {
				from['wzgrp:' + other] = (payload, spot) => {
					const index = Number(payload.key);
					if (other !== target) {
						const at = dropIndex(wz.groupings[target].length, -1, wizardDropRow(spot), spot.place);
						if (!transferGroup(other, index, target, at)) {
							return false;
						}
						focusChosen('chosen:' + target + ':' + ui.groupSel.index);
						return undefined;
					}
					const to = dropIndex(wz.groupings[target].length, index, wizardDropRow(spot), spot.place);
					if (to === index) {
						return false;
					}
					ui.groupSel = { target: target, index: index };
					ui.target[wz.type] = target;
					moveChosen('groups', to - index);
					focusChosen(prefix + to);
					return undefined;
				};
			}
			dragZone(box, {
				id: 'wzgrp:' + target,
				scope: 'wizard',
				keyOf: (row) => wizardRowKey(row, prefix),
				// Строка — ребёнок списка цели или заголовок (подъём по предкам, не обход строк)
				rowOf: (node) => {
					for (let current = node; current && current !== box; current = current.parentElement) {
						if (current === head || current.parentElement === listEl) {
							return current;
						}
					}
					return null;
				},
				rows: () => rows || (rows = [head].concat(Array.from(listEl.children))),
				drag: (key) => (wz.groupings[target][Number(key)] ? 'field' : ''),
				pick: (key) => {
					const select = chosenSelectors.get(prefix + key);
					if (select) {
						select();
					}
				},
				from: from,
				effect: (payload) => (payload.zone === 'wzavail' ? 'copy' : 'move'),
			});
		}

		function addManual(step, input) {
			const raw = input.value.trim();
			const problem = wizardRules.fieldPathProblem(raw);
			if (problem) {
				setNote(problem);
				return;
			}
			const key = wizardKey(raw);
			const node = indexes.any.get(key);
			if (node && (node.kind === 'folder' || node.kind === 'container')) {
				setNote('«' + raw + '» — папка полей, а не поле: выберите поле внутри неё.');
				return;
			}
			const flag = WIZARD_RESTRICTION_FLAGS[step];
			if (node && node.restrict && node.restrict[flag]) {
				setNote('У поля «' + raw + '» ограничение использования: в ' + WIZARD_SECTION_WORDS[step] + ' оно недоступно.');
				return;
			}
			if (step === 'groups' && (resourceKeys.has(key) || (node && node.kind === 'total'))) {
				setNote('«' + raw + '» — ресурс схемы: по ресурсу группировать нельзя.');
				return;
			}
			// Найденное поле пишется так, как в схеме, реквизит по типу — как в описании объекта (тот же путь
			// даёт «>» по раскрытому полю); не найденное — как введено, с предупреждением
			const typed = node ? null : typeNodeByPath(step, raw, true);
			const path = node ? node.path : typed ? typed.path : raw;
			if (!node && !typed) {
				ui.manual.set(key, { path: path, step: step });
			}
			input.value = '';
			addPaths(step, [path]);
		}

		function manualWarnings() {
			const out = [];
			for (const [key, entry] of ui.manual) {
				// Реквизит по типу, чьё описание пришло после ввода, уже не «вне схемы»
				if (presentOnStep(entry.step, key) && !typeNodeByPath(entry.step, entry.path, true)) {
					out.push({ step: entry.step, text: 'Поля «' + entry.path + '» нет среди полей схемы: проверьте путь.' });
				}
			}
			return out;
		}

		function allWarnings() {
			return wizardRules.wizardWarnings(planState(), model).concat(manualWarnings());
		}

		// ---- отрисовка ----

		function renderSteps() {
			const host = hosts.steps;
			host.textContent = '';
			steps().forEach((item, index) => {
				if (index > 0) {
					host.appendChild(el('span', 'dcs-wizard-step-sep', '·'));
				}
				const current = item.id === ui.step;
				const button = el('button', 'dcs-wizard-step' + (current ? ' dcs-wizard-step-active' : ''), index + 1 + ' ' + item.label);
				button.type = 'button';
				if (current) {
					button.setAttribute('aria-current', 'step');
				}
				keyedEl(button, 'step:' + item.id);
				button.addEventListener('click', () => {
					goStep(item.id);
				});
				host.appendChild(button);
			});
		}

		function renderTypeStep(host) {
			if (ctx.newVariant) {
				host.appendChild(
					el(
						'div',
						'dcs-plate',
						'Новый вариант «' + ctx.variant + '»' +
							(ctx.newVariant.presentation ? ' («' + ctx.newVariant.presentation + '»)' : '') +
							': шаги начаты с настроек текущего варианта, сам он не изменится.'
					)
				);
			}
			if (!wz.recognized) {
				host.appendChild(
					el(
						'div',
						'dcs-plate dcs-wizard-warn',
						'Текущая структура не распознана (' + wz.reason + '): шаги начаты с полей и порядка корня, при ОК структура будет собрана заново целиком.'
					)
				);
			}
			const cards = el('div', 'dcs-wizard-cards');
			cards.setAttribute('role', 'radiogroup');
			cards.setAttribute('aria-label', 'Тип отчёта');
			for (const type of wizardRules.REPORT_TYPES) {
				const card = el('label', 'dcs-wizard-card' + (wz.type === type.value ? ' dcs-wizard-card-active' : ''));
				const radio = el('input', 'dcs-wizard-radio');
				radio.type = 'radio';
				radio.name = 'dcsWizardType';
				radio.value = type.value;
				radio.checked = wz.type === type.value;
				keyedEl(radio, 'type:' + type.value);
				radio.addEventListener('change', () => {
					if (radio.checked && wz.type !== type.value) {
						wz.type = type.value;
						keepFocus(renderAll);
					}
				});
				// Чем вид отличается — подсказкой карточки и описанием переключателя, а не постоянным текстом в ней
				card.title = WIZARD_TYPE_HINTS[type.value];
				radio.setAttribute('aria-description', WIZARD_TYPE_HINTS[type.value]);
				card.appendChild(radio);
				const text = el('span', 'dcs-wizard-card-text');
				text.appendChild(el('span', 'dcs-wizard-card-title', type.label));
				card.appendChild(text);
				cards.appendChild(card);
			}
			host.appendChild(cards);
		}

		function moveButton(host, label, title, key, onClick) {
			const button = el('button', 'ghost-btn dcs-btn-small dcs-wizard-move', label);
			button.type = 'button';
			button.title = title;
			button.setAttribute('aria-label', title);
			keyedEl(button, 'move:' + key);
			button.addEventListener('click', onClick);
			host.appendChild(button);
			return button;
		}

		function selectAvail(step, key) {
			ui.avail[step] = key;
			for (const [rowKey, row] of availRows) {
				row.classList.toggle('dcs-tree-selected', rowKey === key);
				row.setAttribute('aria-selected', String(rowKey === key));
				row.tabIndex = rowKey === key ? 0 : -1;
			}
		}

		/**
		 * Одна остановка Tab на список, как у дерева наборов: строки ходят стрелками, а сотни строк
		 * по Tab не дали бы дойти до кнопок «>», «<<» и подвала. Остановка — выделенная строка, без
		 * выделения — первая.
		 */
		function ensureListStop(listEl) {
			const rows = Array.from(listEl.children).filter((child) => child.classList.contains('dcs-wizard-row'));
			if (rows.length > 0 && !rows.some((row) => row.tabIndex === 0)) {
				setRowStop(rows[0], true);
			}
		}

		function toggleAvail(step, key, open) {
			const expanded = ui.expanded[step];
			const want = open === undefined ? !expanded.has(key) : open;
			let selectedInside = false;
			if (want) {
				expanded.add(key);
			} else {
				expanded.delete(key);
				// Выделенный ребёнок свёрнутой строки уходит из списка: выделение и остановка Tab — на саму строку
				selectedInside = ui.avail[step].indexOf(key + '.') === 0;
				if (selectedInside) {
					ui.avail[step] = key;
				}
			}
			keepFocus(() => renderAvail(step));
			const row = availRows.get(key);
			const active = document.activeElement;
			// Фокус стоял на ушедшем ребёнке (щелчок по стрелке родителя) — он переходит на родителя, а не в никуда
			if (selectedInside && row && (!active || active === document.body || !active.isConnected)) {
				row.focus();
			}
		}

		function renderAvail(step) {
			const host = hosts.avail;
			host.textContent = '';
			availRows = new Map();
			const query = wizardFold(ui.search[step].trim());
			const taken = takenKeys(step);
			const visible = (node) => !hiddenOnStep(node, step) && (matchesSearch(node, query) || (node.children || []).some(visible));
			const expanded = ui.expanded[step];
			const rows = [];
			// typeDepth — уровень реквизитов по типу под полем каталога (у строк каталога 0). Поиск идёт только
			// по каталогу: реквизиты подгружаются раскрытием, искать среди непрочитанного нечего, и раскрытое
			// поле показывает их целиком, без фильтра
			const walk = (nodes, depth, typeDepth) => {
				for (const node of nodes) {
					if (typeDepth === 0 && !visible(node)) {
						continue;
					}
					const key = wizardKey(node.path);
					if (typeDepth > 0) {
						typeNodes[step].set(key, node);
					}
					const own = typeDepth === 0 ? (node.children || []).filter(visible) : [];
					// У свёрнутого реквизита по типу стрелку решает его тип: полный подсчёт детей шёл бы от
					// корня цепочки и заново строил детей родителя на каждую строку — ответ описания по объекту
					// из M реквизитов стоил бы O(M²). Дети считаются при раскрытии
					const deep = typeDepth < WIZARD_TYPE_DEPTH && typeCapable(node);
					const lazy = deep && typeDepth > 0 && !expanded.has(key);
					const typed = deep && !lazy ? typeLevel(step, node) : null;
					// Тип ещё не известен (pending) — стрелка тоже есть: раскрытие прочитает описание, и если
					// реквизитов не окажется, стрелка пропадёт
					const hasTyped = lazy ? node.typeExpandable === true : Boolean(typed) && (typed.children.length > 0 || typed.pending.length > 0);
					// Папки при поиске раскрыты сами, реквизиты по типу — только по раскрытию
					const showOwn = own.length > 0 && (query !== '' || expanded.has(key));
					const showTyped = hasTyped && expanded.has(key);
					rows.push({ node: node, key: key, depth: depth, expandable: own.length > 0 || hasTyped, open: showOwn || showTyped });
					if (showOwn) {
						walk(own, depth + 1, 0);
					}
					if (showTyped) {
						walk(typed.children, depth + 1, typeDepth + 1);
						if (typed.pending.length > 0) {
							requestDescriptions(typed.pending);
							rows.push({ loading: true, key: key + '#loading', depth: depth + 1 });
						}
					}
				}
			};
			walk(catalogs[step].nodes || [], 0, 0);
			if (rows.length === 0) {
				host.appendChild(el('div', 'dcs-wizard-empty', query ? 'Ничего не найдено.' : 'Доступных полей нет: путь можно ввести в «Другое поле».'));
				return;
			}
			// Строка «Загрузка реквизитов…» — не остановка: стрелки её перешагивают
			const focusRow = (index) => {
				selectAvail(step, rows[index].key);
				availRows.get(rows[index].key).focus();
			};
			const liveFrom = (index, dir) => {
				for (let k = index; k >= 0 && k < rows.length; k += dir) {
					if (!rows[k].loading) {
						return k;
					}
				}
				return -1;
			};
			rows.forEach((row, position) => {
				if (row.loading) {
					const info = el('div', 'dcs-tree-row dcs-wizard-row-info', 'Загрузка реквизитов…');
					info.style.paddingLeft = 4 + row.depth * 14 + 'px';
					info.setAttribute('role', 'treeitem');
					info.setAttribute('aria-level', String(row.depth + 1));
					info.setAttribute('aria-disabled', 'true');
					info.tabIndex = -1;
					host.appendChild(info);
					return;
				}
				const node = row.node;
				const pickable = wizardPickable(node, step);
				const isTaken = pickable && taken.has(row.key);
				let className = 'dcs-tree-row dcs-wizard-row';
				if (ui.avail[step] === row.key) {
					className += ' dcs-tree-selected';
				}
				if (!pickable) {
					className += ' dcs-wizard-row-group';
				}
				if (isTaken) {
					className += ' dcs-wizard-row-taken';
				}
				const item = el('div', className);
				item.style.paddingLeft = 4 + row.depth * 14 + 'px';
				item.tabIndex = ui.avail[step] === row.key ? 0 : -1;
				item.setAttribute('role', 'treeitem');
				item.setAttribute('aria-level', String(row.depth + 1));
				item.setAttribute('aria-selected', String(ui.avail[step] === row.key));
				if (row.expandable) {
					item.setAttribute('aria-expanded', String(row.open));
				}
				keyedEl(item, 'avail:' + row.key);
				availRows.set(row.key, item);
				const twist = el('span', 'dcs-tree-twist', row.expandable ? (row.open ? '▾' : '▸') : '');
				// Состояние строки читалке называет aria-expanded, знак стрелки в её имя не входит
				twist.setAttribute('aria-hidden', 'true');
				twist.addEventListener('click', (event) => {
					event.stopPropagation();
					toggleAvail(step, row.key);
				});
				item.appendChild(twist);
				item.appendChild(nameEl('span', 'dcs-tree-label', node.name));
				if (node.title && node.title !== node.name) {
					item.appendChild(el('span', 'dcs-wizard-row-note', node.title));
				}
				if (isTaken) {
					item.appendChild(el('span', 'dcs-wizard-row-note', 'выбрано'));
				}
				item.title = pickable ? node.path : node.path + ' — группа полей';
				const activate = () => {
					if (pickable) {
						addPaths(step, [node.path]);
					} else if (row.expandable) {
						toggleAvail(step, row.key);
					}
				};
				// Перенос мышью: строке поля — только атрибут, слушатели — у документа
				if (pickable) {
					item.draggable = true;
				}
				item.addEventListener('click', () => {
					selectAvail(step, row.key);
				});
				item.addEventListener('dblclick', activate);
				// Клавиатура — как у деревьев конструктора запроса: → раскрывает, у раскрытой идёт к первому
				// ребёнку; ← сворачивает раскрытую вручную, иначе идёт к родителю; Home и End — края списка
				item.addEventListener('keydown', (event) => {
					if (event.key === 'Enter') {
						event.preventDefault();
						selectAvail(step, row.key);
						activate();
					} else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
						event.preventDefault();
						const dir = event.key === 'ArrowDown' ? 1 : -1;
						const next = liveFrom(position + dir, dir);
						if (next >= 0) {
							focusRow(next);
						}
					} else if (event.key === 'Home' || event.key === 'End') {
						event.preventDefault();
						const edge = event.key === 'Home' ? liveFrom(0, 1) : liveFrom(rows.length - 1, -1);
						if (edge >= 0) {
							focusRow(edge);
						}
					} else if (event.key === 'ArrowRight') {
						event.preventDefault();
						if (row.expandable && !row.open) {
							toggleAvail(step, row.key, true);
							return;
						}
						const child = row.open ? liveFrom(position + 1, 1) : -1;
						// Пока у раскрытой строки только «Загрузка реквизитов…», идти некуда: следующая живая — уже сосед
						if (child >= 0 && rows[child].depth > row.depth) {
							focusRow(child);
						}
					} else if (event.key === 'ArrowLeft') {
						event.preventDefault();
						// При поиске папка раскрыта сама: свернуть её нельзя, поэтому ← ведёт к родителю
						if (row.open && expanded.has(row.key)) {
							toggleAvail(step, row.key, false);
							return;
						}
						for (let k = position - 1; k >= 0; k -= 1) {
							if (!rows[k].loading && rows[k].depth < row.depth) {
								focusRow(k);
								return;
							}
						}
					}
				});
				host.appendChild(item);
			});
			ensureListStop(host);
		}

		/** Остановка Tab строки выбранных; список в строке (направление, тип группировки) достаётся Tab вместе с ней. */
		function setRowStop(row, on) {
			row.tabIndex = on ? 0 : -1;
			const control = row.querySelector('select');
			if (control) {
				control.tabIndex = row.tabIndex;
			}
		}

		function chosenRow(step, spec) {
			let className = 'dcs-tree-row dcs-wizard-row';
			if (spec.selected) {
				className += ' dcs-tree-selected';
			}
			if (spec.pinned) {
				className += ' dcs-wizard-row-pinned';
			}
			if (spec.off) {
				className += ' dcs-wizard-row-off';
			}
			const row = el('div', className);
			row.setAttribute('role', 'option');
			row.setAttribute('aria-selected', String(spec.selected));
			keyedEl(row, spec.key);
			chosenRows.set(spec.key, row);
			const labelEl = row.appendChild(nameEl('span', 'dcs-tree-label', spec.label));
			// Перенос мышью: строка со списком (направление, тип группировки) тащится только за имя — список остаётся рабочим
			if (spec.control) {
				labelEl.draggable = true;
			} else {
				row.draggable = true;
			}
			for (const note of spec.notes) {
				row.appendChild(el('span', 'dcs-wizard-row-note', note));
			}
			if (spec.control) {
				// Список в строке живёт своей жизнью: щелчок по нему не перевыделяет строку
				spec.control.addEventListener('click', (event) => {
					event.stopPropagation();
				});
				row.appendChild(spec.control);
			}
			setRowStop(row, spec.selected);
			const select = () => {
				if (spec.onSelect() === 'redraw') {
					// Строка другой цели: цель становится активной, рамка и счётчики перерисовываются
					keepFocus(redrawLists);
					return;
				}
				// Выделение меняется на месте: перерисовка увела бы фокус и закрыла бы открытый список в строке
				for (const [key, other] of chosenRows) {
					other.classList.toggle('dcs-tree-selected', key === spec.key);
					other.setAttribute('aria-selected', String(key === spec.key));
					// У каждой цели группировок свой список и своя остановка: чужие списки не трогаются
					if (other.parentNode === row.parentNode) {
						setRowStop(other, key === spec.key);
					}
				}
			};
			chosenSelectors.set(spec.key, select);
			row.addEventListener('click', select);
			row.addEventListener('dblclick', () => {
				spec.onSelect();
				removeChosen(step, false);
			});
			row.addEventListener('keydown', (event) => {
				if (event.key === 'Delete') {
					event.preventDefault();
					spec.onSelect();
					removeChosen(step, false);
				} else if ((event.key === 'ArrowDown' || event.key === 'ArrowUp') && !event.altKey) {
					event.preventDefault();
					const keys = Array.from(chosenRows.keys());
					const next = keys[keys.indexOf(spec.key) + (event.key === 'ArrowDown' ? 1 : -1)];
					if (next) {
						chosenSelectors.get(next)();
						const target = keyed.get(next);
						if (target && target.isConnected) {
							target.focus();
						}
					}
				}
			});
			return row;
		}

		function itemLabel(item) {
			if (item.kind === 'auto') {
				return 'Авто';
			}
			if (item.kind === 'folder') {
				return 'Папка «' + (item.title || '') + '»';
			}
			return item.field || '';
		}

		function itemNotes(step, item) {
			const notes = [];
			if (item.kind === 'auto') {
				notes.push(step === 'fields' ? 'поля по умолчанию' : 'порядок по умолчанию');
			} else if (item.kind === 'folder') {
				notes.push('полей: ' + wizardRules.selectedFieldNames(item.items, true).length);
			} else if (item.title) {
				notes.push(item.title);
			}
			if (item.use === false) {
				notes.push('выключено');
			}
			return notes;
		}

		function renderChosenItems(step) {
			const host = hosts.chosen;
			host.textContent = '';
			chosenRows = new Map();
			chosenSelectors = new Map();
			host.appendChild(el('div', 'dcs-wizard-col-title', step === 'fields' ? 'Выбранные поля' : 'Порядок'));
			const listEl = el('div', 'dcs-tree dcs-wizard-list');
			listEl.setAttribute('role', 'listbox');
			listEl.setAttribute('aria-label', step === 'fields' ? 'Выбранные поля' : 'Порядок');
			const items = step === 'fields' ? wz.selection : wz.order;
			chosenDropZone(listEl, step);
			if (items.length === 0) {
				listEl.appendChild(el('div', 'dcs-wizard-empty', step === 'fields' ? 'Поля не выбраны.' : 'Без сортировки.'));
			}
			items.forEach((item, index) => {
				let control = null;
				if (step === 'order' && !pinnedItem(step, item)) {
					control = selectInput(wizardRules.ORDER_TYPES, item.orderType === 'Desc' ? 'Desc' : 'Asc');
					control.classList.add('dcs-wizard-row-select');
					control.setAttribute('aria-label', 'Направление: ' + (item.field || ''));
					control.addEventListener('change', () => {
						wz.order[index] = Object.assign({}, item, { orderType: control.value });
						redrawSide();
					});
				}
				listEl.appendChild(
					chosenRow(step, {
						key: 'chosen:' + index,
						label: itemLabel(item),
						notes: itemNotes(step, item),
						pinned: pinnedItem(step, item),
						off: item.use === false,
						selected: ui.chosen[step] === index,
						control: control,
						onSelect: () => {
							ui.chosen[step] = index;
						},
					})
				);
			});
			ensureListStop(listEl);
			host.appendChild(listEl);
		}

		function renderTargets() {
			const host = hosts.chosen;
			host.textContent = '';
			chosenRows = new Map();
			chosenSelectors = new Map();
			for (const target of wizardRules.TARGETS[wz.type]) {
				const active = ui.target[wz.type] === target;
				const fields = wz.groupings[target];
				const box = el('div', 'dcs-wizard-target' + (active ? ' dcs-wizard-target-active' : ''));
				const head = el(
					'button',
					'dcs-wizard-target-title',
					wizardRules.TARGET_LABELS[target] + (fields.length > 0 ? ' (' + fields.length + ')' : '')
				);
				head.type = 'button';
				head.setAttribute('aria-pressed', String(active));
				head.title = 'Кнопки > и >> добавляют сюда';
				keyedEl(head, 'target:' + target);
				head.addEventListener('click', () => {
					ui.target[wz.type] = target;
					keepFocus(redrawLists);
				});
				box.appendChild(head);
				const listEl = el('div', 'dcs-wizard-target-list');
				listEl.setAttribute('role', 'listbox');
				listEl.setAttribute('aria-label', wizardRules.TARGET_LABELS[target]);
				setHint(listEl, WIZARD_NESTING_HINT);
				targetDropZone(box, head, listEl, target);
				if (fields.length === 0) {
					listEl.appendChild(el('div', 'dcs-wizard-empty', 'Нет полей.'));
				}
				fields.forEach((field, index) => {
					const control = selectInput(wizardRules.GROUP_TYPES, field.groupType || 'Items');
					control.classList.add('dcs-wizard-row-select');
					control.setAttribute('aria-label', 'Тип группировки: ' + (field.field || ''));
					control.addEventListener('change', () => {
						wz.groupings[target][index] = Object.assign({}, field, { groupType: control.value });
						redrawSide();
					});
					listEl.appendChild(
						chosenRow('groups', {
							key: 'chosen:' + target + ':' + index,
							label: field.field || '',
							notes: [],
							pinned: false,
							off: false,
							selected: ui.groupSel.target === target && ui.groupSel.index === index,
							control: control,
							onSelect: () => {
								ui.groupSel = { target: target, index: index };
								if (ui.target[wz.type] === target) {
									return '';
								}
								ui.target[wz.type] = target;
								return 'redraw';
							},
						})
					);
				});
				ensureListStop(listEl);
				box.appendChild(listEl);
				host.appendChild(box);
			}
			if (wz.type === 'list') {
				const details = checkbox('Детальные записи последним уровнем', wz.details);
				keyedEl(details.input, 'details');
				details.input.addEventListener('change', () => {
					wz.details = details.input.checked;
					redrawSide();
				});
				const row = el('div', 'dcs-check-row');
				row.appendChild(details.wrap);
				host.appendChild(row);
			}
		}

		function renderPickStep(host, step) {
			// Про ресурсы таблицы и диаграммы предупреждает предпросмотр, о вложенности группировок — подсказка
			// списка цели (WIZARD_NESTING_HINT)
			const dual = el('div', 'dcs-wizard-dual');
			const left = el('div', 'dcs-wizard-col');
			left.appendChild(el('div', 'dcs-wizard-col-title', 'Доступные поля'));
			const search = el('input', 'edit-input dcs-wizard-search');
			search.type = 'search';
			search.placeholder = 'Поиск поля';
			search.setAttribute('aria-label', 'Поиск среди доступных полей');
			search.value = ui.search[step];
			keyedEl(search, 'search');
			search.addEventListener('input', () => {
				ui.search[step] = search.value;
				renderAvail(step);
			});
			left.appendChild(search);
			hosts.avail = el('div', 'dcs-tree dcs-wizard-list');
			hosts.avail.setAttribute('role', 'tree');
			hosts.avail.setAttribute('aria-label', 'Доступные поля');
			availDropZone(hosts.avail, step);
			left.appendChild(hosts.avail);
			dual.appendChild(left);
			const moves = el('div', 'dcs-wizard-moves');
			moveButton(moves, '>', 'Добавить выделенное поле', 'add', () => addSelectedAvail(step));
			moveButton(moves, '>>', 'Добавить все поля', 'addAll', () => addAllAvail(step));
			moveButton(moves, '<', 'Убрать выделенное', 'remove', () => removeChosen(step, false));
			moveButton(moves, '<<', 'Убрать все', 'removeAll', () => removeChosen(step, true));
			dual.appendChild(moves);
			hosts.chosen = el('div', 'dcs-wizard-col');
			dual.appendChild(hosts.chosen);
			const order = el('div', 'dcs-wizard-moves');
			moveButton(order, '↑', 'Выше', 'up', () => moveChosen(step, -1));
			moveButton(order, '↓', 'Ниже', 'down', () => moveChosen(step, 1));
			if (step === 'groups' && wizardRules.TARGETS[wz.type].length > 1) {
				// Группировку — в соседнюю цель с её типом, как перенос мышью в другую цель (WCAG 2.5.7)
				moveButton(order, '⇑', 'В предыдущую цель (тип группировки сохраняется)', 'targetUp', () => transferSelected(-1));
				moveButton(order, '⇓', 'В следующую цель (тип группировки сохраняется)', 'targetDown', () => transferSelected(1));
			}
			dual.appendChild(order);
			host.appendChild(dual);
			const other = el('div', 'dcs-wizard-other');
			const label = el('label', 'dcs-wizard-other-label', 'Другое поле…');
			const input = textInput('');
			input.classList.add('dcs-wizard-other-input');
			input.placeholder = 'путь, например Контрагент.ИНН';
			input.setAttribute('aria-label', 'Другое поле: путь');
			keyedEl(input, 'other');
			const addOther = el('button', 'ghost-btn dcs-btn-small', 'Добавить');
			addOther.type = 'button';
			keyedEl(addOther, 'otherAdd');
			addOther.addEventListener('click', () => {
				addManual(step, input);
			});
			other.appendChild(label);
			other.appendChild(input);
			other.appendChild(addOther);
			host.appendChild(other);
			// Подсказка подключается раньше своего Enter: обработчики одного поля идут в порядке
			// подписки, и только так Enter при открытом списке вставляет строку списка (обвязка
			// гасит событие), а не добавляет недописанный путь «вне схемы». Каталог — тот же, что у
			// «Доступных полей» шага: подсказка по активному варианту предложила бы новому варианту
			// пользовательские поля, которых у него нет
			attachCompletion(input, () => 'settings:' + WIZARD_SECTIONS[step], { catalog: () => catalogs[step] });
			input.addEventListener('keydown', (event) => {
				if (event.key === 'Enter' && !event.defaultPrevented) {
					event.preventDefault();
					addManual(step, input);
				}
			});
			drawLists();
		}

		function renderChartStep(host) {
			const current = wz.chartType || wizardRules.DEFAULT_CHART_TYPE;
			const box = el('div', 'dcs-wizard-charts');
			box.setAttribute('role', 'radiogroup');
			box.setAttribute('aria-label', 'Тип диаграммы');
			const labels = [];
			for (const group of wizardRules.CHART_TYPE_GROUPS) {
				const types = wizardRules.CHART_TYPES.filter((type) => type.group === group.id);
				if (types.length === 0) {
					continue;
				}
				const section = el('div', 'dcs-wizard-chart-group');
				section.appendChild(el('div', 'dcs-wizard-chart-title', group.label));
				for (const type of types) {
					const label = el('label', 'dcs-wizard-chart' + (type.value === current ? ' dcs-wizard-chart-active' : ''));
					const radio = el('input', 'dcs-wizard-radio');
					radio.type = 'radio';
					radio.name = 'dcsWizardChart';
					radio.value = type.value;
					radio.checked = type.value === current;
					keyedEl(radio, 'chart:' + type.value);
					labels.push({ label: label, value: type.value });
					radio.addEventListener('change', () => {
						if (!radio.checked) {
							return;
						}
						wz.chartType = type.value;
						for (const entry of labels) {
							entry.label.classList.toggle('dcs-wizard-chart-active', entry.value === type.value);
						}
						redrawSide();
					});
					label.appendChild(radio);
					label.appendChild(el('span', '', type.label));
					label.appendChild(el('span', 'dcs-wizard-row-note', type.value + (type.since ? ', с ' + type.since : '')));
					section.appendChild(label);
				}
				box.appendChild(section);
			}
			host.appendChild(box);
		}

		function renderPreview() {
			const host = hosts.preview;
			host.textContent = '';
			host.appendChild(el('div', 'dcs-wizard-preview-title', 'Результат'));
			const tree = el('div', 'dcs-wizard-preview-tree');
			tree.setAttribute('aria-label', 'Предпросмотр структуры');
			for (const line of wizardRules.previewLines(planState())) {
				const row = el('div', WIZARD_PREVIEW_CLASSES[line.kind] || WIZARD_PREVIEW_CLASSES.group, line.text);
				row.style.paddingLeft = line.depth * 12 + 'px';
				tree.appendChild(row);
			}
			host.appendChild(tree);
			const fields = wz.selection.filter((item) => item && item.use !== false).map(itemLabel).filter(Boolean);
			host.appendChild(el('div', 'dcs-wizard-preview-line', 'Выбранные поля: ' + (fields.length > 0 ? fields.join(', ') : 'нет')));
			const order = wz.order
				.filter((item) => item && item.use !== false)
				.map((item) => (item.kind === 'auto' ? 'Авто' : (item.field || '') + (item.orderType === 'Desc' ? ' ↓' : ' ↑')));
			host.appendChild(el('div', 'dcs-wizard-preview-line', 'Порядок: ' + (order.length > 0 ? order.join(', ') : 'нет')));
			const warnings = allWarnings();
			if (warnings.length > 0) {
				const counts = steps()
					.map((item) => ({ label: item.label, count: warnings.filter((warning) => warning.step === item.id).length }))
					.filter((entry) => entry.count > 0)
					.map((entry) => entry.label + ' (' + entry.count + ')');
				host.appendChild(el('div', 'dcs-warn dcs-wizard-preview-line', 'Предупреждения: ' + counts.join(', ')));
			}
		}

		function renderWarnings() {
			const host = hosts.warn;
			if (!host) {
				return;
			}
			host.textContent = '';
			for (const warning of allWarnings()) {
				if (warning.step === ui.step) {
					host.appendChild(el('div', 'dcs-plate dcs-wizard-warn', warning.text));
				}
			}
		}

		/** Списки шага и отметки «выбрано» — без перестройки поиска и «Другого поля» (в них печатают). */
		function drawLists() {
			if (ui.step === 'groups') {
				renderTargets();
			} else if (ui.step === 'fields' || ui.step === 'order') {
				renderChosenItems(ui.step);
			}
			if (hosts.avail) {
				renderAvail(ui.step);
			}
		}

		function redrawLists() {
			drawLists();
			redrawSide();
		}

		function redrawSide() {
			renderPreview();
			renderWarnings();
		}

		function renderAll() {
			if (!steps().some((item) => item.id === ui.step)) {
				// Тип сменился с диаграммы: у нового типа её шага нет
				ui.step = 'type';
			}
			renderSteps();
			const main = hosts.main;
			main.textContent = '';
			hosts.avail = null;
			hosts.chosen = null;
			const stepHost = el('div', 'dcs-wizard-step-body');
			main.appendChild(stepHost);
			hosts.note = el('div', 'dcs-wizard-note');
			hosts.note.setAttribute('aria-live', 'polite');
			hosts.warn = el('div', 'dcs-wizard-warns');
			main.appendChild(hosts.note);
			main.appendChild(hosts.warn);
			if (ui.step === 'type') {
				renderTypeStep(stepHost);
			} else if (ui.step === 'chart') {
				renderChartStep(stepHost);
			} else {
				renderPickStep(stepHost, ui.step);
			}
			redrawSide();
			level.setButtons(footer());
		}

		function submit() {
			if (editBusy()) {
				return BUSY;
			}
			let operations;
			try {
				operations = wizardRules.planWizardOperations(
					ctx.newVariant ? null : ctx.settings,
					planState(),
					ctx.variant,
					ctx.newVariant ? { newVariant: true, presentation: ctx.newVariant.presentation } : undefined
				);
			} catch (error) {
				return error instanceof Error ? error.message : String(error);
			}
			if (operations.length === 0) {
				closeDialog();
				setStatus('Конструктор: изменений нет, вариант не записан.', false);
				return undefined;
			}
			if (!send('dcs/settings-wizard', { variant: ctx.variant, operations: operations })) {
				return BUSY;
			}
			// После записи — корень «Отчет» и заново развёрнутое дерево: структура собрана другой
			delete seededVariants[ctx.variant];
			pendingSelect = [];
			return undefined;
		}

		const opened = pushDialog({
			title: (ctx.newVariant ? 'Конструктор настроек: новый вариант «' : 'Конструктор настроек: вариант «') + ctx.variant + '»',
			width: 'wide',
			onClose: () => {
				if (wizardRerender === onWizardDescribed) {
					wizardRerender = null;
				}
			},
			// Шаги рисуются внутри build: стек ставит фокус в первое поле уже нарисованного шага
			build: (body, created) => {
				level = created;
				const root = el('div', 'dcs-wizard');
				hosts.steps = el('nav', 'dcs-wizard-steps');
				hosts.steps.setAttribute('aria-label', 'Шаги конструктора');
				root.appendChild(hosts.steps);
				const layout = el('div', 'dcs-wizard-layout');
				hosts.main = el('div', 'dcs-wizard-main');
				hosts.preview = el('aside', 'dcs-wizard-preview');
				hosts.preview.setAttribute('aria-label', 'Результат');
				layout.appendChild(hosts.main);
				layout.appendChild(hosts.preview);
				root.appendChild(layout);
				body.appendChild(root);
				renderAll();
			},
			buttons: footer(),
		});
		if (opened.isOpen()) {
			wizardRerender = onWizardDescribed;
		}
		return opened;
	}

	// ---------- дерево структуры варианта ----------

	/** Битое после правки выделение падает на корень. */
	function ensureValidSelection(settings) {
		const path = uiState.nodePath;
		if (isPseudoPath(path)) {
			const parent = nodeAt(settings, path.slice(0, -1));
			const listName = path[path.length - 1].list;
			const kind = parent && parent.kind;
			const valid =
				(kind === 'table' && (listName === 'columns' || listName === 'rows')) ||
				(kind === 'chart' && (listName === 'points' || listName === 'series'));
			if (!valid) {
				uiState.nodePath = [];
			}
			return;
		}
		if (!nodeAt(settings, path)) {
			uiState.nodePath = [];
		}
	}

	function selectNode(path) {
		clearReplyFocus();
		uiState.nodePath = path;
		renderContent();
	}

	/**
	 * Видимые строки дерева структуры по порядку, для стрелок: {path, key, parentKey, expandable, expanded, node}.
	 * Собираются при каждой отрисовке дерева.
	 */
	let structureRows = [];
	/** Вариант нарисованного дерева: Delete в дереве удаляет узел этого варианта. */
	let structureCtx = null;

	/**
	 * Путь path лежит внутри узла under. Псевдо-узел «Колонки» и т. п. — последний шаг с index −1, и его элементы
	 * той же длины: шаг списка у них — с настоящим номером.
	 */
	function isUnderPath(path, under) {
		const pseudo = isPseudoPath(under);
		if (pseudo ? path.length < under.length : path.length <= under.length) {
			return false;
		}
		return under.every((step, index) => {
			const own = path[index];
			if (pseudo && index === under.length - 1) {
				return own.list === step.list && own.index !== -1;
			}
			return own.list === step.list && own.index === step.index;
		});
	}

	/**
	 * Строка дерева структуры: выделение, галка use (только показ) и бейджи секций. Дерево — одна остановка Tab
	 * (выделенная строка, role treeitem); имя строки для читалки — подпись, имя узла, «не используется», бейджи словами.
	 */
	function treeRow(tree, path, depth, opts) {
		const key = pathKey(path);
		const selected = key === pathKey(uiState.nodePath);
		let className = 'dcs-tree-row dcs-setv-node';
		if (selected) {
			className += ' dcs-tree-selected';
		}
		if (opts.dim) {
			className += ' dcs-tree-off';
		}
		const row = el('div', className);
		row.style.paddingLeft = 8 + depth * 16 + 'px';
		const expandedNow = Boolean(opts.expandable) && uiState.expanded.has(key);
		row.setAttribute('role', 'treeitem');
		row.setAttribute('aria-level', String(depth + 1));
		row.setAttribute('aria-selected', String(selected));
		if (opts.expandable) {
			row.setAttribute('aria-expanded', String(expandedNow));
		}
		row.tabIndex = selected ? 0 : -1;
		keyed(row, focusKey(['node', key]));
		const twist = el('span', 'dcs-tree-twist', opts.expandable ? (expandedNow ? '▾' : '▸') : '');
		twist.setAttribute('aria-hidden', 'true');
		if (opts.expandable) {
			twist.addEventListener('click', (event) => {
				event.stopPropagation();
				toggleStructureNode(path, !expandedNow, false);
			});
		}
		row.appendChild(twist);
		if (opts.check !== undefined) {
			const box = el('input', 'edit-check');
			box.type = 'checkbox';
			box.checked = opts.check;
			// Использование узла здесь не правится — галка только показывает use; читалка слышит его в имени строки
			box.disabled = true;
			box.setAttribute('aria-hidden', 'true');
			row.appendChild(box);
		}
		const labelEl = nameEl('span', 'dcs-tree-label', opts.label);
		row.appendChild(labelEl);
		const spoken = [opts.label];
		if (opts.name) {
			row.appendChild(nameEl('span', 'dcs-tree-name', '[' + opts.name + ']'));
			spoken.push(opts.name);
		}
		if (opts.dim) {
			spoken.push('не используется');
		}
		for (const badge of opts.badges || []) {
			const badgeEl = el('span', 'dcs-tree-badge', badge.text);
			badgeEl.title = badge.hint;
			badgeEl.setAttribute('aria-hidden', 'true');
			row.appendChild(badgeEl);
			spoken.push(badge.hint);
		}
		if (opts.readOnly) {
			row.appendChild(el('span', 'dcs-tree-ro', 'только чтение'));
			spoken.push('только чтение');
		}
		row.setAttribute('aria-label', spoken.join(', '));
		// Перенос мышью: строке узла — только атрибут, слушатели — у документа
		if (opts.node && path.length > 0 && !isPseudoPath(path)) {
			row.draggable = true;
		}
		row.addEventListener('click', () => {
			selectNode(path);
		});
		row.addEventListener('keydown', (event) => {
			onStructureKey(event, key);
		});
		tree.appendChild(row);
		structureRows.push({
			path: path,
			key: key,
			parentKey: opts.parent ? pathKey(opts.parent) : '',
			expandable: Boolean(opts.expandable),
			expanded: expandedNow,
			node: opts.node || null,
		});
		return expandedNow;
	}

	function appendStructureRows(tree, items, parentPath, depth) {
		items.forEach((node, index) => {
			appendNodeRow(tree, node, parentPath.concat([{ list: 'structure', index: index }]), depth, parentPath);
		});
	}

	function appendNodeRow(tree, node, path, depth, parentPath) {
		const kind = node.kind;
		if (kind === 'table' || kind === 'chart') {
			const expanded = treeRow(tree, path, depth, {
				label: nodeLabel(node),
				name: node.name,
				check: node.use !== false,
				dim: node.use === false,
				badges: sectionBadges(node),
				expandable: true,
				parent: parentPath,
				node: node,
			});
			if (!expanded) {
				return;
			}
			for (const listName of kind === 'table' ? ['columns', 'rows'] : ['points', 'series']) {
				appendPseudoRow(tree, node, path, listName, depth + 1);
			}
			return;
		}
		if (kind === 'nestedObject') {
			treeRow(tree, path, depth, {
				label: nodeLabel(node),
				name: node.name,
				check: node.use !== false,
				dim: node.use === false,
				readOnly: true,
				expandable: false,
				parent: parentPath,
				node: node,
			});
			return;
		}
		const children = Array.isArray(node.structure) ? node.structure : [];
		const expanded = treeRow(tree, path, depth, {
			label: nodeLabel(node),
			name: node.name,
			check: node.use !== false,
			dim: node.use === false,
			badges: sectionBadges(node),
			expandable: children.length > 0,
			parent: parentPath,
			node: node,
		});
		if (expanded) {
			appendStructureRows(tree, children, path, depth + 1);
		}
	}

	function appendPseudoRow(tree, parentNode, parentPath, listName, depth) {
		const path = parentPath.concat([{ list: listName, index: -1 }]);
		const items = Array.isArray(parentNode[listName]) ? parentNode[listName] : [];
		const expanded = treeRow(tree, path, depth, {
			label: PSEUDO_TITLES[listName],
			expandable: items.length > 0,
			parent: parentPath,
		});
		if (!expanded) {
			return;
		}
		items.forEach((node, index) => {
			appendNodeRow(tree, node, parentPath.concat([{ list: listName, index: index }]), depth + 1, path);
		});
	}

	/**
	 * Дерево структуры варианта (справа сверху) с панелью пиктограмм над ним. Клавиатура как у остальных деревьев
	 * редактора: ↑ ↓ Home End — соседний узел, → раскрывает (у раскрытого — к первому ребёнку), ← сворачивает (иначе — к
	 * родителю), Delete — удалить узел. Выбор узла перерисовывает вкладку — фокус остаётся на его строке.
	 */
	function renderStructureTree(host, settings, variantName) {
		host.appendChild(structureToolbar(settings, variantName));
		structureRows = [];
		structureCtx = { variantName: variantName };
		const tree = el('div', 'dcs-tree dcs-setv-tree');
		tree.setAttribute('role', 'tree');
		tree.setAttribute('aria-label', 'Структура варианта');
		const rootChildren = Array.isArray(settings.structure) ? settings.structure : [];
		const expanded = treeRow(tree, [], 0, {
			label: 'Отчет',
			badges: sectionBadges(settings),
			expandable: rootChildren.length > 0,
		});
		if (expanded) {
			appendStructureRows(tree, rootChildren, [], 1);
		}
		structureDropZone(tree, settings, variantName);
		host.appendChild(tree);
		if (rootChildren.length === 0) {
			// Пустой вариант чаще всего собирают мастером: подсказка ведёт прямо к нему
			const hint = el('div', 'dcs-wizard-hint');
			hint.appendChild(el('span', '', 'Структура пуста.'));
			const start = el('button', 'ghost-btn dcs-btn-small', 'Собрать структуру конструктором');
			start.type = 'button';
			start.addEventListener('click', () => {
				startSettingsWizard(variantName);
			});
			hint.appendChild(keyed(start, focusKey(['structool', 'wizard'])));
			host.appendChild(hint);
		}
	}

	/**
	 * «Доступные поля» панелей «Выбранные поля», «Отбор» и «Сортировка» по id зоны дерева: поле, брошенное на дерево
	 * структуры, узнаётся по ключу строки (settingsFieldsLayout ставит запись на каждой отрисовке; на экране — одна панель).
	 */
	const settingsAvailNodes = new Map();

	/** Поле, по которому можно группировать: поле набора, вычисляемое, параметр, системное; не ресурс и без запрета группировки. */
	function groupableField(node) {
		return settingsPickable(node) && node.kind !== 'total' && !(node.restrict && node.restrict.group);
	}

	/**
	 * Перенос мышью в дереве структуры: узел переставляется среди соседей того же родителя — та же правка
	 * dcs/move-structure-item с новым номером, что у «Переместить узел выше» и «ниже», только сразу на место. К другому
	 * родителю (между «Строками» и «Колонками», в другую группировку) операция узел не переносит: над такими строками нет
	 * ни линии, ни сброса, курсор — «нельзя». После ответа выбран и в фокусе переставленный узел. Линия «после» раскрытого
	 * узла — под его последним видимым потомком: узел встанет за всем его содержимым.
	 * Поле из «Доступных полей» панели узла, брошенное на «Отчет», группировку или список таблицы (диаграммы), открывает то
	 * же окно «Новая группировка», что пиктограмма «Новая группировка…» при этом выбранном узле, с отмеченным полем.
	 * Сводки строк (по ключу, родитель, номер) собираются при первом обращении за перенос, а не на каждой отрисовке.
	 */
	function structureDropZone(tree, settings, variantName) {
		const rows = structureRows;
		let info = null;
		const infoOf = () => {
			if (!info) {
				// По ключу строки: строка, ключ родителя, номер среди строк, последний видимый потомок
				info = { byKey: new Map(), parent: new Map(), at: new Map(), last: new Map() };
				rows.forEach((row, at) => {
					info.byKey.set(row.key, row);
					info.at.set(row.key, at);
					info.parent.set(row.key, row.path.length > 0 ? pathKey(row.path.slice(0, -1)) + '\n' + row.path[row.path.length - 1].list : '');
				});
			}
			return info;
		};
		const rowOf = (key) => (key === null || key === undefined ? null : infoOf().byKey.get(key) || null);
		const fieldOf = (payload) => {
			const resolve = settingsAvailNodes.get(payload.zone);
			const node = resolve ? resolve(payload.key) : null;
			return groupableField(node) ? node : null;
		};
		const prefix = focusKey(['node', '']);
		const from = {
			struct: (payload, spot) => {
				const source = rowOf(payload.key);
				const target = rowOf(spot.key);
				if (!source || !target) {
					return false;
				}
				const last = source.path[source.path.length - 1];
				const parent = nodeAt(settings, source.path.slice(0, -1));
				const count = parent && Array.isArray(parent[last.list]) ? parent[last.list].length : 0;
				const to = dropIndex(count, last.index, target.path[target.path.length - 1].index, spot.place);
				if (to === last.index) {
					return false;
				}
				if (moveNode(variantName, source.path, to)) {
					// Строку нажали мышью: после ответа фокус — на ней, на новом месте
					replyFocus.structure = true;
				}
				return undefined;
			},
		};
		// Куда узел сброса принимает группировку (addTarget), по ключу — раз за перенос
		let targets = null;
		const targetOf = (row) => {
			if (!targets) {
				targets = new Map();
			}
			if (!targets.has(row.key)) {
				targets.set(row.key, addTarget(settings, row.path));
			}
			return targets.get(row.key);
		};
		// Поле из «Доступных полей» — окно новой группировки в узле сброса, как пиктограмма при этом выбранном узле
		const fieldDrop = (payload, spot) => {
			const field = fieldOf(payload);
			const target = rowOf(spot.key);
			const place = target ? targetOf(target) : null;
			if (!field || !place) {
				return false;
			}
			openAddGroupDialog(settings, variantName, place, field.path);
			return undefined;
		};
		for (const panel of ['selection', 'filter', 'order']) {
			from['setavail:' + panel] = fieldDrop;
		}
		dragZone(tree, {
			id: 'struct',
			scope: 'settings',
			keyOf: (item) => {
				const key = item.getAttribute('data-dcs-key');
				return key && key.indexOf(prefix) === 0 ? key.slice(prefix.length) : null;
			},
			drag: (key) => {
				const row = rowOf(key);
				return row && structureMovable(row) ? 'node' : '';
			},
			pick: (key) => {
				const row = rowOf(key);
				if (row) {
					selectNode(row.path);
				}
			},
			accept: (payload) => payload.zone === 'struct' || fieldOf(payload) !== null,
			rowAccept: (payload, key) => {
				const target = rowOf(key);
				if (!target) {
					return false;
				}
				if (payload.zone !== 'struct') {
					return targetOf(target) !== null;
				}
				const source = rowOf(payload.key);
				return Boolean(source && structureMovable(target)) && infoOf().parent.get(source.key) === infoOf().parent.get(target.key);
			},
			place: (payload) => (payload.zone === 'struct' ? 'line' : 'into'),
			effect: (payload) => (payload.zone === 'struct' ? 'move' : 'copy'),
			markRow: (key, place) => {
				const at = place === 'after' ? infoOf().at.get(key) : undefined;
				const row = at === undefined ? null : rows[at];
				if (!row || !row.expanded) {
					return null;
				}
				const ends = infoOf().last;
				if (!ends.has(key)) {
					let end = at;
					while (end + 1 < rows.length && isUnderPath(rows[end + 1].path, row.path)) {
						end += 1;
					}
					ends.set(key, end);
				}
				// Строки дерева — дети контейнера в том же порядке, что structureRows
				return ends.get(key) > at ? tree.children[ends.get(key)] || null : null;
			},
			from: from,
		});
	}

	/** Узел структуры, который переставляется: не «Отчет» и не списки таблицы и диаграммы. */
	function structureMovable(row) {
		return Boolean(row.node) && row.path.length > 0 && !isPseudoPath(row.path);
	}

	/** Раскрыть или свернуть узел дерева. Свёрнутый узел забирает выделение у скрытого внутри него. */
	function toggleStructureNode(path, open, focus) {
		const key = pathKey(path);
		if (open) {
			uiState.expanded.add(key);
		} else {
			uiState.expanded.delete(key);
			if (isUnderPath(uiState.nodePath, path)) {
				uiState.nodePath = path;
			}
		}
		if (focus) {
			uiState.nodePath = path;
			focusStructureRow = true;
		}
		renderContent();
	}

	function onStructureKey(event, key) {
		if (event.defaultPrevented) {
			return;
		}
		const index = structureRows.findIndex((row) => row.key === key);
		const row = structureRows[index];
		if (!row) {
			return;
		}
		let target = null;
		if (event.key === 'ArrowDown') {
			target = structureRows[Math.min(structureRows.length - 1, index + 1)];
		} else if (event.key === 'ArrowUp') {
			target = structureRows[Math.max(0, index - 1)];
		} else if (event.key === 'Home') {
			target = structureRows[0];
		} else if (event.key === 'End') {
			target = structureRows[structureRows.length - 1];
		} else if (event.key === 'ArrowRight') {
			event.preventDefault();
			if (row.expandable && !row.expanded) {
				toggleStructureNode(row.path, true, true);
				return;
			}
			if (row.expanded && structureRows[index + 1]) {
				target = structureRows[index + 1];
			} else {
				return;
			}
		} else if (event.key === 'ArrowLeft') {
			event.preventDefault();
			if (row.expanded) {
				toggleStructureNode(row.path, false, true);
				return;
			}
			target = structureRows.find((candidate) => candidate.key === row.parentKey) || null;
			if (!target) {
				return;
			}
		} else if (event.key === 'Delete') {
			event.preventDefault();
			// «Отчет» и списки таблицы и диаграммы не удаляются — как у кнопки «Удалить узел»
			if (row.node && row.path.length > 0 && !isPseudoPath(row.path)) {
				removeNode(structureCtx.variantName, row.path, row.node, true);
			} else {
				settingsNotice('Удалить узел', NODE_FIXED_NOTE);
			}
			return;
		} else {
			return;
		}
		event.preventDefault();
		if (target.key === key) {
			return;
		}
		focusStructureRow = true;
		selectNode(target.path);
	}

	/** Контекст добавления узла: куда и какие виды можно добавить при выделении или в узел nodePath; null — некуда. */
	function addTarget(settings, nodePath) {
		const path = nodePath || uiState.nodePath;
		if (isPseudoPath(path)) {
			// В списках таблицы и диаграммы живут только группы
			return { parentPath: path.slice(0, -1), list: path[path.length - 1].list, kinds: ['group'] };
		}
		const kind = nodeKindAt(settings, path);
		if (kind === 'root' || kind === 'group') {
			const insideTableChart = path.some((step) => step.list !== 'structure');
			return {
				parentPath: path,
				list: 'structure',
				kinds: insideTableChart ? ['group'] : ['group', 'table', 'chart'],
			};
		}
		return null;
	}

	const ADD_NODE_NOTE = 'Недоступно: узлы добавляются в «Отчет», в группировку и в списки таблицы и диаграммы.';
	const ADD_GROUP_ONLY_NOTE = 'Недоступно: в таблице и диаграмме бывают только группировки.';
	const NODE_PICK_NOTE = 'Недоступно: выберите группировку, таблицу или диаграмму.';
	const NODE_FIXED_NOTE = 'Недоступно: «Отчет» и списки таблицы и диаграммы не удаляются.';

	/**
	 * Панель пиктограмм над деревом структуры: новая группировка, таблица и диаграмма — то, что допустимо в выделенном
	 * узле, — выше, ниже, удалить. Недоступная команда остаётся в обходе Tab, щелчок по ней называет причину.
	 */
	function structureToolbar(settings, variantName) {
		const target = addTarget(settings);
		const path = uiState.nodePath;
		const node = path.length > 0 && !isPseudoPath(path) ? nodeAt(settings, path) : null;
		let index = -1;
		let count = 0;
		if (node) {
			const last = path[path.length - 1];
			const parent = nodeAt(settings, path.slice(0, -1));
			const siblings = parent && Array.isArray(parent[last.list]) ? parent[last.list] : [];
			index = last.index;
			count = siblings.length;
		}
		const addNote = (kind) => (!target ? ADD_NODE_NOTE : target.kinds.indexOf(kind) < 0 ? ADD_GROUP_ONLY_NOTE : '');
		const addKind = (kind) => {
			if (!addStructureItem(settings, variantName, target, kind, undefined)) {
				setStatus(BUSY, true);
			}
		};
		const tools = [
			{ id: 'group', icon: 'group', name: 'Новая группировка…', note: addNote('group'), run: () => openAddGroupDialog(settings, variantName, target) },
			{ id: 'table', icon: 'table', name: 'Новая таблица', note: addNote('table'), run: () => addKind('table') },
			{ id: 'chart', icon: 'chart', name: 'Новая диаграмма', note: addNote('chart'), run: () => addKind('chart') },
			{
				id: 'up',
				icon: 'up',
				name: 'Переместить узел выше',
				note: !node ? NODE_PICK_NOTE : index === 0 ? 'Недоступно: узел уже первый.' : '',
				run: () => moveNode(variantName, path, index - 1),
			},
			{
				id: 'down',
				icon: 'down',
				name: 'Переместить узел ниже',
				note: !node ? NODE_PICK_NOTE : index >= count - 1 ? 'Недоступно: узел уже последний.' : '',
				run: () => moveNode(variantName, path, index + 1),
			},
			{ id: 'delete', icon: 'delete', name: 'Удалить узел', shortcut: 'Delete', danger: true, note: node ? '' : NODE_FIXED_NOTE, run: () => removeNode(variantName, path, node) },
		];
		const bar = el('div', 'dcs-list-toolbar');
		for (const tool of tools) {
			const button = iconButton({
				icon: tool.icon,
				name: tool.name,
				shortcut: tool.shortcut,
				note: tool.note,
				unavailable: Boolean(tool.note),
				className: tool.danger ? 'ghost-btn dcs-btn-small dcs-btn-danger' : undefined,
				onClick: () => {
					if (tool.note) {
						settingsNotice(tool.name, tool.note);
					} else {
						tool.run();
					}
				},
			});
			bar.appendChild(keyed(button, focusKey(['structool', tool.id])));
		}
		return bar;
	}

	/** Шлёт добавление узла; после сохранения выделение перейдёт на новый узел. */
	function addStructureItem(settings, variantName, target, kind, groupFields) {
		const payload = { parentPath: target.parentPath, list: target.list };
		if (target.list === 'structure') {
			// В остальных списках вид элемента предрешён — kind допустим только в structure
			payload.kind = kind;
		}
		if (groupFields && groupFields.length > 0) {
			payload.groupFields = groupFields;
		}
		if (!send('dcs/add-structure-item', { variant: variantName, payload: payload })) {
			return false;
		}
		const parent = nodeAt(settings, target.parentPath);
		const siblings = parent && Array.isArray(parent[target.list]) ? parent[target.list] : [];
		pendingSelect = target.parentPath.concat([{ list: target.list, index: siblings.length }]);
		return true;
	}

	/**
	 * Окно «Новая группировка» в target (addTarget). preset — поле, брошенное мышью на узел дерева структуры: его флажок
	 * уже отмечен (поля нет в списке — оно в «Других полях»); остальное — как у пиктограммы «Новая группировка…».
	 */
	function openAddGroupDialog(settings, variantName, target, preset) {
		const known = settingsFieldPaths();
		const boxes = [];
		const presetKey = preset ? fieldTreeKey(preset) : '';
		const presetKnown = Boolean(preset) && known.some((fieldPath) => fieldTreeKey(fieldPath) === presetKey);
		let extraInput;
		openDialog(
			'Новая группировка',
			'Добавить',
			(body) => {
				const noFieldsHint = 'Без полей группировка выводит детальные записи.';
				if (known.length > 0) {
					groupTitle(body, 'Поля группировки');
					const listEl = el('div', 'dcs-check-list');
					listEl.setAttribute('role', 'group');
					listEl.setAttribute('aria-label', 'Поля группировки');
					setHint(listEl, noFieldsHint);
					for (const fieldPath of known) {
						const box = checkbox(fieldPath, presetKnown && fieldTreeKey(fieldPath) === presetKey);
						boxes.push({ name: fieldPath, input: box.input });
						listEl.appendChild(box.wrap);
					}
					body.appendChild(listEl);
				}
				extraInput = formRow(body, 'Другие поля', textInput(preset && !presetKnown ? preset : ''));
				extraInput.placeholder = 'через запятую';
				if (known.length === 0) {
					setHint(extraInput, noFieldsHint);
				}
				// Запятая и пробел не входят в путь: подсказка берёт сегмент после последней запятой сама
				attachFieldList(extraInput, 'group');
			},
			() => {
				const fields = boxes.filter((box) => box.input.checked).map((box) => box.name);
				for (const raw of extraInput.value.split(',')) {
					const fieldPath = raw.trim();
					if (fieldPath && fields.indexOf(fieldPath) < 0) {
						fields.push(fieldPath);
					}
				}
				const groupFields = fields.map((fieldPath) => ({
					field: fieldPath,
					groupType: 'Items',
					periodAdditionType: 'None',
				}));
				if (!addStructureItem(settings, variantName, target, 'group', groupFields)) {
					return BUSY;
				}
				return undefined;
			}
		);
	}

	/** Перестановка узла среди соседей (кнопки и перенос мышью); true — правка ушла, после ответа выбран узел. */
	function moveNode(variantName, path, newIndex) {
		if (!send('dcs/move-structure-item', { variant: variantName, payload: { path: path, newIndex: newIndex } })) {
			setStatus(BUSY, true);
			return false;
		}
		const last = path[path.length - 1];
		pendingSelect = path.slice(0, -1).concat([{ list: last.list, index: newIndex }]);
		return true;
	}

	/** Удаление узла с подтверждением; fromTree — клавишей Delete в дереве: после ответа фокус — на строке родителя. */
	function removeNode(variantName, path, node, fromTree) {
		const descendants = countDescendants(node);
		let question = 'Удалить узел «' + nodeLabel(node) + '»?';
		if (descendants > 0) {
			question += ' Вместе с ним удалятся вложенные узлы: ' + descendants + '.';
		}
		confirmRemove(question, () => {
			if (!send('dcs/remove-structure-item', { variant: variantName, payload: { path: path } })) {
				return BUSY;
			}
			pendingSelect = path.slice(0, -1);
			replyFocus.structure = Boolean(fromTree);
			return undefined;
		});
	}

	// ---------- панели выбранного узла ----------

	/** Подпись узла в строке «Настройки: …» над вкладками — как у конфигуратора «Настройки: Отчет». */
	function nodeCaption(settings, path) {
		if (path.length === 0) {
			return 'Отчет';
		}
		if (isPseudoPath(path)) {
			return PSEUDO_TITLES[path[path.length - 1].list] || '';
		}
		const node = nodeAt(settings, path);
		return node ? nodeLabel(node) : '';
	}

	/**
	 * Низ вкладки «Настройки» на всю ширину: строка «Настройки: <узел>» и вкладки узла в порядке
	 * конфигуратора. Полоса вкладок — role tablist с одной остановкой Tab: ← → Home End переключают вкладку, фокус
	 * остаётся на ярлыке после перерисовки.
	 */
	function renderNodePanels(host, settings, variantName) {
		const path = uiState.nodePath;
		const captionText = 'Настройки: ' + nodeCaption(settings, path);
		host.appendChild(nameEl('div', 'dcs-setv-caption', captionText));
		if (isPseudoPath(path)) {
			host.appendChild(
				el(
					'div',
					'dcs-plate',
					'Колонки, строки, точки и серии настраиваются на своих группах: добавьте группу кнопкой «Новая группировка…» над деревом или выберите её в дереве.'
				)
			);
			return;
		}
		const node = nodeAt(settings, path);
		const kind = nodeKindAt(settings, path);
		if (kind === 'nestedObject') {
			host.appendChild(el('div', 'dcs-plate', 'Вложенный отчёт: настройки хранятся в его схеме и здесь не редактируются.'));
			return;
		}
		const panels = NODE_PANELS.filter((panel) => panel.kinds.indexOf(kind) >= 0);
		if (!panels.some((panel) => panel.id === uiState.panel)) {
			uiState.panel = panels.some((panel) => panel.id === DEFAULT_NODE_PANEL) ? DEFAULT_NODE_PANEL : panels[0].id;
		}
		const strip = el('nav', 'tabs dcs-subtabs');
		strip.setAttribute('role', 'tablist');
		strip.setAttribute('aria-label', captionText);
		const body = el('div', 'dcs-panel');
		body.setAttribute('role', 'tabpanel');
		body.id = 'dcsNodePanel';
		panels.forEach((panel, index) => {
			const active = panel.id === uiState.panel;
			const button = el('button', 'tab' + (active ? ' active' : ''), panel.title);
			button.type = 'button';
			button.id = 'dcsNodeTab-' + panel.id;
			button.setAttribute('role', 'tab');
			button.setAttribute('aria-selected', String(active));
			button.tabIndex = active ? 0 : -1;
			if (active) {
				button.setAttribute('aria-controls', body.id);
				body.setAttribute('aria-labelledby', button.id);
			}
			keyed(button, focusKey(['subtab', panel.id]));
			button.addEventListener('click', () => {
				pickNodePanel(panel.id, false);
			});
			button.addEventListener('keydown', (event) => {
				if (event.defaultPrevented) {
					return;
				}
				const last = panels.length - 1;
				let to = -1;
				if (event.key === 'ArrowRight') {
					to = index === last ? 0 : index + 1;
				} else if (event.key === 'ArrowLeft') {
					to = index === 0 ? last : index - 1;
				} else if (event.key === 'Home') {
					to = 0;
				} else if (event.key === 'End') {
					to = last;
				}
				if (to < 0) {
					return;
				}
				event.preventDefault();
				pickNodePanel(panels[to].id, true);
			});
			strip.appendChild(button);
		});
		host.appendChild(strip);
		// Область — в документе до отрисовки: фокус, который ставит отрисовка списка, у неподключённого узла пропал бы
		host.appendChild(body);
		const active = panels.find((panel) => panel.id === uiState.panel);
		active.render(body, node, path, variantName);
		// Во вкладке нет элементов управления (пользовательских полей нет — только текст): область сама встаёт в обход Tab,
		// иначе Tab с полосы вкладок перескочил бы её, и читалка в режиме фокуса до текста не дошла бы
		if (body.querySelectorAll(FOCUSABLE).length === 0) {
			body.tabIndex = 0;
		}
	}

	/** Смена вкладки узла; focus — с клавиатуры: фокус переходит на ярлык до перерисовки и остаётся на нём после. */
	function pickNodePanel(id, focus) {
		if (focus) {
			focusKeyed(focusKey(['subtab', id]));
		}
		if (id === uiState.panel) {
			return;
		}
		clearReplyFocus();
		uiState.panel = id;
		renderContent();
	}

	// ---------- списки панелей «Выбранные поля», «Отбор», «Сортировка»: доступные поля слева, список справа ----------

	/** Узлы «Доступных полей» раздела: тот же каталог, что у подсказки поля в окнах «Добавить поле…» (settings:<раздел>). */
	function settingsFieldNodes(section) {
		return completionCatalog('settings:' + section).nodes;
	}

	/** Ограничение реквизитов, которое действует в разделе (как у подсказки поля): выбранные поля, отбор, сортировка. */
	const SETTINGS_ATTRIBUTE_FLAGS = { selection: 'field', filter: 'condition', order: 'order' };

	/**
	 * Посчитанные реквизиты по типу «Доступных полей» на раздел: {catalog, stamp, model, index — узлы каталога по пути,
	 * entries — уровень по пути поля, fieldIndex — поля наборов по пути для вывода типа}. Новый каталог (модель, вариант,
	 * словарь) или новое описание (describeStamp) сбрасывают уровни: вкладка перерисовывается на каждую правку, а вывод
	 * типа поля набора-запроса разбирает его текст.
	 */
	const settingsTypeCaches = new Map();
	/** Раскрытое поле «Доступных полей» ждёт описания: ответ describeType перерисует вкладку «Настройки». */
	let settingsTypeWaiting = false;

	/**
	 * Реквизиты по типу узла «Доступных полей» раздела «Настроек» (как в конфигураторе: Контрагент → Контрагент.ИНН):
	 * {children, pending} или null — узел по типу не раскрывается (папка, ресурс, системное и
	 * пользовательское поле; виды — как у конструктора настроек, WIZARD_TYPE_KINDS). Тот же расчёт, что у конструктора
	 * (typeAttributeLevel), с ограничением реквизитов раздела.
	 */
	function settingsTypeLevel(section, node) {
		if (!node || WIZARD_TYPE_KINDS.indexOf(node.kind) < 0) {
			return null;
		}
		const catalog = completionCatalog('settings:' + section);
		let cache = settingsTypeCaches.get(section);
		if (!cache || cache.catalog !== catalog || cache.stamp !== describeStamp) {
			const fieldIndex = cache && cache.model === model ? cache.fieldIndex : new Map();
			cache = { catalog: catalog, stamp: describeStamp, model: model, index: null, entries: new Map(), fieldIndex: fieldIndex };
			settingsTypeCaches.set(section, cache);
		}
		const key = wizardKey(node.path);
		const known = cache.entries.get(key);
		if (known) {
			return known;
		}
		let chain = node.typeChain || null;
		if (!chain) {
			// Узлы каталога от корня до поля — по префиксам пути: у каталога есть узел на каждый префикс
			if (!cache.index) {
				cache.index = wizardNodeIndex(catalog);
			}
			chain = [];
			let prefix = '';
			for (const segment of String(node.path).split('.')) {
				prefix = prefix ? prefix + '.' + segment : segment;
				const found = cache.index.get(wizardKey(prefix));
				if (!found) {
					chain = [];
					break;
				}
				chain.push(found);
			}
		}
		const entry = typeAttributeLevel(node, chain, 'settings:' + section, SETTINGS_ATTRIBUTE_FLAGS[section], cache.fieldIndex);
		cache.entries.set(key, entry);
		return entry;
	}

	/** Выбирается полем: поле набора, вычисляемое, ресурс, параметр данных, системное и пользовательское; не папка и не узел пути. */
	function settingsPickable(node) {
		return Boolean(node) && WIZARD_PICK_KINDS.indexOf(node.kind) >= 0;
	}

	const SETTINGS_PICK_NOTE = 'Выберите поле в «Доступных полях» (не папку).';
	const LIST_EMPTY_NOTE = 'Недоступно: список пуст.';
	const LIST_NO_ROW_NOTE = 'Недоступно: строка не выбрана.';
	/** Элементы управления в строке списка: их щелчки и клавиши — свои, а не строки. */
	const ROW_CONTROL_TAGS = ['INPUT', 'SELECT', 'OPTION', 'BUTTON', 'TEXTAREA'];

	/**
	 * Раскладка панелей «Выбранные поля», «Отбор» и «Сортировка»: слева дерево «Доступные поля» раздела
	 * (общий компонент fieldTree, тот же, что у «Ресурсов»), посередине «>», справа список панели (spec.list). «>», Enter и
	 * двойной щелчок по полю — spec.onAdd(узел); по папке — подсказка, что выбрать. Перенос мышью: поле из дерева
	 * тащат в список (settingsListDrop), строку списка, брошенную на дерево, удаляют — spec.onRemove(ключ строки), как
	 * пиктограмма «Удалить».
	 * spec: {id, title, addTitle, note(узел) — пометка строки дерева, onAdd(узел), onRemove(ключ строки),
	 * list(host, avail)} — avail: {zone — id зоны дерева, node(ключ) — выбираемый узел строки или null}.
	 */
	function settingsFieldsLayout(host, spec) {
		// Колонки — в документе до отрисовки списка: он ставит фокус на строку после удаления клавишей
		const layout = host.appendChild(el('div', 'dcs-setv-fields'));
		const left = layout.appendChild(el('div', 'dcs-setv-col'));
		left.appendChild(el('div', 'dcs-qd-col-head', 'Доступные поля'));
		let addBtn = null;
		const sync = (node) => {
			if (addBtn) {
				setTransferState(addBtn, spec.addTitle, !settingsPickable(node), settingsPickable(node) ? '' : SETTINGS_PICK_NOTE);
			}
		};
		const add = (node) => {
			if (!settingsPickable(node)) {
				settingsNotice(spec.title, SETTINGS_PICK_NOTE);
				return;
			}
			spec.onAdd(node);
		};
		const tree = fieldTree(left, {
			label: 'Доступные поля',
			nodes: settingsFieldNodes(spec.id),
			state: settingsAvailUi[spec.id],
			keyPrefix: 'setavail-' + spec.id,
			empty: 'Полей нет: здесь будут поля наборов, вычисляемые поля и ресурсы.',
			note: (node) => {
				const notes = [];
				if (node.kind === 'total') {
					notes.push('ресурс');
				}
				const own = settingsPickable(node) ? spec.note(node) : '';
				if (own) {
					notes.push(own);
				}
				return notes.join(', ');
			},
			pickable: settingsPickable,
			onActivate: add,
			onSelect: sync,
			// Реквизиты ссылочных полей по типу, как в конфигураторе: раскрытие читает описания объектов
			typeChildren: (node) => settingsTypeLevel(spec.id, node),
			requestTypes: (pending) => {
				settingsTypeWaiting = true;
				requestDescriptions(pending);
			},
			drag: {
				id: 'setavail:' + spec.id,
				scope: 'settings',
				from: { ['setlist:' + spec.id]: (payload) => spec.onRemove(payload.key) },
			},
		});
		const moves = transferButtons(layout, [{ label: '>', title: spec.addTitle, onClick: () => add(tree.selected()) }]);
		addBtn = keyed(moves.buttons[0], focusKey(['setmove', spec.id]));
		sync(tree.selected());
		const nodeOf = (key) => {
			const node = tree.nodeOf(key);
			return settingsPickable(node) ? node : null;
		};
		// Поле, брошенное на дерево структуры, узнаётся тем же деревом (structureDropZone)
		settingsAvailNodes.set('setavail:' + spec.id, nodeOf);
		spec.list(layout.appendChild(el('div', 'dcs-setv-col')), { zone: 'setavail:' + spec.id, node: nodeOf });
	}

	/**
	 * Перенос мышью в списке панели «Выбранные поля», «Отбор» или «Сортировка» — spec.drop у settingsListGrid. Поле
	 * из «Доступных полей» встаёт в место сброса тем же действием, что «>» (h.add с местом), строка списка переставляется,
	 * в том числе в папку или группу и из неё (h.move — та же правка списка целиком, что у ↑ ↓). Папка и группа (h.container)
	 * принимают сброс и «в строку» — последним в неё; остальные строки — до и после, а «после» папки с вложенными — первым в
	 * неё, там, где видна линия (listDropSlot). Брошенное на шапку или над первой строкой встаёт первым, под строками —
	 * последним на верхнем уровне. h: {add(узел, slot), move(адрес, slot), container?(элемент)}; slot — listDropSlot;
	 * items — дерево элементов списка; avail — от settingsFieldsLayout.
	 * Перенос в папку и из неё без мыши — пиктограммы «Вынести из папки» и «Перенести в папку выше» (та же h.move).
	 */
	function settingsListDrop(panelId, avail, items, h) {
		const posOf = (key) => (key === null || key === undefined ? null : JSON.parse(key));
		const slotOf = (target) => listDropSlot(items, posOf(target.key), target.place, h.container);
		return {
			kind: () => 'item',
			from: {
				[avail.zone]: (payload, target) => {
					const node = avail.node(payload.key);
					return node ? h.add(node, slotOf(target)) : false;
				},
				['setlist:' + panelId]: (payload, target) => h.move(posOf(payload.key), slotOf(target)),
			},
			place: (payload, key) => (key !== null && h.container && h.container(selItemAt(items, posOf(key))) ? 'both' : 'line'),
			effect: (payload) => (payload.zone === avail.zone ? 'copy' : 'move'),
		};
	}

	/** Ключ состояния списка панели: вариант, путь узла и панель. */
	function listStateKey(variantName, path, panelId) {
		return variantName + '\n' + pathKey(path) + '\n' + panelId;
	}

	function posKey(pos) {
		return JSON.stringify(pos);
	}

	/** Запомнить строку списка; после ответа правки выбрана она (номер — запасной, если адреса больше нет). */
	function rememberListRow(stateKey, pos, index) {
		if (!pos || pos.length === 0) {
			settingsListUi.delete(stateKey);
			return;
		}
		settingsListUi.set(stateKey, { key: posKey(pos), index: index === undefined ? Number.MAX_SAFE_INTEGER : index });
	}

	/**
	 * Снять выбор строки (Escape в списке, щелчок мимо строк, Ctrl+щелчок по выбранной): новый элемент встанет на верхний
	 * уровень. index — строка, которая остаётся остановкой Tab.
	 */
	function clearListRow(stateKey, index) {
		settingsListUi.set(stateKey, { key: '', index: index, none: true });
	}

	/**
	 * Номер выбранной строки среди видимых: по адресу, иначе по запомненному номеру (у края — последняя); без строк и со
	 * снятым выбором −1.
	 */
	function listSelection(stateKey, rows) {
		if (rows.length === 0) {
			return -1;
		}
		const saved = settingsListUi.get(stateKey);
		if (!saved) {
			return 0;
		}
		if (saved.none) {
			return -1;
		}
		const at = rows.findIndex((row) => posKey(row.pos) === saved.key);
		return at >= 0 ? at : Math.max(0, Math.min(saved.index, rows.length - 1));
	}

	/**
	 * Строки списка по дереву элементов: папки выбранных полей и группы отбора раскрыты всегда. {pos, depth, item, first,
	 * last, container — папка или группа с вложенными (у строки aria-expanded)}.
	 */
	function flattenItems(items, nested) {
		const out = [];
		const walk = (listItems, prefix, depth) => {
			listItems.forEach((item, index) => {
				const pos = prefix.concat([index]);
				const inner = nested(item) && Array.isArray(item.items) ? item.items : [];
				out.push({ pos: pos, depth: depth, item: item, first: index === 0, last: index === listItems.length - 1, container: inner.length > 0 });
				if (inner.length > 0) {
					walk(inner, pos, depth + 1);
				}
			});
		};
		walk(items, [], 0);
		return out;
	}

	/** Список, в котором лежит элемент по адресу pos, без правки исходного дерева. */
	function levelItems(items, pos) {
		let listRef = items;
		for (let i = 0; i < pos.length - 1; i++) {
			const owner = listRef[pos[i]];
			listRef = owner && Array.isArray(owner.items) ? owner.items : [];
		}
		return listRef;
	}

	/**
	 * Куда встаёт новый элемент: в выбранную папку (группу условий) последним, иначе — последним на уровне выбранной
	 * строки; без выбора (списка нет или выбор снят Escape) — в конец верхнего уровня. Результат — адрес владельца
	 * ([] — верхний уровень).
	 */
	function insertionParent(row, isContainer) {
		if (!row) {
			return [];
		}
		return isContainer(row.item) ? row.pos : row.pos.slice(0, -1);
	}

	/**
	 * Пояснение у команд добавления, когда новый элемент встанет не на верхний уровень: куда и как добавить на верхний.
	 * ownerName(элемент) — «папку «Суммы»», «группу «ИЛИ»».
	 */
	function insertionNote(row, isContainer, items, ownerName) {
		const parentPos = insertionParent(row, isContainer);
		if (parentPos.length === 0) {
			return '';
		}
		return 'Встанет в ' + ownerName(selItemAt(items, parentPos)) + '. На верхний уровень — после Esc в списке.';
	}

	/** Строка, которая будет выбрана после удаления pos: следующая на месте удалённой, иначе предыдущая, иначе владелец. */
	function posAfterRemoval(items, pos) {
		const index = pos[pos.length - 1];
		if (index + 1 < levelItems(items, pos).length) {
			return pos;
		}
		if (index > 0) {
			return pos.slice(0, -1).concat([index - 1]);
		}
		return pos.slice(0, -1);
	}

	/** Слова команд уровня: папка выбранных полей и группа условий отбора. */
	const LEVEL_WORDS = Object.freeze({
		folder: Object.freeze({
			out: 'Вынести из папки',
			into: 'Перенести в папку выше',
			notInside: 'Недоступно: строка не в папке.',
			noOwner: 'Недоступно: над строкой на её уровне нет папки.',
		}),
		group: Object.freeze({
			out: 'Вынести из группы',
			into: 'Перенести в группу выше',
			notInside: 'Недоступно: строка не в группе.',
			noOwner: 'Недоступно: над строкой на её уровне нет группы.',
		}),
	});

	/**
	 * Пиктограммы уровня над списком с папками (группами): «Вынести из папки» — сразу за её строкой на уровень выше,
	 * «Перенести в папку выше» — последним в папку прямо над строкой. Тот же перенос (itemsMove → правка списка целиком),
	 * что сброс строки мышью: без них перенос в папку и из неё был бы только мышью (WCAG 2.5.7). move(строка, slot).
	 */
	function listLevelTools(items, container, words, noRow, move) {
		const outSlot = (row) => itemsOutdentSlot(items, row.pos);
		const intoSlot = (row) => itemsIndentSlot(items, row.pos, container);
		return [
			{ id: 'outdent', icon: 'outdent', name: words.out, state: (row) => (!row ? noRow() : outSlot(row) ? '' : words.notInside), run: (row) => move(row, outSlot(row)) },
			{ id: 'indent', icon: 'indent', name: words.into, state: (row) => (!row ? noRow() : intoSlot(row) ? '' : words.noOwner), run: (row) => move(row, intoSlot(row)) },
		];
	}

	/** Причина, по которой строку нельзя сдвинуть (пусто — можно). */
	function listMoveNote(row, delta, place) {
		if (!row) {
			return LIST_EMPTY_NOTE;
		}
		if (delta < 0 && row.first) {
			return 'Недоступно: строка уже первая' + (row.depth > 0 ? ' в ' + place : '') + '.';
		}
		if (delta > 0 && row.last) {
			return 'Недоступно: строка уже последняя' + (row.depth > 0 ? ' в ' + place : '') + '.';
		}
		return '';
	}

	/**
	 * Панель пиктограмм над списком панели узла. tools: [{id, icon, name, shortcut?, danger?, hint? — пояснение: строка или
	 * функция выбранной строки (куда встанет новый элемент), state?(строка) — причина недоступности или '', run(строка)}].
	 * Состояние пересчитывается при выборе строки без перерисовки (sync); недоступная команда остаётся в обходе Tab, щелчок
	 * по ней называет причину.
	 */
	function settingsListToolbar(host, panelId, tools) {
		const bar = el('div', 'dcs-list-toolbar');
		let selected = null;
		const hintOf = (tool, row) => (typeof tool.hint === 'function' ? tool.hint(row) : tool.hint || '');
		const buttons = tools.map((tool) => {
			const node = iconButton({
				icon: tool.icon,
				name: tool.name,
				shortcut: tool.shortcut,
				note: hintOf(tool, null),
				className: tool.danger ? 'ghost-btn dcs-btn-small dcs-btn-danger' : undefined,
				onClick: () => {
					const note = tool.state ? tool.state(selected) : '';
					if (note) {
						settingsNotice(tool.name, note);
						return;
					}
					tool.run(selected);
				},
			});
			bar.appendChild(keyed(node, focusKey(['nodetool', panelId, tool.id])));
			return node;
		});
		host.appendChild(bar);
		return {
			sync: (row) => {
				selected = row;
				tools.forEach((tool, index) => {
					const note = tool.state ? tool.state(row) : '';
					setIconState(buttons[index], tool.name, tool.shortcut, Boolean(note), note || hintOf(tool, row));
				});
			},
		};
	}

	/**
	 * Список панели узла — сетка с одной остановкой Tab, как таблица ресурсов: строка выбирается щелчком и стрелками
	 * (↑ ↓ Home End), Enter и двойной щелчок — окно строки, пробел — флажок «Использовать», Delete — удаление. Флажок,
	 * выпадающий список и кнопка строки — в обходе Tab только у выбранной строки. Выбор не перерисовывает список, панель
	 * пиктограмм узнаёт о нём через onSelect. Папки и группы — строки с отступом (treegrid, aria-level), раскрыты всегда.
	 * Выбор снимается Escape, щелчком мимо строк и Ctrl+щелчком по выбранной (onSelect(null)): тогда новый элемент встаёт
	 * на верхний уровень, а остановкой Tab остаётся строка, на которой был фокус. В дереве (treegrid) у папки и группы с
	 * вложенными aria-expanded, ← ведёт к владельцу, → — к первому вложенному. Имя строки для читалки — rowLabel(row) и
	 * «не используется» у снятого флажка: иначе она прочла бы ячейки подряд (имя поля дважды), а флажок — без состояния.
	 * spec: {id, label, tree, headers, rows, stateKey, cells(tr, row, controls), rowLabel(row), useLabel(row),
	 * onUse(row, checked) → отправлено ли, editable(row), onEdit(row), onDelete(row, fromGrid), onSelect(row), empty,
	 * drop? — перенос мышью (settingsListDrop): зона — колонка списка host целиком, строку тащат за ячейку имени (в строке
	 * флажок, список и кнопка), строка, которую тащили, выбирается, как щелчком}.
	 * Возвращает {selected(), pick(ключ строки) — выбрать строку, как щелчком}.
	 */
	function settingsListGrid(host, spec) {
		if (spec.rows.length === 0) {
			emptyNote(host, spec.empty);
			if (spec.drop) {
				// Пустой список — тоже зона: поле из «Доступных полей» встаёт первым
				tableDropZone(host, { id: 'setlist:' + spec.id, scope: 'settings', head: null, keys: null, from: spec.drop.from, place: spec.drop.place, effect: spec.drop.effect });
			}
			if (focusListPanel === spec.stateKey) {
				// Удалена последняя строка: фокус — на «Удалить», она есть всегда (без строк — недоступна с причиной)
				focusListPanel = '';
				focusKeyed(focusKey(['nodetool', spec.id, 'delete']));
			}
			return { selected: () => null, pick: () => {} };
		}
		const wrap = el('div', 'dcs-table-wrap dcs-setv-scroll');
		const table = el('table', 'dcs-table dcs-setv-grid');
		table.setAttribute('role', spec.tree ? 'treegrid' : 'grid');
		table.setAttribute('aria-label', spec.label);
		const thead = document.createElement('thead');
		const head = document.createElement('tr');
		head.setAttribute('role', 'row');
		spec.headers.forEach((title, index) => {
			const th = el('th', index === 0 ? 'dcs-cell-check' : '', title);
			th.setAttribute('role', 'columnheader');
			if (index === 0) {
				th.setAttribute('aria-label', 'Использовать');
			} else if (!title) {
				th.setAttribute('aria-label', 'Команды строки');
			}
			head.appendChild(th);
		});
		thead.appendChild(head);
		table.appendChild(thead);
		const tbody = document.createElement('tbody');
		const trs = [];
		const controls = [];
		// Строка → её адрес (posKey): ключ переноса мышью
		const dragKeys = new WeakMap();
		let current = listSelection(spec.stateKey, spec.rows);
		// Остановка Tab: выбранная строка, а без выбора — строка, на которой его сняли
		const saved = settingsListUi.get(spec.stateKey);
		let stop = current >= 0 ? current : Math.max(0, Math.min(saved && typeof saved.index === 'number' ? saved.index : 0, spec.rows.length - 1));
		const paint = () => {
			trs.forEach((tr, at) => {
				const on = at === current;
				tr.classList.toggle('dcs-tree-selected', on);
				tr.setAttribute('aria-selected', String(on));
				tr.tabIndex = at === stop ? 0 : -1;
				for (const control of controls[at]) {
					control.tabIndex = on ? 0 : -1;
				}
			});
		};
		const setStop = (index, focus) => {
			current = index;
			stop = index;
			rememberListRow(spec.stateKey, spec.rows[index].pos, index);
			paint();
			if (focus) {
				focusGridRow(trs[index]);
			}
			spec.onSelect(spec.rows[index]);
		};
		const clearSelection = (index) => {
			if (current < 0) {
				return;
			}
			current = -1;
			stop = index;
			clearListRow(spec.stateKey, index);
			paint();
			spec.onSelect(null);
		};
		spec.rows.forEach((row, index) => {
			const tr = document.createElement('tr');
			tr.setAttribute('role', 'row');
			if (spec.tree) {
				tr.setAttribute('aria-level', String(row.depth + 1));
				if (row.container) {
					// Папки и группы раскрыты всегда: читалка слышит, что у строки есть вложенные
					tr.setAttribute('aria-expanded', 'true');
				}
			}
			tr.setAttribute('aria-label', spec.rowLabel(row) + (row.item.use === false ? ', не используется' : ''));
			if (row.item.use === false) {
				tr.className = 'dcs-row-off';
			}
			const rowKey = posKey(row.pos);
			keyed(tr, focusKey(['setrow', spec.id, rowKey]));
			const own = [];
			const checkTd = el('td', 'dcs-cell-check');
			checkTd.setAttribute('role', 'gridcell');
			const box = el('input', 'edit-check');
			box.type = 'checkbox';
			box.checked = row.item.use !== false;
			box.setAttribute('aria-label', 'Использовать: ' + spec.useLabel(row));
			keyed(box, focusKey(['setuse', spec.id, rowKey]));
			box.addEventListener('change', () => {
				if (!spec.onUse(row, box.checked)) {
					box.checked = !box.checked;
				}
			});
			checkTd.appendChild(box);
			tr.appendChild(checkTd);
			own.push(box);
			spec.cells(tr, row, own);
			if (spec.editable(row)) {
				actionsCell(tr, [
					{ svg: 'edit', title: 'Править', key: focusKey(['setedit', spec.id, rowKey]), onClick: () => spec.onEdit(row) },
				]);
				own.push(tr.children[tr.children.length - 1].children[0]);
			} else {
				cell(tr, '', 'dcs-cell-actions');
			}
			// Перенос мышью — за ячейку имени: строке только атрибут у ячейки и ключ в WeakMap, слушатели — у документа
			if (spec.drop) {
				dragKeys.set(tr, rowKey);
				if (spec.drop.kind(row) && tr.children[1]) {
					tr.children[1].draggable = true;
				}
			}
			for (const td of tr.children) {
				td.setAttribute('role', 'gridcell');
			}
			tr.addEventListener('click', (event) => {
				if (event.target === tr || event.target.tagName === 'TD') {
					// Ctrl+щелчок по выбранной строке снимает выбор, как в списках Windows
					if ((event.ctrlKey || event.metaKey) && current === index) {
						clearSelection(index);
					} else {
						setStop(index, false);
					}
				}
			});
			// Фокус в флажок или кнопку строки пришёл щелчком: остановка Tab переезжает в эту строку. Фокус на самой строке
			// при снятом выборе (Tab, возврат фокуса после перерисовки) выбор не возвращает
			tr.addEventListener('focusin', (event) => {
				if (current !== index && !(current < 0 && event.target === tr)) {
					setStop(index, false);
				}
			});
			tr.addEventListener('dblclick', (event) => {
				// Двойной щелчок по флажку, направлению или кнопке строки — их собственное действие, не окно строки
				if (ROW_CONTROL_TAGS.indexOf(event.target.tagName) >= 0) {
					return;
				}
				if (spec.editable(row)) {
					spec.onEdit(row);
				}
			});
			tr.addEventListener('keydown', (event) => {
				if (event.target !== tr || event.defaultPrevented) {
					return;
				}
				let to = -1;
				if (event.key === 'ArrowDown') {
					to = Math.min(spec.rows.length - 1, index + 1);
				} else if (event.key === 'ArrowUp') {
					to = Math.max(0, index - 1);
				} else if (event.key === 'Home') {
					to = 0;
				} else if (event.key === 'End') {
					to = spec.rows.length - 1;
				} else if (event.key === 'ArrowLeft' && spec.tree && row.depth > 0) {
					// К владельцу: папке или группе, в которой лежит строка
					const owner = posKey(row.pos.slice(0, -1));
					to = spec.rows.findIndex((candidate) => posKey(candidate.pos) === owner);
				} else if (event.key === 'ArrowRight' && spec.tree && row.container) {
					to = index + 1;
				} else if (event.key === 'Escape') {
					// Без выбора Escape не наш: его разбирают окна выше
					if (current < 0) {
						return;
					}
					event.preventDefault();
					clearSelection(index);
					return;
				} else if (event.key === 'Enter' || event.key === ' ' || event.key === 'Delete') {
					event.preventDefault();
					// Выбор снят: клавиша действует на строку с фокусом и выбирает её, панель пиктограмм — за ней
					if (current !== index) {
						setStop(index, false);
					}
					if (event.key === 'Enter') {
						if (spec.editable(row)) {
							spec.onEdit(row);
						}
					} else if (event.key === ' ') {
						box.checked = !box.checked;
						if (!spec.onUse(row, box.checked)) {
							box.checked = !box.checked;
						}
					} else {
						spec.onDelete(row, true);
					}
					return;
				} else {
					return;
				}
				if (to < 0) {
					return;
				}
				event.preventDefault();
				setStop(to, true);
			});
			trs.push(tr);
			controls.push(own);
			tbody.appendChild(tr);
		});
		table.appendChild(tbody);
		wrap.appendChild(table);
		if (spec.drop) {
			const rowAt = (key) => spec.rows.findIndex((row) => posKey(row.pos) === key);
			tableDropZone(host, {
				id: 'setlist:' + spec.id,
				scope: 'settings',
				head: head,
				rows: () => trs,
				keys: dragKeys,
				drag: (key) => {
					const at = rowAt(key);
					return at >= 0 ? spec.drop.kind(spec.rows[at]) : '';
				},
				pick: (key) => {
					const at = rowAt(key);
					if (at >= 0) {
						setStop(at, false);
					}
				},
				from: spec.drop.from,
				place: spec.drop.place,
				effect: spec.drop.effect,
			});
		}
		// Щелчок по пустому месту под строками снимает выбор: следующий элемент встанет на верхний уровень
		wrap.addEventListener('click', (event) => {
			if (event.target === wrap || event.target === table || event.target === tbody) {
				clearSelection(stop);
			}
		});
		host.appendChild(wrap);
		if (current >= 0) {
			setStop(current, false);
		} else {
			paint();
			spec.onSelect(null);
		}
		if (focusListPanel === spec.stateKey) {
			focusListPanel = '';
			focusGridRow(trs[stop]);
		}
		return {
			selected: () => spec.rows[current] || null,
			// Строка по адресу (posKey) становится выбранной, как щелчком: до удаления сбросом на «Доступные поля»
			pick: (key) => {
				const at = spec.rows.findIndex((row) => posKey(row.pos) === key);
				if (at >= 0) {
					setStop(at, false);
				}
			},
		};
	}

	/**
	 * Фокус на строку сетки под закреплённой шапкой: строка не должна оказаться под ней (у .dcs-setv-scroll отступ
	 * прокрутки сверху — высота шапки, scrollIntoView его учитывает).
	 */
	function focusGridRow(tr) {
		tr.focus();
		if (typeof tr.scrollIntoView === 'function') {
			tr.scrollIntoView({ block: 'nearest' });
		}
	}

	/** Правка списка панели одним сообщением; занятость показывается в строке состояния. */
	function sendPanelItems(type, variantName, path, items) {
		if (!items) {
			return false;
		}
		if (!send(type, { variant: variantName, payload: { path: path, items: items } })) {
			setStatus(BUSY, true);
			return false;
		}
		return true;
	}

	/** Копия списка с переставленным элементом; за границей — null (кнопки гаснут раньше). */
	function movedCopy(items, index, delta) {
		const target = index + delta;
		if (target < 0 || target >= items.length) {
			return null;
		}
		const next = items.slice();
		const moved = next.splice(index, 1)[0];
		next.splice(target, 0, moved);
		return next;
	}

	// ---------- панель «Поля группировки» ----------

	function boundarySummary(value) {
		if (!value) {
			return '';
		}
		if (value.nil) {
			return 'Неопределено';
		}
		const raw = value.decoded !== undefined ? String(value.decoded) : value.text || '';
		if (value.type === 'xs:dateTime') {
			return raw === DCS_ZERO_DATE ? '' : raw.replace('T', ' ');
		}
		if (value.type === 'dcscor:Field') {
			return raw;
		}
		return (value.type || 'значение') + ' — в конфигураторе';
	}

	/**
	 * Редактор границы дополнения периода: не задано, дата, поле компоновки или «Неопределено».
	 * Нетронутое значение возвращается исходным объектом, значение незнакомого типа не правится.
	 */
	function boundaryEditor(body, labelText, original) {
		let mode = '';
		let initialText = '';
		if (original) {
			const raw = original.decoded !== undefined ? String(original.decoded) : original.text || '';
			if (original.nil) {
				mode = 'nil';
			} else if (original.type === 'xs:dateTime') {
				mode = raw === DCS_ZERO_DATE || raw === '' ? '' : 'date';
				initialText = mode === 'date' ? raw : '';
			} else if (original.type === 'dcscor:Field') {
				mode = 'field';
				initialText = raw;
			} else {
				mode = 'ro';
			}
		}
		if (mode === 'ro') {
			formRow(body, labelText, el('span', 'dcs-ro-note', 'Тип «' + (original.type || '?') + '» правится в конфигураторе.'));
			return {
				validate: () => undefined,
				value: () => original,
			};
		}
		const initialMode = mode;
		const modeSelect = selectInput(
			[
				{ value: '', label: 'Не задано' },
				{ value: 'date', label: 'Дата' },
				{ value: 'field', label: 'Поле компоновки' },
				{ value: 'nil', label: 'Неопределено' },
			],
			mode
		);
		const dateInput = el('input', 'edit-input');
		dateInput.type = 'datetime-local';
		dateInput.step = '1';
		if (mode === 'date') {
			dateInput.value = initialText.slice(0, 19);
		}
		const fieldInput = textInput(mode === 'field' ? initialText : '');
		setHint(fieldInput, 'Граница-поле видна пользователю, если параметр включён в доступные поля.');
		const wrap = el('div', 'dcs-bound');
		wrap.appendChild(modeSelect);
		wrap.appendChild(dateInput);
		// Пара «поле + ⋯» в одну строку: колонка .dcs-bound иначе унесла бы кнопку под поле
		const fieldPair = el('div', 'dcs-complete-pair');
		fieldPair.appendChild(fieldInput);
		wrap.appendChild(fieldPair);
		formRow(body, labelText, wrap);
		attachFieldList(fieldInput);
		function refresh() {
			dateInput.classList.toggle('hidden', modeSelect.value !== 'date');
			fieldInput.classList.toggle('hidden', modeSelect.value !== 'field');
			fieldPair.classList.toggle('hidden', modeSelect.value !== 'field');
		}
		modeSelect.addEventListener('change', refresh);
		refresh();
		function dateLexical() {
			let value = dateInput.value;
			if (value.length === 16) {
				value += ':00';
			}
			return value;
		}
		function unchanged() {
			if (modeSelect.value !== initialMode) {
				return false;
			}
			if (initialMode === 'date') {
				return dateLexical() === initialText;
			}
			if (initialMode === 'field') {
				return fieldInput.value.trim() === initialText;
			}
			return true;
		}
		return {
			validate: () => {
				if (modeSelect.value === 'date' && !dateInput.value) {
					return 'укажите дату';
				}
				if (modeSelect.value === 'field' && !fieldInput.value.trim()) {
					return 'укажите поле';
				}
				return undefined;
			},
			value: () => {
				if (unchanged()) {
					return original;
				}
				if (modeSelect.value === 'date') {
					return { type: 'xs:dateTime', decoded: dateLexical() };
				}
				if (modeSelect.value === 'field') {
					return { type: 'dcscor:Field', decoded: fieldInput.value.trim() };
				}
				if (modeSelect.value === 'nil') {
					return { nil: true };
				}
				return undefined;
			},
		};
	}

	function renderGroupFieldsPanel(host, node, path, variantName) {
		const items = Array.isArray(node.groupFields) ? node.groupFields : [];
		listToolbar(host, [
			{
				icon: 'add',
				name: 'Добавить поле…',
				key: focusKey(['nodetool', 'groupFields', 'add']),
				onClick: () => {
					openGroupFieldDialog(variantName, path, items, null, -1);
				},
			},
		]);
		if (items.length === 0) {
			host.appendChild(el('div', 'dcs-plate', 'Полей группировки нет: группировка выводит детальные записи.'));
		} else {
			const tbody = dataTable(host, ['Поле', 'Тип группировки', 'Дополнение периода', 'Начало', 'Конец', '']);
			const dragKeys = new WeakMap();
			const trs = [];
			const thead = tbody.parentElement.children[0];
			// Перенос мышью: поле переставляется за ячейку имени той же правкой, что «Выше» и «Ниже» (копия списка со
			// сдвигом на любое число строк). Зона — таблица целиком, шапка ставит первым
			tableDropZone(tbody.parentElement.parentElement, {
				id: 'setgrpf',
				scope: 'settings',
				head: thead && thead.tagName === 'THEAD' ? thead.children[0] : null,
				rows: () => trs,
				keys: dragKeys,
				drag: () => 'field',
				from: {
					setgrpf: (payload, target) => {
						const from = Number(payload.key);
						const to = dropIndex(items.length, from, target.key === null ? -1 : Number(target.key), target.place);
						if (to === from) {
							return false;
						}
						const moved = movedCopy(items, from, to - from);
						if (sendPanelItems('dcs/set-group-fields', variantName, path, moved)) {
							// Ячейку имени фокус не берёт: после ответа он — на «Править» переставленного поля (ключ — по полю)
							const name = moved[to].field || '<Авто>';
							const nth = moved.slice(0, to + 1).filter((item) => (item.field || '<Авто>') === name).length;
							replyFocus.fallback = focusKey(['grpf', 'edit', name, String(nth)]);
						}
						return undefined;
					},
				},
			});
			// Ключи фокуса: «Править», «Выше» и «Ниже» — по полю (фокус идёт за переставленной строкой), «Удалить» — по
			// номеру (фокус встаёт на ту же кнопку у строки, занявшей место удалённой)
			const seen = {};
			const deleteKey = (at) => focusKey(['grpf', 'delete', String(at)]);
			items.forEach((item, index) => {
				const name = item.field || '<Авто>';
				seen[name] = (seen[name] || 0) + 1;
				const own = (action) => focusKey(['grpf', action, name, String(seen[name])]);
				const firstNote = index === 0 ? 'Недоступно: поле уже первое.' : '';
				const lastNote = index === items.length - 1 ? 'Недоступно: поле уже последнее.' : '';
				const tr = document.createElement('tr');
				// Ручка переноса — ячейка имени: у строки только атрибут, слушатели — у документа
				cell(tr, name).draggable = true;
				dragKeys.set(tr, String(index));
				trs.push(tr);
				cell(tr, groupTypeLabel(item.groupType));
				cell(tr, periodAdditionLabel(item.periodAdditionType));
				cell(tr, boundarySummary(item.periodAdditionBegin));
				cell(tr, boundarySummary(item.periodAdditionEnd));
				actionsCell(tr, [
					{
						svg: 'edit',
						title: 'Править',
						key: own('edit'),
						onClick: () => {
							openGroupFieldDialog(variantName, path, items, item, index);
						},
					},
					{
						svg: 'up',
						title: 'Выше',
						key: own('up'),
						// У края — недоступна, но в обходе Tab: фокус, переехавший сюда со строкой, не пропадает
						unavailable: Boolean(firstNote),
						note: firstNote,
						onClick: () => {
							if (firstNote) {
								settingsNotice('Выше', firstNote);
							} else {
								sendPanelItems('dcs/set-group-fields', variantName, path, movedCopy(items, index, -1));
							}
						},
					},
					{
						svg: 'down',
						title: 'Ниже',
						key: own('down'),
						unavailable: Boolean(lastNote),
						note: lastNote,
						onClick: () => {
							if (lastNote) {
								settingsNotice('Ниже', lastNote);
							} else {
								sendPanelItems('dcs/set-group-fields', variantName, path, movedCopy(items, index, 1));
							}
						},
					},
					{
						svg: 'delete',
						title: 'Удалить',
						danger: true,
						key: deleteKey(index),
						onClick: () => {
							const next = items.slice();
							next.splice(index, 1);
							if (sendPanelItems('dcs/set-group-fields', variantName, path, next)) {
								rowRemovalFocus(deleteKey, index, focusKey(['nodetool', 'groupFields', 'add']));
							}
						},
					},
				]);
				tbody.appendChild(tr);
			});
		}
	}

	function openGroupFieldDialog(variantName, path, items, original, index) {
		const item = original || {};
		let fieldInput;
		let typeSelect;
		let periodSelect;
		let beginEditor;
		let endEditor;
		openDialog(
			original ? 'Поле группировки «' + (item.field || '') + '»' : 'Новое поле группировки',
			original ? 'Сохранить' : 'Добавить',
			(body) => {
				fieldInput = formRow(body, 'Поле', textInput(item.field));
				attachFieldList(fieldInput, 'group');
				typeSelect = formRow(body, 'Тип группировки', selectInput(GROUP_TYPE_OPTIONS, item.groupType || 'Items'));
				periodSelect = formRow(
					body,
					'Дополнение периода',
					selectInput(periodAdditionOptions(), item.periodAdditionType || 'None')
				);
				beginEditor = boundaryEditor(body, 'Начало дополнения', item.periodAdditionBegin);
				endEditor = boundaryEditor(body, 'Конец дополнения', item.periodAdditionEnd);
			},
			() => {
				const field = fieldInput.value.trim();
				if (!field) {
					return 'Укажите поле.';
				}
				const beginError = beginEditor.validate();
				if (beginError) {
					return 'Начало дополнения: ' + beginError + '.';
				}
				const endError = endEditor.validate();
				if (endError) {
					return 'Конец дополнения: ' + endError + '.';
				}
				const value = { field: field, groupType: typeSelect.value, periodAdditionType: periodSelect.value };
				const begin = beginEditor.value();
				if (begin !== undefined) {
					value.periodAdditionBegin = begin;
				}
				const end = endEditor.value();
				if (end !== undefined) {
					value.periodAdditionEnd = end;
				}
				const next = items.slice();
				if (original) {
					next[index] = value;
				} else {
					next.push(value);
				}
				if (!send('dcs/set-group-fields', { variant: variantName, payload: { path: path, items: next } })) {
					return BUSY;
				}
				return undefined;
			}
		);
	}

	// ---------- панель «Выбранные поля» ----------

	function selItemAt(items, pos) {
		let listRef = items;
		for (let i = 0; i < pos.length - 1; i++) {
			listRef = listRef[pos[i]].items;
		}
		return listRef[pos[pos.length - 1]];
	}

	/** Список, в котором лежит элемент по адресу pos; у папки без вложений список создаётся. */
	function selListAt(items, pos) {
		let listRef = items;
		for (let i = 0; i < pos.length - 1; i++) {
			const owner = listRef[pos[i]];
			if (!Array.isArray(owner.items)) {
				owner.items = [];
			}
			listRef = owner.items;
		}
		return listRef;
	}

	function countSelItems(items) {
		let count = 0;
		for (const item of items) {
			count += 1 + (Array.isArray(item.items) ? countSelItems(item.items) : 0);
		}
		return count;
	}

	function selItemName(item) {
		if (item.kind === 'auto') {
			return '<Авто>';
		}
		if (item.kind === 'folder') {
			return 'Папка';
		}
		return item.field || '';
	}

	/** Пути полей списка элементов (с папками) без учёта регистра — пометка «выбрано» в «Доступных полях». */
	function takenFieldKeys(items, fieldOf) {
		const keys = new Set();
		const walk = (listItems) => {
			for (const item of listItems) {
				const field = fieldOf(item);
				if (field) {
					keys.add(fieldTreeKey(field));
				}
				if (Array.isArray(item.items)) {
					walk(item.items);
				}
			}
		};
		walk(items);
		return keys;
	}

	const SEL_AUTO_HINT = 'Состав элемента «Авто» наследуется от родителя.';

	/** Имя строки «Выбранных полей» для читалки: поле и заголовок, папка — заголовком и расположением. */
	function selRowLabel(item) {
		if (item.kind === 'folder') {
			return 'Папка' + (item.title ? ' «' + item.title + '»' : '') + ', расположение: ' + placementLabel(item.placement || 'Auto').toLowerCase();
		}
		if (item.kind === 'auto') {
			return 'Авто';
		}
		return (item.field || '') + (item.title ? ', заголовок «' + item.title + '»' : '');
	}

	/**
	 * «Выбранные поля» как в конфигураторе: слева «Доступные поля», посередине «>», справа список с
	 * флажками, «<Авто>» и папками, над ним пиктограммы: добавить поле (окно), «Авто», папка, удалить, выше, ниже, вынести
	 * из папки, в папку выше. Новый элемент встаёт в выбранную папку, иначе — последним на уровне выбранной строки, и после
	 * ответа выбран он.
	 */
	function renderSelectionPanel(host, node, path, variantName) {
		const items = sectionItems(node.selection);
		const stateKey = listStateKey(variantName, path, 'selection');
		const sendItems = (next) => sendPanelItems('dcs/set-selection', variantName, path, next);
		const isFolder = (item) => item.kind === 'folder';
		const taken = takenFieldKeys(items, (item) => (item.kind === 'field' ? item.field : ''));
		let grid = null;
		// Новый элемент в место slot (itemsDropSlot): «>», «Авто» и сброс поля мышью — одна правка; после ответа выбран он
		const addAt = (slot, fresh) => {
			const made = itemsInsert(items, slot, fresh);
			if (sendItems(made.items)) {
				rememberListRow(stateKey, made.pos);
			}
		};
		const addItem = (row, fresh) => {
			const parentPos = insertionParent(row, isFolder);
			addAt(itemsDropSlot(items, parentPos, 'into'), fresh);
		};
		// Перенос строки, в том числе в папку и из неё: копия списка с перенесённой строкой, выбор — за ней. Мышью (toList)
		// фокус после ответа — на строке, пиктограммами «Вынести из папки» и «В папку выше» — остаётся на кнопке, как у ↑ ↓
		const moveAt = (from, slot, toList) => {
			const made = slot ? itemsMove(items, from, slot) : null;
			if (!made) {
				return false;
			}
			if (sendItems(made.items)) {
				rememberListRow(stateKey, made.pos);
				if (toList) {
					replyFocus.list = stateKey;
				}
			}
			return undefined;
		};
		const edit = (row) => {
			if (row.item.kind === 'folder') {
				openSelFolderDialog(variantName, path, items, row.item, row.pos, null);
			} else if (row.item.kind === 'field') {
				openSelFieldDialog(variantName, path, items, row.item, row.pos, null);
			}
		};
		const remove = (row, fromGrid) => {
			const after = posAfterRemoval(items, row.pos);
			removeSelItem(items, row.item, row.pos, sendItems, () => {
				rememberListRow(stateKey, after);
				if (fromGrid) {
					replyFocus.list = stateKey;
				}
			});
		};
		settingsFieldsLayout(host, {
			id: 'selection',
			title: 'Выбранные поля',
			addTitle: 'Добавить выбранное поле',
			note: (field) => (taken.has(fieldTreeKey(field.path)) ? 'выбрано' : ''),
			onAdd: (field) => addItem(grid.selected(), { kind: 'field', field: field.path }),
			// Строка, брошенная на «Доступные поля», удаляется, как клавишей Delete в списке: сначала она выбрана (папка с
			// вложенными — с вопросом; после отмены выбрана она, и пиктограммы действуют на неё)
			onRemove: (key) => {
				const pos = JSON.parse(key);
				grid.pick(key);
				remove({ pos: pos, item: selItemAt(items, pos) }, true);
			},
			list: (right, avail) => {
				const folderOf = (row) => {
					const parentPos = insertionParent(row, isFolder);
					return parentPos.length > 0 ? parentPos : null;
				};
				const noRow = () => (items.length > 0 ? LIST_NO_ROW_NOTE : LIST_EMPTY_NOTE);
				const where = (row) => insertionNote(row, isFolder, items, (folder) => 'папку' + (folder.title ? ' «' + folder.title + '»' : ''));
				const toolbar = settingsListToolbar(right, 'selection', [
					{ id: 'add', icon: 'add', name: 'Добавить поле…', hint: where, run: (row) => openSelFieldDialog(variantName, path, items, null, null, folderOf(row)) },
					{ id: 'auto', icon: 'auto', name: 'Добавить «Авто»', hint: (row) => [SEL_AUTO_HINT, where(row)].filter(Boolean).join(' '), run: (row) => addItem(row, { kind: 'auto' }) },
					{ id: 'folder', icon: 'folder', name: 'Добавить папку…', hint: where, run: (row) => openSelFolderDialog(variantName, path, items, null, null, folderOf(row)) },
					{ id: 'delete', icon: 'delete', name: 'Удалить', shortcut: 'Delete', danger: true, state: (row) => (row ? '' : noRow()), run: (row) => remove(row, false) },
					{ id: 'up', icon: 'up', name: 'Переместить выше', state: (row) => (row ? listMoveNote(row, -1, 'папке') : noRow()), run: (row) => moveSelRow(row, -1) },
					{ id: 'down', icon: 'down', name: 'Переместить ниже', state: (row) => (row ? listMoveNote(row, 1, 'папке') : noRow()), run: (row) => moveSelRow(row, 1) },
					...listLevelTools(items, isFolder, LEVEL_WORDS.folder, noRow, (row, slot) => moveAt(row.pos, slot, false)),
				]);
				const moveSelRow = (row, delta) => {
					if (moveSelItem(items, row.pos, delta, sendItems)) {
						rememberListRow(stateKey, row.pos.slice(0, -1).concat([row.pos[row.pos.length - 1] + delta]));
					}
				};
				grid = settingsListGrid(right, {
					id: 'selection',
					label: 'Выбранные поля',
					tree: true,
					headers: ['', 'Поле / элемент', 'Заголовок', 'Расположение', ''],
					rows: flattenItems(items, isFolder),
					stateKey: stateKey,
					cells: (tr, row) => {
						const item = row.item;
						const nameTd = cell(tr, selItemName(item));
						nameTd.style.paddingLeft = 8 + row.depth * 18 + 'px';
						if (item.kind === 'auto') {
							nameTd.title = 'Состав наследуется от родителя';
						}
						cell(tr, item.title || '');
						cell(tr, item.kind === 'folder' ? placementLabel(item.placement || 'Auto') : '');
					},
					rowLabel: (row) => selRowLabel(row.item),
					useLabel: (row) => (row.item.kind === 'folder' && row.item.title ? 'Папка «' + row.item.title + '»' : selItemName(row.item)),
					onUse: (row, checked) => {
						const next = cloneItems(items);
						const ref = selItemAt(next, row.pos);
						if (checked) {
							delete ref.use;
						} else {
							ref.use = false;
						}
						return sendItems(next);
					},
					editable: (row) => row.item.kind === 'field' || row.item.kind === 'folder',
					onEdit: edit,
					onDelete: remove,
					onSelect: (row) => toolbar.sync(row),
					empty: 'Выбранных полей нет: выберите поле в «Доступных полях» и нажмите «>».',
					drop: settingsListDrop('selection', avail, items, {
						add: (field, slot) => addAt(slot, { kind: 'field', field: field.path }),
						move: (from, slot) => moveAt(from, slot, true),
						container: isFolder,
					}),
				});
				toolbar.sync(grid.selected());
			},
		});
	}

	/** Сдвиг элемента в пределах его уровня; true — правка ушла. */
	function moveSelItem(original, pos, delta, sendItems) {
		const next = cloneItems(original);
		const listRef = selListAt(next, pos);
		const index = pos[pos.length - 1];
		const target = index + delta;
		if (target < 0 || target >= listRef.length) {
			return false;
		}
		const moved = listRef.splice(index, 1)[0];
		listRef.splice(target, 0, moved);
		return Boolean(sendItems(next));
	}

	/** Удаление элемента (папки с вложенными — после подтверждения); onSent — когда правка ушла. */
	function removeSelItem(original, item, pos, sendItems, onSent) {
		function apply() {
			const next = cloneItems(original);
			const listRef = selListAt(next, pos);
			listRef.splice(pos[pos.length - 1], 1);
			if (!sendItems(next)) {
				return BUSY;
			}
			if (onSent) {
				onSent();
			}
			return undefined;
		}
		const nested = item.kind === 'folder' && Array.isArray(item.items) ? countSelItems(item.items) : 0;
		if (nested > 0) {
			confirmRemove(
				'Удалить папку' + (item.title ? ' «' + item.title + '»' : '') + '? Вместе с ней удалятся вложенные элементы: ' + nested + '.',
				apply
			);
			return;
		}
		apply();
	}

	function openSelFieldDialog(variantName, path, original, item, pos, folderPos) {
		const current = item || {};
		let fieldInput;
		let titleInput;
		let useBox;
		openDialog(
			item ? 'Выбранное поле «' + (current.field || '') + '»' : 'Новое выбранное поле',
			item ? 'Сохранить' : 'Добавить',
			(body) => {
				fieldInput = formRow(body, 'Поле', textInput(current.field));
				attachFieldList(fieldInput, 'selection');
				titleInput = formRow(body, 'Заголовок', textInput(current.title));
				useBox = checkbox('Использовать', current.use !== false);
				checkRow(body, [useBox]);
			},
			() => {
				const field = fieldInput.value.trim();
				if (!field) {
					return 'Укажите поле.';
				}
				const title = titleInput.value.trim();
				const next = cloneItems(original);
				if (item) {
					const ref = selItemAt(next, pos);
					ref.field = field;
					if (title) {
						ref.title = title;
					} else {
						delete ref.title;
						delete ref.titleKind;
					}
					if (useBox.input.checked) {
						delete ref.use;
					} else {
						ref.use = false;
					}
				}
				let freshPos = null;
				if (!item) {
					const fresh = { kind: 'field', field: field };
					if (title) {
						fresh.title = title;
					}
					if (!useBox.input.checked) {
						fresh.use = false;
					}
					const folder = folderPos ? selItemAt(next, folderPos) : null;
					if (folder) {
						if (!Array.isArray(folder.items)) {
							folder.items = [];
						}
						folder.items.push(fresh);
						freshPos = folderPos.concat([folder.items.length - 1]);
					} else {
						next.push(fresh);
						freshPos = [next.length - 1];
					}
				}
				if (!send('dcs/set-selection', { variant: variantName, payload: { path: path, items: next } })) {
					return BUSY;
				}
				if (freshPos) {
					// После ответа в списке выбран новый элемент
					rememberListRow(listStateKey(variantName, path, 'selection'), freshPos);
				}
				return undefined;
			}
		);
	}

	/** Окно папки выбранных полей: правка по адресу pos или новая папка — в папку folderPos (null — на верхний уровень). */
	function openSelFolderDialog(variantName, path, original, item, pos, folderPos) {
		const current = item || {};
		let titleInput;
		let placementSelect;
		let useBox;
		openDialog(
			item ? 'Папка выбранных полей' : 'Новая папка выбранных полей',
			item ? 'Сохранить' : 'Добавить',
			(body) => {
				titleInput = formRow(body, 'Заголовок', textInput(current.title));
				placementSelect = formRow(body, 'Расположение', selectInput(PLACEMENT_OPTIONS, current.placement || 'Auto'));
				useBox = checkbox('Использовать', current.use !== false);
				checkRow(body, [useBox]);
			},
			() => {
				const title = titleInput.value.trim();
				const next = cloneItems(original);
				let ref;
				let freshPos = null;
				if (item) {
					ref = selItemAt(next, pos);
				} else {
					ref = { kind: 'folder' };
					const owner = folderPos ? selItemAt(next, folderPos) : null;
					if (owner) {
						if (!Array.isArray(owner.items)) {
							owner.items = [];
						}
						owner.items.push(ref);
						freshPos = folderPos.concat([owner.items.length - 1]);
					} else {
						next.push(ref);
						freshPos = [next.length - 1];
					}
				}
				if (title) {
					ref.title = title;
				} else {
					delete ref.title;
					delete ref.titleKind;
				}
				if (placementSelect.value === 'Auto') {
					delete ref.placement;
				} else {
					ref.placement = placementSelect.value;
				}
				if (useBox.input.checked) {
					delete ref.use;
				} else {
					ref.use = false;
				}
				if (!send('dcs/set-selection', { variant: variantName, payload: { path: path, items: next } })) {
					return BUSY;
				}
				if (freshPos) {
					rememberListRow(listStateKey(variantName, path, 'selection'), freshPos);
				}
				return undefined;
			}
		);
	}

	// ---------- панель «Сортировка» ----------

	/** Нередактируемые признаки элемента сортировки — серой пометкой, как пришли. */
	function orderItemExtras(item) {
		const parts = [];
		if (item.autoOrder) {
			parts.push('авто-упорядочивание');
		}
		if (item.distinctNullValues) {
			parts.push('различать NULL');
		}
		if (item.viewMode) {
			parts.push('режим: ' + item.viewMode);
		}
		return parts.join('; ');
	}

	/** Имя строки «Сортировки» для читалки: поле, направление и нередактируемые признаки. */
	function orderRowLabel(item) {
		if (item.kind === 'auto') {
			return 'Авто';
		}
		const direction = ORDER_TYPE_OPTIONS.find((option) => option.value === (item.orderType === 'Desc' ? 'Desc' : 'Asc'));
		const extras = orderItemExtras(item);
		return (item.field || '') + ', ' + direction.label.toLowerCase() + (extras ? ', ' + extras : '');
	}

	/**
	 * «Сортировка» как в конфигураторе: слева «Доступные поля», посередине «>», справа список с флажками и
	 * направлением в строке, над ним пиктограммы: добавить поле (окно), «Авто», удалить, выше, ниже. «>» добавляет поле
	 * по возрастанию последним.
	 */
	function renderOrderPanel(host, node, path, variantName) {
		const items = sectionItems(node.order);
		const stateKey = listStateKey(variantName, path, 'order');
		const sendItems = (next) => sendPanelItems('dcs/set-order', variantName, path, next);
		const taken = takenFieldKeys(items, (item) => (item.kind === 'field' ? item.field : ''));
		let grid = null;
		// Новый элемент в место slot: «>» и «Авто» — последним, сброс поля мышью — в место сброса; после ответа выбран он
		const insertAt = (slot, fresh) => {
			const made = itemsInsert(items, slot, fresh);
			if (sendItems(made.items)) {
				rememberListRow(stateKey, made.pos);
			}
		};
		const append = (fresh) => insertAt(itemsDropSlot(items, null, 'end'), fresh);
		const move = (row, delta) => {
			const index = row.pos[0];
			if (sendItems(movedCopy(items, index, delta))) {
				rememberListRow(stateKey, [index + delta]);
			}
		};
		// Перестановка мышью — та же копия списка с перенесённой строкой, что у ↑ ↓ (сдвиг на любое число строк); фокус и
		// выбор — за строкой
		const moveAt = (from, slot) => {
			const made = itemsMove(items, from, slot);
			if (!made) {
				return false;
			}
			if (sendItems(movedCopy(items, from[0], made.pos[0] - from[0]))) {
				rememberListRow(stateKey, made.pos);
				replyFocus.list = stateKey;
			}
			return undefined;
		};
		const remove = (row, fromGrid) => {
			const next = items.slice();
			next.splice(row.pos[0], 1);
			if (sendItems(next)) {
				rememberListRow(stateKey, posAfterRemoval(items, row.pos));
				if (fromGrid) {
					replyFocus.list = stateKey;
				}
			}
		};
		settingsFieldsLayout(host, {
			id: 'order',
			title: 'Сортировка',
			addTitle: 'Добавить поле в сортировку',
			note: (field) => (taken.has(fieldTreeKey(field.path)) ? 'в сортировке' : ''),
			onAdd: (field) => append({ kind: 'field', field: field.path, orderType: 'Asc' }),
			// Как клавиша Delete: строка сначала выбрана
			onRemove: (key) => {
				const pos = JSON.parse(key);
				grid.pick(key);
				remove({ pos: pos, item: items[pos[0]] }, true);
			},
			list: (right, avail) => {
				const noRow = () => (items.length > 0 ? LIST_NO_ROW_NOTE : LIST_EMPTY_NOTE);
				const toolbar = settingsListToolbar(right, 'order', [
					{ id: 'add', icon: 'add', name: 'Добавить поле…', run: () => openOrderFieldDialog(variantName, path, items, null, -1) },
					{ id: 'auto', icon: 'auto', name: 'Добавить «Авто»', run: () => append({ kind: 'auto' }) },
					{ id: 'delete', icon: 'delete', name: 'Удалить', shortcut: 'Delete', danger: true, state: (row) => (row ? '' : noRow()), run: (row) => remove(row, false) },
					{ id: 'up', icon: 'up', name: 'Переместить выше', state: (row) => (row ? listMoveNote(row, -1, '') : noRow()), run: (row) => move(row, -1) },
					{ id: 'down', icon: 'down', name: 'Переместить ниже', state: (row) => (row ? listMoveNote(row, 1, '') : noRow()), run: (row) => move(row, 1) },
				]);
				grid = settingsListGrid(right, {
					id: 'order',
					label: 'Сортировка',
					tree: false,
					headers: ['', 'Поле', 'Направление', ''],
					rows: flattenItems(items, () => false),
					stateKey: stateKey,
					cells: (tr, row, controls) => {
						const item = row.item;
						const index = row.pos[0];
						const nameTd = cell(tr, item.kind === 'auto' ? '<Авто>' : item.field || '');
						const extras = orderItemExtras(item);
						if (extras) {
							nameTd.appendChild(el('span', 'dcs-ro-note', ' (' + extras + ')'));
						}
						const dirTd = el('td');
						if (item.kind === 'field') {
							const direction = item.orderType === 'Desc' ? 'Desc' : 'Asc';
							const dirSelect = selectInput(ORDER_TYPE_OPTIONS, direction);
							dirSelect.classList.add('dcs-row-select');
							dirSelect.setAttribute('aria-label', 'Направление: ' + (item.field || ''));
							keyed(dirSelect, focusKey(['setdir', 'order', posKey(row.pos)]));
							dirSelect.addEventListener('change', () => {
								const next = cloneItems(items);
								next[index].orderType = dirSelect.value;
								if (!sendItems(next)) {
									dirSelect.value = direction;
								}
							});
							dirTd.appendChild(dirSelect);
							controls.push(dirSelect);
						}
						tr.appendChild(dirTd);
					},
					rowLabel: (row) => orderRowLabel(row.item),
					useLabel: (row) => (row.item.kind === 'auto' ? '<Авто>' : row.item.field || ''),
					onUse: (row, checked) => {
						const next = cloneItems(items);
						if (checked) {
							delete next[row.pos[0]].use;
						} else {
							next[row.pos[0]].use = false;
						}
						return sendItems(next);
					},
					editable: (row) => row.item.kind === 'field',
					onEdit: (row) => openOrderFieldDialog(variantName, path, items, row.item, row.pos[0]),
					onDelete: remove,
					onSelect: (row) => toolbar.sync(row),
					empty: 'Порядок не задан: выберите поле в «Доступных полях» и нажмите «>».',
					drop: settingsListDrop('order', avail, items, {
						add: (field, slot) => insertAt(slot, { kind: 'field', field: field.path, orderType: 'Asc' }),
						move: moveAt,
					}),
				});
				toolbar.sync(grid.selected());
			},
		});
	}

	function openOrderFieldDialog(variantName, path, items, original, index) {
		const item = original || {};
		let fieldInput;
		let dirSelect;
		openDialog(
			original ? 'Поле сортировки «' + (item.field || '') + '»' : 'Новое поле сортировки',
			original ? 'Сохранить' : 'Добавить',
			(body) => {
				fieldInput = formRow(body, 'Поле', textInput(item.field));
				attachFieldList(fieldInput, 'order');
				dirSelect = formRow(body, 'Направление', selectInput(ORDER_TYPE_OPTIONS, item.orderType === 'Desc' ? 'Desc' : 'Asc'));
			},
			() => {
				const field = fieldInput.value.trim();
				if (!field) {
					return 'Укажите поле.';
				}
				const next = cloneItems(items);
				if (original) {
					next[index].field = field;
					next[index].orderType = dirSelect.value;
				} else {
					next.push({ kind: 'field', field: field, orderType: dirSelect.value });
				}
				if (!send('dcs/set-order', { variant: variantName, payload: { path: path, items: next } })) {
					return BUSY;
				}
				if (!original) {
					rememberListRow(listStateKey(variantName, path, 'order'), [next.length - 1]);
				}
				return undefined;
			}
		);
	}

	// ---------- словари значений настроек ----------

	/** Виды сравнения отбора: 20 лексем DataCompositionComparisonType из XSD настроек. */
	const COMPARISON_LABELS = {
		Equal: 'Равно',
		NotEqual: 'Не равно',
		Less: 'Меньше',
		LessOrEqual: 'Меньше или равно',
		Greater: 'Больше',
		GreaterOrEqual: 'Больше или равно',
		Contains: 'Содержит',
		InList: 'В списке',
		InListByHierarchy: 'В списке по иерархии',
		InHierarchy: 'В иерархии',
		NotContains: 'Не содержит',
		NotInList: 'Не в списке',
		NotInListByHierarchy: 'Не в списке по иерархии',
		NotInHierarchy: 'Не в иерархии',
		Filled: 'Заполнено',
		NotFilled: 'Не заполнено',
		BeginsWith: 'Начинается с',
		NotBeginsWith: 'Не начинается с',
		Like: 'Подобно',
		NotLike: 'Не подобно',
	};

	/** Виды сравнения без значения. */
	const NO_VALUE_COMPARISONS = ['Filled', 'NotFilled'];

	/** Виды сравнения со списком значений. */
	const LIST_COMPARISONS = ['InList', 'InListByHierarchy', 'NotInList', 'NotInListByHierarchy'];

	/** Типы групп отбора DataCompositionFilterItemsGroupType; отсутствие в файле — И. */
	const FILTER_GROUP_OPTIONS = [
		{ value: 'AndGroup', label: 'И' },
		{ value: 'OrGroup', label: 'ИЛИ' },
		{ value: 'NotGroup', label: 'НЕ' },
	];

	/** Применение отбора DataCompositionFilterApplicationType; пусто — по умолчанию платформы. */
	const APPLICATION_OPTIONS = [
		{ value: '', label: 'По умолчанию' },
		{ value: 'Items', label: 'Элементы' },
		{ value: 'Hierarchy', label: 'Иерархия' },
		{ value: 'HierarchyOnly', label: 'Только иерархия' },
	];

	/** Режимы пользовательской настройки DataCompositionSettingsItemViewMode. */
	const VIEW_MODE_LABELS = {
		Normal: 'обычный',
		QuickAccess: 'быстрый доступ',
		Inaccessible: 'недоступный',
		Auto: 'авто',
	};

	/** Варианты стандартного периода: полный enum StandardPeriodVariant из data-core XSD. */
	const STANDARD_PERIOD_LABELS = {
		Custom: 'Произвольный',
		Today: 'Сегодня',
		ThisWeek: 'Эта неделя',
		ThisTenDays: 'Эта декада',
		ThisMonth: 'Этот месяц',
		ThisQuarter: 'Этот квартал',
		ThisHalfYear: 'Это полугодие',
		ThisYear: 'Этот год',
		FromBeginningOfThisWeek: 'С начала этой недели',
		FromBeginningOfThisTenDays: 'С начала этой декады',
		FromBeginningOfThisMonth: 'С начала этого месяца',
		FromBeginningOfThisQuarter: 'С начала этого квартала',
		FromBeginningOfThisHalfYear: 'С начала этого полугодия',
		FromBeginningOfThisYear: 'С начала этого года',
		Yesterday: 'Вчера',
		LastWeek: 'Прошлая неделя',
		LastTenDays: 'Прошлая декада',
		LastMonth: 'Прошлый месяц',
		LastQuarter: 'Прошлый квартал',
		LastHalfYear: 'Прошлое полугодие',
		LastYear: 'Прошлый год',
		LastWeekTillSameWeekDay: 'Прошлая неделя до этого же дня',
		LastTenDaysTillSameDayNumber: 'Прошлая декада до этого же числа',
		LastMonthTillSameDate: 'Прошлый месяц до этой же даты',
		LastQuarterTillSameDate: 'Прошлый квартал до этой же даты',
		LastHalfYearTillSameDate: 'Прошлое полугодие до этой же даты',
		LastYearTillSameDate: 'Прошлый год до этой же даты',
		Tomorrow: 'Завтра',
		NextWeek: 'Следующая неделя',
		NextTenDays: 'Следующая декада',
		NextMonth: 'Следующий месяц',
		NextQuarter: 'Следующий квартал',
		NextHalfYear: 'Следующее полугодие',
		NextYear: 'Следующий год',
		NextWeekTillSameWeekDay: 'Следующая неделя до этого же дня',
		NextTenDaysTillSameDayNumber: 'Следующая декада до этого же числа',
		NextMonthTillSameDate: 'Следующий месяц до этой же даты',
		NextQuarterTillSameDate: 'Следующий квартал до этой же даты',
		NextHalfYearTillSameDate: 'Следующее полугодие до этой же даты',
		NextYearTillSameDate: 'Следующий год до этой же даты',
		TillEndOfThisWeek: 'До конца этой недели',
		TillEndOfThisTenDays: 'До конца этой декады',
		TillEndOfThisMonth: 'До конца этого месяца',
		TillEndOfThisQuarter: 'До конца этого квартала',
		TillEndOfThisHalfYear: 'До конца этого полугодия',
		TillEndOfThisYear: 'До конца этого года',
		Last7Days: 'Последние 7 дней',
		Next7Days: 'Следующие 7 дней',
		Month: 'Месяц',
	};

	function comparisonLabel(value) {
		return COMPARISON_LABELS[value] || value || '';
	}

	function comparisonOptions() {
		return Object.keys(COMPARISON_LABELS).map((value) => ({ value: value, label: COMPARISON_LABELS[value] }));
	}

	function viewModeLabel(value) {
		return VIEW_MODE_LABELS[value] || value || '';
	}

	function periodVariantLabel(value) {
		return STANDARD_PERIOD_LABELS[value] || value || '';
	}

	function periodVariantOptions() {
		return Object.keys(STANDARD_PERIOD_LABELS).map((value) => ({ value: value, label: STANDARD_PERIOD_LABELS[value] }));
	}

	// ---------- сводки значений ----------

	/** Лексическое значение скаляра: разобранное, иначе текст из файла. */
	function valueRaw(value) {
		return value.decoded !== undefined ? String(value.decoded) : value.text || '';
	}

	/** Сводка шрифта по атрибутам файла: имя, начертания и размер. */
	function fontSummary(attrs) {
		const parts = [];
		if (attrs.faceName || attrs.ref) {
			parts.push(attrs.faceName || attrs.ref);
		}
		if (attrs.bold === 'true') {
			parts.push('жирный');
		}
		if (attrs.italic === 'true') {
			parts.push('курсив');
		}
		if (attrs.underline === 'true') {
			parts.push('подчёркнутый');
		}
		if (attrs.strikeout === 'true') {
			parts.push('зачёркнутый');
		}
		if (attrs.height) {
			parts.push(attrs.height);
		}
		return parts.join(' ') || 'как в макете';
	}

	function shortDate(raw) {
		return raw && raw !== DCS_ZERO_DATE ? raw.replace('T', ' ') : '…';
	}

	/** Сводка одного типизированного значения; незнакомый тип показывается только подписью. */
	function valueSummary(value) {
		if (!value) {
			return '';
		}
		if (value.nil) {
			return 'Неопределено';
		}
		if (value.period) {
			let text = periodVariantLabel(value.period.variant);
			if (value.period.variant === 'Custom') {
				text += ': ' + shortDate(value.period.startDate) + ' — ' + shortDate(value.period.endDate);
			}
			return text;
		}
		if (value.beginningDate) {
			return 'Дата начала: ' + (value.beginningDate.variant || '') + (value.beginningDate.date ? ' ' + shortDate(value.beginningDate.date) : '');
		}
		if (value.list || value.type === 'v8:ValueListType') {
			const rows = value.list && Array.isArray(value.list.items) ? value.list.items : [];
			return 'Список (' + rows.length + '): ' + rows.map((row) => row.presentation || valueSummary(row.value)).join(', ');
		}
		if (value.attrs) {
			return value.type === 'v8ui:Font' ? fontSummary(value.attrs) : (value.type || 'значение') + ' — в конфигураторе';
		}
		if (value.opaque) {
			return (value.type || 'значение') + ' — в конфигураторе';
		}
		if (value.type === 'xs:boolean') {
			return valueRaw(value) === 'true' ? 'Истина' : 'Ложь';
		}
		if (value.type === 'xs:dateTime') {
			const raw = valueRaw(value);
			return raw === DCS_ZERO_DATE ? '' : raw.replace('T', ' ');
		}
		return valueRaw(value);
	}

	/** Сводка массива значений (right, value): повторы перечисляются через запятую. */
	function valuesSummary(values) {
		if (!Array.isArray(values) || values.length === 0) {
			return '';
		}
		return values.map(valueSummary).join(', ');
	}

	/** Значение правится, когда оно одно (или его нет) и тип знаком редактору. */
	function editableValues(values) {
		if (!Array.isArray(values) || values.length === 0) {
			return true;
		}
		return values.length === 1 && valueModeOf(values[0]) !== 'ro';
	}

	/** Бейдж пользовательской настройки: режим и представление показываются, но не правятся. */
	function userSettingBadge(item) {
		if (!item.userSettingID && !item.viewMode && !item.userSettingPresentation) {
			return null;
		}
		const badge = el('span', 'dcs-us-badge', 'ПН');
		const parts = [];
		if (item.viewMode) {
			parts.push('режим: ' + viewModeLabel(item.viewMode));
		}
		if (item.userSettingPresentation) {
			parts.push('представление: ' + item.userSettingPresentation);
		}
		badge.title = 'Пользовательская настройка' + (parts.length > 0 ? ' — ' + parts.join('; ') : '') + '. Здесь не редактируется.';
		return badge;
	}

	// ---------- общий редактор значения по типу ----------

	/** Контрол редактора по типу значения; ro — редактора нет, значение правится в конфигураторе. */
	function valueModeOf(value) {
		if (!value) {
			return '';
		}
		if (value.nil) {
			return 'nil';
		}
		if (value.opaque || value.attrs || value.beginningDate) {
			return 'ro';
		}
		if (value.list || value.type === 'v8:ValueListType') {
			return 'list';
		}
		if (value.period || value.type === 'v8:StandardPeriod') {
			return 'period';
		}
		if (value.type === 'xs:string') {
			return 'string';
		}
		if (value.type === 'v8:LocalStringType') {
			return 'lstring';
		}
		if (value.type === 'xs:boolean') {
			return 'boolean';
		}
		if (value.type === 'xs:decimal') {
			return 'number';
		}
		if (value.type === 'xs:dateTime') {
			return 'date';
		}
		if (value.type === 'dcscor:Field') {
			return 'field';
		}
		if (value.type === 'v8ui:Color') {
			return 'color';
		}
		return 'ro';
	}

	/** Режимы редактора значения; выбор вручную — когда тип значения неизвестен. */
	const VALUE_MODE_OPTIONS = [
		{ value: '', label: 'Не задано' },
		{ value: 'string', label: 'Строка' },
		{ value: 'number', label: 'Число' },
		{ value: 'boolean', label: 'Булево' },
		{ value: 'date', label: 'Дата' },
		{ value: 'period', label: 'Стандартный период' },
		{ value: 'field', label: 'Поле компоновки' },
		{ value: 'color', label: 'Цвет' },
		{ value: 'list', label: 'Список значений' },
		{ value: 'nil', label: 'Неопределено' },
	];

	/** Режимы простых значений: из них состоят строки списка значений. */
	const SIMPLE_VALUE_MODES = ['string', 'number', 'boolean', 'date', 'field', 'nil'];

	function dateTimeInput(initial) {
		const input = el('input', 'edit-input');
		input.type = 'datetime-local';
		input.step = '1';
		if (initial && initial !== DCS_ZERO_DATE) {
			input.value = initial.slice(0, 19);
		}
		return input;
	}

	function dateLexicalOf(input) {
		let value = input.value;
		if (value.length === 16) {
			value += ':00';
		}
		return value;
	}

	/**
	 * Общий редактор значения по типу: контрол выбирается по xsi:type существующего
	 * значения, пустое начинается с подсказанного режима или выбора типа вручную.
	 *
	 * result(): undefined — значение не менялось (нетронутое уходит назад как пришло),
	 * null — значение очищено, объект — новое значение. opts: typeHint — режим пустого значения
	 * (вместе с отсутствием значения он же включает «новое всегда собирается»), fixedMode — тип
	 * не переключается, simpleModes — только простые типы, attachFields(input) — подсказки полей,
	 * textButton(input) — кнопка у строкового поля (окно форматной строки у «Формат»): она правит
	 * только текст поля, тип значения остаётся тем, что выбран в контроле.
	 * Значение незнакомого типа не редактируется: вместо контрола — причина.
	 */
	function createValueControl(original, opts) {
		const options = opts || {};
		const initialMode = original ? valueModeOf(original) : options.typeHint || '';
		if (initialMode === 'ro') {
			const note = el('span', 'dcs-ro-note', 'Тип «' + (original.type || '?') + '» правится в конфигураторе.');
			return {
				root: note,
				readOnly: true,
				mode: () => 'ro',
				setMode: () => undefined,
				validate: () => undefined,
				result: () => undefined,
			};
		}
		const root = el('div', 'dcs-value-edit');
		const initialRaw = original && !original.nil ? valueRaw(original) : '';

		const modeOptions = [];
		for (const option of VALUE_MODE_OPTIONS) {
			if (options.simpleModes && SIMPLE_VALUE_MODES.indexOf(option.value) < 0) {
				continue;
			}
			modeOptions.push(option);
			if (option.value === 'string' && initialMode === 'lstring') {
				modeOptions.push({ value: 'lstring', label: 'Строка (локализуемая)' });
			}
		}
		const modeSelect = selectInput(modeOptions, initialMode);
		if (options.fixedMode) {
			modeSelect.classList.add('hidden');
		}
		root.appendChild(modeSelect);

		const textCtl = textInput(initialMode === 'string' || initialMode === 'lstring' ? initialRaw : '');
		// Поле с кнопкой — пара в одну строку (как «поле + ⋯»); прячется вместе с полем при смене типа
		const textBox = options.textButton ? el('div', 'dcs-complete-pair dcs-value-text-pair') : textCtl;
		if (options.textButton) {
			textBox.appendChild(textCtl);
			textBox.appendChild(options.textButton(textCtl));
		}
		root.appendChild(textBox);

		const numberCtl = el('input', 'edit-input dcs-input-number');
		numberCtl.type = 'number';
		if (initialMode === 'number') {
			numberCtl.value = initialRaw;
		}
		root.appendChild(numberCtl);

		const boolCtl = selectInput(
			[
				{ value: 'true', label: 'Истина' },
				{ value: 'false', label: 'Ложь' },
			],
			initialMode === 'boolean' && initialRaw === 'true' ? 'true' : 'false'
		);
		root.appendChild(boolCtl);

		const dateWrap = el('div', 'dcs-date-edit');
		const dateCtl = dateTimeInput(initialMode === 'date' ? initialRaw : '');
		const dateClear = el('button', 'ghost-btn dcs-btn-small', 'Очистить');
		dateClear.type = 'button';
		dateClear.title = 'Пустая дата платформы';
		dateClear.addEventListener('click', () => {
			dateCtl.value = '';
		});
		dateWrap.appendChild(dateCtl);
		dateWrap.appendChild(dateClear);
		root.appendChild(dateWrap);

		const fieldCtl = textInput(initialMode === 'field' ? initialRaw : '');
		// Пара «поле + ⋯» в одну строку: колонка редактора значения иначе унесла бы кнопку под поле.
		// Подсказка подключается, когда поле уже в паре, — кнопка встаёт рядом с ним
		const fieldPair = el('div', 'dcs-complete-pair');
		fieldPair.appendChild(fieldCtl);
		root.appendChild(fieldPair);
		if (options.attachFields) {
			options.attachFields(fieldCtl);
		}

		const initialPeriod = original && original.period ? original.period : null;
		const periodWrap = el('div', 'dcs-period-edit');
		const periodSelect = selectInput(periodVariantOptions(), initialPeriod ? initialPeriod.variant : 'Custom');
		const periodDates = el('div', 'dcs-period-dates');
		const periodStart = dateTimeInput(initialPeriod ? initialPeriod.startDate || '' : '');
		const periodEnd = dateTimeInput(initialPeriod ? initialPeriod.endDate || '' : '');
		periodDates.appendChild(periodStart);
		periodDates.appendChild(periodEnd);
		periodWrap.appendChild(periodSelect);
		periodWrap.appendChild(periodDates);
		root.appendChild(periodWrap);
		function refreshPeriod() {
			periodDates.classList.toggle('hidden', periodSelect.value !== 'Custom');
		}
		periodSelect.addEventListener('change', refreshPeriod);

		const colorWrap = el('div', 'dcs-color-edit');
		const colorInitial = initialMode === 'color' ? initialRaw : '';
		let colorKind = 'auto';
		if (/^#[0-9A-Fa-f]{6}$/.test(colorInitial)) {
			colorKind = 'hex';
		} else if (colorInitial && colorInitial !== 'auto') {
			colorKind = 'link';
		}
		const colorKindSelect = selectInput(
			[
				{ value: 'auto', label: 'Авто' },
				{ value: 'hex', label: 'Цвет' },
				{ value: 'link', label: 'Ссылка на стиль' },
			],
			colorKind
		);
		const colorPick = el('input', 'dcs-color-pick');
		colorPick.type = 'color';
		if (colorKind === 'hex') {
			colorPick.value = colorInitial;
		}
		const colorLink = textInput(colorKind === 'link' ? colorInitial : '');
		colorLink.placeholder = 'style:… / web:… / win:…';
		colorWrap.appendChild(colorKindSelect);
		colorWrap.appendChild(colorPick);
		colorWrap.appendChild(colorLink);
		root.appendChild(colorWrap);
		function refreshColor() {
			colorPick.classList.toggle('hidden', colorKindSelect.value !== 'hex');
			colorLink.classList.toggle('hidden', colorKindSelect.value !== 'link');
		}
		colorKindSelect.addEventListener('change', refreshColor);
		refreshColor();
		function colorLexical() {
			if (colorKindSelect.value === 'auto') {
				return 'auto';
			}
			if (colorKindSelect.value === 'hex') {
				return colorPick.value.toUpperCase();
			}
			return colorLink.value.trim();
		}

		// Список значений: строки «значение + представление», нетронутые уходят исходными объектами
		const listHost = el('div', 'dcs-list-edit');
		const listRows = [];
		let listStructureChanged = false;
		function addListRow(item) {
			const row = { original: item || null, removed: false };
			const rowEl = el('div', 'dcs-list-row');
			const rowMode = item ? valueModeOf(item.value) : 'string';
			if (item && (rowMode === 'ro' || rowMode === 'list' || rowMode === 'period')) {
				row.readOnly = true;
				rowEl.appendChild(el('span', 'dcs-ro-note', (valueSummary(item.value) || 'значение') + ' — правится в конфигураторе'));
				if (item.presentation) {
					rowEl.appendChild(el('span', 'dcs-ro-note', item.presentation));
				}
			} else {
				row.control = createValueControl(item ? item.value : undefined, {
					typeHint: 'string',
					simpleModes: true,
					attachFields: options.attachFields,
				});
				rowEl.appendChild(row.control.root);
				row.presentation = textInput(item && item.presentation ? item.presentation : '');
				row.presentation.placeholder = 'представление';
				rowEl.appendChild(row.presentation);
				const removeBtn = iconButton({
					icon: 'delete',
					name: 'Убрать значение',
					className: 'struct-btn struct-btn-danger',
					onClick: () => {
						row.removed = true;
						listStructureChanged = true;
						// Кнопка с фокусом уходит вместе со строкой: фокус — на «Убрать» следующей строки, иначе предыдущей,
						// иначе на «Добавить значение»
						const at = listRows.indexOf(row);
						const live = listRows.filter((other) => !other.removed && other.removeBtn);
						const neighbour = live.find((other) => listRows.indexOf(other) > at) || live.filter((other) => listRows.indexOf(other) < at).pop();
						rowEl.remove();
						(neighbour ? neighbour.removeBtn : listAdd).focus();
					},
				});
				row.removeBtn = removeBtn;
				rowEl.appendChild(removeBtn);
			}
			listRows.push(row);
			listHost.appendChild(rowEl);
		}
		const initialList = original && original.list && Array.isArray(original.list.items) ? original.list.items : [];
		for (const item of initialList) {
			addListRow(item);
		}
		const listAdd = iconButton({
			icon: 'add',
			name: 'Добавить значение',
			className: 'struct-btn',
			onClick: () => {
				listStructureChanged = true;
				addListRow(null);
			},
		});
		root.appendChild(listHost);
		root.appendChild(listAdd);
		function listChanged() {
			if (listStructureChanged) {
				return true;
			}
			return listRows.some(
				(row) =>
					!row.removed &&
					row.control &&
					(row.control.result() !== undefined ||
						row.presentation.value.trim() !== ((row.original && row.original.presentation) || ''))
			);
		}
		function listValue() {
			const items = [];
			for (const row of listRows) {
				if (row.removed) {
					continue;
				}
				if (row.readOnly || !row.control) {
					items.push(row.original);
					continue;
				}
				const value = row.control.result();
				const presentation = row.presentation.value.trim();
				if (row.original && value === undefined && presentation === (row.original.presentation || '')) {
					items.push(row.original);
					continue;
				}
				const entry = {};
				const effective = value === undefined || value === null ? row.original && row.original.value : value;
				if (effective) {
					entry.value = effective;
				}
				if (presentation) {
					entry.presentation = presentation;
				}
				items.push(entry);
			}
			return { type: 'v8:ValueListType', list: { items: items } };
		}

		const nilNote = el('span', 'dcs-ro-note', 'Неопределено');
		root.appendChild(nilNote);

		function currentMode() {
			return options.fixedMode ? initialMode : modeSelect.value;
		}
		function refreshMode() {
			const mode = currentMode();
			textCtl.classList.toggle('hidden', mode !== 'string' && mode !== 'lstring');
			if (textBox !== textCtl) {
				textBox.classList.toggle('hidden', mode !== 'string' && mode !== 'lstring');
			}
			numberCtl.classList.toggle('hidden', mode !== 'number');
			boolCtl.classList.toggle('hidden', mode !== 'boolean');
			dateWrap.classList.toggle('hidden', mode !== 'date');
			fieldCtl.classList.toggle('hidden', mode !== 'field');
			fieldPair.classList.toggle('hidden', mode !== 'field');
			periodWrap.classList.toggle('hidden', mode !== 'period');
			colorWrap.classList.toggle('hidden', mode !== 'color');
			listHost.classList.toggle('hidden', mode !== 'list');
			listAdd.classList.toggle('hidden', mode !== 'list');
			nilNote.classList.toggle('hidden', mode !== 'nil');
			refreshPeriod();
		}
		modeSelect.addEventListener('change', refreshMode);
		refreshMode();

		function normDate(raw) {
			return raw && raw !== DCS_ZERO_DATE ? raw.slice(0, 19) : '';
		}
		function unchanged(mode) {
			if (mode !== initialMode) {
				return false;
			}
			if (mode === '' || mode === 'nil') {
				return true;
			}
			if (mode === 'string' || mode === 'lstring') {
				return textCtl.value === initialRaw;
			}
			if (mode === 'number') {
				return numberCtl.value.trim() === initialRaw;
			}
			if (mode === 'boolean') {
				return boolCtl.value === (initialRaw === 'true' ? 'true' : 'false');
			}
			if (mode === 'date') {
				return dateLexicalOf(dateCtl) === normDate(initialRaw);
			}
			if (mode === 'field') {
				return fieldCtl.value.trim() === initialRaw;
			}
			if (mode === 'color') {
				return colorLexical().toLowerCase() === initialRaw.toLowerCase();
			}
			if (mode === 'period') {
				if (!initialPeriod || periodSelect.value !== initialPeriod.variant) {
					return false;
				}
				if (periodSelect.value !== 'Custom') {
					return true;
				}
				return (
					dateLexicalOf(periodStart) === normDate(initialPeriod.startDate) &&
					dateLexicalOf(periodEnd) === normDate(initialPeriod.endDate)
				);
			}
			if (mode === 'list') {
				return !listChanged();
			}
			return true;
		}
		function build(mode) {
			if (mode === 'nil') {
				return { nil: true };
			}
			if (mode === 'string') {
				return { type: 'xs:string', decoded: textCtl.value };
			}
			if (mode === 'lstring') {
				return { type: 'v8:LocalStringType', decoded: textCtl.value };
			}
			if (mode === 'number') {
				return { type: 'xs:decimal', decoded: Number(numberCtl.value) };
			}
			if (mode === 'boolean') {
				return { type: 'xs:boolean', decoded: boolCtl.value === 'true' };
			}
			if (mode === 'date') {
				return { type: 'xs:dateTime', decoded: dateLexicalOf(dateCtl) || DCS_ZERO_DATE };
			}
			if (mode === 'field') {
				return { type: 'dcscor:Field', decoded: fieldCtl.value.trim() };
			}
			if (mode === 'color') {
				return { type: 'v8ui:Color', decoded: colorLexical() };
			}
			if (mode === 'period') {
				const period = { variant: periodSelect.value };
				if (period.variant === 'Custom') {
					period.startDate = dateLexicalOf(periodStart) || DCS_ZERO_DATE;
					period.endDate = dateLexicalOf(periodEnd) || DCS_ZERO_DATE;
				}
				return { type: 'v8:StandardPeriod', period: period };
			}
			if (mode === 'list') {
				return listValue();
			}
			// режим «не задано» — значение очищено
			return null;
		}
		return {
			root: root,
			readOnly: false,
			mode: currentMode,
			setMode: function (mode) {
				if (!options.fixedMode) {
					modeSelect.value = mode;
					refreshMode();
				}
			},
			validate: function () {
				const mode = currentMode();
				if (mode === 'number' && (numberCtl.value.trim() === '' || !Number.isFinite(Number(numberCtl.value)))) {
					return 'укажите число';
				}
				if (mode === 'field' && fieldCtl.value.trim() === '') {
					return 'укажите поле';
				}
				if (mode === 'color' && colorKindSelect.value === 'link' && colorLink.value.trim() === '') {
					return 'укажите ссылку на цвет';
				}
				if (mode === 'list') {
					for (const row of listRows) {
						if (row.removed || !row.control) {
							continue;
						}
						const error = row.control.validate();
						if (error) {
							return error;
						}
					}
				}
				return undefined;
			},
			result: function () {
				const mode = currentMode();
				// Пустое значение с подсказанным типом собирается всегда (строка нового списка)
				if (original || !options.typeHint) {
					if (unchanged(mode)) {
						return undefined;
					}
				} else if (mode === '') {
					return null;
				}
				return build(mode);
			},
		};
	}

	// ---------- панель «Отбор» ----------

	function filterGroupTypeLabel(value) {
		return optionLabel(FILTER_GROUP_OPTIONS, value || 'AndGroup', 'И');
	}

	/** Сводка элемента отбора: условие одной строкой, группа — типом и числом вложенных. */
	function filterItemSummary(item) {
		if (item.kind === 'group') {
			const size = Array.isArray(item.items) ? item.items.length : 0;
			return filterGroupTypeLabel(item.groupType) + ' (' + size + ')';
		}
		let text = (item.left || '') + ' ' + comparisonLabel(item.comparisonType || 'Equal').toLowerCase();
		const value = valuesSummary(item.right);
		if (value) {
			text += ' ' + value;
		}
		return text;
	}

	/** Сводка отбора целиком: элементы через точку с запятой; пусто — отбора нет. */
	function filterSummary(items) {
		return (Array.isArray(items) ? items : []).map(filterItemSummary).join('; ');
	}

	/**
	 * Таблица дерева отбора мини-редактора условия оформления (у панели «Отбор» — сетка settingsListGrid).
	 * ctx: items — текущий список, commit(next) — применить (false — занято), edit(pos) и add(kind, parentPos) — открыть
	 * инлайн-форму элемента, inline — правка локальной копии (подтверждение удаления не требуется), emptyText — плашка.
	 * Команды над таблицей и в строках — пиктограммы с подсказкой. Перенос мышью: строку тащат за
	 * ячейку имени (в строке флажок и кнопки), она встаёт в место сброса той же правкой копии, что ↑ ↓ (ctx.commit), в
	 * группу (серединой её строки) и из неё; с клавиатуры то же делают кнопки строки «Вынести из группы» и «Перенести в
	 * группу выше». Зона — колонка целиком: панель и шапка ставят первым, место под строками — последним. Пока открыта
	 * инлайн-форма (ctx.formOpen), строку не тащат: перерисовка убрала бы форму с набранным. Элементы управления помечены
	 * data-mini-key (miniKey): после перерисовки мини-редактор возвращает фокус на тот же элемент строки, за строкой.
	 * ctx.commit(next, focus) — focus {pos, action}: где ждать фокус после правки (новый адрес строки и действие).
	 */
	function renderFilterTable(host, ctx) {
		const zoneId = 'cafilter:' + ++filterTableSeq;
		const bar = el('div', 'dcs-list-toolbar');
		for (const adder of [
			{ icon: 'add', name: 'Добавить условие…', kind: 'comparison' },
			{ icon: 'folder', name: 'Добавить группу условий…', kind: 'group' },
		]) {
			const button = iconButton({
				icon: adder.icon,
				name: adder.name,
				onClick: () => {
					ctx.add(adder.kind, null);
				},
			});
			button.setAttribute('data-mini-key', miniKey(null, 'add-' + adder.kind));
			bar.appendChild(button);
		}
		host.appendChild(bar);
		const isGroup = (item) => item.kind === 'group';
		const drag = { trs: [], keys: new WeakMap() };
		let head = null;
		if (ctx.items.length === 0) {
			host.appendChild(el('div', 'dcs-plate', ctx.emptyText));
		} else {
			const tbody = dataTable(host, ['', 'Поле / группа', 'Вид сравнения', 'Значение', 'Представление', '']);
			head = tbody.parentElement.children[0].children[0];
			appendFilterRows(tbody, ctx, ctx.items, [], 0, drag);
		}
		const posOf = (key) => (key === null || key === undefined ? null : JSON.parse(key));
		tableDropZone(host, {
			id: zoneId,
			scope: 'settings',
			head: head,
			rows: () => drag.trs,
			keys: drag.keys,
			drag: () => (ctx.formOpen() ? '' : 'item'),
			from: {
				[zoneId]: (payload, spot) => {
					const made = itemsMove(ctx.items, posOf(payload.key), listDropSlot(ctx.items, posOf(spot.key), spot.place, isGroup));
					if (!made) {
						return false;
					}
					ctx.commit(made.items, { pos: made.pos, action: 'edit' });
					return undefined;
				},
			},
			place: (payload, key) => {
				const item = key === null ? null : itemAtPos(ctx.items, posOf(key));
				return item && isGroup(item) ? 'both' : 'line';
			},
		});
	}

	/** Номер таблицы отбора мини-редактора: у каждой своя зона переноса — строки не уходят в таблицу другого окна. */
	let filterTableSeq = 0;

	/** Ключ элемента мини-редактора условия (data-mini-key): адрес строки (у команд над таблицей — пусто) и действие. */
	function miniKey(pos, action) {
		return (pos && pos.length > 0 ? posKey(pos) : '') + '|' + action;
	}

	const MINI_FIRST_NOTE = 'Недоступно: условие уже первое на своём уровне.';
	const MINI_LAST_NOTE = 'Недоступно: условие уже последнее на своём уровне.';

	/** Строки дерева отбора мини-редактора; drag — {trs, keys}: строки по порядку и строка → адрес (posKey) для переноса. */
	function appendFilterRows(tbody, ctx, listItems, posPrefix, depth, drag) {
		listItems.forEach((item, index) => {
			const pos = posPrefix.concat([index]);
			const tr = document.createElement('tr');
			drag.trs.push(tr);
			drag.keys.set(tr, posKey(pos));
			if (item.use === false) {
				tr.className = 'dcs-row-off';
			}
			const checkTd = el('td', 'dcs-cell-check');
			const box = el('input', 'edit-check');
			box.type = 'checkbox';
			box.checked = item.use !== false;
			// У колонки флажков нет заголовка: имя флажка — условие строки
			box.setAttribute('aria-label', 'Использовать: ' + filterRowLabel(item));
			box.setAttribute('data-mini-key', miniKey(pos, 'use'));
			box.addEventListener('change', () => {
				const next = cloneItems(ctx.items);
				const ref = selItemAt(next, pos);
				if (box.checked) {
					delete ref.use;
				} else {
					ref.use = false;
				}
				if (!ctx.commit(next)) {
					box.checked = !box.checked;
				}
			});
			checkTd.appendChild(box);
			tr.appendChild(checkTd);
			const nameTd = cell(tr, item.kind === 'group' ? 'Группа ' + filterGroupTypeLabel(item.groupType) : item.left || '');
			nameTd.style.paddingLeft = 8 + depth * 18 + 'px';
			// Ручка переноса — ячейка имени: у строки только атрибут, слушатели — у документа
			nameTd.draggable = true;
			const badge = userSettingBadge(item);
			if (badge) {
				nameTd.appendChild(badge);
			}
			cell(tr, item.kind === 'group' ? '' : comparisonLabel(item.comparisonType || 'Equal'));
			cell(tr, item.kind === 'group' ? '' : valuesSummary(item.right));
			cell(tr, item.presentation || '');
			const isGroup = (candidate) => candidate.kind === 'group';
			const outSlot = itemsOutdentSlot(ctx.items, pos);
			const intoSlot = itemsIndentSlot(ctx.items, pos, isGroup);
			const actions = [
				{
					act: 'edit',
					svg: 'edit',
					title: 'Править',
					onClick: () => {
						ctx.edit(pos);
					},
				},
			];
			if (item.kind === 'group') {
				actions.push({
					act: 'add-comparison',
					svg: 'add',
					title: 'Добавить условие в группу',
					onClick: () => {
						ctx.add('comparison', pos);
					},
				});
				actions.push({
					act: 'add-group',
					svg: 'folder',
					title: 'Добавить вложенную группу',
					onClick: () => {
						ctx.add('group', pos);
					},
				});
			}
			// У края — недоступна, но в обходе Tab: фокус, оставшийся на ней после перестановки, не теряется, щелчок
			// называет причину (aria-disabled с причиной, как у остальных команд редактора)
			const firstHere = index === 0;
			const lastHere = index === listItems.length - 1;
			actions.push({
				act: 'up',
				svg: 'up',
				title: 'Выше',
				unavailable: firstHere,
				note: firstHere ? MINI_FIRST_NOTE : '',
				onClick: () => {
					if (firstHere) {
						ctx.notify(MINI_FIRST_NOTE);
						return;
					}
					moveFilterItem(ctx, pos, -1);
				},
			});
			actions.push({
				act: 'down',
				svg: 'down',
				title: 'Ниже',
				unavailable: lastHere,
				note: lastHere ? MINI_LAST_NOTE : '',
				onClick: () => {
					if (lastHere) {
						ctx.notify(MINI_LAST_NOTE);
						return;
					}
					moveFilterItem(ctx, pos, 1);
				},
			});
			// В группу и из неё без мыши (WCAG 2.5.7): тот же перенос копии, что сброс строки мышью. Кнопка — только там, где
			// она что-то делает: в плоском отборе их нет вовсе. Фокус после перерисовки — за строкой, на её новом адресе
			if (outSlot) {
				actions.push({
					act: 'outdent',
					svg: 'outdent',
					title: LEVEL_WORDS.group.out,
					onClick: () => {
						const made = itemsMove(ctx.items, pos, outSlot);
						if (made) {
							ctx.commit(made.items, { pos: made.pos });
						}
					},
				});
			}
			if (intoSlot) {
				actions.push({
					act: 'indent',
					svg: 'indent',
					title: LEVEL_WORDS.group.into,
					onClick: () => {
						const made = itemsMove(ctx.items, pos, intoSlot);
						if (made) {
							ctx.commit(made.items, { pos: made.pos });
						}
					},
				});
			}
			actions.push({
				act: 'delete',
				svg: 'delete',
				title: 'Удалить',
				danger: true,
				onClick: () => {
					removeFilterItem(ctx, item, pos);
				},
			});
			actionsCell(tr, actions);
			const buttons = tr.children[tr.children.length - 1].children;
			actions.forEach((action, at) => {
				buttons[at].setAttribute('data-mini-key', miniKey(pos, action.act));
			});
			tbody.appendChild(tr);
			if (item.kind === 'group' && Array.isArray(item.items) && item.items.length > 0) {
				appendFilterRows(tbody, ctx, item.items, pos, depth + 1, drag);
			}
		});
	}

	/** Сдвиг элемента отбора в пределах его уровня; true — правка ушла. */
	function moveFilterItem(ctx, pos, delta) {
		const next = cloneItems(ctx.items);
		const listRef = selListAt(next, pos);
		const index = pos[pos.length - 1];
		const target = index + delta;
		if (target < 0 || target >= listRef.length) {
			return false;
		}
		const moved = listRef.splice(index, 1)[0];
		listRef.splice(target, 0, moved);
		// Мини-редактор условия оформления ждёт фокус на той же кнопке строки, уже на новом месте
		return Boolean(ctx.commit(next, { pos: pos.slice(0, -1).concat([target]) }));
	}

	/** Удаление элемента отбора (группы с вложенными на панели — после подтверждения); onSent — когда правка ушла. */
	function removeFilterItem(ctx, item, pos, onSent) {
		function apply() {
			const next = cloneItems(ctx.items);
			selListAt(next, pos).splice(pos[pos.length - 1], 1);
			// Фокус мини-редактора — на «Удалить» строки, занявшей место удалённой (у последней — предыдущей)
			if (!ctx.commit(next, { pos: posAfterRemoval(ctx.items, pos), action: 'delete' })) {
				return BUSY;
			}
			if (onSent) {
				onSent();
			}
			return undefined;
		}
		const nested = item.kind === 'group' && Array.isArray(item.items) ? countSelItems(item.items) : 0;
		if (nested > 0 && !ctx.inline) {
			confirmRemove('Удалить группу отбора? Вместе с ней удалятся вложенные элементы: ' + nested + '.', apply);
			return;
		}
		apply();
	}

	/**
	 * Форма условия-сравнения; общая для диалога панели и инлайн-формы мини-редактора.
	 * apply правит переданный элемент, не трогая passthrough-поля (viewMode, userSettingID и другие).
	 */
	function buildComparisonForm(body, item) {
		const current = item || {};
		const right = Array.isArray(current.right) ? current.right : [];
		const fieldInput = formRow(body, 'Поле', textInput(current.left));
		attachFieldList(fieldInput, 'filter');
		const cmpSelect = formRow(body, 'Вид сравнения', selectInput(comparisonOptions(), current.comparisonType || 'Equal'));
		const valueHost = el('div', 'dcs-value-host');
		let editor = null;
		if (right.length > 1) {
			valueHost.appendChild(el('span', 'dcs-ro-note', 'Значений несколько — правятся в конфигураторе.'));
		} else {
			editor = createValueControl(right[0], {
				// Поле справа тоже участвует в условии: действует то же ограничение «условие»
				attachFields: (input) => {
					attachFieldList(input, 'filter');
				},
			});
			valueHost.appendChild(editor.root);
		}
		formRow(body, 'Значение', valueHost);
		function refreshValue() {
			const noValue = NO_VALUE_COMPARISONS.indexOf(cmpSelect.value) >= 0;
			valueHost.parentElement.classList.toggle('hidden', noValue);
			if (!noValue && editor && !editor.readOnly && LIST_COMPARISONS.indexOf(cmpSelect.value) >= 0 && editor.mode() !== 'list') {
				editor.setMode('list');
			}
		}
		cmpSelect.addEventListener('change', refreshValue);
		refreshValue();
		const presentationInput = formRow(body, 'Представление', textInput(current.presentation));
		const applicationSelect = formRow(body, 'Применение', selectInput(APPLICATION_OPTIONS, current.application || ''));
		const useBox = checkbox('Использовать', current.use !== false);
		checkRow(body, [useBox]);
		return {
			focusComparison: function () {
				cmpSelect.focus();
			},
			validate: function () {
				if (!fieldInput.value.trim()) {
					return 'Укажите поле.';
				}
				if (NO_VALUE_COMPARISONS.indexOf(cmpSelect.value) >= 0) {
					return undefined;
				}
				if (editor && !editor.readOnly) {
					if (LIST_COMPARISONS.indexOf(cmpSelect.value) >= 0 && editor.mode() !== 'list') {
						return 'Для вида сравнения «' + comparisonLabel(cmpSelect.value) + '» нужен список значений.';
					}
					const error = editor.validate();
					if (error) {
						return 'Значение: ' + error + '.';
					}
				}
				return undefined;
			},
			apply: function (ref) {
				ref.kind = 'comparison';
				ref.left = fieldInput.value.trim();
				ref.comparisonType = cmpSelect.value;
				if (NO_VALUE_COMPARISONS.indexOf(cmpSelect.value) >= 0) {
					delete ref.right;
				} else if (editor) {
					const value = editor.result();
					if (value === null) {
						delete ref.right;
					} else if (value !== undefined) {
						ref.right = [value];
					}
				}
				const presentation = presentationInput.value.trim();
				if (presentation) {
					ref.presentation = presentation;
				} else {
					delete ref.presentation;
				}
				if (applicationSelect.value) {
					ref.application = applicationSelect.value;
				} else {
					delete ref.application;
				}
				if (useBox.input.checked) {
					delete ref.use;
				} else {
					ref.use = false;
				}
			},
		};
	}

	/** Форма группы отбора: тип И/ИЛИ/НЕ, представление и использование. */
	function buildGroupForm(body, item) {
		const current = item || {};
		const typeSelect = formRow(body, 'Тип группы', selectInput(FILTER_GROUP_OPTIONS, current.groupType || 'AndGroup'));
		const presentationInput = formRow(body, 'Представление', textInput(current.presentation));
		const useBox = checkbox('Использовать', current.use !== false);
		checkRow(body, [useBox]);
		return {
			validate: () => undefined,
			apply: function (ref) {
				ref.kind = 'group';
				if (typeSelect.value === 'AndGroup' && !current.groupType) {
					// отсутствие типа в файле означает И — лишний элемент не пишется
					delete ref.groupType;
				} else {
					ref.groupType = typeSelect.value;
				}
				const presentation = presentationInput.value.trim();
				if (presentation) {
					ref.presentation = presentation;
				} else {
					delete ref.presentation;
				}
				if (useBox.input.checked) {
					delete ref.use;
				} else {
					ref.use = false;
				}
			},
		};
	}

	/**
	 * Правка или добавление: применяет форму к копии списка ctx и отдаёт её commit. Новый элемент, ушедший правкой,
	 * сообщается ctx.added(адрес) — панель выбирает его строку после ответа.
	 */
	function applyFilterForm(ctx, form, pos, parentPos, index) {
		const next = cloneItems(ctx.items);
		let ref;
		let freshPos = null;
		if (pos) {
			ref = selItemAt(next, pos);
		} else {
			ref = {};
			const level = itemsLevel(next, parentPos || []);
			// Номер вставки — место сброса поля мышью; без него — последним
			const at = typeof index === 'number' ? Math.max(0, Math.min(index, level.length)) : level.length;
			level.splice(at, 0, ref);
			freshPos = (parentPos || []).concat([at]);
		}
		form.apply(ref);
		// Мини-редактор после «Применить» ставит фокус на «Править» этой строки (новой — на её месте)
		const sent = ctx.commit(next, { pos: pos || freshPos, action: 'edit' });
		if (sent && freshPos && ctx.added) {
			ctx.added(freshPos);
		}
		return sent;
	}

	/**
	 * Диалог элемента отбора: правка по адресу pos или добавление kind в группу parentPos. preset — поле нового условия
	 * («>», двойной щелчок и перенос мышью из «Доступных полей»): поле заполнено, фокус — на виде сравнения. index — номер
	 * вставки нового элемента в группе (место сброса мышью); без него — последним.
	 */
	function openFilterItemDialog(ctx, pos, kind, parentPos, preset, index) {
		const item = pos ? selItemAt(ctx.items, pos) : null;
		const isGroup = item ? item.kind === 'group' : kind === 'group';
		let form;
		openDialog(
			item ? (isGroup ? 'Группа отбора' : 'Условие отбора') : isGroup ? 'Новая группа отбора' : 'Новое условие отбора',
			item ? 'Сохранить' : 'Добавить',
			(body) => {
				form = isGroup ? buildGroupForm(body, item) : buildComparisonForm(body, item || preset || null);
			},
			() => {
				const error = form.validate();
				if (error) {
					return error;
				}
				if (!applyFilterForm(ctx, form, pos, parentPos, index)) {
					return BUSY;
				}
				return undefined;
			}
		);
		// Поле уже выбрано в «Доступных полях»: остаются вид сравнения и значение
		if (!item && preset && form && form.focusComparison) {
			form.focusComparison();
		}
	}

	/** Имя строки «Отбора» для читалки: условие одной строкой или группа с числом условий, и представление. */
	function filterRowLabel(item) {
		const head =
			item.kind === 'group'
				? 'Группа ' + filterGroupTypeLabel(item.groupType) + ', условий: ' + (Array.isArray(item.items) ? item.items.length : 0)
				: filterItemSummary(item);
		return head + (item.presentation ? ', представление «' + item.presentation + '»' : '');
	}

	/**
	 * «Отбор» как в конфигураторе: слева «Доступные поля», посередине «>», справа дерево условий с флажками,
	 * над ним пиктограммы: добавить условие (окно), группу условий, удалить, выше, ниже, вынести из группы, в группу выше.
	 * «>», Enter и двойной щелчок по полю открывают окно нового условия с этим полем: вид сравнения и значение выбирает
	 * пользователь. Новое условие встаёт в выбранную группу, иначе — последним на уровне выбранной строки.
	 */
	function renderFilterPanel(host, node, path, variantName) {
		const stateKey = listStateKey(variantName, path, 'filter');
		const isGroup = (item) => item.kind === 'group';
		const ctx = {
			items: sectionItems(node.filter),
			inline: false,
			commit: function (next) {
				return sendPanelItems('dcs/set-filter', variantName, path, next);
			},
			edit: function (pos) {
				openFilterItemDialog(ctx, pos, '', null);
			},
			add: function (kind, parentPos, preset, index) {
				openFilterItemDialog(ctx, null, kind, parentPos, preset, index);
			},
			added: function (pos) {
				rememberListRow(stateKey, pos);
			},
		};
		let grid = null;
		const parentOf = (row) => {
			const parentPos = insertionParent(row, isGroup);
			return parentPos.length > 0 ? parentPos : null;
		};
		const remove = (row, fromGrid) => {
			const after = posAfterRemoval(ctx.items, row.pos);
			removeFilterItem(ctx, row.item, row.pos, () => {
				rememberListRow(stateKey, after);
				if (fromGrid) {
					replyFocus.list = stateKey;
				}
			});
		};
		const move = (row, delta) => {
			if (moveFilterItem(ctx, row.pos, delta)) {
				rememberListRow(stateKey, row.pos.slice(0, -1).concat([row.pos[row.pos.length - 1] + delta]));
			}
		};
		// Перенос строки, в том числе в группу и из неё: копия отбора с перенесённой строкой (все свойства условия — с ней),
		// выбор — за ней. Мышью (toList) фокус после ответа — на строке, пиктограммами уровня — остаётся на кнопке
		const moveAt = (from, slot, toList) => {
			const made = slot ? itemsMove(ctx.items, from, slot) : null;
			if (!made) {
				return false;
			}
			if (ctx.commit(made.items)) {
				rememberListRow(stateKey, made.pos);
				if (toList) {
					replyFocus.list = stateKey;
				}
			}
			return undefined;
		};
		settingsFieldsLayout(host, {
			id: 'filter',
			title: 'Отбор',
			addTitle: 'Добавить условие по выбранному полю',
			note: () => '',
			onAdd: (field) => ctx.add('comparison', parentOf(grid.selected()), { left: field.path }),
			// Как клавиша Delete: строка сначала выбрана (группа с вложенными — с вопросом; после отмены выбрана она)
			onRemove: (key) => {
				const pos = JSON.parse(key);
				grid.pick(key);
				remove({ pos: pos, item: selItemAt(ctx.items, pos) }, true);
			},
			list: (right, avail) => {
				const noRow = () => (ctx.items.length > 0 ? LIST_NO_ROW_NOTE : LIST_EMPTY_NOTE);
				const where = (row) => insertionNote(row, isGroup, ctx.items, (group) => 'группу «' + filterGroupTypeLabel(group.groupType) + '»');
				const toolbar = settingsListToolbar(right, 'filter', [
					{ id: 'add', icon: 'add', name: 'Добавить условие…', hint: where, run: (row) => ctx.add('comparison', parentOf(row)) },
					{ id: 'folder', icon: 'folder', name: 'Добавить группу условий…', hint: where, run: (row) => ctx.add('group', parentOf(row)) },
					{ id: 'delete', icon: 'delete', name: 'Удалить', shortcut: 'Delete', danger: true, state: (row) => (row ? '' : noRow()), run: (row) => remove(row, false) },
					{ id: 'up', icon: 'up', name: 'Переместить выше', state: (row) => (row ? listMoveNote(row, -1, 'группе') : noRow()), run: (row) => move(row, -1) },
					{ id: 'down', icon: 'down', name: 'Переместить ниже', state: (row) => (row ? listMoveNote(row, 1, 'группе') : noRow()), run: (row) => move(row, 1) },
					...listLevelTools(ctx.items, isGroup, LEVEL_WORDS.group, noRow, (row, slot) => moveAt(row.pos, slot, false)),
				]);
				grid = settingsListGrid(right, {
					id: 'filter',
					label: 'Отбор',
					tree: true,
					headers: ['', 'Поле / группа', 'Вид сравнения', 'Значение', 'Представление', ''],
					rows: flattenItems(ctx.items, isGroup),
					stateKey: stateKey,
					cells: (tr, row) => {
						const item = row.item;
						const nameTd = cell(tr, item.kind === 'group' ? 'Группа ' + filterGroupTypeLabel(item.groupType) : item.left || '');
						nameTd.style.paddingLeft = 8 + row.depth * 18 + 'px';
						const badge = userSettingBadge(item);
						if (badge) {
							nameTd.appendChild(badge);
						}
						cell(tr, item.kind === 'group' ? '' : comparisonLabel(item.comparisonType || 'Equal'));
						cell(tr, item.kind === 'group' ? '' : valuesSummary(item.right));
						cell(tr, item.presentation || '');
					},
					rowLabel: (row) => filterRowLabel(row.item),
					useLabel: (row) => (row.item.kind === 'group' ? 'Группа ' + filterGroupTypeLabel(row.item.groupType) : filterItemSummary(row.item)),
					onUse: (row, checked) => {
						const next = cloneItems(ctx.items);
						const ref = selItemAt(next, row.pos);
						if (checked) {
							delete ref.use;
						} else {
							ref.use = false;
						}
						return ctx.commit(next);
					},
					editable: () => true,
					onEdit: (row) => ctx.edit(row.pos),
					onDelete: remove,
					onSelect: (row) => toolbar.sync(row),
					empty: 'Условий отбора нет: выберите поле в «Доступных полях» и нажмите «>».',
					// Поле, брошенное в отбор, открывает то же окно «Новое условие отбора», что «>»; условие встанет в место сброса
					drop: settingsListDrop('filter', avail, ctx.items, {
						add: (field, slot) => ctx.add('comparison', slot.parent.length > 0 ? slot.parent : null, { left: field.path }, slot.index),
						move: (from, slot) => moveAt(from, slot, true),
						container: isGroup,
					}),
				});
				toolbar.sync(grid.selected());
			},
		});
	}

	/** Первый элемент ввода внутри узла (поле, список, флажок), в порядке документа; нет — null. */
	function firstControl(root) {
		for (const child of Array.from(root.children || [])) {
			if ((child.tagName === 'INPUT' || child.tagName === 'SELECT' || child.tagName === 'TEXTAREA') && !child.disabled) {
				return child;
			}
			const found = firstControl(child);
			if (found) {
				return found;
			}
		}
		return null;
	}

	/** Узел внутри root с атрибутом name = value; нет — null. */
	function findByAttribute(root, name, value) {
		for (const child of Array.from(root.children || [])) {
			if (typeof child.getAttribute === 'function' && child.getAttribute(name) === value) {
				return child;
			}
			const found = findByAttribute(child, name, value);
			if (found) {
				return found;
			}
		}
		return null;
	}

	const MINI_FORM_OPEN = 'Примените или отмените правку условия.';

	/**
	 * Мини-редактор отбора для диалога условного оформления: правит локальную копию,
	 * формы элементов раскрываются под таблицей (вложенный диалог открыть нельзя).
	 * Таблица перерисовывается на каждую правку, и фокус возвращается по ключу элемента (miniKey): на ту же кнопку строки
	 * на её новом адресе, у края — на ту же, недоступную с причиной; удалённой строки нет — на соседнюю или «Добавить
	 * условие…». Открытая форма ставит фокус в своё первое поле, «Применить» — на «Править» строки, «Отмена» — на кнопку,
	 * открывшую форму. Пока форма открыта, перестановки, флажки, удаление и перенос мышью ждут «Применить» или «Отмена»
	 * (иначе набранное в форме пропало бы): причина — в живой строке редактора, плашка страницы лежит под окном.
	 */
	function filterMiniEditor(host, initialItems, emptyText) {
		const state = { items: cloneItems(Array.isArray(initialItems) ? initialItems : []), changed: false, formOpen: false, invoker: '' };
		const tableHost = el('div', 'dcs-mini-filter');
		const note = el('div', 'dcs-mini-note');
		note.setAttribute('role', 'status');
		note.setAttribute('aria-live', 'polite');
		const formHost = el('div', 'dcs-mini-form');
		host.appendChild(tableHost);
		host.appendChild(note);
		host.appendChild(formHost);
		const ctx = {
			items: state.items,
			inline: true,
			emptyText: emptyText,
			formOpen: () => state.formOpen,
			notify: (text) => {
				note.textContent = text;
			},
			commit: function (next, focus) {
				if (state.formOpen) {
					note.textContent = MINI_FORM_OPEN;
					return false;
				}
				state.items = next;
				ctx.items = next;
				state.changed = true;
				rerender(focus);
				return true;
			},
			edit: function (pos) {
				openForm(selItemAt(state.items, pos), pos, '', null);
			},
			add: function (kind, parentPos) {
				openForm(null, null, kind, parentPos);
			},
		};
		/** Ключ элемента редактора с фокусом; фокус не в нём — ''. */
		function focusedKey() {
			const active = document.activeElement;
			return active && typeof active.getAttribute === 'function' ? active.getAttribute('data-mini-key') || '' : '';
		}
		/**
		 * Перерисовка таблицы; focus — {pos, action} (куда ушла строка) или ключ miniKey. Без него — тот же элемент, что
		 * был с фокусом. Запасные цели — «Править» той же строки, затем «Добавить условие…».
		 */
		function rerender(focus) {
			const had = focusedKey();
			const action = had ? had.slice(had.lastIndexOf('|') + 1) : '';
			const wanted = [];
			if (typeof focus === 'string') {
				wanted.push(focus);
			} else if (focus && focus.pos) {
				wanted.push(miniKey(focus.pos, focus.action || action), miniKey(focus.pos, 'edit'));
			} else if (had) {
				wanted.push(had, had.slice(0, had.lastIndexOf('|') + 1) + 'edit');
			}
			tableHost.textContent = '';
			formHost.textContent = '';
			note.textContent = '';
			state.formOpen = false;
			renderFilterTable(tableHost, ctx);
			if (wanted.length === 0) {
				return;
			}
			wanted.push(miniKey(null, 'add-comparison'));
			for (const key of wanted) {
				const target = findByAttribute(tableHost, 'data-mini-key', key);
				if (target) {
					target.focus();
					return;
				}
			}
		}
		function openForm(item, pos, kind, parentPos) {
			// Кнопка, открывшая форму: на неё вернётся фокус после «Отмена» (у повторного открытия — прежняя)
			state.invoker = focusedKey() || state.invoker;
			formHost.textContent = '';
			note.textContent = '';
			state.formOpen = true;
			const isGroup = item ? item.kind === 'group' : kind === 'group';
			const box = el('div', 'dcs-mini-box');
			box.appendChild(el('div', 'dcs-form-group', item ? (isGroup ? 'Группа отбора' : 'Условие отбора') : isGroup ? 'Новая группа' : 'Новое условие'));
			const body = el('div');
			box.appendChild(body);
			const form = isGroup ? buildGroupForm(body, item) : buildComparisonForm(body, item);
			const errorEl = el('div', 'dcs-dialog-error');
			box.appendChild(errorEl);
			const actions = el('div', 'dcs-mini-actions');
			const okBtn = el('button', 'primary-btn dcs-btn-small', 'Применить');
			okBtn.type = 'button';
			okBtn.addEventListener('click', () => {
				const error = form.validate();
				if (error) {
					errorEl.textContent = error;
					return;
				}
				// Форма закрывается своей правкой: её commit — не та перерисовка, что потеряла бы набранное
				state.formOpen = false;
				state.invoker = '';
				applyFilterForm(ctx, form, pos, parentPos);
			});
			const cancelBtn = el('button', 'ghost-btn dcs-btn-small', 'Отмена');
			cancelBtn.type = 'button';
			cancelBtn.addEventListener('click', () => {
				const invoker = state.invoker;
				state.invoker = '';
				rerender(invoker || miniKey(null, 'add-comparison'));
			});
			actions.appendChild(okBtn);
			actions.appendChild(cancelBtn);
			box.appendChild(actions);
			formHost.appendChild(box);
			const first = firstControl(body);
			if (first) {
				first.focus();
			}
		}
		rerender();
		return {
			current: () => state.items,
			changed: () => state.changed,
			formOpen: () => state.formOpen,
		};
	}

	// ---------- панели «Параметры» и «Другие настройки» ----------

	/** Точечная правка значения параметра: value и use меняются, остальное не трогается. */
	function sendParameterValue(variantName, section, path, parameter, patch) {
		const payload = { section: section, parameter: parameter };
		if (section === 'output') {
			payload.path = path;
		}
		if (patch.value !== undefined) {
			payload.value = patch.value;
		}
		if (patch.use !== undefined) {
			payload.use = patch.use;
		}
		if (patch.remove) {
			payload.remove = true;
		}
		if (!send('dcs/set-parameter-value', { variant: variantName, payload: payload })) {
			setStatus(BUSY, true);
			return false;
		}
		return true;
	}

	function paramItemsSummary(items) {
		return items.map((item) => item.parameter || '').join(', ');
	}

	/** Значение параметра не заполнено: нет записи значения, Неопределено или пустые строка и дата. */
	function emptyParamValue(record) {
		const values = Array.isArray(record.value) ? record.value : [];
		if (values.length === 0) {
			return true;
		}
		if (values.length > 1) {
			return false;
		}
		const value = values[0];
		if (value.nil) {
			return true;
		}
		if (value.opaque || value.attrs || value.list || value.period || value.beginningDate) {
			return false;
		}
		const raw = valueRaw(value);
		return raw === '' || raw === DCS_ZERO_DATE;
	}

	function renderDataParametersPanel(host, node, path, variantName) {
		const records = sectionItems(node.dataParameters);
		const recordByName = {};
		for (const record of records) {
			recordByName[record.parameter || ''] = record;
		}
		const showBox = checkbox('Отображать недоступные', uiState.showInaccessibleParams);
		showBox.input.addEventListener('change', () => {
			uiState.showInaccessibleParams = showBox.input.checked;
			renderContent();
		});
		const bar = el('div', 'dcs-params-bar');
		bar.appendChild(showBox.wrap);
		host.appendChild(bar);
		const rows = [];
		const seen = {};
		for (const param of list('parameters')) {
			const name = param.name || '';
			seen[name] = true;
			if (param.useRestriction && !uiState.showInaccessibleParams) {
				continue;
			}
			rows.push({ name: name, param: param, record: recordByName[name] || null });
		}
		for (const record of records) {
			const name = record.parameter || '';
			if (!seen[name]) {
				// Запись варианта без параметра схемы: показывается честно, как есть
				rows.push({ name: name, param: null, record: record });
			}
		}
		if (rows.length === 0) {
			emptyNote(host, 'Параметров нет.');
			return;
		}
		const tbody = dataTable(host, ['', 'Параметр', 'Значение', '']);
		for (const row of rows) {
			appendDataParamRow(tbody, row, path, variantName);
		}
	}

	function appendDataParamRow(tbody, row, path, variantName) {
		const record = row.record;
		const tr = document.createElement('tr');
		if (record && record.use === false) {
			tr.className = 'dcs-row-off';
		}
		const checkTd = el('td', 'dcs-cell-check');
		const box = el('input', 'edit-check');
		box.type = 'checkbox';
		box.checked = record ? record.use !== false : false;
		// У колонки флажков нет заголовка: имя — параметр. Ключ — по параметру: фокус переживает перерисовку по ответу
		box.setAttribute('aria-label', 'Использовать: ' + row.name);
		keyed(box, focusKey(['dparam', 'use', row.name]));
		box.addEventListener('change', () => {
			if (!sendParameterValue(variantName, 'data', path, row.name, { use: box.checked })) {
				box.checked = !box.checked;
			}
		});
		checkTd.appendChild(box);
		tr.appendChild(checkTd);
		const nameTd = cell(tr, row.name);
		if (row.param && row.param.title && row.param.title !== row.name) {
			nameTd.title = row.param.title;
		}
		if (row.param && row.param.useRestriction) {
			nameTd.appendChild(el('span', 'dcs-ro-note', ' (недоступен)'));
		}
		if (record) {
			const badge = userSettingBadge(record);
			if (badge) {
				nameTd.appendChild(badge);
			}
		}
		const composite = record && Array.isArray(record.items) && record.items.length > 0;
		const valueTd = el('td');
		if (composite) {
			valueTd.appendChild(
				el('span', 'dcs-ro-note', 'Составное значение (' + paramItemsSummary(record.items) + ') — правится в конфигураторе')
			);
		} else if (record) {
			valueTd.textContent = valuesSummary(record.value);
		} else if (row.param && (row.param.valuePresentation || row.param.value)) {
			valueTd.appendChild(el('span', 'dcs-ro-note', (row.param.valuePresentation || row.param.value) + ' (из схемы)'));
		}
		if (row.param && row.param.denyIncompleteValues && record && record.use !== false && emptyParamValue(record)) {
			valueTd.appendChild(el('span', 'dcs-warn', ' Параметр запрещает незаполненные значения.'));
		}
		tr.appendChild(valueTd);
		if (!composite && (!record || editableValues(record.value))) {
			actionsCell(tr, [
				{
					svg: 'edit',
					title: 'Править',
					// Ключ — по параметру: после ответа фокус возвращается на кнопку той же строки
					key: focusKey(['dparam', 'edit', row.name]),
					onClick: () => {
						openParamValueDialog(variantName, 'data', path, row);
					},
				},
			]);
		} else {
			cell(tr, '');
		}
		tbody.appendChild(tr);
	}

	/** Диалог значения параметра данных: редактор по типу и галка использования. */
	function openParamValueDialog(variantName, section, path, row) {
		const record = row.record;
		const values = record && Array.isArray(record.value) ? record.value : [];
		let editor;
		let useBox;
		openDialog(
			'Параметр «' + row.name + '»',
			'Сохранить',
			(body) => {
				if (row.param && row.param.type) {
					formRow(body, 'Тип', el('span', 'dcs-ro-note', row.param.type));
				}
				const host = el('div', 'dcs-value-host');
				editor = createValueControl(values[0], {
					attachFields: (input) => {
						attachFieldList(input);
					},
				});
				host.appendChild(editor.root);
				formRow(body, 'Значение', host);
				useBox = checkbox('Использовать', record ? record.use !== false : true);
				checkRow(body, [useBox]);
			},
			() => {
				const error = editor.validate();
				if (error) {
					return 'Значение: ' + error + '.';
				}
				const patch = {};
				const value = editor.result();
				if (value === null) {
					// очищенное значение параметра — Неопределено: value присутствует всегда
					patch.value = { nil: true };
				} else if (value !== undefined) {
					patch.value = value;
				}
				const use = useBox.input.checked;
				if (record ? (record.use !== false) !== use : !use) {
					patch.use = use;
				}
				if (patch.value === undefined && patch.use === undefined) {
					closeDialog();
					return undefined;
				}
				if (!sendParameterValue(variantName, section, path, row.name, patch)) {
					return BUSY;
				}
				return undefined;
			}
		);
	}

	/** Расположение итогов DataCompositionTotalPlacement (core XSD). */
	const TOTAL_PLACEMENT_OPTIONS = [
		{ value: 'Auto', label: 'Авто' },
		{ value: 'Begin', label: 'Начало' },
		{ value: 'End', label: 'Конец' },
		{ value: 'BeginAndEnd', label: 'Начало и конец' },
		{ value: 'None', label: 'Нет' },
	];

	/** Вывод текста DataCompositionTextOutputType (без «выводить заполненные»). */
	const TEXT_OUTPUT_OPTIONS = [
		{ value: 'Auto', label: 'Авто' },
		{ value: 'Output', label: 'Выводить' },
		{ value: 'DontOutput', label: 'Не выводить' },
	];

	/** Типы диаграммы — тот же список из 47 лексем, что на последнем шаге конструктора настроек. */
	const CHART_TYPE_OPTIONS = wizardRules.CHART_TYPES.map((item) => ({ value: item.value, label: item.label }));

	/**
	 * Белый словарь параметров вывода: имя → тип значения и контрол.
	 * Всё вне словаря показывается только для чтения. У ТипДиаграммы правится само значение, а его
	 * под-параметры «ТипДиаграммы.*» — только чтение: md-sparrow переносит их при правке дословно
	 * (keepsItems). Добавляется он в корне и у диаграммы — там его пишет платформа.
	 */
	const OUTPUT_PARAMS = {
		'ВыводитьЗаголовок': { control: 'enum', type: 'dcsset:DataCompositionTextOutputType', options: TEXT_OUTPUT_OPTIONS },
		'ВыводитьПараметрыДанных': { control: 'enum', type: 'dcsset:DataCompositionTextOutputType', options: TEXT_OUTPUT_OPTIONS },
		'ВыводитьОтбор': { control: 'enum', type: 'dcsset:DataCompositionTextOutputType', options: TEXT_OUTPUT_OPTIONS.concat([{ value: 'OutputFilled', label: 'Выводить заполненные' }]) },
		'Заголовок': { control: 'text', type: 'v8:LocalStringType' },
		'МакетОформления': { control: 'text', type: 'xs:string' },
		'ТипЗаголовкаПолей': { control: 'enum', type: 'dcscor:DataCompositionFieldsTitleType', options: [{ value: 'Auto', label: 'Авто' }, { value: 'Full', label: 'Полный' }, { value: 'Short', label: 'Краткий' }] },
		'РасположениеИтогов': { control: 'enum', type: 'dcscor:DataCompositionTotalPlacement', options: TOTAL_PLACEMENT_OPTIONS },
		'РасположениеОбщихИтогов': { control: 'enum', type: 'dcscor:DataCompositionTotalPlacement', options: TOTAL_PLACEMENT_OPTIONS },
		'ВертикальноеРасположениеОбщихИтогов': { control: 'enum', type: 'dcscor:DataCompositionTotalPlacement', options: TOTAL_PLACEMENT_OPTIONS },
		'ГоризонтальноеРасположениеОбщихИтогов': { control: 'enum', type: 'dcscor:DataCompositionTotalPlacement', options: TOTAL_PLACEMENT_OPTIONS },
		'РасположениеПолейГруппировки': { control: 'enum', type: 'dcsset:DataCompositionGroupFieldsPlacement', options: [{ value: 'Together', label: 'Вместе' }, { value: 'Separately', label: 'Отдельно' }, { value: 'SeparatelyAndInTotalsOnly', label: 'Отдельно и только в итогах' }] },
		'РасположениеГруппировки': { control: 'enum', type: 'dcsset:DataCompositionGroupPlacement', options: [{ value: 'Begin', label: 'Начало' }, { value: 'End', label: 'Конец' }, { value: 'BeginAndEnd', label: 'Начало и конец' }, { value: 'None', label: 'Нет' }] },
		'РасположениеРеквизитов': { control: 'enum', type: 'dcsset:DataCompositionAttributesPlacement', options: [{ value: 'Together', label: 'Вместе' }, { value: 'Separately', label: 'Отдельно' }, { value: 'WithOwnerField', label: 'Вместе с владельцем' }, { value: 'SpecialPosition', label: 'В специальной позиции' }] },
		'РасположениеРесурсов': { control: 'enum', type: 'dcsset:DataCompositionResourcesPlacement', options: [{ value: 'Horizontally', label: 'Горизонтально' }, { value: 'Vertically', label: 'Вертикально' }] },
		'АвтоПозицияРесурсов': { control: 'enum', type: 'dcsset:DataCompositionResourcesAutoPosition', options: [{ value: 'DontUse', label: 'Не использовать' }, { value: 'AfterAllFields', label: 'После всех полей' }] },
		'ФиксацияСверху': { control: 'enum', type: 'dcsset:DataCompositionFixation', options: [{ value: 'Auto', label: 'Авто' }, { value: 'DontUse', label: 'Не использовать' }] },
		'ФиксацияСлева': { control: 'enum', type: 'dcsset:DataCompositionFixation', options: [{ value: 'Auto', label: 'Авто' }, { value: 'DontUse', label: 'Не использовать' }] },
		'КоличествоЗаписей': { control: 'number', type: 'xs:decimal' },
		'ПроцентЗаписей': { control: 'number', type: 'xs:decimal', max: 100 },
		'ТипМакета': { control: 'enum', type: 'dcsset:DataCompositionGroupTemplateType', options: [{ value: 'Auto', label: 'Авто' }, { value: 'Vertical', label: 'Вертикально' }, { value: 'Horizontal', label: 'Горизонтально' }] },
		'ВариантИспользованияГруппировки': { control: 'enum', type: 'dcsset:DataCompositionGroupUseVariant', options: [{ value: 'Auto', label: 'Авто' }, { value: 'AdditionalInformation', label: 'Дополнительная информация' }], kinds: ['group'] },
		'ТипДиаграммы': { control: 'enum', type: 'v8ui:ChartType', options: CHART_TYPE_OPTIONS, defaultValue: 'Column', kinds: ['root', 'chart'], keepsItems: true },
	};

	/**
	 * Параметры вывода, которых платформа не хранит на уровне узла, — зеркало отказов md-sparrow
	 * (ROOT_, GROUP_, TABLE_, TABLE_GROUP_, CHART_ и CHART_GROUP_FORBIDDEN_OUTPUT_PARAMETERS в DcsSettingsEdit.java).
	 * Загрузка схемы в платформу (ibcmd 8.3.27) принимает их без ошибки, но молча отбрасывает: в корне варианта — пять
	 * параметров группировки; у группировки структуры — пять других (на любой глубине); у таблицы — 10 из 22 имён
	 * словаря; у группы строк и группы колонок таблицы — 7 (расположение общих итогов хранится только здесь); у
	 * диаграммы хранятся только тип диаграммы, заголовок и его вывод; у группы точек и группы серий — только количество
	 * и процент записей. Списки явные: в них только отброшенные загрузкой имена. Вложенные группы таблицы и диаграммы
	 * получают запрет своей верхней группы, как и в md-sparrow. Такие параметры не предлагаются, а уже записанные в файле
	 * показываются только для просмотра — строку можно удалить.
	 */
	const OUTPUT_PARAMS_NOT_STORED = {
		root: ['КоличествоЗаписей', 'ПроцентЗаписей', 'ТипМакета', 'РасположениеОбщихИтогов', 'ВариантИспользованияГруппировки'],
		group: ['ФиксацияСверху', 'ФиксацияСлева', 'ВыводитьПараметрыДанных', 'РасположениеОбщихИтогов', 'ГоризонтальноеРасположениеОбщихИтогов'],
		table: [
			'ФиксацияСверху',
			'ФиксацияСлева',
			'ВариантИспользованияГруппировки',
			'ВыводитьОтбор',
			'ВыводитьПараметрыДанных',
			'ТипДиаграммы',
			'РасположениеОбщихИтогов',
			'ТипМакета',
			'ПроцентЗаписей',
			'КоличествоЗаписей',
		],
		tableGroup: [
			'ФиксацияСверху',
			'ФиксацияСлева',
			'ВыводитьПараметрыДанных',
			'ТипДиаграммы',
			'ВертикальноеРасположениеОбщихИтогов',
			'ГоризонтальноеРасположениеОбщихИтогов',
			'ТипМакета',
		],
		chart: [
			'МакетОформления',
			'КоличествоЗаписей',
			'ПроцентЗаписей',
			'ТипМакета',
			'РасположениеИтогов',
			'РасположениеПолейГруппировки',
			'РасположениеГруппировки',
			'РасположениеРеквизитов',
			'РасположениеРесурсов',
			'ГоризонтальноеРасположениеОбщихИтогов',
			'РасположениеОбщихИтогов',
			'ВертикальноеРасположениеОбщихИтогов',
			'ТипЗаголовкаПолей',
			'ВыводитьПараметрыДанных',
			'ВыводитьОтбор',
			'АвтоПозицияРесурсов',
			'ФиксацияСлева',
			'ВариантИспользованияГруппировки',
			'ФиксацияСверху',
		],
		chartGroup: [
			'МакетОформления',
			'ТипМакета',
			'РасположениеИтогов',
			'РасположениеПолейГруппировки',
			'РасположениеГруппировки',
			'РасположениеРеквизитов',
			'РасположениеРесурсов',
			'ГоризонтальноеРасположениеОбщихИтогов',
			'РасположениеОбщихИтогов',
			'ВертикальноеРасположениеОбщихИтогов',
			'ТипЗаголовкаПолей',
			'ТипДиаграммы',
			'ВыводитьЗаголовок',
			'Заголовок',
			'ВыводитьПараметрыДанных',
			'ВыводитьОтбор',
			'АвтоПозицияРесурсов',
			'ФиксацияСлева',
			'ВариантИспользованияГруппировки',
			'ФиксацияСверху',
		],
	};

	/** Где параметр не хранится — продолжение фразы «платформа не хранит этот параметр …». */
	const OUTPUT_LEVEL_PLACES = {
		root: 'в корне варианта',
		group: 'у группировки',
		table: 'у таблицы',
		tableGroup: 'у группы строк или колонок таблицы',
		chart: 'у диаграммы',
		chartGroup: 'у группы точек или серий диаграммы',
	};

	/**
	 * Уровень узла для OUTPUT_PARAMS_NOT_STORED, как его различает md-sparrow: root — корень варианта;
	 * group — группировка структуры (путь идёт только по шагам structure, на любой глубине); table и chart —
	 * сами таблица и диаграмма; tableGroup и chartGroup — группы за шагами rows/columns и points/series
	 * (и вложенные в них группы).
	 */
	function outputLevelOf(node, path) {
		if (path.length === 0) {
			return 'root';
		}
		const kind = node.kind;
		if (kind !== 'group') {
			return kind;
		}
		if (path.every((step) => step.list === 'structure')) {
			return 'group';
		}
		return path.some((step) => step.list === 'points' || step.list === 'series') ? 'chartGroup' : 'tableGroup';
	}

	/** Параметр вывода name не хранится на уровне level (outputLevelOf). */
	function outputNotStored(name, level) {
		const names = OUTPUT_PARAMS_NOT_STORED[level];
		return Array.isArray(names) && names.indexOf(name) >= 0;
	}

	/**
	 * Имена «+ Добавить параметр» у узла вида kind на уровне level: словарь окна без параметров чужого вида узла
	 * (kinds словаря), без тех, что уровень не хранит, и без уже записанных (records — строки секции).
	 */
	function outputAddable(kind, level, records) {
		return Object.keys(OUTPUT_PARAMS).filter((name) => {
			const dict = OUTPUT_PARAMS[name];
			if (dict.kinds && dict.kinds.indexOf(kind) < 0) {
				return false;
			}
			if (outputNotStored(name, level)) {
				return false;
			}
			return !records.some((record) => record.parameter === name);
		});
	}

	/** Причина для строки и подсказки: «платформа не хранит этот параметр в корне варианта». */
	function outputNotStoredReason(level) {
		return 'платформа не хранит этот параметр ' + OUTPUT_LEVEL_PLACES[level] + ': загрузка его отбрасывает';
	}

	/** Доступное имя галки использования в строке параметра вывода. */
	function outputUseLabel(name) {
		return 'Использовать параметр «' + name + '»';
	}

	/** Вопрос перед удалением записанного там, где платформа его не хранит: сначала причина, потом вопрос. */
	function outputUnkeptQuestion(name, level) {
		return 'Платформа не хранит «' + name + '» ' + OUTPUT_LEVEL_PLACES[level] + '. Удалить строку?';
	}

	/** Значение словарного параметра правится, когда тип в файле не спорит со словарём. */
	function canEditOutputValue(dict, values) {
		if (values.length > 1) {
			return false;
		}
		const value = values[0];
		if (!value || value.nil) {
			return true;
		}
		if (value.opaque || value.attrs || value.list || value.period || value.beginningDate) {
			return false;
		}
		const type = value.type || '';
		if (dict.control === 'enum') {
			return type === '' || type === dict.type;
		}
		if (dict.control === 'number') {
			return type === '' || type === 'xs:decimal';
		}
		return type === '' || type === 'xs:string' || type === 'v8:LocalStringType';
	}

	function outputNumberError(dict, raw) {
		const value = Number(raw);
		if (raw.trim() === '' || !Number.isInteger(value) || value < 1 || (dict.max && value > dict.max)) {
			return 'Укажите целое число от 1' + (dict.max ? ' до ' + dict.max : '') + '.';
		}
		return undefined;
	}

	/** Встроенный контрол значения словарного параметра вывода: правка шлёт точечную мутацию. */
	function outputValueControl(dict, values, path, variantName, name) {
		const value = values[0];
		const raw = value && !value.nil ? valueRaw(value) : '';
		// Имя для читалки (у колонки значений заголовок общий) и ключ: ответ правки перерисует панель, фокус вернётся сюда
		const named = (node) => {
			node.setAttribute('aria-label', 'Значение «' + name + '»');
			return keyed(node, focusKey(['outp', 'value', name]));
		};
		if (dict.control === 'enum') {
			let options = dict.options;
			if (!raw) {
				options = [{ value: '', label: '—' }].concat(options);
			} else if (!options.some((option) => option.value === raw)) {
				options = [{ value: raw, label: raw }].concat(options);
			}
			const select = selectInput(options, raw);
			select.classList.add('dcs-row-select');
			browseSelect(
				select,
				() => {
					if (select.value === raw) {
						return;
					}
					// Пустой пункт «—» — лишь показ незаполненного значения, в enum он не пишется
					if (select.value === '' || !sendParameterValue(variantName, 'output', path, name, { value: { type: dict.type, decoded: select.value } })) {
						select.value = raw;
					}
				},
				() => {
					select.value = raw;
				}
			);
			return named(select);
		}
		if (dict.control === 'number') {
			const input = numberInput(Number(raw) > 0 ? Number(raw) : undefined);
			input.addEventListener('change', () => {
				const error = outputNumberError(dict, input.value);
				if (error) {
					setStatus('«' + name + '»: ' + error, true);
					input.value = raw;
					return;
				}
				if (!sendParameterValue(variantName, 'output', path, name, { value: { type: 'xs:decimal', decoded: Number(input.value) } })) {
					input.value = raw;
				}
			});
			return named(input);
		}
		const input = textInput(raw);
		input.classList.add('dcs-inline-input');
		input.addEventListener('change', () => {
			if (input.value === raw) {
				return;
			}
			// Существующий строковый тип сохраняется, новый берётся из словаря
			const type = value && (value.type === 'xs:string' || value.type === 'v8:LocalStringType') ? value.type : dict.type;
			if (!sendParameterValue(variantName, 'output', path, name, { value: { type: type, decoded: input.value } })) {
				input.value = raw;
			}
		});
		return named(input);
	}

	function renderOutputPanel(host, node, path, variantName) {
		const kind = path.length === 0 ? 'root' : node.kind;
		const level = outputLevelOf(node, path);
		const records = sectionItems(node.outputParameters);
		// Добавление — над таблицей, как команды остальных панелей; список, а не пиктограмма: выбирается имя
		const names = outputAddable(kind, level, records);
		if (names.length > 0) {
			const bar = el('div', 'dcs-list-toolbar');
			const select = el('select', 'edit-ref-add-select');
			select.setAttribute('aria-label', 'Добавить параметр вывода');
			const first = document.createElement('option');
			first.value = '';
			first.textContent = '+ Добавить параметр';
			select.appendChild(first);
			for (const name of names) {
				const option = document.createElement('option');
				option.value = name;
				option.textContent = name;
				select.appendChild(option);
			}
			actionSelect(select, (name) => {
				openOutputParamDialog(variantName, path, name);
			});
			bar.appendChild(keyed(select, focusKey(['nodetool', 'output', 'add'])));
			host.appendChild(bar);
		}
		if (records.length === 0) {
			host.appendChild(el('div', 'dcs-plate', 'Параметры вывода не заданы: действуют умолчания платформы.'));
		} else {
			const unkept = records.filter((record) => outputNotStored(record.parameter || '', level));
			if (unkept.length > 0) {
				host.appendChild(
					el(
						'div',
						'dcs-plate dcs-plate-warn',
						(unkept.length === 1 ? 'Параметр ' : 'Параметры ') +
							unkept.map((record) => '«' + record.parameter + '»').join(', ') +
							' платформа ' +
							OUTPUT_LEVEL_PLACES[level] +
							' не хранит: загрузка ' +
							(unkept.length === 1 ? 'его' : 'их') +
							' отбрасывает. Удалите ' +
							(unkept.length === 1 ? 'строку' : 'строки') +
							' кнопкой «Удалить» в строке.'
					)
				);
			}
			const tbody = dataTable(host, ['', 'Параметр', 'Значение', '']);
			const removable = records.filter((record) => outputRemovable(record, level)).map((record) => record.parameter || '');
			records.forEach((record) => {
				appendOutputRow(tbody, record, path, variantName, level, removable);
			});
		}
	}

	/** У строки параметра вывода есть «Удалить»: словарный без подпараметров или записанный там, где не хранится. */
	function outputRemovable(record, level) {
		const name = record.parameter || '';
		const composite = Array.isArray(record.items) && record.items.length > 0;
		return Boolean((OUTPUT_PARAMS[name] && !composite) || outputNotStored(name, level));
	}

	/** removable — имена строк с кнопкой удаления по порядку: после удаления фокус — на кнопке соседней строки. */
	function appendOutputRow(tbody, record, path, variantName, level, removable) {
		const name = record.parameter || '';
		const dict = OUTPUT_PARAMS[name];
		// Записан там, где платформа его не хранит: только просмотр и удаление (правку md-sparrow отклонит)
		const unkept = outputNotStored(name, level);
		const tr = document.createElement('tr');
		if (record.use === false || unkept) {
			tr.className = 'dcs-row-off';
		}
		const checkTd = el('td', 'dcs-cell-check');
		const box = el('input', 'edit-check');
		box.type = 'checkbox';
		box.checked = record.use !== false;
		// Имя галки — параметр, причина блокировки — описание: одного title экранный диктор не читает
		box.setAttribute('aria-label', outputUseLabel(name));
		keyed(box, focusKey(['outp', 'use', name]));
		if (unkept) {
			box.disabled = true;
			box.title = outputNotStoredReason(level);
			box.setAttribute('aria-description', outputNotStoredReason(level));
		}
		box.addEventListener('change', () => {
			// Точечная правка использования не трогает значение — доступна и вне словаря
			if (!sendParameterValue(variantName, 'output', path, name, { use: box.checked })) {
				box.checked = !box.checked;
			}
		});
		checkTd.appendChild(box);
		tr.appendChild(checkTd);
		const nameTd = cell(tr, name);
		const badge = userSettingBadge(record);
		if (badge) {
			nameTd.appendChild(badge);
		}
		const values = Array.isArray(record.value) ? record.value : [];
		const composite = Array.isArray(record.items) && record.items.length > 0;
		const valueTd = el('td');
		if (unkept) {
			valueTd.appendChild(el('span', 'dcs-ro-note', (valuesSummary(values) || '—') + ' — ' + outputNotStoredReason(level)));
		} else if (composite && !(dict && dict.keepsItems)) {
			valueTd.appendChild(
				el('span', 'dcs-ro-note', 'Подпараметры (' + paramItemsSummary(record.items) + ') — правятся в конфигураторе')
			);
		} else if (!dict) {
			valueTd.appendChild(el('span', 'dcs-ro-note', (valuesSummary(values) || '—') + ' — вне словаря, правится в конфигураторе'));
		} else if (!canEditOutputValue(dict, values)) {
			valueTd.appendChild(el('span', 'dcs-ro-note', (valuesSummary(values) || '—') + ' — правится в конфигураторе'));
		} else {
			valueTd.appendChild(outputValueControl(dict, values, path, variantName, name));
		}
		if (composite && dict && dict.keepsItems && !unkept) {
			valueTd.appendChild(
				el(
					'div',
					'dcs-ro-note',
					'Подпараметры (' + paramItemsSummary(record.items) + ') — только просмотр, при смене значения сохраняются'
				)
			);
		}
		tr.appendChild(valueTd);
		if (outputRemovable(record, level)) {
			const question = unkept ? outputUnkeptQuestion(name, level) : 'Сбросить параметр «' + name + '» к умолчанию платформы?';
			actionsCell(tr, [
				{
					svg: 'delete',
					title: unkept ? 'Удалить: платформа его здесь не хранит' : 'Сбросить к умолчанию платформы',
					danger: true,
					key: focusKey(['outp', 'remove', name]),
					onClick: () => {
						confirmRemove(question, () => {
							if (!sendParameterValue(variantName, 'output', path, name, { remove: true })) {
								return BUSY;
							}
							// Строки больше нет: фокус — на кнопке соседней строки, а без них — на «+ Добавить параметр»
							const at = removable.indexOf(name);
							const neighbour = removable[at + 1] || removable[at - 1];
							replyFocus.fallback = neighbour ? focusKey(['outp', 'remove', neighbour]) : focusKey(['nodetool', 'output', 'add']);
							return undefined;
						});
					},
				},
			]);
		} else {
			cell(tr, '');
		}
		tbody.appendChild(tr);
	}

	/** Добавление словарного параметра вывода: значение выбирается до отправки. */
	function openOutputParamDialog(variantName, path, name) {
		const dict = OUTPUT_PARAMS[name];
		let enumSelect;
		let numberCtl;
		let textCtl;
		openDialog(
			'Параметр вывода «' + name + '»',
			'Добавить',
			(body) => {
				if (dict.control === 'enum') {
					enumSelect = formRow(body, 'Значение', selectInput(dict.options, dict.defaultValue || dict.options[0].value));
				} else if (dict.control === 'number') {
					numberCtl = formRow(body, 'Значение', numberInput(undefined));
				} else {
					textCtl = formRow(body, 'Значение', textInput(''));
				}
			},
			() => {
				let value;
				if (dict.control === 'enum') {
					value = { type: dict.type, decoded: enumSelect.value };
				} else if (dict.control === 'number') {
					const error = outputNumberError(dict, numberCtl.value);
					if (error) {
						return error;
					}
					value = { type: 'xs:decimal', decoded: Number(numberCtl.value) };
				} else {
					value = { type: dict.type, decoded: textCtl.value.trim() };
				}
				if (!sendParameterValue(variantName, 'output', path, name, { value: value })) {
					return BUSY;
				}
				return undefined;
			}
		);
	}

	// ---------- панель «Условное оформление» ----------

	/** Области применения оформления: десять флагов useIn* контракта в порядке XSD. */
	const CA_USE_IN = [
		{ key: 'group', label: 'Группировка' },
		{ key: 'hierarchicalGroup', label: 'Иерархическая группировка' },
		{ key: 'overall', label: 'Общий итог' },
		{ key: 'fieldsHeader', label: 'Заголовок полей' },
		{ key: 'header', label: 'Заголовок' },
		{ key: 'parameters', label: 'Параметры' },
		{ key: 'filter', label: 'Отбор' },
		{ key: 'resourceFieldsHeader', label: 'Заголовок полей ресурсов' },
		{ key: 'overallHeader', label: 'Заголовок общего итога' },
		{ key: 'overallResourceFieldsHeader', label: 'Заголовок полей ресурсов общего итога' },
	];

	/** Значения флага области: отсутствие — по умолчанию платформы, элемент не пишется. */
	const CA_USE_OPTIONS = [
		{ value: '', label: 'По умолчанию' },
		{ value: 'Use', label: 'Использовать' },
		{ value: 'DontUse', label: 'Не использовать' },
	];

	/** Словарь параметров оформления для добавления: надёжная лексика цветов и строк. */
	const CA_APPEARANCE_PARAMS = [
		{ name: 'ЦветФона', type: 'v8ui:Color' },
		{ name: 'ЦветТекста', type: 'v8ui:Color' },
		{ name: 'ЦветГраницы', type: 'v8ui:Color' },
		{ name: 'Текст', type: 'v8:LocalStringType' },
		{ name: 'Формат', type: 'v8:LocalStringType' },
	];

	/** Сводка оформления: включённые параметры со значениями. */
	function appearanceSummary(items) {
		const parts = [];
		for (const item of Array.isArray(items) ? items : []) {
			if (item.use === false) {
				continue;
			}
			parts.push((item.parameter || '') + ': ' + (valuesSummary(item.value) || '—'));
		}
		return parts.join('; ');
	}

	/** Сводка областей применения: только изменённые флаги, «+» использовать, «−» нет. */
	function useInSummary(useIn) {
		if (!useIn) {
			return '';
		}
		const parts = [];
		for (const flag of CA_USE_IN) {
			if (useIn[flag.key] === 'Use') {
				parts.push('+ ' + flag.label.toLowerCase());
			} else if (useIn[flag.key] === 'DontUse') {
				parts.push('− ' + flag.label.toLowerCase());
			}
		}
		return parts.join(', ');
	}

	function caFieldsSummary(fields) {
		const items = Array.isArray(fields) ? fields : [];
		if (items.length === 0) {
			return '<Вся область>';
		}
		return items.map((item) => (item.use === false ? '(' + (item.field || '') + ')' : item.field || '')).join(', ');
	}

	function renderAppearancePanel(host, node, path, variantName) {
		const items = sectionItems(node.conditionalAppearance);
		listToolbar(host, [
			{
				icon: 'add',
				name: 'Добавить оформление…',
				key: focusKey(['nodetool', 'appearance', 'add']),
				onClick: () => {
					openAppearanceDialog(variantName, path, null, -1);
				},
			},
		]);
		if (items.length === 0) {
			host.appendChild(el('div', 'dcs-plate', 'Условного оформления нет.'));
		} else {
			const tbody = dataTable(host, ['', 'Оформление', 'Условие', 'Оформляемые поля', 'Представление', 'Область', '']);
			items.forEach((item, index) => {
				const tr = document.createElement('tr');
				if (item.use === false) {
					tr.className = 'dcs-row-off';
				}
				const checkTd = el('td', 'dcs-cell-check');
				const box = el('input', 'edit-check');
				box.type = 'checkbox';
				box.checked = item.use !== false;
				// Имя — элемент оформления (у колонки флажков нет заголовка); ключ — по номеру, как у кнопок строки
				box.setAttribute('aria-label', 'Использовать: ' + (item.presentation || appearanceSummary(item.appearance) || 'элемент ' + (index + 1)));
				keyed(box, focusKey(['appr', 'use', String(index)]));
				box.addEventListener('change', () => {
					const next = cloneItems([item])[0];
					if (box.checked) {
						delete next.use;
					} else {
						next.use = false;
					}
					if (!send('dcs/set-appearance-item', { variant: variantName, payload: { path: path, index: index, item: next } })) {
						setStatus(BUSY, true);
						box.checked = !box.checked;
					}
				});
				checkTd.appendChild(box);
				tr.appendChild(checkTd);
				cell(tr, appearanceSummary(item.appearance));
				cell(tr, filterSummary(item.filter));
				cell(tr, caFieldsSummary(item.fields));
				const presTd = cell(tr, item.presentation || '');
				const badge = userSettingBadge(item);
				if (badge) {
					presTd.appendChild(badge);
				}
				cell(tr, useInSummary(item.useIn));
				// Ключи — по номеру: после правки фокус на той же кнопке, после удаления — у строки, занявшей место удалённой
				const deleteKey = (at) => focusKey(['appr', 'delete', String(at)]);
				actionsCell(tr, [
					{
						svg: 'edit',
						title: 'Править',
						key: focusKey(['appr', 'edit', String(index)]),
						onClick: () => {
							openAppearanceDialog(variantName, path, item, index);
						},
					},
					{
						svg: 'delete',
						title: 'Удалить',
						danger: true,
						key: deleteKey(index),
						onClick: () => {
							confirmRemove('Удалить элемент оформления «' + (item.presentation || appearanceSummary(item.appearance) || index + 1) + '»?', () => {
								if (!send('dcs/remove-appearance-item', { variant: variantName, payload: { path: path, index: index } })) {
									return BUSY;
								}
								rowRemovalFocus(deleteKey, index, focusKey(['nodetool', 'appearance', 'add']));
								return undefined;
							});
						},
					},
				]);
				tbody.appendChild(tr);
			});
		}
	}

	/** Оформляемые поля: галка использования, путь и удаление; добавление с подсказками. */
	function caFieldsEditor(body, initialFields) {
		const state = { fields: cloneItems(Array.isArray(initialFields) ? initialFields : []), changed: false };
		const host = el('div', 'dcs-ca-fields');
		body.appendChild(host);
		const addRow = el('div', 'dcs-ca-add');
		const input = textInput('');
		input.placeholder = 'путь поля';
		input.setAttribute('aria-label', 'Путь поля');
		const button = iconButton({
			icon: 'add',
			name: 'Добавить поле',
			className: 'struct-btn',
			onClick: () => {
				const field = input.value.trim();
				if (!field) {
					input.focus();
					return;
				}
				state.fields.push({ field: field });
				state.changed = true;
				input.value = '';
				rerender();
			},
		});
		addRow.appendChild(input);
		addRow.appendChild(button);
		// Подсказка — когда поле уже в строке: кнопка «⋯» встаёт между полем и «Добавить поле»
		attachFieldList(input);
		body.appendChild(addRow);
		/** focusAt — номер строки, «Убрать» которой получит фокус (кнопка с фокусом ушла вместе со строкой). */
		function rerender(focusAt) {
			host.textContent = '';
			const removeButtons = [];
			if (state.fields.length === 0) {
				host.appendChild(el('div', 'empty', 'Полей нет: оформляется вся область действия элемента.'));
			}
			state.fields.forEach((field, index) => {
				const row = el('div', 'dcs-ca-field-row');
				const box = checkbox(field.field || '', field.use !== false);
				box.input.addEventListener('change', () => {
					if (box.input.checked) {
						delete state.fields[index].use;
					} else {
						state.fields[index].use = false;
					}
					state.changed = true;
				});
				row.appendChild(box.wrap);
				const removeBtn = iconButton({
					icon: 'delete',
					name: 'Убрать поле «' + (field.field || '') + '»',
					className: 'struct-btn struct-btn-danger',
					onClick: () => {
						state.fields.splice(index, 1);
						state.changed = true;
						rerender(index);
					},
				});
				row.appendChild(removeBtn);
				removeButtons.push(removeBtn);
				host.appendChild(row);
			});
			if (focusAt !== undefined) {
				const target = removeButtons[Math.min(focusAt, removeButtons.length - 1)] || input;
				target.focus();
			}
		}
		rerender();
		return {
			current: () => state.fields,
			changed: () => state.changed,
		};
	}

	// ---------- окно «Форматная строка» ----------

	/** Разбор, сборка и пример форматной строки (dcs-editor-format.js). */
	const formatRules = window.DcsFormat;

	/** Параметр оформления, значение которого — форматная строка: «Формат» (в английской выгрузке — Format). */
	function isFormatParameter(name) {
		const key = String(name || '')
			.trim()
			.toLowerCase();
		return key === 'формат' || key === 'format';
	}

	const FORMAT_TITLE = 'Форматная строка';

	/** Вкладки окна по виду значения; «Язык (страна)» общий для всех — он над вкладками. */
	const FORMAT_TABS = [
		{ id: 'number', title: 'Число' },
		{ id: 'date', title: 'Дата' },
		{ id: 'boolean', title: 'Логическое' },
	];

	/**
	 * Значение ключа, который включили флажком при пустом поле: иначе в строку ушло бы «ЧЦ=» без
	 * числа. Значения свои, а не умолчания платформы, — их правят тут же в поле. ЧРД — запятая, как у
	 * конструктора платформы и русской локали: точка по одному флажку переводила бы отчёт на десятичную точку.
	 */
	const FORMAT_DEFAULTS = { Л: 'ru_RU', ЧЦ: '10', ЧДЦ: '2', ЧС: '0', ЧРД: ',', ЧГ: '3,0', ЧО: '1', ДФ: 'dd.MM.yyyy', ДЛФ: 'D' };

	/** Подсказка формы значения в пустом поле. */
	const FORMAT_PLACEHOLDERS = { locale: 'ru_RU', grouping: '3,0', pattern: 'dd.MM.yyyy' };

	/** Пример по умолчанию: у отрицательного дробного числа видны группы, дробь и минус. */
	const FORMAT_SAMPLES = { number: '-1234567.891', date: '2026-03-08T09:05:07' };

	/** Пустой итог примера показывается словами: пустая строка на экране не видна. */
	const FORMAT_EMPTY_PREVIEW = '(пустая строка)';

	/** Вариант списка «как записано» для значения, которого нет среди известных: оно остаётся дословно. */
	const FORMAT_RAW_CHOICE = 'raw';

	/** Счётчик окон: id вкладок и панелей свои у каждого открытия, чтобы aria-controls не связали чужие. */
	let formatDialogCount = 0;

	/** Ошибка целого значения ключа (ЧЦ, ЧДЦ, ЧС); пусто — значение подходит. Границы свои. */
	function formatIntegerProblem(name, value) {
		if (!/^[-+]?\d+$/.test(value)) {
			return 'укажите целое число';
		}
		const number = parseInt(value, 10);
		if (name === 'ЧЦ' && number < 1) {
			return 'укажите целое число больше нуля';
		}
		if (name === 'ЧДЦ' && number < 0) {
			return 'укажите целое число не меньше нуля';
		}
		return '';
	}

	/** Варианты списка ключа: ЧО — вид отрицательного числа, ДЛФ — вид даты по локали. */
	function formatChoiceOptions(info) {
		if (info.name === 'ДЛФ') {
			return formatRules.DLF_OPTIONS.map((option) => ({ value: option.value, ru: option.ru, label: option.value + ' — ' + option.label }));
		}
		return formatRules.NN_OPTIONS.map((option) => ({ value: option.value, label: option.value + ' — ' + option.label }));
	}

	/** Вариант списка, которому равно записанное значение (ДЛФ — и латиницей, и кириллицей); нет такого — ''. */
	function formatChoiceOf(options, stored) {
		const text = String(stored).trim().toUpperCase();
		const found = options.find((option) => option.value.toUpperCase() === text || (option.ru && option.ru.toUpperCase() === text));
		return found ? found.value : '';
	}

	/** Строка «Прочих параметров»: параметр или сегмент без «=», как он записан в строке. */
	function formatUnknownText(item) {
		return (typeof item.raw === 'string' ? item.raw : (item.key || '') + '=' + (item.value || '')).trim();
	}

	/**
	 * Окно «Форматная строка» — уровень стека над окном оформления. Сверху «Язык (страна)», ниже
	 * вкладки Число / Дата / Логическое: у каждого ключа флажок (ключ есть в строке) и поле значения,
	 * на вкладке — пример. Внизу итоговая строка; её можно править и руками, поля тогда перечитываются.
	 *
	 * Строку собирает модуль форматной строки от разобранной: нетронутые параметры, неизвестные ключи
	 * и английские имена остаются дословно, неизменённая строка возвращается байт в байт. Поэтому ОК
	 * без правок ничего не меняет. spec: {text, onDone(text)} — onDone зовётся, только если строка
	 * изменилась.
	 */
	function openFormatDialog(spec) {
		const rules = formatRules;
		const initialText = String(spec.text == null ? '' : spec.text);
		const initial = rules.parseFormat(initialText);
		const uid = 'dcsFmt' + ++formatDialogCount;
		const state = {
			// Разобранная строка, от которой считаются правки полей: исходная или набранная руками в поле строки
			base: initial,
			tab: '',
		};
		// Ключ в подписи — на языке имён строки: у «ND=10; NFD=2» подпись «Всего цифр (ND)», как ключ записан
		const lang = initial.lang === 'en' ? 'en' : 'ru';
		const entries = [];
		const tabs = [];
		const previews = [];
		let level = null;
		let textArea = null;
		let unknownEl = null;

		function storedOf(entry) {
			return rules.getValue(state.base, entry.info.name);
		}

		/** Строка по полям: от base меняются только выключенные ключи и включённые с новым значением. */
		function current() {
			let struct = state.base;
			for (const entry of entries) {
				const stored = storedOf(entry);
				if (!entry.box.input.checked) {
					if (stored !== undefined) {
						struct = rules.removeKey(struct, entry.info.name);
					}
					continue;
				}
				const value = entry.read(stored);
				if (stored === undefined || value !== stored) {
					struct = rules.setValue(struct, entry.info.name, value);
				}
			}
			return struct;
		}

		function keyName(info) {
			return lang === 'en' ? info.en : info.name;
		}

		/** Включённый ключ с пустым полем получает значение по умолчанию: «ЧЦ=» без числа ничего не значит. */
		function fillDefault(entry) {
			const fallback = FORMAT_DEFAULTS[entry.info.name];
			if (entry.input && entry.input.value === '' && fallback !== undefined) {
				entry.input.value = fallback;
			}
		}

		/** Строка ключа: флажок с подписью «что — (ключ)» и поле значения; у флага ЧВН поля нет. */
		function entryRow(host, info, tab) {
			const label = info.label + ' (' + keyName(info) + ')';
			const row = el('div', 'dcs-fmt-row');
			const box = checkbox(label, false);
			row.appendChild(box.wrap);
			const entry = { info: info, tab: tab, box: box, control: null, input: null, read: () => '', show: () => undefined };
			if (info.kind === 'choice') {
				const options = formatChoiceOptions(info);
				// Новый ключ начинается с умолчания окна (ЧО=1 — обычный минус), а не с первого варианта списка
				const fallback = options.some((option) => option.value === FORMAT_DEFAULTS[info.name]) ? FORMAT_DEFAULTS[info.name] : options[0].value;
				const select = selectInput(options, fallback);
				select.classList.add('dcs-fmt-input');
				let rawOption = null;
				entry.read = (stored) => {
					if (select.value === FORMAT_RAW_CHOICE) {
						return stored === undefined ? '' : stored;
					}
					// Тот же вариант, что записан (ДЛФ=Д кириллицей), пишется как был: строка не меняется
					return stored !== undefined && formatChoiceOf(options, stored) === select.value ? stored : select.value;
				};
				entry.show = (stored) => {
					// Вариант «как записано» живёт, пока в строке его значение: иначе включённый ключ ушёл бы пустым
					if (rawOption) {
						rawOption.remove();
						rawOption = null;
						select.value = fallback;
					}
					if (stored === undefined) {
						return;
					}
					const known = formatChoiceOf(options, stored);
					if (known) {
						select.value = known;
						return;
					}
					rawOption = document.createElement('option');
					rawOption.value = FORMAT_RAW_CHOICE;
					rawOption.textContent = 'как записано: «' + stored + '»';
					select.appendChild(rawOption);
					select.value = FORMAT_RAW_CHOICE;
				};
				select.addEventListener('change', () => {
					box.input.checked = true;
					refresh();
				});
				entry.control = select;
			} else if (info.kind !== 'flag') {
				const input = textInput('');
				input.classList.add('dcs-fmt-input');
				if (info.kind === 'integer') {
					input.inputMode = 'numeric';
				}
				if (FORMAT_PLACEHOLDERS[info.kind]) {
					input.placeholder = FORMAT_PLACEHOLDERS[info.kind];
				}
				entry.read = (stored) => {
					if (info.kind !== 'integer') {
						return input.value;
					}
					// Число сравнивается без пробелов по краям: записанное « 15» не переписывается в «15» само
					const value = input.value.trim();
					return stored !== undefined && String(stored).trim() === value ? stored : value;
				};
				entry.show = (stored) => {
					if (stored !== undefined) {
						input.value = stored;
					}
				};
				input.addEventListener('input', () => {
					input.removeAttribute('aria-invalid');
					// Набранное значение без флажка потерялось бы: ввод сам включает ключ
					box.input.checked = true;
					refresh();
				});
				entry.control = input;
				entry.input = input;
			} else {
				// ЧВН — сам ключ: записанное значение переносится как было, новый пишется без значения
				entry.read = (stored) => (stored === undefined ? '' : stored);
			}
			if (entry.control) {
				entry.control.setAttribute('aria-label', label + ': значение');
				row.appendChild(entry.control);
			}
			box.input.addEventListener('change', () => {
				if (box.input.checked) {
					fillDefault(entry);
				}
				refresh();
			});
			host.appendChild(row);
			entries.push(entry);
			return entry;
		}

		/** Поля по разобранной строке: флажок — есть ли ключ, поле — его значение. */
		function sync() {
			for (const entry of entries) {
				const stored = storedOf(entry);
				entry.box.input.checked = stored !== undefined;
				entry.show(stored);
				if (entry.control) {
					entry.control.removeAttribute('aria-invalid');
				}
			}
		}

		/** Пример вкладки: значение для примера → как его покажет строка (своё приближение, не платформа). */
		function previewBlock(host, tab) {
			const box = el('div', 'dcs-fmt-preview');
			box.appendChild(el('span', 'dcs-fmt-preview-label', 'Пример:'));
			let sample;
			if (tab === 'number') {
				sample = textInput(FORMAT_SAMPLES.number);
				sample.inputMode = 'decimal';
			} else if (tab === 'date') {
				sample = dateTimeInput(FORMAT_SAMPLES.date);
			} else {
				sample = selectInput(
					[
						{ value: 'true', label: 'Истина' },
						{ value: 'false', label: 'Ложь' },
					],
					'true'
				);
			}
			sample.classList.add('dcs-fmt-sample');
			sample.setAttribute('aria-label', 'Значение для примера');
			sample.addEventListener(tab === 'boolean' ? 'change' : 'input', () => {
				refresh();
			});
			box.appendChild(sample);
			const arrow = el('span', 'dcs-fmt-arrow', '→');
			arrow.setAttribute('aria-hidden', 'true');
			box.appendChild(arrow);
			const result = el('span', 'dcs-fmt-result');
			// Итог примера меняется от каждого поля: читалка слышит его, не уходя с поля
			result.setAttribute('aria-live', 'polite');
			box.appendChild(result);
			host.appendChild(box);
			previews.push({
				tab: tab,
				sample: sample,
				result: result,
				paint: (struct) => {
					let value;
					if (tab === 'number') {
						const raw = sample.value.replace(/\s/g, '').replace(',', '.');
						value = raw !== '' && Number.isFinite(Number(raw)) ? Number(raw) : null;
					} else if (tab === 'date') {
						// Пустое поле — пустая дата платформы: так виден ключ «Как выводить пустую дату»
						value = dateLexicalOf(sample) || DCS_ZERO_DATE;
					} else {
						value = sample.value === 'true';
					}
					if (value === null) {
						result.textContent = 'введите число';
						return;
					}
					const text = rules.preview(struct, value);
					result.textContent = text === '' ? FORMAT_EMPTY_PREVIEW : text;
				},
			});
		}

		function pickTab(id, focus) {
			state.tab = id;
			for (const tab of tabs) {
				const active = tab.id === id;
				tab.button.classList.toggle('active', active);
				tab.button.setAttribute('aria-selected', String(active));
				// Одна остановка Tab на полосе — активная вкладка, соседние — стрелками
				tab.button.tabIndex = active ? 0 : -1;
				tab.panel.classList.toggle('hidden', !active);
				if (active && focus) {
					tab.button.focus();
				}
			}
		}

		function tabKey(event, index) {
			const last = tabs.length - 1;
			let to = -1;
			if (event.key === 'ArrowRight') {
				to = index === last ? 0 : index + 1;
			} else if (event.key === 'ArrowLeft') {
				to = index === 0 ? last : index - 1;
			} else if (event.key === 'Home') {
				to = 0;
			} else if (event.key === 'End') {
				to = last;
			}
			if (to < 0) {
				return;
			}
			event.preventDefault();
			pickTab(tabs[to].id, true);
		}

		function refresh() {
			const struct = current();
			const text = rules.buildFormat(struct);
			// Поле строки, в котором печатают, уже равно сборке: не трогаем его, чтобы не сбить каретку
			if (textArea.value !== text) {
				textArea.value = text;
			}
			const unknown = struct.unknown.map(formatUnknownText).filter(Boolean);
			unknownEl.textContent = unknown.length
				? 'Прочие параметры — окно их не разбирает и переносит как записаны: ' + unknown.join('; ')
				: '';
			for (const item of previews) {
				item.paint(struct);
			}
			if (level) {
				level.setTitle(FORMAT_TITLE, text !== initialText);
			}
		}

		function build(body, owner) {
			level = owner;
			const common = el('div', 'dcs-fmt-common');
			for (const info of rules.KEYS) {
				if (info.group === 'common') {
					entryRow(common, info, '');
				}
			}
			body.appendChild(common);
			const strip = el('div', 'tabs dcs-subtabs dcs-fmt-tabs');
			strip.setAttribute('role', 'tablist');
			strip.setAttribute('aria-label', 'Вид значения');
			body.appendChild(strip);
			FORMAT_TABS.forEach((item, index) => {
				const button = el('button', 'tab', item.title);
				button.type = 'button';
				button.id = uid + '-tab-' + item.id;
				button.setAttribute('role', 'tab');
				const panel = el('div', 'dcs-fmt-panel');
				panel.id = uid + '-panel-' + item.id;
				panel.setAttribute('role', 'tabpanel');
				panel.setAttribute('aria-labelledby', button.id);
				button.setAttribute('aria-controls', panel.id);
				button.addEventListener('click', () => {
					pickTab(item.id, false);
				});
				button.addEventListener('keydown', (event) => {
					tabKey(event, index);
				});
				strip.appendChild(button);
				for (const info of rules.KEYS) {
					if (info.group === item.id) {
						entryRow(panel, info, item.id);
					}
				}
				previewBlock(panel, item.id);
				body.appendChild(panel);
				tabs.push({ id: item.id, button: button, panel: panel });
			});
			body.appendChild(el('div', 'dcs-ro-note dcs-fmt-note', rules.PREVIEW_NOTE));
			unknownEl = el('div', 'dcs-ro-note dcs-fmt-unknown');
			body.appendChild(unknownEl);
			textArea = el('textarea', 'edit-input dcs-fmt-text');
			textArea.rows = 2;
			textArea.spellcheck = false;
			// Имя поля — видимая подпись строки: читалка и голосовое управление находят его по тому, что
			// написано на экране (WCAG 2.5.3), а не по заголовку окна
			textArea.setAttribute('aria-label', 'Итоговая строка');
			textArea.value = initialText;
			textArea.addEventListener('input', () => {
				// Строка, набранная руками, становится новой основой: поля перечитываются из неё
				state.base = rules.parseFormat(textArea.value);
				sync();
				refresh();
			});
			formRow(body, 'Итоговая строка', textArea);
			sync();
			// Открывается вкладка первого записанного ключа: у «ДФ=dd.MM.yyyy» — «Дата», у пустой строки — «Число»
			const first = FORMAT_TABS.find((item) => rules.KEYS.some((info) => info.group === item.id && rules.hasKey(initial, info.name)));
			pickTab((first || FORMAT_TABS[0]).id, false);
			refresh();
		}

		function submit(owner) {
			for (const entry of entries) {
				if (entry.info.kind !== 'integer' || !entry.box.input.checked) {
					continue;
				}
				const value = entry.read(storedOf(entry));
				// Записанное до окна не проверяем: его не трогали, и отказ на чужом значении не дал бы закрыть окно
				if (value === rules.getValue(initial, entry.info.name)) {
					continue;
				}
				const problem = formatIntegerProblem(entry.info.name, value);
				if (problem) {
					if (entry.tab) {
						pickTab(entry.tab, false);
					}
					entry.control.setAttribute('aria-invalid', 'true');
					entry.control.focus();
					return '«' + entry.info.label + '» (' + keyName(entry.info) + '): ' + problem + '.';
				}
			}
			const text = rules.buildFormat(current());
			if (text !== initialText) {
				spec.onDone(text);
			}
			owner.close();
			return undefined;
		}

		return pushDialog({
			title: FORMAT_TITLE,
			width: 'wide',
			build: build,
			buttons: [
				{ id: 'ok', label: 'ОК', primary: true, onClick: submit },
				{ id: 'cancel', label: 'Отмена' },
			],
		});
	}

	/** Кнопка «…» у значения «Формат»: окно форматной строки над окном оформления правит текст поля. */
	function formatStringButton(input) {
		const button = el('button', 'ghost-btn dcs-btn-small dcs-fmt-open', '…');
		button.type = 'button';
		button.title = 'Конструктор форматной строки';
		button.setAttribute('aria-label', 'Конструктор форматной строки');
		button.addEventListener('click', () => {
			openFormatDialog({
				text: input.value,
				onDone: (text) => {
					input.value = text;
				},
			});
		});
		return button;
	}

	/**
	 * Параметры оформления внутри диалога: цвета, строки и прочие простые типы правятся,
	 * шрифт и незнакомые — только показ, их строки не удаляются. Правки собираются при submit.
	 */
	function caAppearanceEditor(body, initialItems) {
		const rows = [];
		let structureChanged = false;
		// Добавление — над таблицей, как у «Других настроек»; список, а не пиктограмма: выбирается имя
		const addRow = el('div', 'dcs-ca-add');
		const addSelect = el('select', 'edit-ref-add-select');
		addSelect.setAttribute('aria-label', 'Добавить параметр оформления');
		addRow.appendChild(addSelect);
		body.appendChild(addRow);
		const host = el('div', 'dcs-ca-appearance');
		body.appendChild(host);
		const tbody = dataTable(host, ['', 'Параметр', 'Значение', '']);
		function refreshAdd() {
			addSelect.textContent = '';
			const first = document.createElement('option');
			first.value = '';
			first.textContent = '+ Добавить параметр';
			addSelect.appendChild(first);
			for (const entry of CA_APPEARANCE_PARAMS) {
				if (rows.some((row) => !row.removed && row.item.parameter === entry.name)) {
					continue;
				}
				const option = document.createElement('option');
				option.value = entry.name;
				option.textContent = entry.name;
				addSelect.appendChild(option);
			}
			addSelect.classList.toggle('hidden', addSelect.options.length === 1);
		}
		function appendRow(row) {
			const tr = document.createElement('tr');
			const checkTd = el('td', 'dcs-cell-check');
			row.useBox = el('input', 'edit-check');
			row.useBox.type = 'checkbox';
			row.useBox.checked = row.item.use !== false;
			checkTd.appendChild(row.useBox);
			tr.appendChild(checkTd);
			const nameTd = cell(tr, row.item.parameter || '');
			const badge = userSettingBadge(row.item);
			if (badge) {
				nameTd.appendChild(badge);
			}
			const values = Array.isArray(row.item.value) ? row.item.value : [];
			const valueTd = el('td');
			if (editableValues(values)) {
				// Тип существующего значения не переключается; пустое и «Неопределено» выбирают тип
				row.control = createValueControl(values[0], {
					fixedMode: Boolean(values[0]) && !values[0].nil,
					typeHint: values[0] ? undefined : 'string',
					attachFields: (input) => {
						attachFieldList(input);
					},
					// У «Формат» — «…» окна форматной строки. Окно правит текст поля, а тип имеющегося значения
					// (v8:LocalStringType или xs:string) держит сам контрол: fixedMode его не переключает
					textButton: isFormatParameter(row.item.parameter) ? formatStringButton : undefined,
				});
				valueTd.appendChild(row.control.root);
			} else {
				valueTd.appendChild(el('span', 'dcs-ro-note', (valuesSummary(values) || '—') + ' — правится в конфигураторе'));
			}
			tr.appendChild(valueTd);
			if (row.control) {
				actionsCell(tr, [
					{
						svg: 'delete',
						title: 'Убрать параметр «' + (row.item.parameter || '') + '»',
						danger: true,
						onClick: () => {
							row.removed = true;
							structureChanged = true;
							// Кнопка с фокусом уходит вместе со строкой: фокус — на «Убрать» следующей строки, иначе предыдущей,
							// иначе на список добавления
							const at = rows.indexOf(row);
							const live = rows.filter((other) => !other.removed && other.removeBtn);
							const neighbour = live.find((other) => rows.indexOf(other) > at) || live.filter((other) => rows.indexOf(other) < at).pop();
							tr.remove();
							refreshAdd();
							if (neighbour) {
								neighbour.removeBtn.focus();
							} else if (!addSelect.classList.contains('hidden')) {
								addSelect.focus();
							}
						},
					},
				]);
				row.removeBtn = tr.children[tr.children.length - 1].children[0];
			} else {
				cell(tr, '');
			}
			tbody.appendChild(tr);
		}
		for (const item of cloneItems(Array.isArray(initialItems) ? initialItems : [])) {
			const row = { item: item, removed: false };
			rows.push(row);
			appendRow(row);
		}
		// Стрелки на закрытом списке только выбирают имя, добавляет Enter или выбор мышью (actionSelect)
		actionSelect(addSelect, (name) => {
			const entry = CA_APPEARANCE_PARAMS.filter((candidate) => candidate.name === name)[0];
			const row = {
				item: { parameter: entry.name, value: [{ type: entry.type, decoded: entry.type === 'v8ui:Color' ? 'auto' : '' }] },
				removed: false,
				added: true,
			};
			rows.push(row);
			appendRow(row);
			structureChanged = true;
			refreshAdd();
		});
		refreshAdd();
		function rowUseChanged(row) {
			return row.useBox && row.useBox.checked !== (row.item.use !== false);
		}
		return {
			validate: function () {
				for (const row of rows) {
					if (row.removed || !row.control) {
						continue;
					}
					const error = row.control.validate();
					if (error) {
						return 'Параметр «' + (row.item.parameter || '') + '»: ' + error + '.';
					}
				}
				return undefined;
			},
			changed: function () {
				return (
					structureChanged ||
					rows.some((row) => !row.removed && (rowUseChanged(row) || (row.control && row.control.result() !== undefined)))
				);
			},
			current: function () {
				const result = [];
				for (const row of rows) {
					if (row.removed) {
						continue;
					}
					const value = row.control ? row.control.result() : undefined;
					if (!row.added && value === undefined && !rowUseChanged(row)) {
						result.push(row.item);
						continue;
					}
					const next = cloneItems([row.item])[0];
					if (!row.useBox || row.useBox.checked) {
						delete next.use;
					} else {
						next.use = false;
					}
					if (value === null) {
						next.value = [{ nil: true }];
					} else if (value !== undefined) {
						next.value = [value];
					}
					result.push(next);
				}
				return result;
			},
		};
	}

	/** Диалог элемента условного оформления: оформление, условие, поля и области применения. */
	function openAppearanceDialog(variantName, path, original, index) {
		const item = original || {};
		let useBox;
		let presentationInput;
		let appearanceEd;
		let mini;
		let fieldsEd;
		const useInSelects = {};
		openWideDialog(
			original ? 'Элемент условного оформления' : 'Новый элемент условного оформления',
			original ? 'Сохранить' : 'Добавить',
			(body) => {
				useBox = checkbox('Использовать', item.use !== false);
				checkRow(body, [useBox]);
				presentationInput = formRow(body, 'Представление', textInput(item.presentation));
				groupTitle(body, 'Параметры оформления');
				appearanceEd = caAppearanceEditor(body, item.appearance);
				groupTitle(body, 'Условие');
				mini = filterMiniEditor(body, item.filter, 'Условий нет: оформление действует всегда.');
				groupTitle(body, 'Оформляемые поля');
				fieldsEd = caFieldsEditor(body, item.fields);
				groupTitle(body, 'Область использования');
				const grid = el('div', 'dcs-usein-grid');
				for (const flag of CA_USE_IN) {
					const row = el('label', 'dcs-usein-row');
					row.appendChild(el('span', 'dcs-usein-label', flag.label));
					const select = selectInput(CA_USE_OPTIONS, (item.useIn && item.useIn[flag.key]) || '');
					useInSelects[flag.key] = select;
					row.appendChild(select);
					grid.appendChild(row);
				}
				body.appendChild(grid);
			},
			() => {
				if (mini.formOpen()) {
					return MINI_FORM_OPEN;
				}
				const appearanceError = appearanceEd.validate();
				if (appearanceError) {
					return appearanceError;
				}
				const next = original ? cloneItems([original])[0] : {};
				if (useBox.input.checked) {
					delete next.use;
				} else {
					next.use = false;
				}
				const presentation = presentationInput.value.trim();
				if (presentation) {
					next.presentation = presentation;
				} else {
					delete next.presentation;
				}
				if (!original || appearanceEd.changed()) {
					const appearance = appearanceEd.current();
					if (appearance.length > 0) {
						next.appearance = appearance;
					} else {
						delete next.appearance;
					}
				}
				if (!original || mini.changed()) {
					const filter = mini.current();
					if (filter.length > 0) {
						next.filter = filter;
					} else {
						delete next.filter;
					}
				}
				if (!original || fieldsEd.changed()) {
					const fields = fieldsEd.current();
					if (fields.length > 0) {
						next.fields = fields;
					} else {
						delete next.fields;
					}
				}
				const useIn = {};
				let hasUseIn = false;
				for (const flag of CA_USE_IN) {
					if (useInSelects[flag.key].value) {
						useIn[flag.key] = useInSelects[flag.key].value;
						hasUseIn = true;
					}
				}
				if (hasUseIn) {
					next.useIn = useIn;
				} else {
					delete next.useIn;
				}
				if (original) {
					if (!send('dcs/set-appearance-item', { variant: variantName, payload: { path: path, index: index, item: next } })) {
						return BUSY;
					}
					return undefined;
				}
				if (!send('dcs/add-appearance-item', { variant: variantName, payload: { path: path, item: next } })) {
					return BUSY;
				}
				return undefined;
			}
		);
	}

	// ---------- панель «Пользовательские поля» (только показ) ----------

	function renderUserFieldsPanel(host, node) {
		host.appendChild(el('div', 'dcs-plate', 'Пользовательские поля доступны только для просмотра.'));
		const items = Array.isArray(node.userFields) ? node.userFields : [];
		if (items.length === 0) {
			emptyNote(host, 'Пользовательских полей нет.');
			return;
		}
		for (const field of items) {
			const details = document.createElement('details');
			details.className = 'dcs-userfield';
			const summary = document.createElement('summary');
			summary.appendChild(el('span', 'dcs-kind', field.kind === 'case' ? 'Поле-выбор' : 'Поле-выражение'));
			summary.appendChild(nameEl('span', 'dcs-userfield-path', field.dataPath || ''));
			if (field.title) {
				summary.appendChild(nameEl('span', 'dcs-tree-name', field.title));
			}
			details.appendChild(summary);
			const bodyEl = el('div', 'dcs-userfield-body');
			if (field.kind === 'case') {
				bodyEl.appendChild(el('div', 'dcs-ro-note', 'Ветвей выбора: ' + (field.casesCount || 0) + '. Выражения ветвей правятся в конфигураторе.'));
			} else {
				bodyEl.appendChild(el('div', 'dcs-userfield-label', 'Детальные записи'));
				bodyEl.appendChild(el('pre', 'dcs-userfield-expr', field.detailExpression || ''));
				bodyEl.appendChild(el('div', 'dcs-userfield-label', 'Итоговые записи'));
				bodyEl.appendChild(el('pre', 'dcs-userfield-expr', field.totalExpression || ''));
			}
			details.appendChild(bodyEl);
			host.appendChild(details);
		}
	}

	// ---------- каркас вкладок ----------

	function visibleTabs() {
		return TABS.filter((tab) => tab.always === true || tab.count() > 0);
	}

	function renderTabs() {
		const tabs = visibleTabs();
		if (!tabs.some((tab) => tab.id === activeTabId)) {
			activeTabId = tabs[0] ? tabs[0].id : '';
		}
		// Ярлык с фокусом рисуется заново (число в скобках меняется): фокус остаётся на нём
		const focus = captureFocus([tabsRoot]);
		tabsRoot.textContent = '';
		for (const tab of tabs) {
			const button = document.createElement('button');
			button.type = 'button';
			button.className = 'tab' + (tab.id === activeTabId ? ' active' : '');
			// Какая закладка открыта, читалка слышит (класс active виден только глазу)
			if (tab.id === activeTabId) {
				button.setAttribute('aria-current', 'page');
			}
			const count = tab.count();
			button.textContent = count > 0 ? tab.title + ' (' + count + ')' : tab.title;
			keyed(button, focusKey(['tab', tab.id]));
			button.addEventListener('click', () => {
				// Правленый текст запроса записывается до смены закладки
				flushQueryEdits('nav');
				if (tab.id !== activeTabId) {
					// Ответ правки, отправленной с другой закладки, фокус сюда не переносит
					clearReplyFocus();
				}
				activeTabId = tab.id;
				renderTabs();
				renderContent();
			});
			tabsRoot.appendChild(button);
		}
		restoreFocus(focus);
	}

	function renderContent() {
		const focus = captureFocus([contentRoot]);
		closeCompletionWithin(contentRoot);
		renderingContent = true;
		try {
			contentRoot.textContent = '';
		} finally {
			renderingContent = false;
		}
		queryStatusRefresh = null;
		// Ключи ярлыков закладок живут дольше содержимого: их узлы перерисовывает renderTabs
		for (const key of Array.from(focusKeys.keys())) {
			if (!key.startsWith('tab\n')) {
				focusKeys.delete(key);
			}
		}
		const tab = visibleTabs().find((candidate) => candidate.id === activeTabId);
		if (!tab) {
			emptyNote(contentRoot, 'Схема пуста.');
			return;
		}
		tab.render(contentRoot);
		restoreFocus(focus);
	}

	// Ответ, пришедший во время переноса мышью, ждёт его конца: перерисовка убрала бы строку из-под указателя
	window.addEventListener('message', (event) => whenIdle(() => onHostMessage(event)));

	function onHostMessage(event) {
		const msg = event.data;
		if (!msg || typeof msg !== 'object') {
			return;
		}
		if (msg.type === 'validation') {
			// Вердикт строгой проверки схемы: плашка с ошибками или «ошибок нет» и предупреждениями
			validating = false;
			validateBtn.disabled = false;
			if (msg.error) {
				showNotice('error', 'Проверка схемы', [{ text: String(msg.error) }]);
				return;
			}
			showNotice(validationNoticeTone(msg), 'Проверка схемы', validationNoticeLines(msg));
			return;
		}
		if (msg.type === 'metadata') {
			// Ответ конструктору запроса: дерево объектов
			if (msg.loading) {
				// Дерева нет и в кэше хоста: загрузка идёт с нуля, готовое дерево придёт следующим ответом
				qcGroupsCold = true;
			} else {
				qcGroupsLoading = false;
				qcGroupsCold = false;
				if (msg.error) {
					qcGroupsError = String(msg.error);
				} else {
					qcGroups = Array.isArray(msg.groups) ? msg.groups : [];
					qcGroupsError = '';
				}
			}
			rerenderSoon(qcRerender);
			// Дерево знает, каких объектов нет в конфигурации: строке проверки имён набора это нужно
			scheduleNameCheck();
			return;
		}
		if (msg.type === 'queryTables') {
			// Таблицы объекта для конструктора: в кэш вкладки по пути и языку; «вне выгрузки» и
			// ошибка — описания нет, повтора нет (повтор — новым открытием вкладки)
			if (typeof msg.relativePath === 'string' && msg.relativePath !== '') {
				const ready = !msg.error && !msg.outside && msg.description && typeof msg.description === 'object';
				// Составы — до обоих кэшей: описание в них одно и то же
				const description = ready ? withTypeCompositions(msg.description) : null;
				queryTablesCache.set(
					queryTablesKey(msg.relativePath, msg.lang),
					ready
						? { state: 'ready', description: description }
						: { state: 'error', error: String(msg.error || msg.note || 'Таблицы объекта не прочитаны.') }
				);
				// Тот же ответ cf-md-query-tables нужен и полям источников конструктора, и подсказке через
				// точку (кэш описаний по имени объекта): второе чтение jar того же объекта не нужно
				const key = ready ? fieldTypes.answerKeyOf({ queryTable: description.object, lang: msg.lang }) : '';
				const known = key ? describeCache.get(key) : null;
				if (key && (!known || known.state === 'loading')) {
					describeCache.set(key, { state: 'ready', description: description });
					describeStamp++;
				}
			}
			rerenderSoon(qcRerender);
			scheduleNameCheck();
			return;
		}
		if (msg.type === 'typeDictionary') {
			// Словарь окна типа — в кэш вкладки; ошибка — плашкой в окне, повтор — её кнопкой
			typeDictionaryLoading = false;
			if (msg.error) {
				typeDictionaryError = String(msg.error);
			} else if (msg.dictionary && typeof msg.dictionary === 'object') {
				typeDictionary = msg.dictionary;
				typeDictionaryError = '';
			} else {
				typeDictionaryError = 'Ответ словаря типов не разобран.';
			}
			rerenderSoon(typeRerender);
			return;
		}
		if (msg.type === 'describeType') {
			// Описание объекта для подсказки через точку: в кэш вкладки; «вне выгрузки» гасит
			// дальнейшие запросы, ошибка и ненайденный объект — «описания нет» без повторов
			if (msg.outside) {
				describeOutside = true;
			}
			const key = fieldTypes.answerKeyOf(msg);
			if (key) {
				const ready = !msg.error && msg.description && typeof msg.description === 'object';
				describeCache.set(key, ready ? { state: 'ready', description: withTypeCompositions(msg.description) } : { state: 'none' });
				describeStamp++;
			}
			onDescribed();
			// Раскрытое поле «Доступных полей» «Настроек» ждало реквизитов: вкладка перерисовывается, фокус — по ключу строки
			if (settingsTypeWaiting) {
				settingsTypeWaiting = false;
				if (activeTabId === 'variants') {
					rerenderSoon(renderContent);
				}
			}
			// Поля источников конструктора запроса берутся из того же кэша описаний
			rerenderSoon(qcRerender);
			// По тому же кэшу проверяются имена текста набора
			scheduleNameCheck();
			return;
		}
		if (msg.type === 'variant') {
			// Ответ ленивой загрузки настроек варианта: данные в кэш, ошибка — в плашку
			if (typeof msg.variant !== 'string' || msg.variant === '') {
				return;
			}
			if (variantLoading === msg.variant) {
				variantLoading = '';
			}
			if (msg.error) {
				variantErrors[msg.variant] = String(msg.error);
			} else {
				variantCache[msg.variant] = msg.settings;
				delete variantErrors[msg.variant];
			}
			if (activeTabId === 'variants') {
				renderContent();
			}
			return;
		}
		if (msg.type !== 'saved') {
			return;
		}
		onSaved(msg);
		// Проверка схемы, отложенная до конца правки (validateQueued), уходит, когда канал свободен
		runQueuedValidate();
	}

	/** Ответ правки (saved): фоновой записи текста запроса или правки пользователя. */
	function onSaved(msg) {
		saving = false;
		if (background) {
			// Ответ фоновой записи текста запроса: правки по одной, так что в полёте была она
			onBackgroundSaved(msg);
			return;
		}
		// Отказ пакета «>>» называет поле, а не номер операции (resourceRefusalText); прочие отказы — как есть
		const refusal = msg.ok ? '' : resourceRefusalText(resourceReply, msg.error);
		setStatus(msg.ok ? 'Сохранено' : String(refusal || 'Ошибка сохранения'), !msg.ok);
		// Окно, из которого ушла правка; правка со страницы (null) окон, открытых после неё, не закрывает
		const origin = editOrigin;
		editOrigin = null;
		const fromDialog = Boolean(origin && origin.isOpen());
		if (msg.ok) {
			// Модель перечитана целиком: формы закрываются, вкладки перерисовываются
			if (fromDialog) {
				closeDialog();
			}
			if (Array.isArray(msg.addedParameters)) {
				// Ответ конструктора запроса: запрос записан, какие параметры объявлены, итог автозаполнения
				showNotice('ok', 'Конструктор запроса', queryAppliedNoticeLines(msg));
			} else if (msg.autofill) {
				// Итог автозаполнения: что добавлено, что пропущено и почему
				showNotice('ok', 'Заполнение из запроса', autofillNoticeLines(msg.autofill));
			}
			if (msg.settings && msg.settings.variant) {
				// Правка настроек: кэш затронутого варианта обновляется, вариант становится активным
				if (msg.settings.variant !== uiState.variant) {
					uiState.variant = msg.settings.variant;
					uiState.nodePath = [];
					uiState.panel = 'selection';
				}
				variantCache[msg.settings.variant] = msg.settings.data || {};
				delete variantErrors[msg.settings.variant];
			} else if (pendingVariant) {
				// Настройки не перечитались вместе с правкой: вариант перезагрузится лениво
				delete variantCache[pendingVariant];
			}
			if (pendingSelect) {
				uiState.nodePath = pendingSelect;
				expandTo(pendingSelect);
			}
			pendingVariant = '';
			pendingSelect = null;
			pendingPathCommit = null;
			// Фокус после правки с клавиатуры (Delete, переименование из таблицы) — только в отрисовке этого ответа
			focusVariantRow = replyFocus.variant;
			focusStructureRow = replyFocus.structure;
			focusListPanel = replyFocus.list;
			focusResourceRow = replyFocus.resources;
			const fallbackFocus = replyFocus.fallback;
			clearReplyFocus();
			// Добавленный ресурс («>», «>>», окно): выбрана его строка, итог — плашкой после отрисовки
			const resourceDone = resourceReply;
			resourceReply = null;
			if (resourceDone) {
				resourceUi.selected = resourceDone.row;
			}
			if (msg.model) {
				model = withTypeCompositions(msg.model);
				pruneVariantCache();
				// Окно конструктора могло записать текст набора поверх черновика: черновик уступает
				reconcileQueryDrafts();
				// Набранный в ячейке путь поля, которого больше нет (переименовано окном, удалено, набор переименован), забывается
				pruneFieldPathDrafts();
				renderTabs();
				renderContent();
			} else if (activeTabId === 'variants') {
				renderContent();
			}
			// Удалён последний вариант: закладка «Настройки» остаётся, фокус её отрисовка ставит на «Добавить
			// вариант…» (renderVariants) — ярлык закладки его не забирает
			if (fallbackFocus && (!document.activeElement || document.activeElement === document.body)) {
				// Кнопки удалённой последней строки больше нет: фокус — на запасной цели, а не в никуда
				focusKeyed(fallbackFocus);
			}
			// Плашка — по модели ответа: у «>» вид типа поля считается заново, описания могли прийти за время сохранения
			const resourceNotice = resourceDone ? resourceReplyNotice(resourceDone) : null;
			if (resourceNotice) {
				showNotice(resourceNotice.tone, 'Ресурсы', resourceNotice.lines);
			}
			// Ответ отрисован (или вкладка «Настройки» не на экране): флажки не ждут следующей, чужой отрисовки
			focusVariantRow = false;
			focusStructureRow = false;
			focusListPanel = '';
			focusResourceRow = false;
			pendingRename = null;
			pendingDataSet = '';
			retryQueryDrafts();
			return;
		}
		pendingVariant = '';
		pendingSelect = null;
		pendingDataSet = '';
		pendingRename = null;
		// Ресурс не добавлен: выбор в таблице прежний, итога нет — причину скажет отказ
		resourceReply = null;
		// Фокус после удаления клавишей ждал удачного ответа: на отказ его не переносить и при следующей перерисовке
		clearReplyFocus();
		// Отказ правки из окна показывается в верхнем окне: правку отправила кнопка этого стека
		if (fromDialog) {
			dialogStack.top().setError(String(msg.error || 'Ошибка сохранения'));
		}
		const pathCommit = pendingPathCommit;
		pendingPathCommit = null;
		if (pathCommit) {
			// md-sparrow не принял путь из ячейки: причина — под ячейкой, как у отказа проверки, набранное остаётся, а
			// уход из ячейки тот же путь заново не шлёт (Enter — шлёт)
			const problem = 'Не переименовано: ' + String(msg.error || 'ошибка сохранения');
			fieldPathDrafts.set(pathCommit.draftKey, { text: pathCommit.value, problem: problem, refused: true });
			renderContent();
			// Строка под ячейкой рисуется заново уже с текстом — такую живая область не объявляет
			announceCompletion(problem);
		} else if (!fromDialog) {
			// Правка со страницы (флажок, ячейка, действие списка) или из окна, которое уже закрыто: элементы возвращаются к
			// модели, причину слышит читалка — строка состояния не живая область. Фокус перерисовка возвращает по ключу
			renderContent();
			// Отказ «>>» с полем вместо номера операции уже начат словами «Ресурсы не добавлены»: «Не сохранено» ему лишнее
			announceCompletion(refusal !== msg.error ? String(refusal) : 'Не сохранено: ' + String(msg.error || 'ошибка сохранения'));
		}
		retryQueryDrafts();
	}

	// ---------- API для конструктора запроса ----------

	/** Конструктору запроса дерево «База данных» доступно, когда макет внутри выгрузки (признак стартовой модели). */
	const metadataAvailable = Boolean(model && model.queryConstructor);

	/** Язык таблицы по имени её вида: имена ВТ и суффиксы полей сверяются с описанием на том же языке. */
	function tableLangOf(tableName) {
		const head = String(tableName || '').split('.')[0].toUpperCase();
		return fieldTypes.OBJECT_KINDS.some((kind) => kind.en.toUpperCase() === head) ? 'en' : 'ru';
	}

	/**
	 * Тип колонки X общей таблицы констант — тип поля «Значение» таблицы `Константа.X`, только если её
	 * описание уже в кэше вкладки (константа раскрывалась в дереве, её тип выводился): запроса здесь нет.
	 */
	function constantValueType(tableName, column) {
		const own = fieldTypes.constantColumnTable(tableName, column);
		const target = own ? fieldTypes.tableObjectOf(own.table, own.lang) : null;
		const description = target ? describeLookup(target.key) : null;
		const field = description ? fieldTypes.findField(fieldTypes.findTable(description, target.tail), own.field) : null;
		return field && field.type ? field.type : null;
	}

	/** Последняя собранная таблица констант: дерево, язык и отметка кэша описаний, по которым она собрана. */
	let constantsTableMemo = null;

	/**
	 * Общая таблица констант (`Константы` / `Constants`): своего описания в md-sparrow у неё нет, и
	 * таблица собирается из ветки констант дерева «База данных» — по полю на константу (имя и синоним).
	 * Описания всех констант не запрашиваются: их сотни (в ERP — тысячи), а тип поля нужен только
	 * раскрытию и выводу типов, и тот, кому он нужен, просит описание своей константы сам
	 * (DcsFieldTypes.constantColumnTable). Пока дерево не пришло — loading: ответ дерева перерисует окно.
	 * Сборка запоминается, пока не сменились дерево и кэш описаний: таблицу спрашивают на каждую
	 * перерисовку по каждому источнику, а констант тысячи.
	 */
	function constantsQueryTable(tableName) {
		if (!Array.isArray(qcGroups)) {
			if (qcGroupsError) {
				return { state: 'none' };
			}
			requestMetadataGroups();
			return { state: 'loading' };
		}
		const lang = String(tableName || '').trim().toUpperCase() === 'CONSTANTS' ? 'en' : 'ru';
		const memo = constantsTableMemo;
		if (memo && memo.groups === qcGroups && memo.lang === lang && memo.stamp === describeStamp) {
			return memo.answer;
		}
		const group = qcGroups.find((item) => item && item.objectType === 'Constant');
		const name = lang === 'en' ? 'Constants' : 'Константы';
		const fields = (group && Array.isArray(group.items) ? group.items : [])
			.filter((item) => item && typeof item.name === 'string' && item.name !== '')
			.map((item) => ({
				name: item.name,
				nameEn: item.name,
				kind: 'constant',
				type: constantValueType(name, item.name),
				synonym: typeof item.synonym === 'string' && item.synonym !== item.name ? item.synonym : '',
			}));
		const table = { name: name, kind: 'main', synonym: name, params: [], fields: fields };
		const answer = { state: 'ready', table: table, description: { object: name, kind: 'constants', tables: [table] } };
		constantsTableMemo = { groups: qcGroups, lang: lang, stamp: describeStamp, answer: answer };
		return answer;
	}

	/**
	 * Таблица языка запросов из кэша описаний (cf-md-query-tables через dcs/describe-type): нет в
	 * кэше — запрос панели и состояние loading, ответ перерисует открытый конструктор (qcRerender).
	 * Общую таблицу констант собирает constantsQueryTable из дерева.
	 */
	function describeQueryTable(tableName) {
		if (!metadataAvailable) {
			return { state: 'none' };
		}
		if (fieldTypes.isConstantsTable(tableName)) {
			return constantsQueryTable(tableName);
		}
		const target = fieldTypes.tableObjectOf(tableName, tableLangOf(tableName));
		if (!target) {
			return { state: 'none' };
		}
		const description = describeLookup(target.key);
		if (description === undefined) {
			requestDescriptions([target]);
			return { state: 'loading' };
		}
		const table = description ? fieldTypes.findTable(description, target.tail) : null;
		return table ? { state: 'ready', table: table, description: description } : { state: 'none' };
	}

	/** Дети ссылочного типа (раскрытие поля для разыменования): недостающие описания запрашиваются сразу. */
	function queryTypeChildren(valueType) {
		if (!valueType) {
			return { children: [], loading: false };
		}
		const result = fieldTypes.typeChildren(valueType, describeLookup, { typeText: (type) => typeLabelOf(type, '') });
		if (result.pending.length > 0) {
			requestDescriptions(result.pending);
		}
		return { children: result.children, loading: result.pending.length > 0 };
	}

	/**
	 * Тип колонки запроса пакета модели конструктора (колонка временной таблицы — по запросу, который её
	 * создал): недостающие описания запрашиваются, ответ перерисует открытый конструктор.
	 */
	function queryBatchColumnType(batch, statementIndex, column) {
		if (!metadataAvailable) {
			return { type: null, loading: false };
		}
		const result = fieldTypes.batchColumnType(batch, statementIndex, column, describeLookup, { queryModel: queryModelApi });
		if (result.pending.length > 0) {
			requestDescriptions(result.pending);
		}
		return { type: result.type, loading: result.pending.length > 0 };
	}

	/** Итог вывода типа для конструктора: недостающие описания — запросом панели, ответ перерисует окно. */
	function queryTypeAnswer(result) {
		if (result.pending.length > 0) {
			requestDescriptions(result.pending);
		}
		return { type: result.type, loading: result.pending.length > 0 };
	}

	/**
	 * Тип выражения в части запроса модели конструктора (деление «>>» на «Группировке» по типу и
	 * сумма нечислового поля). address — {statement, part} части в batch; outerTemp — временные
	 * таблицы внешнего пакета у вложенного конструктора. Флаг дерева «База данных» (metadataAvailable)
	 * здесь не нужен: описания объектов читаются и в проекте EDT (.mdo), как у подсказки «через точку»,
	 * а без этого деление «>>» в EDT писало бы СУММА(Т.Ссылка). Макет вне выгрузки хост узнаёт
	 * сам (describeOutside) — тогда типа нет.
	 */
	function queryPartExpressionType(batch, address, expr, outerTemp) {
		const where = address || {};
		const statement = batch && Array.isArray(batch.statements) ? batch.statements[where.statement] : null;
		const part = statement && Array.isArray(statement.parts) ? statement.parts[where.part] : null;
		if (!part) {
			return { type: null, loading: false };
		}
		return queryTypeAnswer(fieldTypes.partExpressionType(batch, where.statement, part, expr, describeLookup, { queryModel: queryModelApi, outerTemp: outerTemp }));
	}

	/** Тип колонки вложенного запроса части: поля подзапроса раскрываются и связываются по типу, как у ВТ. */
	function querySubqueryColumnType(batch, statementIndex, subquery, column, outerTemp) {
		if (!metadataAvailable) {
			return { type: null, loading: false };
		}
		return queryTypeAnswer(fieldTypes.subqueryColumnType(batch, statementIndex, subquery, column, describeLookup, { queryModel: queryModelApi, outerTemp: outerTemp }));
	}

	// ---------- проверка имён запроса по метаданным ----------

	/**
	 * Проверка имён доступна, когда макет внутри выгрузки конфигурации и выгрузка — не расширение (признак
	 * стартовой модели, как queryConstructor). В выгрузке расширения нет объектов основной конфигурации, а
	 * описания заимствованных объектов несут только заимствованные реквизиты и части: проверка по ним давала
	 * бы ложные предупреждения на рабочих запросах.
	 */
	const nameCheckAvailable = metadataAvailable && !(model && model.configurationExtension);

	/**
	 * Общие реквизиты выгрузки (признак стартовой модели, перечитанные модели его не несут): поля таблиц, которых
	 * описания md-sparrow перечисляют не у всех таблиц (табличные части, константы), — о них проверка имён молчит.
	 */
	const nameCheckCommonAttributes = model && Array.isArray(model.configurationCommonAttributes) ? model.configurationCommonAttributes.slice() : [];

	/** Имена объектов дерева «База данных» по видам (без учёта регистра): собирается заново, когда приходит новое дерево. */
	let treeObjectIndex = null;

	/**
	 * Есть ли объект в дереве «База данных»: true / false; null — дерева ещё нет, вид неизвестен или ветки
	 * вида в дереве нет вовсе: утверждать «нет объекта» тогда нельзя.
	 */
	function treeObjectExists(kindRu, name) {
		if (!Array.isArray(qcGroups)) {
			return null;
		}
		if (!treeObjectIndex || treeObjectIndex.groups !== qcGroups) {
			const byType = new Map();
			for (const group of qcGroups) {
				if (group && typeof group.objectType === 'string') {
					const items = Array.isArray(group.items) ? group.items : [];
					byType.set(group.objectType, new Set(items.map((item) => String((item && item.name) || '').toUpperCase())));
				}
			}
			treeObjectIndex = { groups: qcGroups, byType: byType };
		}
		const kind = fieldTypes.OBJECT_KINDS.find((item) => item.ru === kindRu);
		const names = kind ? treeObjectIndex.byType.get(kind.en) : undefined;
		return names ? names.has(String(name || '').toUpperCase()) : null;
	}

	/**
	 * Предупреждения проверки имён модели запроса (DcsQueryEdit.nameProblems) по кэшу описаний; их ответы
	 * перерисуют конструктор и строку под текстом набора. outerTemp — ВТ внешнего пакета у вложенного
	 * конструктора. options.quiet — строка под текстом набора: ради неё дерево «База данных» не грузится
	 * (на большой выгрузке холодная загрузка — минуты), и таблица «Константы» без дерева не проверяется;
	 * options.ask — запрашивать ли недостающие описания: у конструктора — сразу, у строки набора — 'later'
	 * (после отрисовки вкладки, и только для сохранённого текста: черновик при наборе дал бы запросы по
	 * недописанным именам) или false. Недоступна проверка — пустой список.
	 */
	function queryNameProblems(queryModel, outerTemp, options) {
		if (!nameCheckAvailable || !queryModel) {
			return [];
		}
		const quiet = Boolean(options && options.quiet);
		const env = fieldTypes.nameCheckEnv(describeLookup, {
			queryModel: queryModelApi,
			outerTemp: Array.isArray(outerTemp) ? outerTemp : [],
			objectExists: treeObjectExists,
			commonAttributes: nameCheckCommonAttributes,
			constants: (tableName) => (quiet && !Array.isArray(qcGroups) ? { state: 'none' } : constantsQueryTable(tableName)),
		});
		const problems = queryEditApi.nameProblems(queryModel, env);
		const ask = options && options.ask !== undefined ? options.ask : true;
		if (env.pending.length > 0 && ask === 'later') {
			// Строке набора описания не к спеху: запросы уходят после отрисовки, а то, что к этому времени уже
			// запросил кто-то другой (конструктор, подсказка), повторно не шлётся
			const pending = env.pending.slice();
			setTimeout(() => requestDescriptions(pending), HIGHLIGHT_DEBOUNCE_MS);
		} else if (env.pending.length > 0 && ask) {
			requestDescriptions(env.pending);
		}
		return problems;
	}

	/**
	 * Явный API редактора для многостраничного конструктора запроса (dcs-editor-query-dialog.js):
	 * он подключается после этого скрипта и ничего, кроме этого объекта, внутри не видит.
	 * - элементы форм: el, formRow, textInput, selectInput, checkbox, codeEditor (редактор
	 *   с подсветкой {box, input, flush}), attachCompletion(input, scopeFn, options) — подсказка;
	 *   iconButton(spec) — кнопка-пиктограмма команды над списком (spec — у iconButton);
	 *   transferButtons(host, items) — столбец кнопок переноса > >> < << (общий с вкладкой «Ресурсы»);
	 *   drag — перенос мышью: zone(контейнер, spec) — зона списка (spec — у dragZone), index — номер вставки
	 *   по месту сброса у строки (dropIndex);
	 * - окна: pushDialog(spec) — уровень стека диалогов;
	 * - канал: send(type, fields) — правка (false — предыдущая ещё сохраняется, текст busyText; за фоновой записью
	 *   текста запроса набора правка встаёт в очередь); isSaving() — новая правка получила бы отказ; ответ saved
	 *   закрывает все окна или показывает отказ в верхнем (ответ фоновой записи окна не трогает);
	 * - данные: model() — текущая модель cf-dcs-info; typeLabel(valueType) — подпись типа;
	 *   metadata.available() / request() / retry() / state() — дерево «База данных» (dcs/list-metadata);
	 *   queryTables(relativePath, lang) — таблицы объекта дерева (dcs/query-tables, кэш вкладки);
	 *   describeTable(имяТаблицы) — {state: ready|loading|none, table} по кэшу описаний (общую таблицу
	 *   констант `Константы` / `Constants` — из ветки констант дерева, constantsQueryTable);
	 *   typeChildren(valueType) — {children, loading}; expandable(valueType) — есть ли дети по типу;
	 *   batchColumnType(модельЗапроса, номерЗапроса, колонка) — {type, loading}: тип колонки запроса
	 *   пакета (колонки временных таблиц);
	 *   partExpressionType(модельЗапроса, {statement, part}, выражение, внешниеВТ?) — {type, loading}:
	 *   тип выражения в части (деление «>>» на «Группировке», сумма нечислового);
	 *   subqueryColumnType(модельЗапроса, номерЗапроса, запросИсточника, колонка, внешниеВТ?) —
	 *   {type, loading}: тип колонки вложенного запроса;
	 *   nameProblems(модельЗапроса, внешниеВТ?) — предупреждения проверки имён по метаданным
	 *   (DcsQueryEdit.nameProblems); вне выгрузки и в выгрузке расширения — пустой список;
	 * - перерисовка: setRerender(fn) / clearRerender(fn) — fn зовётся на каждый ответ дерева,
	 *   таблиц объекта и описаний, пока конструктор открыт.
	 */
	window.DcsEditorApi = Object.freeze({
		el: el,
		formRow: formRow,
		textInput: textInput,
		selectInput: selectInput,
		checkbox: checkbox,
		codeEditor: codeEditor,
		attachCompletion: attachCompletion,
		iconButton: iconButton,
		transferButtons: transferButtons,
		drag: Object.freeze({
			zone: dragZone,
			index: dropIndex,
		}),
		pushDialog: pushDialog,
		send: send,
		busyText: BUSY,
		isSaving: editBusy,
		model: () => model,
		typeLabel: (valueType) => typeLabelOf(valueType, ''),
		metadata: Object.freeze({
			available: () => metadataAvailable,
			request: requestMetadataGroups,
			retry: () => {
				qcGroups = null;
				qcGroupsError = '';
				requestMetadataGroups();
			},
			state: () => ({ groups: qcGroups, error: qcGroupsError, loading: qcGroupsLoading, cold: qcGroupsCold }),
		}),
		queryTables: requestQueryTables,
		describeTable: describeQueryTable,
		typeChildren: queryTypeChildren,
		batchColumnType: queryBatchColumnType,
		partExpressionType: queryPartExpressionType,
		subqueryColumnType: querySubqueryColumnType,
		nameProblems: (queryModel, outerTemp) => queryNameProblems(queryModel, outerTemp),
		expandable: (valueType) => Boolean(valueType && fieldTypes.expandable(valueType)),
		setRerender: (fn) => {
			qcRerender = fn;
		},
		clearRerender: (fn) => {
			if (qcRerender === fn) {
				qcRerender = null;
			}
		},
	});

	renderTabs();
	renderContent();
})();
