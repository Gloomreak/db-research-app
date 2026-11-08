import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';
import { Bar, Doughnut } from 'react-chartjs-2';
import {
  Chart as ChartJS, ArcElement, BarElement, CategoryScale, LinearScale, Tooltip, Legend,
} from 'chart.js';
import { ApiRepository } from './database/apiRepository';
import { WasmRepository } from './database/wasmRepository';
import type { Mode, Project, ProjectInput, Repository, ResearchRun, Stats, Task, TaskInput, TaskStatus } from './database/types';

ChartJS.register(ArcElement, BarElement, CategoryScale, LinearScale, Tooltip, Legend);

const MODES: { id: Mode; label: string; detail: string }[] = [
  { id: 'postgres', label: 'PostgreSQL', detail: 'сервер' },
  { id: 'sqlite', label: 'SQLite', detail: 'сервер' },
  { id: 'wasm', label: 'SQLite WASM', detail: 'браузер, OPFS' },
];
const STATUS_LABELS: Record<TaskStatus, string> = { new: 'Новая', in_progress: 'В работе', completed: 'Завершена' };
const SCENARIOS = [
  ['all', 'Все сценарии'], ['select', 'JOIN / выборка'], ['search', 'Поиск по названию'],
  ['aggregate', 'GROUP BY'], ['update_delete', 'UPDATE / DELETE'], ['index', 'До / после индекса'],
  ['commit', 'Транзакция COMMIT'], ['rollback', 'Транзакция ROLLBACK'], ['reload', 'Перезапуск / OPFS'],
];

type View = 'overview' | 'projects' | 'project' | 'tasks' | 'research';
type ResearchTab = 'compare' | 'experiments' | 'sql' | 'transactions';
type Dialog = { kind: 'project'; value?: Project } | { kind: 'task'; value?: Task } | null;
type HistoryItem = { run?: ResearchRun; title: string; error?: string; generated?: Record<string, unknown> };

function createRepository(mode: Mode): Repository {
  return mode === 'wasm' ? new WasmRepository() : new ApiRepository(mode);
}

