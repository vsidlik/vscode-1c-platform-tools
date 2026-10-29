# Запись окна в реестре окон

`record.json` — запись окна из двух папок с подпроектом в формате, который читает MCP-сервер
(`mcp-1c-platform-tools`, `test/fixtures/window-record.json` — тот же файл). Тест
`src/test/shared/windowRegistry.node.ts` сверяет с ней разбор и поля записи, которую пишет окно:
при смене формата правятся оба файла и `WINDOW_RECORD_VERSION` в обоих репозиториях.
