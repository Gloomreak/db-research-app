export type Mode = 'postgres' | 'sqlite' | 'wasm';
export type TaskStatus = 'new' | 'in_progress' | 'completed';
export type TaskSort = 'created_at' | 'due_date' | 'priority' | 'title';

export interface Project {
  id: number;
  title: string;
  description: string | null;
  created_at: string;
  task_count?: number;
  completed_count?: number;
}

export interface Task {
  id: number;
  project_id: number;
  project_title?: string;
  title: string;
  description: string | null;
  status: TaskStatus;
  priority: number;
  created_at: string;
  due_date: string | null;
}

export interface ProjectInput {
  title: string;
  description: string | null;
}

export type TaskInput = Omit<Task, 'id' | 'created_at' | 'project_title'>;

export interface TaskFilters {
  project_id?: number;
  status?: TaskStatus;
  priority?: number;
  search?: string;
  sort?: TaskSort;
  direction?: 'asc' | 'desc';
  limit?: number;
  offset?: number;
}

export interface Stats {
  projects: number;
  tasks: number;
  overdue: number;
  statuses: { status: TaskStatus; count: number }[];
  priorities: { priority: number; count: number }[];
  by_project: { id: number; title: string; count: number }[];
  completion_rate: number;
}

export interface Metric {
  mean_ms: number;
  median_ms: number;
  min_ms: number;
  max_ms: number;
  repeats: number;
  result: number | boolean | string | unknown[];
}

export interface ResearchRun {
  mode: Mode;
  scenario: string;
  seed: number;
  repeats?: number;
  data_size: number;
  created_at: string;
  ui_total_ms: number;
  sql_ms?: number;
  backend_time_ms?: number;
  http_requests: number;
  transferred_bytes?: number;
  results: Record<string, unknown>;
  environment: Record<string, string>;
}

export interface Repository {
  readonly mode: Mode;
  init(): Promise<void>;
  close(): Promise<void>;
  listProjects(): Promise<Project[]>;
  saveProject(input: ProjectInput, id?: number): Promise<Project>;
  deleteProject(id: number): Promise<void>;
  listTasks(filters: TaskFilters): Promise<Task[]>;
  saveTask(input: TaskInput, id?: number): Promise<Task>;
  deleteTask(id: number): Promise<void>;
  stats(): Promise<Stats>;
  clearData(): Promise<{ projects: number; tasks: number }>;
  generateData(count: number, seed: number, replace: boolean): Promise<Record<string, unknown>>;
  research(scenario: string, repeats: number, seed: number): Promise<ResearchRun>;
  exportData(format: 'json' | 'csv'): Promise<Blob>;
}