function App() {
  const [mode, setMode] = useState<Mode>(() => {
    try {
      const saved = localStorage.getItem('datadesk-mode');
      return MODES.some(item => item.id === saved) ? saved as Mode : 'sqlite';
    } catch { return 'sqlite'; }
  });
  const repository = useMemo(() => createRepository(mode), [mode]);
  const [view, setView] = useState<View>('overview');
  const [selectedProject, setSelectedProject] = useState<Project | null>(null);
  const [selectedTask, setSelectedTask] = useState<Task | null>(null);
  const [projects, setProjects] = useState<Project[]>([]);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [recentTasks, setRecentTasks] = useState<Task[]>([]);
  const [stats, setStats] = useState<Stats | null>(null);
  const [loading, setLoading] = useState(true);
  const [connectionState, setConnectionState] = useState<'checking' | 'connected' | 'error'>('checking');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [dialog, setDialog] = useState<Dialog>(null);
  const [query, setQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [priorityFilter, setPriorityFilter] = useState('');
  const [projectFilter, setProjectFilter] = useState('');
  const [sort, setSort] = useState<'created_at' | 'due_date' | 'priority'>('created_at');
  const [runs, setRuns] = useState<HistoryItem[]>([]);
  const [scenario, setScenario] = useState('all');
  const [repeats, setRepeats] = useState(5);
  const [seed, setSeed] = useState(42);
  const [dataCount, setDataCount] = useState(1000);
  const [replaceData, setReplaceData] = useState(false);
  const [researchTab, setResearchTab] = useState<ResearchTab>('compare');
  const [compareScenario, setCompareScenario] = useState('all');

  const refresh = useCallback(async (showSpinner = true) => {
    if (showSpinner) setLoading(true);
    try {
      const [nextProjects, nextTasks, nextStats, nextRecentTasks] = await Promise.all([
        repository.listProjects(),
        repository.listTasks({
          search: query || undefined,
          status: statusFilter ? statusFilter as TaskStatus : undefined,
          priority: priorityFilter ? Number(priorityFilter) : undefined,
          project_id: projectFilter ? Number(projectFilter) : undefined,
          sort,
          direction: sort === 'priority' ? 'asc' : 'desc',
          limit: 1000,
        }),
        repository.stats(),
        repository.listTasks({ limit: 6, sort: 'created_at', direction: 'desc' }),
      ]);
      setProjects(nextProjects);
      setTasks(nextTasks);
      setRecentTasks(nextRecentTasks);
      setStats(nextStats);
      setConnectionState('connected');
      setError('');
    } catch (reason) {
      setConnectionState('error');
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setLoading(false);
    }
  }, [repository, query, statusFilter, priorityFilter, projectFilter, sort]);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setConnectionState('checking');
    setError('');
    setProjects([]);
    setTasks([]);
    setRecentTasks([]);
    setStats(null);
    repository.init().then(() => { if (active) void refresh(false); }).catch(reason => {
      if (active) {
        setConnectionState('error');
        setError(reason instanceof Error ? reason.message : String(reason));
        setLoading(false);
      }
    });
    return () => { active = false; void repository.close(); };
  }, [repository]); // Each mode opens its own independent store.

  useEffect(() => {
    if (!['tasks', 'project', 'overview'].includes(view)) return;
    const timer = window.setTimeout(() => { void refresh(false); }, 180);
    return () => window.clearTimeout(timer);
  }, [query, statusFilter, priorityFilter, projectFilter, sort, view, refresh]);

  const switchMode = async (next: Mode) => {
    if (next === mode) return;
    if (!window.confirm(`Переключиться на ${MODES.find(item => item.id === next)?.label}?\n\nБазы режимов независимы: данные не копируются и не объединяются.`)) return;
    setMode(next);
    setSelectedTask(null);
    setSelectedProject(null);
    setProjectFilter('');
    if (view === 'project') setView('projects');
    try {
      localStorage.setItem('datadesk-mode', next);
      setNotice('Режим изменён. Данные прежней базы не переносились.');
    } catch {
      setNotice('Режим изменён, но браузер не сохранил выбор. Данные прежней базы не переносились.');
    }
  };

  const saveProject = async (input: ProjectInput, id?: number) => {
    setBusy(true);
    try {
      await repository.saveProject(input, id);
      setDialog(null);
      setNotice(id ? 'Проект обновлён.' : 'Проект создан.');
      await refresh(false);
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setBusy(false); }
  };

  const removeProject = async (project: Project) => {
    const count = project.task_count ?? 0;
    if (!window.confirm(`Удалить проект «${project.title}»? Вместе с ним будут удалены ${count} связанных задач.`)) return;
    setBusy(true);
    try {
      await repository.deleteProject(project.id);
      setNotice('Проект и его задачи удалены.');
      await refresh(false);
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setBusy(false); }
  };

  const saveTask = async (input: TaskInput, id?: number) => {
    setBusy(true);
    try {
      await repository.saveTask(input, id);
      setDialog(null);
      setSelectedTask(null);
      setNotice(id ? 'Задача обновлена.' : 'Задача создана.');
      await refresh(false);
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setBusy(false); }
  };

  const removeTask = async (task: Task) => {
    if (!window.confirm(`Удалить задачу «${task.title}»?`)) return;
    setBusy(true);
    try {
      await repository.deleteTask(task.id);
      setSelectedTask(null);
      setNotice('Задача удалена.');
      await refresh(false);
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setBusy(false); }
  };

  const generate = async () => {
    if (!projects.length && !replaceData) {
      // Initial generation creates a repeatable set of projects as well as tasks.
    } else if (replaceData && !window.confirm(`Удалить все данные режима ${MODES.find(item => item.id === mode)?.label} и создать ${dataCount.toLocaleString('ru-RU')} тестовых задач? Действие необратимо.`)) return;
    setBusy(true);
    try {
      const generated = await repository.generateData(dataCount, seed, replaceData);
      const run: ResearchRun = {
        mode,
        scenario: 'mass_insert',
        seed,
        data_size: replaceData ? dataCount : (stats?.tasks ?? 0) + dataCount,
        created_at: new Date().toISOString(),
        ui_total_ms: Number(generated.ui_total_ms ?? 0),
        sql_ms: Number(generated.sql_ms ?? 0),
        backend_time_ms: typeof generated.backend_time_ms === 'number' ? generated.backend_time_ms : undefined,
        http_requests: Number(generated.http_requests ?? 0),
        transferred_bytes: Number(generated.transferred_bytes ?? 0),
        results: { inserted_records: generated.tasks, projects_created: generated.projects },
        environment: { engine: mode === 'wasm' ? 'SQLite WASM' : mode, storage: mode === 'wasm' ? 'OPFS' : 'server' },
      };
      setRuns(current => [{ title: 'Массовая вставка', run }, ...current]);
      setNotice(`Создано задач: ${Number(generated.tasks).toLocaleString('ru-RU')}.`);
      await refresh(false);
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : String(reason);
      setError(message);
      setRuns(current => [{ title: 'Массовая вставка', error: message }, ...current]);
    } finally { setBusy(false); }
  };

  const clearData = async () => {
    const projectCount = stats?.projects ?? 0;
    const taskCount = stats?.tasks ?? 0;
    if (!window.confirm(
      `Очистить базу ${MODES.find(item => item.id === mode)?.label}?\n\nБудут удалены ${projectCount} проектов и ${taskCount} задач только в этом режиме. Таблицы и настройки базы останутся. Действие необратимо.`,
    )) return;
    setBusy(true);
    try {
      const removed = await repository.clearData();
      setSelectedProject(null);
      setSelectedTask(null);
      setProjectFilter('');
      setNotice(`База очищена. Удалено проектов: ${removed.projects}, задач: ${removed.tasks}.`);
      await refresh(false);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally { setBusy(false); }
  };

  const runResearch = async (targetScenario = scenario) => {
    setBusy(true);
    const started = performance.now();
    try {
      const measuredRun = await repository.research(targetScenario, repeats, seed);
      const run = { ...measuredRun, ui_total_ms: performance.now() - started };
      setRuns(current => [{ title: SCENARIOS.find(item => item[0] === targetScenario)?.[1] ?? targetScenario, run }, ...current]);
      setNotice('Сценарий завершён. Метрики SQL и полной операции указаны отдельно.');
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : String(reason);
      setError(message);
      setRuns(current => [{ title: SCENARIOS.find(item => item[0] === targetScenario)?.[1] ?? targetScenario, error: message }, ...current]);
    } finally { setBusy(false); }
  };

  const repeatResearch = async (previous: ResearchRun) => {
    setScenario(previous.scenario);
    setSeed(previous.seed);
    if (previous.repeats) setRepeats(previous.repeats);
    setBusy(true);
    const started = performance.now();
    try {
      const measuredRun = await repository.research(previous.scenario, previous.repeats ?? repeats, previous.seed);
      const run = { ...measuredRun, ui_total_ms: performance.now() - started };
      setRuns(current => [{ title: SCENARIOS.find(item => item[0] === previous.scenario)?.[1] ?? previous.scenario, run }, ...current]);
      setNotice('Эксперимент повторён с прежними параметрами.');
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : String(reason);
      setError(message);
      setRuns(current => [{ title: previous.scenario, error: message }, ...current]);
    } finally { setBusy(false); }
  };

  const exportResults = () => {
    const blob = new Blob([JSON.stringify({ exported_at: new Date().toISOString(), runs }, null, 2)], { type: 'application/json' });
    download(blob, `datadesk-results-${Date.now()}.json`);
  };

  const exportConfig = () => {
    const config = { mode, scenario, repeats, seed, dataCount, replaceData, exported_at: new Date().toISOString() };
    download(new Blob([JSON.stringify(config, null, 2)], { type: 'application/json' }), `datadesk-config-${Date.now()}.json`);
  };

  const exportResultsCsv = () => {
    const columns = ['mode', 'scenario', 'seed', 'data_size', 'created_at', 'ui_total_ms', 'sql_ms', 'backend_time_ms', 'http_requests', 'transferred_bytes'];
    const quote = (value: unknown) => `"${String(value ?? '').replaceAll('"', '""')}"`;
    const rows = runs.filter(item => item.run).map(({ run }) => columns.map(column => quote(run?.[column as keyof ResearchRun])).join(','));
    download(new Blob([[columns.join(','), ...rows].join('\r\n')], { type: 'text/csv;charset=utf-8' }), `datadesk-results-${Date.now()}.csv`);
  };

  const exportDatabase = async (format: 'json' | 'csv') => {
    try {
      const blob = await repository.exportData(format);
      download(blob, `datadesk-${mode}-${Date.now()}.${format}`);
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
  };

  const nav = (next: View) => {
    setView(next);
    if (next !== 'project') setSelectedProject(null);
    if (next === 'overview' || next === 'projects') {
      setQuery('');
      setStatusFilter('');
      setPriorityFilter('');
      setProjectFilter('');
    }
    void refresh(false);
  };

  const openProject = (project: Project) => {
    setSelectedProject(project);
    setProjectFilter(String(project.id));
    setQuery('');
    setStatusFilter('');
    setPriorityFilter('');
    setView('project');
    void refresh(false);
  };

  const pageTitle = view === 'overview' ? 'Обзор'
    : view === 'projects' ? 'Проекты'
      : view === 'project' ? selectedProject?.title ?? 'Проект'
        : view === 'tasks' ? 'Задачи' : 'Исследование';
  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand"><strong>DataDesk</strong></div>
        <nav className="navigation" aria-label="Основная навигация">
          <button className={view === 'overview' ? 'nav-item active' : 'nav-item'} onClick={() => nav('overview')}>Обзор</button>
          <button className={view === 'projects' || view === 'project' ? 'nav-item active' : 'nav-item'} onClick={() => nav('projects')}>Проекты</button>
          <button className={view === 'tasks' ? 'nav-item active' : 'nav-item'} onClick={() => nav('tasks')}>Задачи</button>
          <button className={view === 'research' ? 'nav-item active' : 'nav-item'} onClick={() => nav('research')}>Исследование</button>
        </nav>
        <div className="sidebar-bottom">
          <div className="sidebar-storage">Текущее хранилище<strong>{MODES.find(item => item.id === mode)?.label}</strong></div>
        </div>
      </aside>

      <main className="main-content">
        <header className="topbar">
          <div className="breadcrumbs">{pageTitle}</div>
          <div className="mode-control"><label htmlFor="storage-mode">Хранилище</label><select id="storage-mode" aria-label="Режим хранения" value={mode} onChange={event => void switchMode(event.target.value as Mode)}>
            {MODES.map(item => <option key={item.id} value={item.id}>{item.label} — {item.detail}</option>)}
          </select></div>
        </header>

        <div className="page">
          {error && <div className="alert error-alert" role="alert"><strong>Ошибка</strong><p>{error}</p><button onClick={() => setError('')}>Закрыть</button></div>}
          {notice && <div className="alert success-alert" role="status"><p>{notice}</p><button onClick={() => setNotice('')}>Закрыть</button></div>}
          <div className="page-heading">
            <div><h1>{pageTitle}</h1><p>{view === 'overview' ? 'Краткая сводка текущей базы и недавней работы.' : view === 'project' ? selectedProject?.description || 'Задачи этого проекта.' : view === 'research' ? 'Сценарии, параметры и результаты измерений.' : ''}</p></div>
            {(view === 'projects' || view === 'project') && <button className="button primary" onClick={() => setDialog({ kind: 'project' })}>Создать проект</button>}
            {(view === 'tasks' || view === 'project') && <button className="button primary" onClick={() => setDialog({ kind: 'task' })} disabled={!projects.length}>Добавить задачу</button>}
          </div>

          {loading && <div className="loading-bar"><span /></div>}

          {view === 'overview' && <Overview stats={stats} recentTasks={recentTasks} projects={projects} mode={mode} connectionState={connectionState} onOpenTasks={() => nav('tasks')} onOpenTask={setSelectedTask} />}
          {view === 'projects' && <ProjectsView projects={projects} busy={busy} onEdit={value => setDialog({ kind: 'project', value })} onDelete={value => void removeProject(value)} onOpen={openProject} />}
          {view === 'project' && selectedProject && <ProjectDetail project={projects.find(item => item.id === selectedProject.id) ?? selectedProject} tasks={tasks} onBack={() => nav('projects')} onTask={setSelectedTask} />}
          {view === 'tasks' && <TasksView tasks={tasks} projects={projects} query={query} setQuery={setQuery} status={statusFilter} setStatus={setStatusFilter} priority={priorityFilter} setPriority={setPriorityFilter} project={projectFilter} setProject={setProjectFilter} sort={sort} setSort={setSort} busy={busy} onSelect={setSelectedTask} onDelete={value => void removeTask(value)} />}
          {view === 'research' && <ResearchView mode={mode} stats={stats} scenario={scenario} setScenario={setScenario} repeats={repeats} setRepeats={setRepeats} seed={seed} setSeed={setSeed} dataCount={dataCount} setDataCount={setDataCount} replaceData={replaceData} setReplaceData={setReplaceData} busy={busy} runs={runs} tab={researchTab} setTab={setResearchTab} compareScenario={compareScenario} setCompareScenario={setCompareScenario} onGenerate={() => void generate()} onClearData={() => void clearData()} onRun={nextScenario => void runResearch(nextScenario)} onRepeat={repeat => void repeatResearch(repeat)} onExport={exportResults} onExportCsv={exportResultsCsv} onExportConfig={exportConfig} onExportDatabase={format => void exportDatabase(format)} />}
        </div>
      </main>
      {dialog && <EditorDialog dialog={dialog} projects={projects} busy={busy} onClose={() => setDialog(null)} onSaveProject={saveProject} onSaveTask={saveTask} />}
      {selectedTask && <TaskDrawer key={selectedTask.id} task={selectedTask} projects={projects} busy={busy} onClose={() => setSelectedTask(null)} onSave={saveTask} onDelete={removeTask} />}
    </div>
  );
}

