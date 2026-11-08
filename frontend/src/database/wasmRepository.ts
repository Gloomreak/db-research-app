import type {
  Mode, Project, ProjectInput, Repository, ResearchRun, Stats, Task, TaskFilters, TaskInput,
} from './types';

type WorkerResponse = { id: number; result?: unknown; error?: string; sql_ms?: number };

export class WasmRepository implements Repository {
  readonly mode: Mode = 'wasm';
  initializationMs = 0;
  private worker?: Worker;
  private sequence = 0;
  private sqlTotalMs = 0;
  private pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();

  async init() {
    const started = performance.now();
    if (!globalThis.crossOriginIsolated || typeof SharedArrayBuffer === 'undefined') {
      throw new Error('Для SQLite WASM нужны COOP/COEP-заголовки и поддержка SharedArrayBuffer. Запустите Vite с localhost или через HTTPS.');
    }
    if (!navigator.storage?.getDirectory) {
      throw new Error('OPFS недоступна в этом браузере. SQLite WASM не может гарантировать сохранность данных.');
    }
    if (!this.worker) {
      this.worker = new Worker(new URL('./sqlite.worker.ts', import.meta.url), { type: 'module' });
      this.worker.onmessage = (event: MessageEvent<WorkerResponse>) => {
        const pending = this.pending.get(event.data.id);
        if (!pending) return;
        this.pending.delete(event.data.id);
        this.sqlTotalMs += event.data.sql_ms ?? 0;
        if (event.data.error) pending.reject(new Error(event.data.error));
        else pending.resolve(event.data.result);
      };
      this.worker.onerror = event => {
        for (const pending of this.pending.values()) pending.reject(new Error(event.message || 'Ошибка SQLite WASM worker.'));
        this.pending.clear();
      };
    }
    await this.query('SELECT 1 AS ready');
    this.initializationMs = performance.now() - started;
  }

  async close() {
    if (!this.worker) return;
    try { await this.send('close'); } finally {
      this.worker.terminate();
      this.worker = undefined;
    }
  }

