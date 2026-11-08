from __future__ import annotations

import csv
import io
import json
import statistics
import sqlite3
import time
from datetime import datetime, timezone
from typing import Any

from fastapi import FastAPI, HTTPException, Query, Response
from fastapi.middleware.cors import CORSMiddleware
from psycopg import IntegrityError as PostgresIntegrityError

from .db import DATABASES, RESEARCH_INDEX
from .generator import generate
from .schemas import GenerationInput, ProjectInput, ResearchInput, TaskInput

app = FastAPI(title="DataDesk Research API", version="1.0.0")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173", "http://127.0.0.1:5173"],
    allow_methods=["*"],
    allow_headers=["*"],
)


def database(mode: str):
    if mode not in DATABASES:
        raise HTTPException(404, "Server mode must be 'postgres' or 'sqlite'.")
    db = DATABASES[mode]
    try:
        db.initialize()
    except Exception as error:
        raise HTTPException(503, f"{mode} database is unavailable: {error}") from error
    return db


def query(db, sql: str, params: tuple = ()):
    try:
        with db.connection() as connection:
            cursor = connection.execute(db.sql(sql), params)
            rows = cursor.fetchall() if cursor.description else []
            connection.commit()
            return [db.row_dict(row) for row in rows], cursor.rowcount
    except (sqlite3.IntegrityError, PostgresIntegrityError) as error:
        raise HTTPException(400, f"Database constraint violation: {error}") from error


def insert_id(db, sql: str, params: tuple):
    try:
        with db.connection() as connection:
            cursor = connection.execute(db.sql(sql), params)
            row = cursor.fetchone()
            identifier = row["id"] if row is not None else cursor.lastrowid
            connection.commit()
            return identifier
    except (sqlite3.IntegrityError, PostgresIntegrityError) as error:
        raise HTTPException(400, f"Database constraint violation: {error}") from error


def now():
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


@app.get("/api/health")
def health():
    return {"ok": True, "available_modes": ["postgres", "sqlite"]}


@app.get("/api/{mode}/projects")
def list_projects(mode: str):
    db = database(mode)
    rows, _ = query(db, """SELECT p.*, COUNT(t.id) AS task_count,
        SUM(CASE WHEN t.status = 'completed' THEN 1 ELSE 0 END) AS completed_count
        FROM projects p LEFT JOIN tasks t ON t.project_id = p.id
        GROUP BY p.id ORDER BY p.created_at DESC, p.id DESC""")
    return rows


@app.post("/api/{mode}/projects")
def create_project(mode: str, value: ProjectInput):
    db = database(mode)
    identifier = insert_id(db, "INSERT INTO projects(title, description, created_at) VALUES (?, ?, ?) RETURNING id", (value.title.strip(), value.description, now()))
    rows, _ = query(db, "SELECT * FROM projects WHERE id = ?", (identifier,))
    return rows[0]


@app.put("/api/{mode}/projects/{project_id}")
def update_project(mode: str, project_id: int, value: ProjectInput):
    db = database(mode)
    _, count = query(db, "UPDATE projects SET title = ?, description = ? WHERE id = ?", (value.title.strip(), value.description, project_id))
    if count == 0:
        raise HTTPException(404, "Project not found.")
    rows, _ = query(db, "SELECT * FROM projects WHERE id = ?", (project_id,))
    return rows[0]


@app.delete("/api/{mode}/projects/{project_id}")
def delete_project(mode: str, project_id: int):
    db = database(mode)
    _, count = query(db, "DELETE FROM projects WHERE id = ?", (project_id,))
    if count == 0:
        raise HTTPException(404, "Project not found.")
    return {"deleted": True}


@app.get("/api/{mode}/tasks")
def list_tasks(
    mode: str,
    project_id: int | None = None,
    status: str | None = None,
    priority: int | None = Query(None, ge=1, le=3),
    search: str | None = None,
    sort: str = "created_at",
    direction: str = "desc",
    limit: int = Query(100, ge=1, le=1000),
    offset: int = Query(0, ge=0),
):
    db = database(mode)
    sort_columns = {"created_at": "t.created_at", "due_date": "t.due_date", "priority": "t.priority", "title": "t.title"}
    if sort not in sort_columns or direction not in {"asc", "desc"}:
        raise HTTPException(400, "Invalid sort parameters.")
    clauses, params = [], []
    for column, value in (("t.project_id", project_id), ("t.status", status), ("t.priority", priority)):
        if value is not None:
            clauses.append(f"{column} = ?")
            params.append(value)
    if search:
        clauses.append("t.title LIKE ?")
        params.append(f"%{search}%")
    where = f"WHERE {' AND '.join(clauses)}" if clauses else ""
    rows, _ = query(db, f"""SELECT t.*, p.title AS project_title FROM tasks t
        JOIN projects p ON p.id = t.project_id {where}
        ORDER BY {sort_columns[sort]} {direction.upper()}, t.id DESC LIMIT ? OFFSET ?""", (*params, limit, offset))
    return rows