function Overview({ stats, recentTasks, projects, mode, connectionState, onOpenTasks, onOpenTask }: {
  stats: Stats | null; recentTasks: Task[]; projects: Project[]; mode: Mode;
  connectionState: 'checking' | 'connected' | 'error'; onOpenTasks: () => void; onOpenTask: (task: Task) => void;
}) {
  const projectNames = new Map(projects.map(project => [project.id, project.title]));
  const counts = Object.fromEntries((stats?.statuses ?? []).map(item => [item.status, item.count])) as Partial<Record<TaskStatus, number>>;
  const now = new Date();
  const storage = MODES.find(item => item.id === mode)!;
  return <div className="overview-layout">
    <section className="overview-metrics">
      <OverviewMetric label="Проекты" value={stats?.projects ?? 0} />
      <OverviewMetric label="Всего задач" value={stats?.tasks ?? 0} />
      <OverviewMetric label="В работе" value={counts.in_progress ?? 0} />
      <OverviewMetric label="Завершено" value={counts.completed ?? 0} />
      <OverviewMetric label="Просрочено" value={stats?.overdue ?? 0} accent />
    </section>
    <section className="overview-grid">
      <section className="panel overview-chart">
        <div className="section-title"><div><h2>Задачи по статусам</h2><p>Распределение в текущей базе</p></div></div>
        {(stats?.tasks ?? 0) > 0
          ? <div className="overview-doughnut"><Doughnut data={{
            labels: ['Новые', 'В работе', 'Завершены'],
            datasets: [{ data: [counts.new ?? 0, counts.in_progress ?? 0, counts.completed ?? 0], backgroundColor: ['#9aa0a6', '#d2a64e', '#5a9474'], borderWidth: 0 }],
          }} options={{ plugins: { legend: { position: 'bottom', labels: { usePointStyle: false, boxWidth: 10, padding: 18, font: { size: 12 } } } }, cutout: '67%' }} />
          <div className="chart-total"><strong>{stats?.tasks ?? 0}</strong><span>задач</span></div></div>
          : <EmptyState title="Нет задач для диаграммы" description="Добавьте задачи, чтобы увидеть распределение." />}
      </section>
      <section className="panel storage-card">
        <div className="section-title"><div><h2>Текущее хранилище</h2><p>Активный режим работы</p></div></div>
        <dl>
          <div><dt>Архитектура</dt><dd>{storage.label} — {storage.detail}</dd></div>
          <div><dt>Подключение</dt><dd className={`connection ${connectionState}`}>{connectionState === 'checking' ? 'Проверка…' : connectionState === 'connected' ? 'Доступно' : 'Нет соединения'}</dd></div>
          <div><dt>Записей</dt><dd>{stats?.projects ?? 0} проектов, {stats?.tasks ?? 0} задач</dd></div>
          <div><dt>Размер базы</dt><dd>Не измеряется</dd></div>
          <div><dt>Расположение</dt><dd>{mode === 'wasm' ? 'Браузер, OPFS' : 'Сервер'}</dd></div>
        </dl>
      </section>
      <section className="panel recent-panel">
        <div className="section-title"><div><h2>Последние задачи</h2><p>Недавно созданные</p></div><button className="text-button" onClick={onOpenTasks}>Все задачи</button></div>
        {recentTasks.length ? <div className="recent-list">{recentTasks.map(task => <button className="recent-row" key={task.id} onClick={() => onOpenTask(task)}>
          <span className="recent-task-title">{task.title}<small>{projectNames.get(task.project_id) ?? task.project_title ?? 'Без проекта'}</small></span>
          <StatusBadge status={task.status} />
          <time>{formatDate(task.created_at)}</time>
        </button>)}</div> : <EmptyState title="Задач пока нет" description="Создайте задачу в разделе «Проекты» или «Задачи»." />}
      </section>
    </section>
    <p className="overview-updated">Сводка обновлена {now.toLocaleString('ru-RU', { dateStyle: 'short', timeStyle: 'short' })}.</p>
  </div>;
}

