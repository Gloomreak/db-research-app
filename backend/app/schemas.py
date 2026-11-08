from __future__ import annotations

from datetime import datetime, timezone
from typing import Literal

from pydantic import BaseModel, Field, field_validator


Status = Literal["new", "in_progress", "completed"]


class ProjectInput(BaseModel):
    title: str = Field(min_length=1, max_length=200)
    description: str | None = None

    @field_validator("title")
    @classmethod
    def normalized_title(cls, value: str) -> str:
        value = value.strip()
        if not value:
            raise ValueError("Title cannot be empty.")
        return value


class TaskInput(BaseModel):
    project_id: int
    title: str = Field(min_length=1, max_length=200)
    description: str | None = None
    status: Status = "new"
    priority: int = Field(ge=1, le=3)
    due_date: datetime | None = None

    @field_validator("title")
    @classmethod
    def normalized_title(cls, value: str) -> str:
        value = value.strip()
        if not value:
            raise ValueError("Title cannot be empty.")
        return value

    @field_validator("due_date")
    @classmethod
    def utc_due_date(cls, value: datetime | None) -> datetime | None:
        if value is None:
            return None
        if value.tzinfo is None:
            return value.replace(tzinfo=timezone.utc)
        return value.astimezone(timezone.utc)


class GenerationInput(BaseModel):
    count: int = Field(ge=1, le=100_000)
    seed: int = 42
    replace: bool = False


class ResearchInput(BaseModel):
    scenario: Literal["all", "select", "search", "aggregate", "update_delete", "index", "commit", "rollback", "reload"]
    repeats: int = Field(default=5, ge=1, le=20)
    seed: int = 42
