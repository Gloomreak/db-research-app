import type {
  Mode, Project, ProjectInput, Repository, ResearchRun, Stats, Task, TaskFilters, TaskInput,
} from './types';

type ServerMode = Exclude<Mode, 'wasm'>;

export class ApiRepository implements Repository {
  readonly mode: ServerMode;

  constructor(mode: ServerMode) {
    this.mode = mode;
  }

  async init() {
    await this.request('health');
  }

  async close() {}

  private async request<T>(path: string, options?: RequestInit): Promise<T> {
    let response: Response;
    try {
      response = await fetch(`/api/${path}`, options);
    } catch (error) {
      throw new Error(`Backend API недоступен: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (!response.ok) {
      const payload = await response.json().catch(() => null) as { detail?: string } | null;
      throw new Error(payload?.detail ?? `Ошибка API: ${response.status} ${response.statusText}`);
    }
    return response.json() as Promise<T>;
  }

  private path(path: string) {
    return `${this.mode}/${path}`;
  }

  listProjects() {
    return this.request<Project[]>(this.path('projects'));
  }

  saveProject(input: ProjectInput, id?: number) {
    return this.request<Project>(this.path(id ? `projects/${id}` : 'projects'), {
      method: id ? 'PUT' : 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    });
  }

  async deleteProject(id: number) {
    await this.request(this.path(`projects/${id}`), { method: 'DELETE' });
  }

  listTasks(filters: TaskFilters) {
    const query = new URLSearchParams();
    Object.entries(filters).forEach(([key, value]) => {
      if (value !== undefined && value !== '') query.set(key, String(value));
    });
    return this.request<Task[]>(this.path(`tasks?${query}`));
  }

  saveTask(input: TaskInput, id?: number) {
    return this.request<Task>(this.path(id ? `tasks/${id}` : 'tasks'), {
      method: id ? 'PUT' : 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    });
  }

  async deleteTask(id: number) {
    await this.request(this.path(`tasks/${id}`), { method: 'DELETE' });
  }

  stats() {
    return this.request<Stats>(this.path('stats'));
  }

  clearData() {
    return this.request<{ projects: number; tasks: number }>(this.path('data'), { method: 'DELETE' });
  }

  async generateData(count: number, seed: number, replace: boolean) {
    const started = performance.now();
    let response: Response;
    try {
      response = await fetch(`/api/${this.path('generate')}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ count, seed, replace }),
      });
    } catch (error) {
      throw new Error(`Backend API недоступен: ${error instanceof Error ? error.message : String(error)}`);
    }
    const body = await response.text();
    if (!response.ok) {
      let detail = body;
      try { detail = JSON.parse(body).detail ?? body; } catch { /* Keep the raw API error. */ }
      throw new Error(detail);
    }
    return {
      ...JSON.parse(body) as Record<string, unknown>,
      ui_total_ms: performance.now() - started,
      http_requests: 1,
      transferred_bytes: new Blob([body]).size,
    };
  }

  async research(scenario: string, repeats: number, seed: number): Promise<ResearchRun> {
    if (scenario === 'reload') throw new Error('Проверка перезагрузки доступна только в режиме SQLite WASM.');
    const started = performance.now();
    const response = await fetch(`/api/${this.path('research')}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ scenario, repeats, seed }),
    });
    const payload = await response.text();
    if (!response.ok) {
      let detail = payload;
      try { detail = JSON.parse(payload).detail ?? payload; } catch { /* Keep the raw API error. */ }
      throw new Error(detail);
    }
    const run = JSON.parse(payload) as Omit<ResearchRun, 'ui_total_ms' | 'transferred_bytes'> & { full_time_ms: number };
    return { ...run, ui_total_ms: performance.now() - started, backend_time_ms: run.full_time_ms, transferred_bytes: new Blob([payload]).size };
  }

  async exportData(format: 'json' | 'csv') {
    const response = await fetch(`/api/${this.path(`export?format=${format}`)}`);
    if (!response.ok) throw new Error(`Не удалось экспортировать данные: ${response.statusText}`);
    return response.blob();
  }
}