function OverviewMetric({ label, value, accent = false }: { label: string; value: string | number; accent?: boolean }) {
  return <div className={`overview-metric${accent ? ' overdue-metric' : ''}`}><span>{label}</span><strong>{value}</strong></div>;
}

function Metric({ label, value }: { label: string; value: string | number }) {
  return <div><small>{label}</small><strong>{value}</strong></div>;
}

function StatusBadge({ status }: { status: TaskStatus }) {
  return <span className={`badge ${status}`}>{STATUS_LABELS[status]}</span>;
}

function ProjectDetail({ project, tasks, onBack, onTask }: {
  project: Project; tasks: Task[]; onBack: () => void; onTask: (task: Task) => void;
}) {
  return <section className="project-detail panel">
    <div className="detail-heading"><button className="text-button" onClick={onBack}>Все проекты</button><div><span>Проект</span><strong>{project.title}</strong></div><p>{project.description || 'Описание не добавлено.'}</p><small>Создан {formatDate(project.created_at)}, задач: {project.task_count ?? tasks.length}</small></div>
    <div className="section-title"><div><h2>Задачи проекта</h2><p>Нажмите на задачу, чтобы открыть подробности.</p></div></div>
    <TaskTable tasks={tasks} onSelect={onTask} />
  </section>;
}

function ProjectsView({ projects, busy, onEdit, onDelete, onOpen }: {
  projects: Project[]; busy: boolean; onEdit: (project: Project) => void; onDelete: (project: Project) => void; onOpen: (project: Project) => void;
}) {
  if (!projects.length) return <EmptyState title="Пока нет проектов" description="Создайте первый проект, чтобы добавлять задачи." />;
  return <section className="project-grid">
    {projects.map(project => {
      const count = project.task_count ?? 0;
      const completed = project.completed_count ?? 0;
      const percent = count ? Math.round(completed / count * 100) : 0;
      return <article className="project-card" key={project.id}>
        <button className="project-card-main" onClick={() => onOpen(project)}>
          <strong className="project-title">{project.title}</strong>
          <p className="project-description">{project.description || 'Описание не добавлено.'}</p>
        </button>
        <div className="project-progress-label"><span>{count} {plural(count, 'задача', 'задачи', 'задач')}</span><span>{percent}%</span></div>
        <div className="progress-track"><span style={{ width: `${percent}%` }} /></div>
        <div className="project-footer"><span>{completed} завершено</span><span>Создан {formatDate(project.created_at)}</span></div>
        <div className="project-actions"><button className="text-button" onClick={() => onEdit(project)}>Редактировать</button><button className="text-button danger-text" disabled={busy} onClick={() => onDelete(project)}>Удалить</button></div>
      </article>;
    })}
  </section>;
}

