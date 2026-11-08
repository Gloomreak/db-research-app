# Схема базы данных

В каждом режиме отдельно создаются две таблицы:

- `projects(id, title, description, created_at)` — `title` и `created_at` обязательны.
- `tasks(id, project_id, title, description, status, priority, created_at, due_date)` — внешний ключ на `projects.id` с `ON DELETE CASCADE`.

Статус ограничен `new`, `in_progress`, `completed`; приоритет — числами 1, 2, 3. Даты сериализуются ISO 8601 UTC. Обе таблицы используют integer primary key; PostgreSQL назначает идентификатор через `SERIAL`-совместимый `INTEGER PRIMARY KEY` и `RETURNING id`. Исследуемый индекс `idx_tasks_project_status(project_id,status,created_at)` изначально не создаётся; сценарий индекса сравнивает запрос до и после его создания и выводит план (`EXPLAIN QUERY PLAN` SQLite, `EXPLAIN` PostgreSQL).

Внешние ключи и ограничения статуса/приоритета проверяет сама БД. Удаление проекта в UI требует подтверждения и предупреждает о числе задач; каскад реализован ограничением БД.