@app.post("/api/{mode}/tasks")
def create_task(mode: str, value: TaskInput):
    db = database(mode)
    identifier = insert_id(db, """INSERT INTO tasks(project_id,title,description,status,priority,created_at,due_date)
        VALUES(?,?,?,?,?,?,?) RETURNING id""", (value.project_id, value.title.strip(), value.description, value.status, value.priority, now(), value.due_date.isoformat().replace("+00:00", "Z") if value.due_date else None))
    rows, _ = query(db, """SELECT t.*, p.title AS project_title FROM tasks t JOIN projects p ON p.id=t.project_id WHERE t.id=?""", (identifier,))
    return rows[0]


@app.put("/api/{mode}/tasks/{task_id}")
def update_task(mode: str, task_id: int, value: TaskInput):
    db = database(mode)
    _, count = query(db, """UPDATE tasks SET project_id=?,title=?,description=?,status=?,priority=?,due_date=? WHERE id=?""",
        (value.project_id, value.title.strip(), value.description, value.status, value.priority, value.due_date.isoformat().replace("+00:00", "Z") if value.due_date else None, task_id))
    if count == 0:
        raise HTTPException(404, "Task not found.")
    rows, _ = query(db, """SELECT t.*, p.title AS project_title FROM tasks t JOIN projects p ON p.id=t.project_id WHERE t.id=?""", (task_id,))
    return rows[0]


@app.delete("/api/{mode}/tasks/{task_id}")
def delete_task(mode: str, task_id: int):
    _, count = query(database(mode), "DELETE FROM tasks WHERE id=?", (task_id,))
    if count == 0:
        raise HTTPException(404, "Task not found.")
    return {"deleted": True}


@app.get("/api/{mode}/stats")
def get_stats(mode: str):
    db = database(mode)
    projects, _ = query(db, "SELECT COUNT(*) AS count FROM projects")
    tasks, _ = query(db, "SELECT COUNT(*) AS count FROM tasks")
    statuses, _ = query(db, "SELECT status, COUNT(*) AS count FROM tasks GROUP BY status")
    priorities, _ = query(db, "SELECT priority, COUNT(*) AS count FROM tasks GROUP BY priority")
    by_project, _ = query(db, """SELECT p.id, p.title, COUNT(t.id) AS count FROM projects p
        LEFT JOIN tasks t ON t.project_id=p.id GROUP BY p.id ORDER BY count DESC""")
    completed, _ = query(db, "SELECT COUNT(*) AS count FROM tasks WHERE status='completed'")
    overdue, _ = query(db, "SELECT COUNT(*) AS count FROM tasks WHERE due_date < ? AND status != 'completed'", (now(),))
    total = tasks[0]["count"]
    return {"projects": projects[0]["count"], "tasks": total, "statuses": statuses, "priorities": priorities, "by_project": by_project,
        "completion_rate": round(completed[0]["count"] * 100 / total, 2) if total else 0, "overdue": overdue[0]["count"]}


@app.delete("/api/{mode}/data")
def clear_data(mode: str):
    db = database(mode)
    with db.connection() as connection:
        projects = connection.execute("SELECT COUNT(*) AS count FROM projects").fetchone()["count"]
        tasks = connection.execute("SELECT COUNT(*) AS count FROM tasks").fetchone()["count"]
        connection.execute("DELETE FROM tasks")
        connection.execute("DELETE FROM projects")
        connection.commit()
    return {"projects": projects, "tasks": tasks}