function TasksView(props: {
  tasks: Task[]; projects: Project[]; query: string; setQuery: (value: string) => void;
  status: string; setStatus: (value: string) => void; priority: string; setPriority: (value: string) => void;
  project: string; setProject: (value: string) => void; sort: string; setSort: (value: 'created_at' | 'due_date' | 'priority') => void;
  busy: boolean; onSelect: (task: Task) => void; onDelete: (task: Task) => void;
}) {
  return <section className="panel">
    <div className="toolbar">
      <label className="searchbox"><input value={props.query} onChange={event => props.setQuery(event.target.value)} placeholder="Поиск по названию" /></label>
      <select value={props.project} onChange={event => props.setProject(event.target.value)}><option value="">Все проекты</option>{props.projects.map(project => <option key={project.id} value={project.id}>{project.title}</option>)}</select>
      <select value={props.status} onChange={event => props.setStatus(event.target.value)}><option value="">Все статусы</option><option value="new">Новая</option><option value="in_progress">В работе</option><option value="completed">Завершена</option></select>
      <select value={props.priority} onChange={event => props.setPriority(event.target.value)}><option value="">Все приоритеты</option><option value="1">Высокий</option><option value="2">Средний</option><option value="3">Низкий</option></select>
      <select value={props.sort} onChange={event => props.setSort(event.target.value as 'created_at' | 'due_date' | 'priority')}><option value="created_at">Сначала новые</option><option value="due_date">По сроку</option><option value="priority">По приоритету</option></select>
    </div>
    {!props.tasks.length ? <EmptyState title="Задачи не найдены" description="Измените фильтры или создайте задачу." /> :
      <TaskTable tasks={props.tasks} onSelect={props.onSelect} />}
    <div className="table-foot">Показано {props.tasks.length} задач <span>На экране отображается до 1 000 записей.</span></div>
  </section>;
}

function TaskTable({ tasks, onSelect }: { tasks: Task[]; onSelect: (task: Task) => void }) {
  return <div className="table-scroll"><table className="data-table"><thead><tr><th>Задача</th><th>Проект</th><th>Статус</th><th>Приоритет</th><th>Срок</th></tr></thead><tbody>
    {tasks.map(task => <tr key={task.id} onClick={() => onSelect(task)} tabIndex={0} onKeyDown={event => { if (event.key === 'Enter') onSelect(task); }}>
      <td><strong className="task-name">{task.title}</strong><small>{task.description || '—'}</small></td>
      <td>{task.project_title}</td><td><StatusBadge status={task.status} /></td>
      <td>{['', 'Высокий', 'Средний', 'Низкий'][task.priority]}</td>
      <td>{task.due_date ? formatDate(task.due_date) : '—'}</td>
    </tr>)}
  </tbody></table></div>;
}

