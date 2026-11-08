# SQLite WASM и OPFS

SQLite WASM запускается в module Worker; файл `/datadesk.sqlite3` хранится через OPFS VFS официальной сборки `@sqlite.org/sqlite-wasm`. Vite задаёт `Cross-Origin-Opener-Policy: same-origin` и `Cross-Origin-Embedder-Policy: require-corp`; ожидается `crossOriginIsolated` и `SharedArrayBuffer`. Запускать development-сервер следует через `localhost`; production-сервер должен сохранить оба заголовка.

Перед открытием базы проверяются OPFS и cross-origin isolation. Если API OPFS или заголовки недоступны, режим явно показывает ошибку вместо перехода на IndexedDB, LocalStorage или непостоянный буфер. SQLite WASM-сценарий reload закрывает worker/DB, затем заново открывает OPFS файл и проверяет число задач. Само переключение режима не изменяет данные других баз.

Доступность OPFS, квоты, приватный режим, права и детали поддержки зависят от браузера/профиля. Для отдельной вкладки/сайта браузер может удалить данные по политике хранения; приложение не обещает резервное копирование. IndexedDB не является четвёртым режимом сравнения и не используется как fallback.