@app.post("/api/{mode}/generate")
def generate_data(mode: str, value: GenerationInput):
    db = database(mode)
    backend_started = time.perf_counter()
    projects, tasks = generate(value.count, value.seed)
    try:
        with db.connection() as connection:
            if value.replace:
                connection.execute("DELETE FROM tasks")
                connection.execute("DELETE FROM projects")
            existing = connection.execute("SELECT COUNT(*) AS count FROM projects").fetchone()["count"]
            project_ids = [row["id"] for row in connection.execute("SELECT id FROM projects ORDER BY id").fetchall()] if existing else []
            if not project_ids:
                for project in projects:
                    cursor = connection.execute(db.sql("INSERT INTO projects(title,description,created_at) VALUES(?,?,?) RETURNING id"),
                        (project["title"], project["description"], project["created_at"]))
                    project_ids.append(cursor.fetchone()["id"])
            task_rows = [
                (project_ids[task["project_index"] % len(project_ids)], task["title"], task["description"], task["status"], task["priority"], task["created_at"], task["due_date"])
                for task in tasks
            ]
            insert_started = time.perf_counter()
            cursor = connection.cursor()
            cursor.executemany(db.sql("""INSERT INTO tasks(project_id,title,description,status,priority,created_at,due_date) VALUES(?,?,?,?,?,?,?)"""), task_rows)
            connection.commit()
            sql_ms = (time.perf_counter() - insert_started) * 1000
    except Exception as error:
        raise HTTPException(400, f"Could not generate test data: {error}") from error
    return {
        "projects": len(project_ids) if not existing else 0,
        "tasks": value.count,
        "seed": value.seed,
        "sql_ms": round(sql_ms, 4),
        "backend_time_ms": round((time.perf_counter() - backend_started) * 1000, 4),
    }


def measured(db, callback, repeats: int):
    callback()
    times, result = [], None
    for _ in range(repeats):
        started = time.perf_counter()
        result = callback()
        times.append((time.perf_counter() - started) * 1000)
    return {"mean_ms": round(statistics.mean(times), 4), "median_ms": round(statistics.median(times), 4),
        "min_ms": round(min(times), 4), "max_ms": round(max(times), 4), "repeats": repeats, "result": result}