  private send(action: string, sql?: string, params?: unknown[], payload?: unknown): Promise<unknown> {
    if (!this.worker) return Promise.reject(new Error('SQLite WASM не инициализирована.'));
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.worker!.postMessage({ id, action, sql, params, payload });
    });
  }

  private query<T>(sql: string, params: unknown[] = []) {
    return this.send('query', sql, params) as Promise<T[]>;
  }

  private async exec(sql: string, params: unknown[] = []) {
    const result = await this.send('exec', sql, params) as { changes: number };
    return result.changes;
  }

  async listProjects(): Promise<Project[]> {
    return this.query<Project>(`SELECT p.*, COUNT(t.id) AS task_count,
      SUM(CASE WHEN t.status='completed' THEN 1 ELSE 0 END) AS completed_count
      FROM projects p LEFT JOIN tasks t ON t.project_id=p.id GROUP BY p.id ORDER BY p.created_at DESC, p.id DESC`);
  }

  async saveProject(input: ProjectInput, id?: number): Promise<Project> {
    if (id) await this.exec('UPDATE projects SET title=?,description=? WHERE id=?', [input.title.trim(), input.description, id]);
    else await this.exec('INSERT INTO projects(title,description,created_at) VALUES(?,?,?)', [input.title.trim(), input.description, new Date().toISOString()]);
    const rows = await this.query<Project>('SELECT * FROM projects WHERE id=?', [id ?? (await this.query<{ id: number }>('SELECT last_insert_rowid() AS id'))[0].id]);
    if (!rows[0]) throw new Error('Проект не найден после сохранения.');
    return rows[0];
  }

  async deleteProject(id: number) {
    await this.exec('DELETE FROM projects WHERE id=?', [id]);
  }

  listTasks(filters: TaskFilters): Promise<Task[]> {
    const columns = { created_at: 't.created_at', due_date: 't.due_date', priority: 't.priority', title: 't.title' } as const;
    const clauses: string[] = [];
    const params: unknown[] = [];
    for (const [key, column] of [['project_id', 't.project_id'], ['status', 't.status'], ['priority', 't.priority']] as const) {
      const value = filters[key];
      if (value !== undefined) { clauses.push(`${column}=?`); params.push(value); }
    }
    if (filters.search) { clauses.push('t.title LIKE ?'); params.push(`%${filters.search}%`); }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    const sort = columns[filters.sort ?? 'created_at'];
    const direction = filters.direction === 'asc' ? 'ASC' : 'DESC';
    params.push(filters.limit ?? 1000, filters.offset ?? 0);
    return this.query<Task>(`SELECT t.*,p.title AS project_title FROM tasks t JOIN projects p ON p.id=t.project_id
      ${where} ORDER BY ${sort} ${direction},t.id DESC LIMIT ? OFFSET ?`, params);
  }

  async saveTask(input: TaskInput, id?: number): Promise<Task> {
    if (id) {
      await this.exec(`UPDATE tasks SET project_id=?,title=?,description=?,status=?,priority=?,due_date=? WHERE id=?`,
        [input.project_id, input.title.trim(), input.description, input.status, input.priority, input.due_date, id]);
    } else {
      await this.exec(`INSERT INTO tasks(project_id,title,description,status,priority,created_at,due_date) VALUES(?,?,?,?,?,?,?)`,
        [input.project_id, input.title.trim(), input.description, input.status, input.priority, new Date().toISOString(), input.due_date]);
    }
    const taskId = id ?? (await this.query<{ id: number }>('SELECT last_insert_rowid() AS id'))[0].id;
    const rows = await this.query<Task>('SELECT t.*,p.title AS project_title FROM tasks t JOIN projects p ON p.id=t.project_id WHERE t.id=?', [taskId]);
    if (!rows[0]) throw new Error('Задача не найдена после сохранения.');
    return rows[0];
  }

  async deleteTask(id: number) {
    await this.exec('DELETE FROM tasks WHERE id=?', [id]);
  }

  async stats(): Promise<Stats> {
    const projects = (await this.query<{ count: number }>('SELECT COUNT(*) AS count FROM projects'))[0].count;
    const tasks = (await this.query<{ count: number }>('SELECT COUNT(*) AS count FROM tasks'))[0].count;
    const statuses = await this.query<Stats['statuses'][number]>('SELECT status,COUNT(*) AS count FROM tasks GROUP BY status');
    const priorities = await this.query<Stats['priorities'][number]>('SELECT priority,COUNT(*) AS count FROM tasks GROUP BY priority');
    const by_project = await this.query<Stats['by_project'][number]>(`SELECT p.id,p.title,COUNT(t.id) AS count FROM projects p
      LEFT JOIN tasks t ON t.project_id=p.id GROUP BY p.id ORDER BY count DESC`);
    const completed = (await this.query<{ count: number }>("SELECT COUNT(*) AS count FROM tasks WHERE status='completed'"))[0].count;
    const overdue = (await this.query<{ count: number }>("SELECT COUNT(*) AS count FROM tasks WHERE due_date < ? AND status != 'completed'", [new Date().toISOString()]))[0].count;
    return { projects, tasks, overdue, statuses, priorities, by_project, completion_rate: tasks ? Math.round(completed * 10000 / tasks) / 100 : 0 };
  }

  clearData(): Promise<{ projects: number; tasks: number }> {
    return this.send('clear') as Promise<{ projects: number; tasks: number }>;
  }

  async generateData(count: number, seed: number, replace: boolean) {
    const started = performance.now();
    const result = await this.send('bulk', undefined, undefined, { count, seed, replace }) as Record<string, unknown>;
    return { ...result, ui_total_ms: performance.now() - started };
  }

  async research(scenario: string, repeats: number, seed: number): Promise<ResearchRun> {
    const started = performance.now();
    const sqlStarted = this.sqlTotalMs;
    const results: Record<string, unknown> = {};
    const measure = async (run: () => Promise<unknown>) => {
      await run();
      const times: number[] = [];
      const sqlTimes: number[] = [];
      let result: unknown;
      for (let i = 0; i < repeats; i++) {
        const start = performance.now();
        const sqlStart = this.sqlTotalMs;
        result = await run();
        times.push(performance.now() - start);
        sqlTimes.push(this.sqlTotalMs - sqlStart);
      }
      return {
        mean_ms: times.reduce((a, b) => a + b, 0) / times.length,
        median_ms: [...times].sort((a, b) => a - b)[Math.floor(times.length / 2)],
        mean_sql_ms: sqlTimes.reduce((a, b) => a + b, 0) / sqlTimes.length,
        median_sql_ms: [...sqlTimes].sort((a, b) => a - b)[Math.floor(sqlTimes.length / 2)],
        min_ms: Math.min(...times), max_ms: Math.max(...times), repeats, result,
      };
    };
    if (scenario === 'select' || scenario === 'all') results.select = await measure(async () => (await this.query('SELECT t.id FROM tasks t JOIN projects p ON p.id=t.project_id WHERE t.project_id=? AND t.status=? ORDER BY t.created_at DESC LIMIT 100', [1, 'new'])).length);
    if (scenario === 'search' || scenario === 'all') results.search = await measure(async () => (await this.query('SELECT id FROM tasks WHERE title LIKE ?', ['%database%'])).length);
    if (scenario === 'aggregate' || scenario === 'all') results.aggregate = await measure(() => this.query('SELECT status,COUNT(*) AS count FROM tasks GROUP BY status'));
    if (scenario === 'update_delete' || scenario === 'all') {
      results.update_delete = await measure(async () => {
        await this.exec('BEGIN IMMEDIATE');
        try {
          await this.exec('INSERT INTO projects(title,created_at) VALUES(?,?)', [`research-crud-${seed}`, new Date().toISOString()]);
          const projectId = (await this.query<{ id: number }>('SELECT last_insert_rowid() AS id'))[0].id;
          await this.exec("INSERT INTO tasks(project_id,title,status,priority,created_at) VALUES(?,'before-update','new',2,?)", [projectId, new Date().toISOString()]);
          const taskId = (await this.query<{ id: number }>('SELECT last_insert_rowid() AS id'))[0].id;
          const updated = await this.exec("UPDATE tasks SET title='after-update' WHERE id=?", [taskId]) === 1;
          const title = (await this.query<{ title: string }>('SELECT title FROM tasks WHERE id=?', [taskId]))[0].title;
          const deleted = await this.exec('DELETE FROM tasks WHERE id=?', [taskId]) === 1;
          const remaining = (await this.query<{ count: number }>('SELECT COUNT(*) AS count FROM tasks WHERE id=?', [taskId]))[0].count;
          await this.exec('DELETE FROM projects WHERE id=?', [projectId]);
          await this.exec('COMMIT');
          return { updated: updated && title === 'after-update', deleted: deleted && remaining === 0, fixture_removed: true };
        } catch (error) { await this.exec('ROLLBACK'); throw error; }
      });
    }
    if (scenario === 'index' || scenario === 'all') {
      await this.exec('DROP INDEX IF EXISTS idx_tasks_project_status');
      const before = await measure(async () => (await this.query('SELECT id FROM tasks WHERE project_id=? AND status=? ORDER BY created_at DESC LIMIT 100', [1, 'new'])).length);
      await this.exec('CREATE INDEX IF NOT EXISTS idx_tasks_project_status ON tasks(project_id,status,created_at)');
      const after = await measure(async () => (await this.query('SELECT id FROM tasks WHERE project_id=? AND status=? ORDER BY created_at DESC LIMIT 100', [1, 'new'])).length);
      results.index = { before, after, plan: await this.query("EXPLAIN QUERY PLAN SELECT id FROM tasks WHERE project_id=1 AND status='new' ORDER BY created_at DESC LIMIT 100") };
    }
    if (scenario === 'commit' || scenario === 'all') {
      results.commit = await measure(async () => {
        await this.exec('BEGIN IMMEDIATE');
        try {
          await this.exec("INSERT INTO projects(title,description,created_at) VALUES('research-commit','transaction test',?)", [new Date().toISOString()]);
          const id = (await this.query<{ id: number }>('SELECT last_insert_rowid() AS id'))[0].id;
          await this.exec("INSERT INTO tasks(project_id,title,status,priority,created_at) VALUES(?,'commit-task','new',2,?)", [id, new Date().toISOString()]);
          await this.exec('COMMIT');
          const persisted = (await this.query<{ count: number }>('SELECT COUNT(*) AS count FROM tasks WHERE project_id=?', [id]))[0].count === 1;
          await this.exec('DELETE FROM projects WHERE id=?', [id]);
          return persisted;
        } catch (error) { await this.exec('ROLLBACK'); throw error; }
      });
    }
    if (scenario === 'rollback' || scenario === 'all') {
      results.rollback = await measure(async () => {
        const title = `research-rollback-${seed}-${crypto.randomUUID()}`;
        await this.exec('BEGIN IMMEDIATE');
        let controlledError = false;
        try {
          await this.exec('INSERT INTO projects(title,created_at) VALUES(?,?)', [title, new Date().toISOString()]);
          const projectId = (await this.query<{ id: number }>('SELECT last_insert_rowid() AS id'))[0].id;
          await this.exec("INSERT INTO tasks(project_id,title,status,priority,created_at) VALUES(?,'partial-before-error','new',2,?)", [projectId, new Date().toISOString()]);
          try {
            await this.exec("INSERT INTO tasks(project_id,title,status,priority,created_at) VALUES(?,'controlled-error','new',99,?)", [projectId, new Date().toISOString()]);
          } catch {
            controlledError = true;
          }
          await this.exec('ROLLBACK');
        } catch (error) { await this.exec('ROLLBACK'); throw error; }
        const count = (await this.query<{ count: number }>('SELECT COUNT(*) AS count FROM projects WHERE title=?', [title]))[0].count;
        return { controlled_error: controlledError, rollback_verified: count === 0 };
      });
    }
    if (scenario === 'reload' || scenario === 'all') {
      const before = (await this.query<{ count: number }>('SELECT COUNT(*) AS count FROM tasks'))[0].count;
      await this.close();
      await this.init();
      const after = (await this.query<{ count: number }>('SELECT COUNT(*) AS count FROM tasks'))[0].count;
      results.reload = { before, after, persisted: before === after };
    }
    const stats = await this.stats();
    return { mode: this.mode, scenario, seed, repeats, data_size: stats.tasks, created_at: new Date().toISOString(), ui_total_ms: performance.now() - started, sql_ms: this.sqlTotalMs - sqlStarted, http_requests: 0, results, environment: { engine: 'SQLite WASM', storage: 'OPFS', initialization_ms: this.initializationMs.toFixed(3) } };
  }

  async exportData(format: 'json' | 'csv') {
    const projects = await this.query<Record<string, unknown>>('SELECT * FROM projects ORDER BY id');
    const tasks = await this.query<Record<string, unknown>>('SELECT * FROM tasks ORDER BY id');
    if (format === 'json') return new Blob([JSON.stringify({ projects, tasks, exported_at: new Date().toISOString(), mode: this.mode }, null, 2)], { type: 'application/json' });
    const columns = ['id', 'project_id', 'title', 'description', 'status', 'priority', 'created_at', 'due_date'];
    const csv = [columns.join(','), ...tasks.map(row => columns.map(column => JSON.stringify(row[column] ?? '')).join(','))].join('\n');
    return new Blob([csv], { type: 'text/csv' });
  }
}
