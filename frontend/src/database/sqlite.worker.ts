/// <reference lib="webworker" />

import sqlite3InitModule from '@sqlite.org/sqlite-wasm';

type Request = { id: number; action: 'query' | 'exec' | 'bulk' | 'clear' | 'close'; sql?: string; params?: unknown[]; payload?: unknown };
type SqliteApi = {
  oo1: {
    OpfsDb: new (filename: string) => {
      exec(options: { sql: string; bind?: unknown[]; rowMode?: 'object'; resultRows?: Record<string, unknown>[] }): void;
      changes(): number;
      close(): void;
    };
  };
};

let database: InstanceType<SqliteApi['oo1']['OpfsDb']> | undefined;

self.onmessage = async (event: MessageEvent<Request>) => {
  const { id, action, sql, params = [], payload } = event.data;
  let sqlMs = 0;
  const timedExec = (options: Parameters<NonNullable<typeof database>['exec']>[0]) => {
    const started = performance.now();
    database!.exec(options);
    sqlMs += performance.now() - started;
  };
  try {
    if (action === 'close') {
      database?.close();
      database = undefined;
      self.postMessage({ id, result: true, sql_ms: 0 });
      return;
    }
    if (!database) {
      const sqlite3 = await sqlite3InitModule() as unknown as SqliteApi;
      database = new sqlite3.oo1.OpfsDb('/datadesk.sqlite3');
      database.exec({ sql: 'PRAGMA foreign_keys = ON' });
      database.exec({ sql: `CREATE TABLE IF NOT EXISTS projects (
        id INTEGER PRIMARY KEY, title TEXT NOT NULL, description TEXT, created_at TEXT NOT NULL
      )` });
      database.exec({ sql: `CREATE TABLE IF NOT EXISTS tasks (
        id INTEGER PRIMARY KEY, project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        title TEXT NOT NULL, description TEXT, status TEXT NOT NULL CHECK(status IN ('new','in_progress','completed')),
        priority INTEGER NOT NULL CHECK(priority IN (1,2,3)), created_at TEXT NOT NULL, due_date TEXT
      )` });
    }
    if (action === 'query' || action === 'exec') {
      const rows: Record<string, unknown>[] = [];
      timedExec({ sql: sql!, bind: params, ...(action === 'query' ? { rowMode: 'object', resultRows: rows } : {}) });
      self.postMessage({ id, result: action === 'query' ? rows : { changes: database.changes() }, sql_ms: sqlMs });
      return;
    }
    if (action === 'clear') {
      const projects: Record<string, unknown>[] = [];
      const tasks: Record<string, unknown>[] = [];
      timedExec({ sql: 'SELECT COUNT(*) AS count FROM projects', rowMode: 'object', resultRows: projects });
      timedExec({ sql: 'SELECT COUNT(*) AS count FROM tasks', rowMode: 'object', resultRows: tasks });
      timedExec({ sql: 'BEGIN IMMEDIATE' });
      try {
        timedExec({ sql: 'DELETE FROM tasks' });
        timedExec({ sql: 'DELETE FROM projects' });
        timedExec({ sql: 'COMMIT' });
      } catch (error) {
        timedExec({ sql: 'ROLLBACK' });
        throw error;
      }
      self.postMessage({
        id,
        result: { projects: Number(projects[0].count), tasks: Number(tasks[0].count) },
        sql_ms: sqlMs,
      });
      return;
    }
    if (action === 'bulk') {
      const data = payload as { count: number; seed: number; replace: boolean };
      let state = data.seed >>> 0;
      const next = () => { state = (Math.imul(1664525, state) + 1013904223) >>> 0; return state; };
      const projects = ['Research', 'Product', 'Operations', 'Design', 'Engineering', 'Support', 'Analytics', 'Planning'];
      const verbs = ['Review', 'Improve', 'Prepare', 'Test', 'Document', 'Plan', 'Update', 'Measure', 'Explore', 'Build'];
      const subjects = ['database', 'dashboard', 'workflow', 'report', 'interface', 'migration', 'query', 'prototype', 'release', 'analysis'];
      const statuses = ['new', 'in_progress', 'completed'];
      const epoch = Date.UTC(2024, 0, 1);
      timedExec({ sql: 'BEGIN IMMEDIATE' });
      try {
        if (data.replace) {
          timedExec({ sql: 'DELETE FROM tasks' });
          timedExec({ sql: 'DELETE FROM projects' });
        }
        const existing: Record<string, unknown>[] = [];
        timedExec({ sql: 'SELECT id FROM projects ORDER BY id', rowMode: 'object', resultRows: existing });
        let projectIds = existing.map(row => Number(row.id));
        if (!projectIds.length) {
          for (const title of projects) {
            timedExec({ sql: 'INSERT INTO projects(title,description,created_at) VALUES(?,?,?)', bind: [title, `Seeded sample project: ${title}`, new Date(epoch).toISOString()] });
            const inserted: Record<string, unknown>[] = [];
            timedExec({ sql: 'SELECT last_insert_rowid() AS id', rowMode: 'object', resultRows: inserted });
            projectIds.push(Number(inserted[0].id));
          }
        }
        for (let i = 0; i < data.count; i++) {
          const created = epoch + (next() % 1000) * 86400000 + (next() % 86400) * 1000;
          const due = i % 4 ? new Date(created + (next() % 90) * 86400000).toISOString() : null;
          const projectIndex = next() % projects.length;
          const title = `${verbs[next() % verbs.length]} ${subjects[next() % subjects.length]} ${i + 1}`;
          const status = statuses[next() % statuses.length];
          const priority = (next() % 3) + 1;
          timedExec({ sql: `INSERT INTO tasks(project_id,title,description,status,priority,created_at,due_date)
            VALUES(?,?,?,?,?,?,?)`, bind: [projectIds[projectIndex % projectIds.length], title, `Deterministic sample task #${i + 1}`, status, priority, new Date(created).toISOString(), due] });
        }
        timedExec({ sql: 'COMMIT' });
        self.postMessage({ id, result: { projects: projectIds.length, tasks: data.count, seed: data.seed, sql_ms: sqlMs }, sql_ms: sqlMs });
      } catch (error) {
        timedExec({ sql: 'ROLLBACK' });
        throw error;
      }
    }
  } catch (error) {
    self.postMessage({ id, error: error instanceof Error ? error.message : String(error) });
  }
};