def research(db, name: str, repeats: int, seed: int):
    results: dict[str, Any] = {}
    with db.connection() as connection:
        if name in {"all", "select"}:
            results["select"] = measured(db, lambda: len(connection.execute(db.sql("""SELECT t.id FROM tasks t
                JOIN projects p ON p.id=t.project_id WHERE t.project_id=? AND t.status=? ORDER BY t.created_at DESC LIMIT 100"""), (1, "new")).fetchall()), repeats)
        if name in {"all", "search"}:
            results["search"] = measured(db, lambda: len(connection.execute(db.sql("SELECT id FROM tasks WHERE title LIKE ?"), ("%database%",)).fetchall()), repeats)
        if name in {"all", "aggregate"}:
            results["aggregate"] = measured(db, lambda: [dict(row) for row in connection.execute("SELECT status,COUNT(*) AS count FROM tasks GROUP BY status").fetchall()], repeats)
        if name in {"all", "update_delete"}:
            def update_delete():
                with db.connection() as tx:
                    cursor = tx.execute(db.sql("INSERT INTO projects(title,created_at) VALUES(?,?) RETURNING id"), (f"crud-{seed}", now()))
                    project_id = cursor.fetchone()["id"]
                    cursor = tx.execute(db.sql("""INSERT INTO tasks(project_id,title,status,priority,created_at) VALUES(?,?,?,?,?) RETURNING id"""), (project_id, "before-update", "new", 2, now()))
                    task_id = cursor.fetchone()["id"]
                    updated = tx.execute(db.sql("UPDATE tasks SET title=? WHERE id=?"), ("after-update", task_id)).rowcount == 1
                    title = tx.execute(db.sql("SELECT title FROM tasks WHERE id=?"), (task_id,)).fetchone()["title"]
                    deleted = tx.execute(db.sql("DELETE FROM tasks WHERE id=?"), (task_id,)).rowcount == 1
                    remaining = tx.execute(db.sql("SELECT COUNT(*) AS count FROM tasks WHERE id=?"), (task_id,)).fetchone()["count"]
                    tx.execute(db.sql("DELETE FROM projects WHERE id=?"), (project_id,))
                    tx.commit()
                    return {"updated": updated and title == "after-update", "deleted": deleted and remaining == 0, "fixture_removed": True}
            results["update_delete"] = measured(db, update_delete, repeats)
        if name in {"all", "index"}:
            connection.execute(f"DROP INDEX IF EXISTS {RESEARCH_INDEX}")
            baseline = measured(db, lambda: len(connection.execute(db.sql("""SELECT id FROM tasks
                WHERE project_id=? AND status=? ORDER BY created_at DESC LIMIT 100"""), (1, "new")).fetchall()), repeats)
            connection.execute(f"CREATE INDEX IF NOT EXISTS {RESEARCH_INDEX} ON tasks(project_id,status,created_at)")
            indexed = measured(db, lambda: len(connection.execute(db.sql("""SELECT id FROM tasks
                WHERE project_id=? AND status=? ORDER BY created_at DESC LIMIT 100"""), (1, "new")).fetchall()), repeats)
            if db.mode == "sqlite":
                plan = [dict(row) for row in connection.execute("EXPLAIN QUERY PLAN SELECT id FROM tasks WHERE project_id=1 AND status='new' ORDER BY created_at DESC LIMIT 100").fetchall()]
            else:
                plan = [dict(row) for row in connection.execute(db.sql("EXPLAIN SELECT id FROM tasks WHERE project_id=? AND status=? ORDER BY created_at DESC LIMIT 100"), (1, "new")).fetchall()]
            results["index"] = {"before": baseline, "after": indexed, "plan": plan}
            connection.commit()
        if name in {"all", "commit"}:
            def commit():
                with db.connection() as tx:
                    cursor = tx.execute(db.sql("INSERT INTO projects(title,description,created_at) VALUES(?,?,?) RETURNING id"), (f"commit-{seed}", "transaction test", now()))
                    project_id = cursor.fetchone()["id"]
                    tx.execute(db.sql("INSERT INTO tasks(project_id,title,description,status,priority,created_at,due_date) VALUES(?,?,?,?,?,?,?)"), (project_id, "commit-task", None, "new", 2, now(), None))
                    tx.commit()
                    found = tx.execute(db.sql("SELECT COUNT(*) AS count FROM tasks WHERE project_id=?"), (project_id,)).fetchone()
                    persisted = dict(found)["count"] == 1
                    tx.execute(db.sql("DELETE FROM projects WHERE id=?"), (project_id,))
                    tx.commit()
                    return persisted
            results["commit"] = measured(db, commit, repeats)
        if name in {"all", "rollback"}:
            def rollback():
                title = f"rollback-{seed}-{time.time_ns()}"
                error_raised = False
                with db.connection() as tx:
                    tx.execute("BEGIN")
                    cursor = tx.execute(db.sql("INSERT INTO projects(title,created_at) VALUES(?,?) RETURNING id"), (title, now()))
                    project_id = cursor.fetchone()["id"]
                    tx.execute(db.sql("INSERT INTO tasks(project_id,title,status,priority,created_at) VALUES(?,?,?,?,?)"), (project_id, "partial-before-error", "new", 2, now()))
                    try:
                        tx.execute(db.sql("INSERT INTO tasks(project_id,title,status,priority,created_at) VALUES(?,?,?,?,?)"), (project_id, "controlled-error", "new", 99, now()))
                    except (sqlite3.IntegrityError, PostgresIntegrityError):
                        error_raised = True
                        tx.rollback()
                    else:
                        tx.rollback()
                found, _ = query(db, "SELECT COUNT(*) AS count FROM projects WHERE title=?", (title,))
                return {"controlled_error": error_raised, "rollback_verified": found[0]["count"] == 0}
            results["rollback"] = measured(db, rollback, repeats)
    return results


@app.post("/api/{mode}/research")
def run_research(mode: str, value: ResearchInput):
    if mode != "wasm" and value.scenario == "reload":
        raise HTTPException(400, "Reload/persistence verification is available only in SQLite WASM mode.")
    db = database(mode)
    started = time.perf_counter()
    results = research(db, value.scenario, value.repeats, value.seed)
    return {"mode": mode, "scenario": value.scenario, "seed": value.seed, "repeats": value.repeats, "data_size": query(db, "SELECT COUNT(*) AS count FROM tasks")[0][0]["count"],
        "created_at": now(), "full_time_ms": round((time.perf_counter() - started) * 1000, 3),
        "http_requests": 1, "results": results, "environment": {"backend": "FastAPI", "database": mode}}


@app.get("/api/{mode}/export")
def export(mode: str, format: str = "json"):
    db = database(mode)
    projects, _ = query(db, "SELECT * FROM projects ORDER BY id")
    tasks, _ = query(db, "SELECT * FROM tasks ORDER BY id")
    data = {"projects": projects, "tasks": tasks, "exported_at": now(), "mode": mode}
    if format == "csv":
        stream = io.StringIO()
        writer = csv.DictWriter(stream, fieldnames=["id", "project_id", "title", "description", "status", "priority", "created_at", "due_date"])
        writer.writeheader()
        writer.writerows(tasks)
        return Response(stream.getvalue(), media_type="text/csv", headers={"Content-Disposition": "attachment; filename=datadesk-export.csv"})
    return data