function ResearchView(props: {
  mode: Mode; stats: Stats | null; scenario: string; setScenario: (value: string) => void; repeats: number; setRepeats: (value: number) => void;
  seed: number; setSeed: (value: number) => void; dataCount: number; setDataCount: (value: number) => void;
  replaceData: boolean; setReplaceData: (value: boolean) => void; busy: boolean; runs: HistoryItem[]; tab: ResearchTab; setTab: (tab: ResearchTab) => void;
  compareScenario: string; setCompareScenario: (value: string) => void;
  onGenerate: () => void; onClearData: () => void; onRun: (scenario?: string) => void; onRepeat: (run: ResearchRun) => void; onExport: () => void; onExportCsv: () => void; onExportConfig: () => void; onExportDatabase: (format: 'json' | 'csv') => void;
}) {
  const completedRuns = props.runs.filter(item => item.run);
  const latest = completedRuns[0]?.run;
  const comparisonRuns = completedRuns.filter(item => item.run?.scenario !== 'mass_insert' && (props.compareScenario === 'all' || item.run?.scenario === props.compareScenario));
  const recentRuns = comparisonRuns.slice(0, 12).reverse();
  const sqlExamples: Record<string, string> = {
    all: 'SELECT project_id, status, COUNT(*) FROM tasks GROUP BY project_id, status;',
    select: 'SELECT t.*, p.title AS project_title\nFROM tasks AS t\nJOIN projects AS p ON p.id = t.project_id\nWHERE t.project_id = ? AND t.status = ?\nORDER BY t.created_at DESC LIMIT 100;',
    search: 'SELECT * FROM tasks WHERE title LIKE ? ORDER BY created_at DESC;',
    aggregate: 'SELECT status, COUNT(*) AS count\nFROM tasks GROUP BY status;',
    update_delete: 'UPDATE tasks SET title = ? WHERE id = ?;\nDELETE FROM tasks WHERE id = ?;',
    index: 'CREATE INDEX idx_tasks_project_status\nON tasks(project_id, status, created_at);',
    commit: 'BEGIN;\nINSERT INTO projects (...);\nINSERT INTO tasks (...);\nCOMMIT;',
    rollback: 'BEGIN;\nINSERT INTO projects (...);\nINSERT INTO tasks (...);\n-- controlled constraint error\nROLLBACK;',
    reload: 'PRAGMA foreign_keys = ON;\nSELECT COUNT(*) FROM tasks;',
  };
  const tabs: [ResearchTab, string][] = [['compare', 'Сравнение'], ['experiments', 'Эксперименты'], ['sql', 'SQL и данные'], ['transactions', 'Транзакции']];
  const renderResults = () => <section className="panel results-panel">
    <div className="section-title"><div><h2>Результаты измерений</h2><p>Результаты остаются в этой сессии и доступны для экспорта.</p></div>
      <div className="button-pair"><button className="button secondary" onClick={props.onExportCsv}>Экспорт CSV</button><button className="button secondary" onClick={props.onExport}>Экспорт JSON</button></div>
    </div>
    {!props.runs.length ? <EmptyState title="Измерений пока нет" description="Перейдите в «Эксперименты» и запустите сценарий." /> :
      <div className="table-scroll"><table className="data-table results-table"><thead><tr><th>Сценарий</th><th>Хранилище</th><th>Записей</th><th>Время операции</th><th>SQL-время</th><th>Seed</th><th>Результат</th></tr></thead><tbody>
        {props.runs.map((item, index) => <tr key={`${index}-${item.title}`}>
          <td>{item.title}<small>{item.run?.created_at ? new Date(item.run.created_at).toLocaleString('ru-RU') : 'Ошибка запуска'}</small></td>
          <td>{item.run ? MODES.find(candidate => candidate.id === item.run?.mode)?.label : '—'}</td>
          <td>{item.run?.data_size.toLocaleString('ru-RU') ?? '—'}</td>
          <td>{item.run ? `${item.run.ui_total_ms.toFixed(2)} ms` : '—'}</td>
          <td>{item.run ? sqlSummary(item.run) : '—'}</td>
          <td>{item.run?.seed ?? '—'}</td>
          <td className="result-actions">{item.error ? <span className="error-text">{item.error}</span> : <><details><summary>Детали</summary><pre>{JSON.stringify(item.run?.results ?? item.generated, null, 2)}</pre></details>{item.run && item.run.scenario !== 'mass_insert' && (item.run.mode === props.mode
            ? <button className="text-button" disabled={props.busy} onClick={() => props.onRepeat(item.run!)}>Повторить</button>
            : <span className="repeat-hint">Для повтора выберите этот режим</span>)}</>}</td>
        </tr>)}
      </tbody></table></div>}
  </section>;

  return <section className="research-page">
    <div className="research-intro"><h2>Лаборатория хранения данных</h2><p>В проекте реализованы три независимых режима: PostgreSQL на сервере, SQLite на сервере и SQLite WASM в браузере. Результаты строятся только по запускам в текущей сессии.</p></div>
    <nav className="research-tabs" aria-label="Разделы исследования">{tabs.map(([id, label]) => <button key={id} className={props.tab === id ? 'selected' : ''} onClick={() => props.setTab(id)}>{label}</button>)}</nav>
    {props.tab === 'compare' && <div className="research-main">
      {completedRuns.length ? <section className="panel chart-panel">
        <div className="section-title"><div><h2>Сравнение выполненных запусков</h2><p>Запуски доступны для сравнения между тремя режимами в текущей сессии.</p></div>
          <label className="comparison-filter">Тип операции<select value={props.compareScenario} onChange={event => props.setCompareScenario(event.target.value)}><option value="all">Все операции</option>{SCENARIOS.filter(([value]) => value !== 'all' && value !== 'reload').map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
        </div>
        {recentRuns.length ? <div className="compare-chart"><Bar data={{
          labels: recentRuns.map(item => `${item.title} — ${MODES.find(candidate => candidate.id === item.run?.mode)?.label ?? ''}`),
          datasets: [
            { label: 'Полная операция UI, ms', data: recentRuns.map(item => item.run?.ui_total_ms ?? null), backgroundColor: '#777777' },
            { label: 'SQL, ms', data: recentRuns.map(item => item.run ? sqlMean(item.run) : null), backgroundColor: '#b8a36a' },
          ],
        }} options={{ responsive: true, plugins: { legend: { position: 'bottom', labels: { boxWidth: 12, font: { size: 12 } } } }, scales: { x: { grid: { display: false }, ticks: { maxRotation: 45, minRotation: 20 } }, y: { beginAtZero: true } } }} /></div> : <p className="chart-empty">Для этого типа операции запусков пока нет.</p>}
      </section> : <EmptyState title="Нет данных для сравнения" description="Запустите один и тот же сценарий в нескольких режимах на вкладке «Эксперименты»." />}
      {renderResults()}
      <p className="method-note">Полное время включает интерфейс, сеть и backend; SQL-время измеряется отдельно только там, где это доступно. Сравнение зависит от оборудования и окружения.</p>
    </div>}
    {props.tab === 'experiments' && <div className="research-main">
      <section className="panel experiment-panel">
        <div className="section-title"><div><h2>Тестовые данные</h2><p>Генератор использует одинаковый seed в каждом режиме.</p></div><span>{props.stats?.tasks.toLocaleString('ru-RU') ?? 0} задач сейчас</span></div>
        <div className="experiment-controls">
          <label>Количество задач<select value={props.dataCount} onChange={event => props.setDataCount(Number(event.target.value))}><option value={1000}>1 000</option><option value={10000}>10 000</option><option value={100000}>100 000</option></select></label>
          <label>Seed<input type="number" value={props.seed} onChange={event => props.setSeed(Number(event.target.value))} /></label>
          <label className="check-label"><input type="checkbox" checked={props.replaceData} onChange={event => props.setReplaceData(event.target.checked)} /> Заменить данные этой базы</label>
          <button className="button primary" disabled={props.busy} onClick={props.onGenerate}>{props.busy ? 'Выполняется…' : 'Создать набор'}</button>
          <button className="button secondary danger-text" disabled={props.busy} onClick={props.onClearData}>Очистить базу</button>
        </div>
        <p className="inline-note">Замена затрагивает только выбранную базу и требует подтверждения.</p>
      </section>
      <section className="panel experiment-panel">
        <div className="section-title"><div><h2>Параметры запуска</h2><p>Один прогревочный запуск, затем измеряемые повторы.</p></div></div>
        <div className="experiment-controls scenario-controls">
          <label>Сценарий<select value={props.scenario} onChange={event => props.setScenario(event.target.value)}>{SCENARIOS.map(([value, label]) => <option value={value} key={value} disabled={value === 'reload' && props.mode !== 'wasm'}>{value === 'reload' ? `${label} (только WASM)` : label}</option>)}</select></label>
          <label>Повторы<input type="number" min={1} max={20} value={props.repeats} onChange={event => props.setRepeats(Math.max(1, Math.min(20, Number(event.target.value))))} /></label>
          <label>Seed<input type="number" value={props.seed} onChange={event => props.setSeed(Number(event.target.value))} /></label>
          <button className="button primary" disabled={props.busy} onClick={() => props.onRun()}>{props.busy ? 'Измерение…' : 'Запустить эксперимент'}</button>
        </div>
        {latest && <div className="metric-summary">
          <Metric label="Режим" value={MODES.find(candidate => candidate.id === latest.mode)?.label ?? latest.mode} />
          <Metric label="Время UI" value={`${latest.ui_total_ms.toFixed(2)} ms`} />
          <Metric label="SQL" value={sqlSummary(latest)} />
          <Metric label="Backend" value={latest.backend_time_ms === undefined ? 'Не применяется' : `${latest.backend_time_ms.toFixed(2)} ms`} />
          <Metric label="Запросы HTTP" value={latest.http_requests} />
        </div>}
      </section>
      {renderResults()}
      <div className="button-pair"><button className="button secondary" onClick={props.onExportConfig}>Сохранить конфигурацию</button><button className="button secondary" onClick={() => props.onExportDatabase('json')}>Экспорт данных JSON</button><button className="button secondary" onClick={() => props.onExportDatabase('csv')}>Экспорт данных CSV</button></div>
    </div>}
    {props.tab === 'sql' && <div className="research-main">
      <section className="panel sql-panel"><div className="section-title"><div><h2>SQL последнего сценария</h2><p>Пример запроса для текущей операции; значения передаются параметрами.</p></div><span>{MODES.find(candidate => candidate.id === props.mode)?.label}</span></div>
        <pre className="sql-code">{sqlExamples[props.scenario] ?? sqlExamples.all}</pre>
        {latest ? <><div className="sql-result-label">Результат последнего запуска: {latest.data_size.toLocaleString('ru-RU')} задач, {latest.ui_total_ms.toFixed(2)} ms на операцию</div><details className="sql-details"><summary>Результаты и план выполнения</summary><pre>{JSON.stringify(latest.results, null, 2)}</pre></details></> : <p className="inline-note">Запустите сценарий, чтобы увидеть его план и результат.</p>}
      </section>
      <div className="experiment-controls"><label>Операция<select value={props.scenario} onChange={event => props.setScenario(event.target.value)}>{SCENARIOS.map(([value, label]) => <option value={value} key={value} disabled={value === 'reload' && props.mode !== 'wasm'}>{label}</option>)}</select></label><button className="button primary" disabled={props.busy} onClick={() => props.onRun()}>Выполнить</button></div>
    </div>}
    {props.tab === 'transactions' && <div className="research-main">
      <section className="panel experiment-panel transaction-panel"><h2>Проверка транзакций</h2><p>Выполняются реальные операции БД. Для отката вставляются временные проект и задача, затем вызывается ошибка ограничения. Транзакция откатывается, после чего проверяется отсутствие обеих записей.</p>
        <div className="transaction-actions"><button className="button secondary" disabled={props.busy} onClick={() => { props.setScenario('commit'); props.onRun('commit'); }}>Тест COMMIT</button><button className="button secondary" disabled={props.busy} onClick={() => { props.setScenario('rollback'); props.onRun('rollback'); }}>Вызвать ошибку и откатить</button></div>
        {latest && (latest.scenario === 'commit' || latest.scenario === 'rollback') && <div className="transaction-result"><strong>Последняя проверка</strong><p>{latest.scenario === 'commit' ? 'Изменения зафиксированы и проверены.' : 'Транзакция откачена; частичные изменения отсутствуют.'}</p><details><summary>Результат БД</summary><pre>{JSON.stringify(latest.results, null, 2)}</pre></details></div>}
      </section>
      {renderResults()}
    </div>}
  </section>;
}

function TaskDrawer({ task, projects, busy, onClose, onSave, onDelete }: {
  task: Task; projects: Project[]; busy: boolean; onClose: () => void;
  onSave: (input: TaskInput, id?: number) => Promise<void>; onDelete: (task: Task) => Promise<void>;
}) {
  const [title, setTitle] = useState(task.title);
  const [description, setDescription] = useState(task.description ?? '');
  const [projectId, setProjectId] = useState(task.project_id);
  const [status, setStatus] = useState<TaskStatus>(task.status);
  const [priority, setPriority] = useState(task.priority);
  const [dueDate, setDueDate] = useState(task.due_date?.slice(0, 10) ?? '');
  const submit = (event: FormEvent) => {
    event.preventDefault();
    void onSave({
      project_id: projectId,
      title: title.trim(),
      description: description.trim() || null,
      status,
      priority,
      due_date: dueDate ? new Date(`${dueDate}T00:00:00.000Z`).toISOString() : null,
    }, task.id);
  };
  return <div className="drawer-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) onClose(); }}>
    <form className="task-drawer" onSubmit={submit}>
      <header className="drawer-header"><div><p>Задача</p><h2>Подробности</h2></div><button type="button" className="text-button" onClick={onClose}>Закрыть</button></header>
      <label>Название<input required maxLength={200} value={title} onChange={event => setTitle(event.target.value)} /></label>
      <label>Проект<select value={projectId} onChange={event => setProjectId(Number(event.target.value))}>{projects.map(project => <option key={project.id} value={project.id}>{project.title}</option>)}</select></label>
      <label>Описание<textarea rows={5} value={description} onChange={event => setDescription(event.target.value)} /></label>
      <div className="form-grid"><label>Статус<select value={status} onChange={event => setStatus(event.target.value as TaskStatus)}><option value="new">Новая</option><option value="in_progress">В работе</option><option value="completed">Завершена</option></select></label>
        <label>Приоритет<select value={priority} onChange={event => setPriority(Number(event.target.value))}><option value={1}>Высокий</option><option value={2}>Средний</option><option value={3}>Низкий</option></select></label>
        <label className="full-span">Срок<input type="date" value={dueDate} onChange={event => setDueDate(event.target.value)} /></label>
      </div>
      <dl className="drawer-meta"><div><dt>Создана</dt><dd>{formatDate(task.created_at)}</dd></div><div><dt>ID</dt><dd>{task.id}</dd></div></dl>
      <footer className="drawer-actions"><button type="button" className="text-button danger-text" disabled={busy} onClick={() => void onDelete(task)}>Удалить задачу</button><button type="submit" className="button primary" disabled={busy}>{busy ? 'Сохранение…' : 'Сохранить'}</button></footer>
    </form>
  </div>;
}

function sqlSummary(run: ResearchRun) {
  const means: number[] = [];
  const collect = (value: unknown) => {
    if (!value || typeof value !== 'object') return;
    if ('mean_sql_ms' in value && typeof value.mean_sql_ms === 'number') means.push(value.mean_sql_ms);
    else if ('mean_ms' in value && typeof value.mean_ms === 'number') means.push(value.mean_ms);
    else Object.values(value).forEach(collect);
  };
  if (run.sql_ms !== undefined && run.mode === 'wasm') return `${run.sql_ms.toFixed(2)} ms total`;
  for (const key of ['select', 'search', 'aggregate', 'index']) {
    if (run.results[key] !== undefined) collect(run.results[key]);
  }
  return means.length ? means.map(value => `${value.toFixed(2)} ms`).join(' / ') : 'Не отделялось от времени транзакции';
}

function sqlMean(run: ResearchRun) {
  const values: number[] = [];
  const collect = (value: unknown) => {
    if (!value || typeof value !== 'object') return;
    if ('mean_sql_ms' in value && typeof value.mean_sql_ms === 'number') values.push(value.mean_sql_ms);
    else if ('mean_ms' in value && typeof value.mean_ms === 'number') values.push(value.mean_ms);
    else Object.values(value).forEach(collect);
  };
  for (const key of ['select', 'search', 'aggregate', 'index']) {
    if (run.results[key] !== undefined) collect(run.results[key]);
  }
  return values.length ? values.reduce((sum, item) => sum + item, 0) / values.length : run.mode === 'wasm' ? run.sql_ms ?? 0 : null;
}

function EditorDialog(props: {
  dialog: Exclude<Dialog, null>; projects: Project[]; busy: boolean; onClose: () => void;
  onSaveProject: (input: ProjectInput, id?: number) => Promise<void>; onSaveTask: (input: TaskInput, id?: number) => Promise<void>;
}) {
  const project = props.dialog.kind === 'project' ? props.dialog.value : undefined;
  const task = props.dialog.kind === 'task' ? props.dialog.value : undefined;
  const [title, setTitle] = useState(project?.title ?? task?.title ?? '');
  const [description, setDescription] = useState(project?.description ?? task?.description ?? '');
  const [projectId, setProjectId] = useState(task?.project_id ?? props.projects[0]?.id ?? 0);
  const [status, setStatus] = useState<TaskStatus>(task?.status ?? 'new');
  const [priority, setPriority] = useState(task?.priority ?? 2);
  const [dueDate, setDueDate] = useState(task?.due_date?.slice(0, 10) ?? '');

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (props.dialog.kind === 'project') await props.onSaveProject({ title: title.trim(), description: description.trim() || null }, project?.id);
    else await props.onSaveTask({ project_id: projectId, title: title.trim(), description: description.trim() || null, status, priority, due_date: dueDate ? new Date(`${dueDate}T00:00:00.000Z`).toISOString() : null }, task?.id);
  };

  return <div className="modal-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) props.onClose(); }}>
    <form className="editor-modal" onSubmit={event => void submit(event)}>
      <div className="modal-head"><div><h2>{project ? 'Редактировать проект' : task ? 'Редактировать задачу' : props.dialog.kind === 'project' ? 'Новый проект' : 'Новая задача'}</h2><p>Поля со звёздочкой обязательны.</p></div><button type="button" className="text-button" onClick={props.onClose}>Закрыть</button></div>
      <label>Название *<input autoFocus required maxLength={200} value={title} onChange={event => setTitle(event.target.value)} placeholder={props.dialog.kind === 'project' ? 'Например, Исследование СУБД' : 'Что нужно сделать?'} /></label>
      {props.dialog.kind === 'task' && <label>Проект<select required value={projectId} onChange={event => setProjectId(Number(event.target.value))}>{props.projects.map(item => <option key={item.id} value={item.id}>{item.title}</option>)}</select></label>}
      <label>Описание<textarea rows={3} value={description} onChange={event => setDescription(event.target.value)} placeholder="Необязательно" /></label>
      {props.dialog.kind === 'task' && <div className="form-grid">
        <label>Статус<select value={status} onChange={event => setStatus(event.target.value as TaskStatus)}><option value="new">Новая</option><option value="in_progress">В работе</option><option value="completed">Завершена</option></select></label>
        <label>Приоритет<select value={priority} onChange={event => setPriority(Number(event.target.value))}><option value={1}>Высокий</option><option value={2}>Средний</option><option value={3}>Низкий</option></select></label>
        <label className="full-span">Срок выполнения<input type="date" value={dueDate} onChange={event => setDueDate(event.target.value)} /></label>
      </div>}
      <div className="modal-actions"><button type="button" className="button secondary" onClick={props.onClose}>Отмена</button><button className="button primary" disabled={props.busy}>{props.busy ? 'Сохранение…' : 'Сохранить'}</button></div>
    </form>
  </div>;
}

function EmptyState({ title, description }: { title: string; description: string }) {
  return <div className="empty-state"><strong>{title}</strong><p>{description}</p></div>;
}

function plural(count: number, one: string, few: string, many: string) {
  const n = Math.abs(count) % 100;
  const last = n % 10;
  return n > 10 && n < 20 ? many : last > 1 && last < 5 ? few : last === 1 ? one : many;
}

function formatDate(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleDateString('ru-RU');
}

function download(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}

export default App;
