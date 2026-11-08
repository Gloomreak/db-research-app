from fastapi.testclient import TestClient

from backend.app.main import app
from backend.app.db import Database


client = TestClient(app)


def test_projects_tasks_filters_stats_and_cascade(tmp_path, monkeypatch):
    monkeypatch.setenv("SQLITE_PATH", str(tmp_path / "test.sqlite3"))

    project = client.post("/api/sqlite/projects", json={"title": "Research", "description": None})
    assert project.status_code == 200
    project_id = project.json()["id"]

    first = client.post("/api/sqlite/tasks", json={
        "project_id": project_id, "title": "Measure database", "status": "new", "priority": 1,
        "due_date": "2020-01-01T00:00:00Z",
    })
    second = client.post("/api/sqlite/tasks", json={
        "project_id": project_id, "title": "Review results", "status": "completed", "priority": 3,
    })
    assert first.status_code == 200
    assert second.status_code == 200
    assert first.json()["project_title"] == "Research"

    filtered = client.get("/api/sqlite/tasks", params={"project_id": project_id, "status": "new", "priority": 1})
    assert [row["title"] for row in filtered.json()] == ["Measure database"]
    searched = client.get("/api/sqlite/tasks", params={"search": "database"})
    assert len(searched.json()) == 1

    stats = client.get("/api/sqlite/stats").json()
    assert stats["projects"] == 1
    assert stats["tasks"] == 2
    assert stats["completion_rate"] == 50
    assert stats["overdue"] == 1

    deleted = client.delete(f"/api/sqlite/projects/{project_id}")
    assert deleted.status_code == 200
    assert client.get("/api/sqlite/tasks").json() == []


def test_generation_is_reproducible_and_replace_is_atomic(tmp_path, monkeypatch):
    monkeypatch.setenv("SQLITE_PATH", str(tmp_path / "generate.sqlite3"))
    result = client.post("/api/sqlite/generate", json={"count": 20, "seed": 123, "replace": True})
    assert result.status_code == 200
    first_set = client.get("/api/sqlite/tasks").json()
    result = client.post("/api/sqlite/generate", json={"count": 20, "seed": 123, "replace": True})
    assert result.status_code == 200
    second_set = client.get("/api/sqlite/tasks").json()
    assert [task["title"] for task in first_set] == [task["title"] for task in second_set]
    assert len(second_set) == 20


def test_research_index_and_real_transactions(tmp_path, monkeypatch):
    monkeypatch.setenv("SQLITE_PATH", str(tmp_path / "research.sqlite3"))
    assert client.post("/api/sqlite/generate", json={"count": 30, "seed": 4, "replace": True}).status_code == 200
    response = client.post("/api/sqlite/research", json={"scenario": "all", "repeats": 2, "seed": 4})
    assert response.status_code == 200
    results = response.json()["results"]
    assert results["commit"]["result"] == 1
    assert results["rollback"]["result"] == {
        "controlled_error": True, "rollback_verified": True,
    }
    assert results["index"]["before"]["result"] == results["index"]["after"]["result"]
    assert results["index"]["plan"]
    assert results["update_delete"]["result"] == {
        "updated": True, "deleted": True, "fixture_removed": True,
    }
    after_run = client.get("/api/sqlite/tasks")
    assert after_run.status_code == 200
    assert len(after_run.json()) == 30


def test_invalid_foreign_key_is_rejected(tmp_path, monkeypatch):
    monkeypatch.setenv("SQLITE_PATH", str(tmp_path / "constraints.sqlite3"))
    response = client.post("/api/sqlite/tasks", json={
        "project_id": 9999, "title": "Orphan", "status": "new", "priority": 1,
    })
    assert response.status_code >= 400


def test_clear_database_removes_tasks_and_projects_but_keeps_schema(tmp_path, monkeypatch):
    monkeypatch.setenv("SQLITE_PATH", str(tmp_path / "clear.sqlite3"))
    project = client.post("/api/sqlite/projects", json={"title": "Will be removed", "description": None})
    project_id = project.json()["id"]
    task = client.post("/api/sqlite/tasks", json={
        "project_id": project_id, "title": "Also removed", "status": "new", "priority": 2,
    })
    assert task.status_code == 200

    response = client.delete("/api/sqlite/data")

    assert response.status_code == 200
    assert response.json() == {"projects": 1, "tasks": 1}
    assert client.get("/api/sqlite/projects").json() == []
    assert client.get("/api/sqlite/tasks").json() == []
    assert client.post("/api/sqlite/projects", json={"title": "Schema remains", "description": None}).status_code == 200


def test_database_connection_context_closes_connection(tmp_path, monkeypatch):
    monkeypatch.setenv("SQLITE_PATH", str(tmp_path / "connection.sqlite3"))
    database = Database("sqlite")

    with database.connection() as connection:
        connection.execute("SELECT 1")

    try:
        connection.execute("SELECT 1")
    except Exception as error:
        assert "closed" in str(error).lower()
    else:
        raise AssertionError("Database connection was not closed.")
