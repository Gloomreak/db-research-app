from __future__ import annotations

from datetime import datetime, timedelta, timezone
from typing import Iterator


STATUSES = ("new", "in_progress", "completed")
PRIORITIES = (1, 2, 3)
PROJECTS = ("Research", "Product", "Operations", "Design", "Engineering", "Support", "Analytics", "Planning")
ADJECTIVES = ("Review", "Improve", "Prepare", "Test", "Document", "Plan", "Update", "Measure", "Explore", "Build")
SUBJECTS = ("database", "dashboard", "workflow", "report", "interface", "migration", "query", "prototype", "release", "analysis")
EPOCH = datetime(2024, 1, 1, tzinfo=timezone.utc)


class Random:
    def __init__(self, seed: int):
        self.state = seed & 0xFFFFFFFF

    def next(self) -> int:
        self.state = (1664525 * self.state + 1013904223) & 0xFFFFFFFF
        return self.state

    def pick(self, values):
        return values[self.next() % len(values)]


def generate(count: int, seed: int) -> tuple[list[dict], Iterator[dict]]:
    random = Random(seed)
    projects = [
        {"title": name, "description": f"Seeded sample project: {name}", "created_at": EPOCH.isoformat().replace("+00:00", "Z")}
        for name in PROJECTS
    ]

    def tasks():
        for index in range(count):
            created = EPOCH + timedelta(days=random.next() % 1000, seconds=random.next() % 86400)
            due = created + timedelta(days=random.next() % 90) if index % 4 else None
            yield {
                "project_index": random.next() % len(projects),
                "title": f"{random.pick(ADJECTIVES)} {random.pick(SUBJECTS)} {index + 1}",
                "description": f"Deterministic sample task #{index + 1}",
                "status": random.pick(STATUSES),
                "priority": random.pick(PRIORITIES),
                "created_at": created.isoformat().replace("+00:00", "Z"),
                "due_date": due.isoformat().replace("+00:00", "Z") if due else None,
            }

    return projects, tasks()
