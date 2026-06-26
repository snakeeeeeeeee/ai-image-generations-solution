import React, { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import {
  Activity,
  AlertTriangle,
  BarChart3,
  CheckCircle2,
  CirclePause,
  Clock3,
  Copy,
  Database,
  Eye,
  ImageIcon,
  Link as LinkIcon,
  Loader2,
  Lock,
  LogOut,
  MemoryStick,
  RefreshCw,
  Send,
  Server,
  Cpu,
  UploadCloud,
  X,
  XCircle
} from 'lucide-react';
import {
  Area,
  CartesianGrid,
  ComposedChart,
  Line,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis
} from 'recharts';
import './styles.css';

interface RuntimeStats {
  draining: boolean;
  safeToRestart: boolean;
  activeGenerations: number;
  queuedGenerations: number;
  maxConcurrentGenerations: number;
  activeImageProcessing: number;
  queuedImageProcessing: number;
  maxConcurrentImageProcessing: number;
  memory: {
    rssBytes: number;
    heapUsedBytes: number;
    externalBytes: number;
    arrayBuffersBytes: number;
    maxRssBytes: number;
  };
}

interface Summary {
  total: number;
  success: number;
  failed: number;
  successRate: number;
  avgTotalMs: number;
  p95TotalMs: number;
  p95OpenaiMs: number;
  p95UploadMs: number;
  avgImageBytes: number;
  uploadedBytes: number;
  requestsLastHour: Array<{
    minute: string;
    total: number;
    success: number;
    failed: number;
    avgTotalMs: number;
  }>;
}

interface RequestRecord {
  requestId: string;
  createdAt: string;
  operation: 'generation' | 'edit' | 'manual_upload';
  statusCode: number;
  success: boolean;
  model?: string;
  size?: string;
  totalMs: number;
  openaiMs: number;
  decodeMs: number;
  uploadMs: number;
  imageBytes: number;
  imageCount: number;
  errorCode?: string;
  errorMessage?: string;
  requestParams?: Record<string, unknown>;
  responseParams?: Record<string, unknown>;
  imageUrls: string[];
}

interface ErrorRecord {
  code: string;
  count: number;
  lastSeenAt: string;
}

interface DashboardData {
  runtime: RuntimeStats;
  summary: Summary;
  async: AsyncOverview;
  asyncTasks: PaginatedAsyncTasks;
  callbacks: PaginatedCallbacks;
  errors: PaginatedErrors;
  requests: PaginatedRecords;
  images: PaginatedRecords;
}

interface AsyncTaskSummary {
  total: number;
  submitted: number;
  queued: number;
  processing: number;
  succeeded: number;
  failed: number;
  lastCreatedAt?: string;
  lastUpdatedAt?: string;
}

interface CallbackSummary {
  total: number;
  pending: number;
  processing: number;
  delivered: number;
  failed: number;
  lastCreatedAt?: string;
  lastUpdatedAt?: string;
}

interface QueueStats {
  waiting: number;
  active: number;
  delayed: number;
  completed: number;
  failed: number;
  paused: number;
}

interface WorkerCurrentTask {
  client_task_id: string;
  provider_task_id: string;
  operation: 'generation' | 'edit' | string;
  model: string;
  started_at: string;
}

interface WorkerHeartbeat {
  worker_id: string;
  role: 'worker';
  hostname: string;
  ip_addresses: string[];
  pid: number;
  started_at: string;
  last_seen_at: string;
  worker_concurrency: number;
  image_processing_concurrency: number;
  active_tasks: number;
  completed_since_start: number;
  failed_since_start: number;
  rss_bytes: number;
  heap_used_bytes: number;
  last_error_code?: string;
  current_tasks: WorkerCurrentTask[];
}

interface WorkerSummary {
  total: number;
  active_tasks: number;
  worker_concurrency: number;
  image_processing_concurrency: number;
  completed_since_start: number;
  failed_since_start: number;
  data: WorkerHeartbeat[];
}

interface AsyncOverview {
  enabled: boolean;
  tasks: AsyncTaskSummary;
  callbacks: CallbackSummary;
  queue: QueueStats | null;
  workers: WorkerSummary;
}

interface AsyncTaskRecord {
  provider_task_id: string;
  client_task_id: string;
  request_id: string;
  provider: string;
  executor?: {
    type?: string;
    lease_id?: string;
    resolve_url?: string;
    secret_id?: string;
  };
  model: string;
  operation: 'generation' | 'edit';
  status: 'submitted' | 'queued' | 'processing' | 'succeeded' | 'failed';
  parameters: Record<string, unknown>;
  metadata: Record<string, unknown>;
  usage?: Record<string, unknown> | null;
  raw_response_truncated?: boolean;
  raw_response_omitted_fields?: string[];
  attempts: number;
  image_count: number;
  first_image_url?: string;
  error_code?: string;
  error_message?: string;
  created_at: string;
  started_at?: string;
  finished_at?: string;
  updated_at: string;
}

interface CallbackEventRecord {
  event_id: string;
  provider_task_id: string;
  client_task_id: string;
  callback_url: string;
  batch_callback_url?: string;
  secret_id?: string;
  status: 'pending' | 'processing' | 'delivered' | 'failed';
  attempts: number;
  next_attempt_at: string;
  delivered_at?: string;
  created_at: string;
  updated_at: string;
}

interface PaginatedErrors {
  data: ErrorRecord[];
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
  windowHours: number;
}

interface PaginatedRecords {
  data: RequestRecord[];
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
}

interface PaginatedAsyncTasks {
  data: AsyncTaskRecord[];
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
}

interface PaginatedCallbacks {
  data: CallbackEventRecord[];
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
}

interface AdminUploadResult {
  url: string;
  key: string;
  filename: string;
  contentType: string;
  bytes: number;
  width: number;
  height: number;
  format: string;
  uploadedAt: string;
}

type AuthState = 'checking' | 'authenticated' | 'anonymous';
type RefreshIntervalMs = 5000 | 15000 | 30000 | 60000;
type DashboardTab = 'sync' | 'async';

const adminBasePath = new URL(import.meta.env.BASE_URL, window.location.origin).pathname.replace(/\/+$/, '');
const adminPath = (path = '') => `${adminBasePath}${path}`;
const refreshIntervals: Array<{ label: string; value: RefreshIntervalMs }> = [
  { label: '5 秒', value: 5000 },
  { label: '15 秒', value: 15000 },
  { label: '30 秒', value: 30000 },
  { label: '1 分钟', value: 60000 }
];
const pageSizeOptions = [10, 20, 50, 100];

function App() {
  const [authState, setAuthState] = useState<AuthState>('checking');

  useEffect(() => {
    fetchJson(adminPath('/api/summary'))
      .then(() => setAuthState('authenticated'))
      .catch(() => setAuthState('anonymous'));
  }, []);

  if (authState === 'checking' && !location.pathname.endsWith('/login')) {
    return <LoadingScreen />;
  }

  if (authState === 'anonymous' || location.pathname.endsWith('/login')) {
    return <LoginPage onLogin={() => setAuthState('authenticated')} />;
  }

  return <Dashboard onLogout={() => setAuthState('anonymous')} />;
}

function LoadingScreen() {
  return (
    <main className="screen-center">
      <div className="loading-panel">
        <Loader2 className="spin" size={22} />
        <span>正在连接监控台</span>
      </div>
    </main>
  );
}

function LoginPage({ onLogin }: { onLogin: () => void }) {
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setLoading(true);
    setError('');

    try {
      await fetchJson(adminPath('/login'), {
        method: 'POST',
        headers: {
          'content-type': 'application/json'
        },
        body: JSON.stringify({ password })
      });
      history.replaceState(null, '', adminBasePath);
      onLogin();
    } catch {
      setError('密码不正确，请重新输入。');
    } finally {
      setLoading(false);
    }
  }

  return (
    <main className="login-shell">
      <section className="login-panel">
        <div className="login-mark">
          <Lock size={24} />
        </div>
        <p className="eyebrow">OpenAI GPT Image 加速层</p>
        <h1>图片处理监控台</h1>
        <p className="login-copy">查看生成耗时、R2 上传、内存水位和最近错误。</p>
        <form onSubmit={submit} className="login-form">
          <label htmlFor="password">访问密码</label>
          <input
            id="password"
            type="password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            autoComplete="current-password"
            placeholder="输入 .env 中的 ADMIN_PASSWORD"
          />
          {error ? <p className="form-error">{error}</p> : null}
          <button type="submit" disabled={loading || password.length === 0}>
            {loading ? <Loader2 className="spin" size={18} /> : <Lock size={18} />}
            登录
          </button>
        </form>
      </section>
    </main>
  );
}

function Dashboard({ onLogout }: { onLogout: () => void }) {
  const [data, setData] = useState<DashboardData | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [activeTab, setActiveTab] = useState<DashboardTab>('sync');
  const [refreshIntervalMs, setRefreshIntervalMs] = useState<RefreshIntervalMs>(5000);
  const [requestPage, setRequestPage] = useState(1);
  const [requestPageSize, setRequestPageSize] = useState(20);
  const [imagePage, setImagePage] = useState(1);
  const [imagePageSize, setImagePageSize] = useState(10);
  const [asyncTaskPage, setAsyncTaskPage] = useState(1);
  const [asyncTaskPageSize, setAsyncTaskPageSize] = useState(10);
  const [callbackPage, setCallbackPage] = useState(1);
  const [callbackPageSize, setCallbackPageSize] = useState(10);
  const [errorPage, setErrorPage] = useState(1);
  const errorPageSize = 5;
  const [error, setError] = useState('');
  const [drainUpdating, setDrainUpdating] = useState(false);

  async function load(options: {
    silent?: boolean;
    requestPage?: number;
    requestPageSize?: number;
    imagePage?: number;
    imagePageSize?: number;
    asyncTaskPage?: number;
    asyncTaskPageSize?: number;
    callbackPage?: number;
    callbackPageSize?: number;
    errorPage?: number;
  } = {}) {
    if (options.silent) {
      setRefreshing(true);
    } else {
      setLoading(true);
    }
    setError('');
    try {
      const nextRequestPage = options.requestPage ?? requestPage;
      const nextRequestPageSize = options.requestPageSize ?? requestPageSize;
      const nextImagePage = options.imagePage ?? imagePage;
      const nextImagePageSize = options.imagePageSize ?? imagePageSize;
      const nextAsyncTaskPage = options.asyncTaskPage ?? asyncTaskPage;
      const nextAsyncTaskPageSize = options.asyncTaskPageSize ?? asyncTaskPageSize;
      const nextCallbackPage = options.callbackPage ?? callbackPage;
      const nextCallbackPageSize = options.callbackPageSize ?? callbackPageSize;
      const nextErrorPage = options.errorPage ?? errorPage;
      const [summary, asyncOverview, asyncTasks, callbacks, requests, images, errors] = await Promise.all([
        fetchJson<{ runtime: RuntimeStats; summary: Summary }>(adminPath('/api/summary')),
        fetchJson<AsyncOverview>(adminPath('/api/async/summary')),
        fetchJson<PaginatedAsyncTasks>(adminPath(`/api/async/tasks?page=${nextAsyncTaskPage}&page_size=${nextAsyncTaskPageSize}`)),
        fetchJson<PaginatedCallbacks>(adminPath(`/api/async/callbacks?page=${nextCallbackPage}&page_size=${nextCallbackPageSize}`)),
        fetchJson<PaginatedRecords>(adminPath(`/api/requests?page=${nextRequestPage}&page_size=${nextRequestPageSize}`)),
        fetchJson<PaginatedRecords>(adminPath(`/api/images?page=${nextImagePage}&page_size=${nextImagePageSize}`)),
        fetchJson<PaginatedErrors>(adminPath(`/api/errors?page=${nextErrorPage}&page_size=${errorPageSize}`))
      ]);
      setRequestPage(requests.page);
      setRequestPageSize(requests.pageSize);
      setImagePage(images.page);
      setImagePageSize(images.pageSize);
      setAsyncTaskPage(asyncTasks.page);
      setAsyncTaskPageSize(asyncTasks.pageSize);
      setCallbackPage(callbacks.page);
      setCallbackPageSize(callbacks.pageSize);
      setErrorPage(errors.page);
      setData({
        runtime: summary.runtime,
        summary: summary.summary,
        async: asyncOverview,
        asyncTasks,
        callbacks,
        errors,
        requests,
        images
      });
    } catch {
      setError('无法加载监控数据，请确认登录状态和服务运行状态。');
    } finally {
      if (options.silent) {
        setRefreshing(false);
      } else {
        setLoading(false);
      }
    }
  }

  useEffect(() => {
    void load();
  }, []);

  useEffect(() => {
    const timer = window.setInterval(() => void load({ silent: true }), refreshIntervalMs);
    return () => window.clearInterval(timer);
  }, [
    refreshIntervalMs,
    requestPage,
    requestPageSize,
    imagePage,
    imagePageSize,
    asyncTaskPage,
    asyncTaskPageSize,
    callbackPage,
    callbackPageSize,
    errorPage
  ]);

  async function logout() {
    await fetch(adminPath('/logout'), { method: 'POST' });
    history.replaceState(null, '', adminPath('/login'));
    onLogout();
  }

  async function setDraining(draining: boolean) {
    setDrainUpdating(true);
    setError('');
    try {
      await fetchJson(adminPath('/api/drain'), {
        method: 'POST',
        headers: {
          'content-type': 'application/json'
        },
        body: JSON.stringify({
          draining,
          reason: draining ? 'manual maintenance' : 'manual resume'
        })
      });
      await load({ silent: true });
    } catch {
      setError('无法切换排空模式，请确认登录状态和服务运行状态。');
    } finally {
      setDrainUpdating(false);
    }
  }

  function changeRequestPage(page: number) {
    setRequestPage(page);
    void load({ silent: true, requestPage: page });
  }

  function changeRequestPageSize(pageSize: number) {
    setRequestPage(1);
    setRequestPageSize(pageSize);
    void load({ silent: true, requestPage: 1, requestPageSize: pageSize });
  }

  function changeImagePage(page: number) {
    setImagePage(page);
    void load({ silent: true, imagePage: page });
  }

  function changeImagePageSize(pageSize: number) {
    setImagePage(1);
    setImagePageSize(pageSize);
    void load({ silent: true, imagePage: 1, imagePageSize: pageSize });
  }

  function changeAsyncTaskPage(page: number) {
    setAsyncTaskPage(page);
    void load({ silent: true, asyncTaskPage: page });
  }

  function changeAsyncTaskPageSize(pageSize: number) {
    setAsyncTaskPage(1);
    setAsyncTaskPageSize(pageSize);
    void load({ silent: true, asyncTaskPage: 1, asyncTaskPageSize: pageSize });
  }

  function changeCallbackPage(page: number) {
    setCallbackPage(page);
    void load({ silent: true, callbackPage: page });
  }

  function changeCallbackPageSize(pageSize: number) {
    setCallbackPage(1);
    setCallbackPageSize(pageSize);
    void load({ silent: true, callbackPage: 1, callbackPageSize: pageSize });
  }

  function changeErrorPage(page: number) {
    setErrorPage(page);
    void load({ silent: true, errorPage: page });
  }

  const memoryPercent = data ? percent(data.runtime.memory.rssBytes, data.runtime.memory.maxRssBytes) : 0;
  const processingPercent = data
    ? percent(data.runtime.activeImageProcessing, data.runtime.maxConcurrentImageProcessing)
    : 0;
  const r2UploadError = data?.errors.data.find((item) => item.code === 'r2_upload_failed');
  const asyncBacklog = data
    ? data.async.tasks.submitted + data.async.tasks.queued + data.async.tasks.processing + data.async.callbacks.pending + data.async.callbacks.processing
    : 0;

  return (
    <main className="dashboard-shell">
      <header className="topbar">
        <div>
          <p className="eyebrow">图片包装服务</p>
          <h1>监控台</h1>
        </div>
        <div className="topbar-actions">
          <label className="refresh-select">
            <span>自动刷新</span>
            <select
              value={refreshIntervalMs}
              onChange={(event) => setRefreshIntervalMs(Number(event.target.value) as RefreshIntervalMs)}
            >
              {refreshIntervals.map((interval) => (
                <option key={interval.value} value={interval.value}>{interval.label}</option>
              ))}
            </select>
          </label>
          <button className="ghost-button" onClick={() => void load()} disabled={loading || refreshing}>
            <RefreshCw size={17} className={loading || refreshing ? 'spin' : ''} />
            刷新
          </button>
          <button className="ghost-button" onClick={() => void logout()}>
            <LogOut size={17} />
            退出
          </button>
        </div>
      </header>

      {error ? <div className="alert"><AlertTriangle size={18} />{error}</div> : null}

      {data ? (
        <>
          <nav className="dashboard-tabs" aria-label="监控台视图">
            <button
              type="button"
              className={activeTab === 'sync' ? 'active' : ''}
              onClick={() => setActiveTab('sync')}
              aria-pressed={activeTab === 'sync'}
            >
              <Activity size={16} />
              同步接口
            </button>
            <button
              type="button"
              className={activeTab === 'async' ? 'active' : ''}
              onClick={() => setActiveTab('async')}
              aria-pressed={activeTab === 'async'}
            >
              <Send size={16} />
              任务队列
              {asyncBacklog > 0 ? <span>{formatNumber(asyncBacklog)}</span> : null}
            </button>
          </nav>

          {activeTab === 'sync' ? (
            <>
              <section className={`maintenance-panel ${data.runtime.draining ? 'draining' : ''}`}>
                <div className="maintenance-copy">
                  <div className="maintenance-icon">
                    <CirclePause size={20} />
                  </div>
                  <div>
                    <h2>{data.runtime.draining ? '排空模式已开启' : '排空模式未开启'}</h2>
                    <p>
                      {data.runtime.draining
                        ? data.runtime.safeToRestart
                          ? '当前没有活跃生成或处理队列，可以安全重启或升级。'
                          : '新图片请求已拒绝，已有请求会继续处理，等待队列清空后再重启。'
                        : '开启后会拒绝新的文生图/图生图请求，已有请求继续完成。'}
                    </p>
                  </div>
                </div>
                <button
                  className={data.runtime.draining ? 'ghost-button' : 'danger-button'}
                  disabled={drainUpdating}
                  onClick={() => void setDraining(!data.runtime.draining)}
                >
                  {drainUpdating ? <Loader2 className="spin" size={17} /> : <CirclePause size={17} />}
                  {data.runtime.draining ? '退出排空模式' : '进入排空模式'}
                </button>
              </section>

              <AdminUploadPanel onUploaded={() => void load({ silent: true, requestPage: 1, imagePage: 1 })} />

              <section className="status-grid">
                <StatusTile
                  icon={<Server size={19} />}
                  label="服务状态"
                  value={data.runtime.draining ? '排空中' : memoryPercent >= 90 ? '内存高水位' : '运行正常'}
                  tone={data.runtime.draining ? 'warning' : memoryPercent >= 90 ? 'warning' : 'success'}
                  detail={data.runtime.safeToRestart ? '可安全重启' : `RSS ${formatBytes(data.runtime.memory.rssBytes)} / ${formatBytes(data.runtime.memory.maxRssBytes)}`}
                />
                <StatusTile
                  icon={<Activity size={19} />}
                  label="生成并发"
                  value={`${data.runtime.activeGenerations}/${data.runtime.maxConcurrentGenerations}`}
                  detail={`等待队列 ${data.runtime.queuedGenerations}`}
                />
                <StatusTile
                  icon={<UploadCloud size={19} />}
                  label="处理队列"
                  value={`${data.runtime.activeImageProcessing}/${data.runtime.maxConcurrentImageProcessing}`}
                  tone={processingPercent >= 80 ? 'warning' : 'default'}
                  detail={`等待队列 ${data.runtime.queuedImageProcessing}`}
                />
                <StatusTile
                  icon={<UploadCloud size={19} />}
                  label="R2 上传状态"
                  value={r2UploadError ? '存在失败' : '正常'}
                  tone={r2UploadError ? 'warning' : 'success'}
                  detail={r2UploadError ? `失败 ${r2UploadError.count} 次` : '最近无上传错误'}
                />
                <StatusTile
                  icon={<MemoryStick size={19} />}
                  label="内存使用"
                  value={`${memoryPercent.toFixed(1)}%`}
                  tone={memoryPercent >= 90 ? 'danger' : memoryPercent >= 75 ? 'warning' : 'default'}
                  detail={`Heap ${formatBytes(data.runtime.memory.heapUsedBytes)} / External ${formatBytes(data.runtime.memory.externalBytes)}`}
                />
              </section>

              <section className="metric-grid">
                <MetricCard title="总请求" value={formatNumber(data.summary.total)} icon={<BarChart3 size={18} />} />
                <MetricCard title="成功率" value={`${(data.summary.successRate * 100).toFixed(1)}%`} icon={<CheckCircle2 size={18} />} />
                <MetricCard title="平均耗时" value={formatMs(data.summary.avgTotalMs)} icon={<Clock3 size={18} />} />
                <MetricCard title="P95 总耗时" value={formatMs(data.summary.p95TotalMs)} icon={<Clock3 size={18} />} />
                <MetricCard title="P95 OpenAI" value={formatMs(data.summary.p95OpenaiMs)} icon={<Server size={18} />} />
                <MetricCard title="P95 上传" value={formatMs(data.summary.p95UploadMs)} icon={<UploadCloud size={18} />} />
                <MetricCard title="平均图片" value={formatBytes(data.summary.avgImageBytes)} icon={<ImageIcon size={18} />} />
                <MetricCard title="累计上传" value={formatBytes(data.summary.uploadedBytes)} icon={<Database size={18} />} />
              </section>

              <RequestTrendChart summary={data.summary} />
              <ErrorPanel errors={data.errors} onPageChange={changeErrorPage} />
              <ImageTable page={data.images} onPageChange={changeImagePage} onPageSizeChange={changeImagePageSize} />
              <RequestTable page={data.requests} onPageChange={changeRequestPage} onPageSizeChange={changeRequestPageSize} />
            </>
          ) : (
            <>
              <AsyncOverviewPanel overview={data.async} />
              <AsyncTaskTable page={data.asyncTasks} enabled={data.async.enabled} onPageChange={changeAsyncTaskPage} onPageSizeChange={changeAsyncTaskPageSize} />
              <CallbackTable page={data.callbacks} enabled={data.async.enabled} onPageChange={changeCallbackPage} onPageSizeChange={changeCallbackPageSize} />
            </>
          )}
        </>
      ) : (
        <div className="panel empty-panel">
          <Loader2 className="spin" size={24} />
          <span>正在加载数据</span>
        </div>
      )}
    </main>
  );
}

function AdminUploadPanel({ onUploaded }: { onUploaded: () => void }) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState('');
  const [result, setResult] = useState<AdminUploadResult | null>(null);

  function selectFile(event: React.ChangeEvent<HTMLInputElement>) {
    setUploadError('');
    setResult(null);
    setSelectedFile(event.currentTarget.files?.[0] ?? null);
  }

  function clearFile() {
    setSelectedFile(null);
    setUploadError('');
    if (inputRef.current) {
      inputRef.current.value = '';
    }
  }

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selectedFile) {
      setUploadError('请选择一张图片。');
      return;
    }

    setUploading(true);
    setUploadError('');
    try {
      const form = new FormData();
      form.append('image', selectedFile, selectedFile.name);
      const response = await fetchJson<{ data: AdminUploadResult }>(adminPath('/api/upload'), {
        method: 'POST',
        body: form
      });
      setResult(response.data);
      clearFile();
      onUploaded();
    } catch (error) {
      setUploadError(error instanceof Error ? error.message : '上传失败，请稍后重试。');
    } finally {
      setUploading(false);
    }
  }

  return (
    <section className="panel upload-panel">
      <div className="panel-heading">
        <div>
          <h2>上传图片到 R2</h2>
          <p>沿用生图日期目录，上传完成后会出现在最近图片中。</p>
        </div>
      </div>

      <form className="upload-form" onSubmit={submit}>
        <label className={`upload-picker ${selectedFile ? 'has-file' : ''}`} htmlFor="admin-image-upload">
          <input
            ref={inputRef}
            id="admin-image-upload"
            type="file"
            accept="image/png,image/jpeg,image/webp"
            onChange={selectFile}
          />
          <span className="upload-picker-icon">
            <UploadCloud size={20} />
          </span>
          <span>
            <strong>{selectedFile ? selectedFile.name : '选择本地图片'}</strong>
            <small>
              {selectedFile
                ? `${formatBytes(selectedFile.size)} · ${selectedFile.type || '未知类型'}`
                : 'PNG、JPG、WebP'}
            </small>
          </span>
        </label>

        <div className="upload-actions">
          <button className="ghost-button" type="button" onClick={clearFile} disabled={uploading || !selectedFile}>
            清空
          </button>
          <button className="primary-button" type="submit" disabled={uploading || !selectedFile}>
            {uploading ? <Loader2 className="spin" size={17} /> : <UploadCloud size={17} />}
            上传
          </button>
        </div>
      </form>

      {uploadError ? <div className="upload-message upload-message-error"><AlertTriangle size={16} />{uploadError}</div> : null}

      {result ? (
        <div className="upload-result">
          <div className="upload-result-summary">
            <CheckCircle2 size={17} />
            <div>
              <strong>上传完成</strong>
              <span>{result.format.toUpperCase()} · {result.width}x{result.height} · {formatBytes(result.bytes)}</span>
            </div>
          </div>
          <div className="upload-url">
            <code>{result.url}</code>
            <div className="table-actions">
              <a className="icon-button" href={result.url} target="_blank" rel="noreferrer" title="打开 URL" aria-label="打开上传图片 URL">
                <LinkIcon size={14} />
              </a>
              <button className="icon-button" type="button" onClick={() => void navigator.clipboard.writeText(result.url)} title="复制 URL" aria-label="复制上传图片 URL">
                <Copy size={14} />
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </section>
  );
}

function StatusTile({ icon, label, value, detail, tone = 'default' }: {
  icon: React.ReactNode;
  label: string;
  value: string;
  detail: string;
  tone?: 'default' | 'success' | 'warning' | 'danger';
}) {
  return (
    <article className={`status-tile ${tone}`}>
      <div className="tile-icon">{icon}</div>
      <div>
        <p>{label}</p>
        <strong>{value}</strong>
        <span>{detail}</span>
      </div>
    </article>
  );
}

function MetricCard({ title, value, icon }: { title: string; value: string; icon: React.ReactNode }) {
  return (
    <article className="metric-card">
      <div className="metric-header">
        <span>{title}</span>
        {icon}
      </div>
      <strong>{value}</strong>
    </article>
  );
}

function AsyncStatusPill({ status }: { status: AsyncTaskRecord['status'] }) {
  const statusMap: Record<AsyncTaskRecord['status'], { label: string; className: string }> = {
    submitted: { label: '已提交', className: 'neutral' },
    queued: { label: '排队中', className: 'warning' },
    processing: { label: '处理中', className: 'warning' },
    succeeded: { label: '成功', className: 'ok' },
    failed: { label: '失败', className: 'bad' }
  };
  const item = statusMap[status];
  return (
    <span className={`status-pill ${item.className}`}>
      {status === 'succeeded' ? <CheckCircle2 size={13} /> : status === 'failed' ? <XCircle size={13} /> : null}
      {item.label}
    </span>
  );
}

function CallbackStatusPill({ status }: { status: CallbackEventRecord['status'] }) {
  const statusMap: Record<CallbackEventRecord['status'], { label: string; className: string }> = {
    pending: { label: '待投递', className: 'warning' },
    processing: { label: '投递中', className: 'warning' },
    delivered: { label: '已投递', className: 'ok' },
    failed: { label: '失败', className: 'bad' }
  };
  const item = statusMap[status];
  return (
    <span className={`status-pill ${item.className}`}>
      {status === 'delivered' ? <CheckCircle2 size={13} /> : status === 'failed' ? <XCircle size={13} /> : null}
      {item.label}
    </span>
  );
}

function ChartTooltip({ active, payload, label }: any) {
  if (!active || !payload?.length) {
    return null;
  }
  return (
    <div className="chart-tooltip">
      <strong>{String(label).replace('T', ' ')}</strong>
      {payload.map((item: any) => (
        <span key={item.dataKey}>
          {item.name}: {item.dataKey === 'avgTotalMs' ? formatMs(Number(item.value)) : item.value}
        </span>
      ))}
    </div>
  );
}

function RequestTrendChart({ summary }: { summary: Summary }) {
  return (
    <section className="panel chart-panel">
      <div className="panel-heading">
        <div>
          <h2>最近 1 小时请求趋势</h2>
          <p>按分钟聚合成功、失败和平均耗时。</p>
        </div>
      </div>
      <div className="chart-wrap">
        <ResponsiveContainer width="100%" height={260}>
          <ComposedChart data={summary.requestsLastHour}>
            <defs>
              <linearGradient id="success" x1="0" x2="0" y1="0" y2="1">
                <stop offset="5%" stopColor="#10b981" stopOpacity={0.35} />
                <stop offset="95%" stopColor="#10b981" stopOpacity={0} />
              </linearGradient>
              <linearGradient id="failed" x1="0" x2="0" y1="0" y2="1">
                <stop offset="5%" stopColor="#ef4444" stopOpacity={0.28} />
                <stop offset="95%" stopColor="#ef4444" stopOpacity={0} />
              </linearGradient>
            </defs>
            <CartesianGrid stroke="#e5e7eb" strokeDasharray="4 4" />
            <XAxis dataKey="minute" tickFormatter={(value) => String(value).slice(11)} tick={{ fontSize: 12 }} />
            <YAxis yAxisId="count" tick={{ fontSize: 12 }} allowDecimals={false} />
            <YAxis
              yAxisId="duration"
              orientation="right"
              tick={{ fontSize: 12 }}
              tickFormatter={(value) => `${Math.round(Number(value) / 1000)}s`}
            />
            <Tooltip content={<ChartTooltip />} />
            <Area yAxisId="count" type="monotone" dataKey="success" name="成功" stroke="#059669" fill="url(#success)" strokeWidth={2} />
            <Area yAxisId="count" type="monotone" dataKey="failed" name="失败" stroke="#dc2626" fill="url(#failed)" strokeWidth={2} />
            <Line yAxisId="duration" type="monotone" dataKey="avgTotalMs" name="平均耗时" stroke="#2563eb" strokeWidth={2} dot={false} />
          </ComposedChart>
        </ResponsiveContainer>
      </div>
    </section>
  );
}

function AsyncOverviewPanel({ overview }: { overview: AsyncOverview }) {
  const queue = overview.queue;
  const taskBacklog = overview.tasks.submitted + overview.tasks.queued + overview.tasks.processing;
  const callbackBacklog = overview.callbacks.pending + overview.callbacks.processing;

  return (
    <section className="panel async-panel">
      <div className="panel-heading">
        <div>
          <h2>任务队列运行态</h2>
          <p>{overview.enabled ? '展示 PostgreSQL 任务事实库、Redis 队列和回调投递积压，同步等待请求也会落在这里。' : '未配置 PostgreSQL 或 Redis，任务队列管理未启用。'}</p>
        </div>
        <span className={`status-pill ${overview.enabled ? 'ok' : 'neutral'}`}>
          {overview.enabled ? <CheckCircle2 size={13} /> : <CirclePause size={13} />}
          {overview.enabled ? '已启用' : '未启用'}
        </span>
      </div>

      <div className="async-status-grid">
        <StatusTile
          icon={<Activity size={19} />}
          label="任务积压"
          value={formatNumber(taskBacklog)}
          tone={taskBacklog > 0 ? 'warning' : 'success'}
          detail={`排队 ${overview.tasks.queued} / 处理中 ${overview.tasks.processing}`}
        />
        <StatusTile
          icon={<CheckCircle2 size={19} />}
          label="任务终态"
          value={`${formatNumber(overview.tasks.succeeded)} / ${formatNumber(overview.tasks.failed)}`}
          tone={overview.tasks.failed > 0 ? 'warning' : 'default'}
          detail={`成功 / 失败，总计 ${formatNumber(overview.tasks.total)}`}
        />
        <StatusTile
          icon={<Send size={19} />}
          label="回调积压"
          value={formatNumber(callbackBacklog)}
          tone={callbackBacklog > 0 ? 'warning' : 'success'}
          detail={`待投递 ${overview.callbacks.pending} / 投递中 ${overview.callbacks.processing}`}
        />
        <StatusTile
          icon={<Database size={19} />}
          label="Redis 队列"
          value={queue ? formatNumber(queue.waiting + queue.active + queue.delayed) : '-'}
          tone={queue && queue.failed > 0 ? 'warning' : 'default'}
          detail={queue ? `等待 ${queue.waiting} / 活跃 ${queue.active} / 失败 ${queue.failed}` : '未连接队列'}
        />
      </div>
      <WorkerPanel workers={overview.workers} enabled={overview.enabled} />
    </section>
  );
}

function WorkerPanel({ workers, enabled }: { workers: WorkerSummary; enabled: boolean }) {
  return (
    <section className="worker-panel" aria-label="运行节点">
      <div className="worker-summary-grid">
        <StatusTile
          icon={<Cpu size={19} />}
          label="在线 Worker"
          value={enabled ? formatNumber(workers.total) : '-'}
          tone={enabled && workers.total === 0 ? 'warning' : 'default'}
          detail={enabled ? `活跃任务 ${formatNumber(workers.active_tasks)}` : '任务队列未启用'}
        />
        <StatusTile
          icon={<Activity size={19} />}
          label="图片处理总并发"
          value={enabled ? formatNumber(workers.image_processing_concurrency) : '-'}
          detail={`BullMQ 并发 ${enabled ? formatNumber(workers.worker_concurrency) : '-'}`}
        />
        <StatusTile
          icon={<CheckCircle2 size={19} />}
          label="节点启动后成功"
          value={enabled ? formatNumber(workers.completed_since_start) : '-'}
          tone="success"
          detail="在线节点累计"
        />
        <StatusTile
          icon={<XCircle size={19} />}
          label="节点启动后失败"
          value={enabled ? formatNumber(workers.failed_since_start) : '-'}
          tone={workers.failed_since_start > 0 ? 'warning' : 'default'}
          detail="在线节点累计"
        />
      </div>

      <div className="worker-section">
        <div className="worker-section-heading">
          <div>
            <h3>运行节点</h3>
            <p>按 Redis 心跳展示在线 worker、IP、当前任务和节点内存。</p>
          </div>
          <span>{enabled ? `${formatNumber(workers.total)} 个在线` : '未启用'}</span>
        </div>

        <div className="worker-list">
          {!enabled ? (
            <div className="empty-state"><CirclePause size={18} />任务队列未启用</div>
          ) : workers.data.length === 0 ? (
            <div className="empty-state"><AlertTriangle size={18} />暂无在线 worker 心跳</div>
          ) : workers.data.map((worker) => (
            <article className="worker-card" key={worker.worker_id}>
              <div className="worker-card-header">
                <div className="worker-title">
                  <strong>{worker.hostname}</strong>
                  <span>IP {formatWorkerIps(worker.ip_addresses)}</span>
                  <span>PID {worker.pid} · {shortId(worker.worker_id)}</span>
                </div>
                <span className="status-pill ok">在线</span>
              </div>
              <dl className="worker-stats">
                <div>
                  <dt>活跃</dt>
                  <dd>{worker.active_tasks}</dd>
                </div>
                <div>
                  <dt>图片处理并发</dt>
                  <dd>{worker.image_processing_concurrency}</dd>
                </div>
                <div>
                  <dt>成功/失败</dt>
                  <dd>{worker.completed_since_start}/{worker.failed_since_start}</dd>
                </div>
                <div>
                  <dt>RSS</dt>
                  <dd>{formatBytes(worker.rss_bytes)}</dd>
                </div>
              </dl>
              <div className="worker-meta">
                <span>启动 {formatRelativeDuration(worker.started_at)}</span>
                <span>心跳 {formatRelativeDuration(worker.last_seen_at)}</span>
                {worker.last_error_code ? <span>最后错误 {worker.last_error_code}</span> : null}
              </div>
              {worker.current_tasks.length > 0 ? (
                <div className="worker-task-list">
                  {worker.current_tasks.map((task) => (
                    <div className="worker-task" key={task.provider_task_id}>
                      <span className="id-cell">{task.client_task_id}</span>
                      <span>{asyncOperationLabel(task.operation)}</span>
                      <span>{task.model}</span>
                      <span>{formatRelativeDuration(task.started_at)}</span>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="worker-idle">当前无任务</div>
              )}
            </article>
          ))}
        </div>
      </div>
    </section>
  );
}

function ErrorPanel({ errors, onPageChange }: {
  errors: PaginatedErrors;
  onPageChange: (page: number) => void;
}) {
  const hasPrevious = errors.page > 1;
  const hasNext = errors.page < errors.totalPages;

  return (
    <section className="panel">
      <div className="panel-heading">
        <div>
          <h2>错误分布</h2>
          <p>最近 1 天按错误码聚合，每页 5 条。</p>
        </div>
      </div>
      <div className="error-list">
        {errors.data.length === 0 ? (
          <div className="empty-state"><CheckCircle2 size={18} /> 暂无错误记录</div>
        ) : errors.data.map((error) => (
          <div className="error-row" key={error.code}>
            <div>
              <strong>{error.code}</strong>
              <span>最近 {formatDate(error.lastSeenAt)}</span>
            </div>
            <b>{error.count}</b>
          </div>
        ))}
      </div>
      {errors.total > errors.pageSize ? (
        <div className="error-pagination">
          <span>
            共 {formatNumber(errors.total)} 类，第 {formatNumber(errors.page)} / {formatNumber(errors.totalPages)} 页
          </span>
          <div className="pagination-actions">
            <button className="ghost-button" disabled={!hasPrevious} onClick={() => onPageChange(errors.page - 1)}>
              上一页
            </button>
            <button className="ghost-button" disabled={!hasNext} onClick={() => onPageChange(errors.page + 1)}>
              下一页
            </button>
          </div>
        </div>
      ) : null}
    </section>
  );
}

function AsyncTaskTable({ page, enabled, onPageChange, onPageSizeChange }: {
  page: PaginatedAsyncTasks;
  enabled: boolean;
  onPageChange: (page: number) => void;
  onPageSizeChange: (pageSize: number) => void;
}) {
  return (
    <section className="panel table-panel">
      <div className="panel-heading">
        <div>
          <h2>图片任务</h2>
          <p>展示提交方式、direct lease 执行状态、R2 结果和安全版上游响应状态，不展示 prompt 和密钥。</p>
        </div>
      </div>
      <div className="table-scroll">
        <table className="async-task-table">
          <thead>
            <tr>
              <th>创建时间</th>
              <th>状态</th>
              <th>new-api 任务</th>
              <th>内部任务</th>
              <th>提交方式</th>
              <th>执行方式/模型</th>
              <th>租约</th>
              <th>渠道</th>
              <th>类型</th>
              <th>参数</th>
              <th>用量/原始响应</th>
              <th>尝试</th>
              <th>图片</th>
              <th>错误</th>
              <th>更新时间</th>
              <th>URL</th>
            </tr>
          </thead>
          <tbody>
            {!enabled ? (
              <tr>
                <td colSpan={16} className="table-empty">任务队列管理未启用</td>
              </tr>
            ) : page.data.length === 0 ? (
              <tr>
                <td colSpan={16} className="table-empty">暂无图片任务</td>
              </tr>
            ) : page.data.map((task) => (
              <tr key={task.provider_task_id}>
                <td>{formatDate(task.created_at)}</td>
                <td><AsyncStatusPill status={task.status} /></td>
                <td className="id-cell">{task.client_task_id}</td>
                <td className="id-cell">{task.provider_task_id}</td>
                <td>{formatSubmissionMode(task)}</td>
                <td>{formatExecutorLabel(task)} / {task.model}</td>
                <td className="id-cell">{formatLeaseId(task)}</td>
                <td>{formatChannelId(task)}</td>
                <td>{asyncOperationLabel(task.operation)}</td>
                <td className="params-cell">
                  <span className="single-line">{formatAsyncTaskParams(task)}</span>
                </td>
                <td className="params-cell">
                  <span className="single-line">{formatAsyncTaskUsage(task)}</span>
                </td>
                <td>{task.attempts}</td>
                <td>{task.image_count}</td>
                <td className="error-message-cell">{task.error_code ? formatTaskError(task) : '-'}</td>
                <td>{formatDate(task.updated_at)}</td>
                <td>
                  {task.first_image_url ? (
                    <div className="table-actions">
                      <a className="icon-button" href={task.first_image_url} target="_blank" rel="noreferrer" title="打开图片 URL" aria-label="打开图片任务 URL">
                        <LinkIcon size={14} />
                      </a>
                      <button className="icon-button" onClick={() => void navigator.clipboard.writeText(task.first_image_url ?? '')} title="复制 URL" aria-label="复制图片任务 URL">
                        <Copy size={14} />
                      </button>
                    </div>
                  ) : '-'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <Pagination page={page} onPageChange={onPageChange} onPageSizeChange={onPageSizeChange} />
    </section>
  );
}

function CallbackTable({ page, enabled, onPageChange, onPageSizeChange }: {
  page: PaginatedCallbacks;
  enabled: boolean;
  onPageChange: (page: number) => void;
  onPageSizeChange: (pageSize: number) => void;
}) {
  return (
    <section className="panel table-panel">
      <div className="panel-heading">
        <div>
          <h2>回调投递</h2>
          <p>按回调事件查看投递状态、密钥标识和下一次重试时间。</p>
        </div>
      </div>
      <div className="table-scroll table-scroll-compact">
        <table className="callback-table">
          <thead>
            <tr>
              <th>创建时间</th>
              <th>状态</th>
              <th>事件 ID</th>
              <th>new-api 任务</th>
              <th>内部任务</th>
              <th>密钥标识</th>
              <th>尝试</th>
              <th>下一次投递</th>
              <th>已投递时间</th>
              <th>回调地址</th>
            </tr>
          </thead>
          <tbody>
            {!enabled ? (
              <tr>
                <td colSpan={10} className="table-empty">异步回调管理未启用</td>
              </tr>
            ) : page.data.length === 0 ? (
              <tr>
                <td colSpan={10} className="table-empty">暂无回调事件</td>
              </tr>
            ) : page.data.map((event) => (
              <tr key={event.event_id}>
                <td>{formatDate(event.created_at)}</td>
                <td><CallbackStatusPill status={event.status} /></td>
                <td className="id-cell">{event.event_id}</td>
                <td className="id-cell">{event.client_task_id}</td>
                <td className="id-cell">{event.provider_task_id}</td>
                <td>{event.secret_id ?? '-'}</td>
                <td>{event.attempts}</td>
                <td>{formatDate(event.next_attempt_at)}</td>
                <td>{event.delivered_at ? formatDate(event.delivered_at) : '-'}</td>
                <td className="url-cell">
                  <span className="single-line">{event.batch_callback_url || event.callback_url}</span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <Pagination page={page} onPageChange={onPageChange} onPageSizeChange={onPageSizeChange} />
    </section>
  );
}

function ImageTable({ page, onPageChange, onPageSizeChange }: {
  page: PaginatedRecords;
  onPageChange: (page: number) => void;
  onPageSizeChange: (pageSize: number) => void;
}) {
  return (
    <section className="panel table-panel">
      <div className="panel-heading">
        <div>
          <h2>最近图片</h2>
          <p>分页展示成功生成和本地上传的图片 URL。</p>
        </div>
      </div>
      <div className="table-scroll table-scroll-compact">
        <table className="image-table">
          <thead>
            <tr>
              <th>时间</th>
              <th>类型</th>
              <th>状态</th>
              <th>模型</th>
              <th>尺寸</th>
              <th>总耗时</th>
              <th>图片大小</th>
              <th>URL</th>
            </tr>
          </thead>
          <tbody>
            {page.data.length === 0 ? (
              <tr>
                <td colSpan={8} className="table-empty">暂无图片记录</td>
              </tr>
            ) : page.data.map((request) => (
              <tr key={request.requestId}>
                <td>{formatDate(request.createdAt)}</td>
                <td>
                  <span className="status-pill neutral">{operationLabel(request.operation)}</span>
                </td>
                <td>
                  <span className="status-pill ok">
                    <CheckCircle2 size={13} />
                    {request.statusCode}
                  </span>
                </td>
                <td>{request.model ?? '-'}</td>
                <td>{request.size ?? '-'}</td>
                <td>{formatMs(request.totalMs)}</td>
                <td>{request.imageCount} / {formatBytes(request.imageBytes)}</td>
                <td>
                  <div className="table-actions">
                    <a className="icon-button" href={request.imageUrls[0]} target="_blank" rel="noreferrer" title="打开 URL">
                      <LinkIcon size={14} />
                    </a>
                    <button className="icon-button" onClick={() => void navigator.clipboard.writeText(request.imageUrls[0] ?? '')} title="复制 URL">
                      <Copy size={14} />
                    </button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <Pagination page={page} onPageChange={onPageChange} onPageSizeChange={onPageSizeChange} />
    </section>
  );
}

function RequestTable({ page, onPageChange, onPageSizeChange }: {
  page: PaginatedRecords;
  onPageChange: (page: number) => void;
  onPageSizeChange: (pageSize: number) => void;
}) {
  const [detailRequest, setDetailRequest] = useState<RequestRecord | null>(null);
  const [errorDetailRequest, setErrorDetailRequest] = useState<RequestRecord | null>(null);

  return (
    <>
      <section className="panel table-panel">
        <div className="panel-heading">
          <div>
            <h2>最近请求</h2>
            <p>仅保存排障指标，不保存 prompt 和密钥。</p>
          </div>
        </div>
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>时间</th>
                <th>类型</th>
                <th>状态</th>
                <th>模型</th>
                <th>尺寸</th>
                <th>总耗时</th>
                <th>OpenAI</th>
                <th>解码</th>
                <th>上传</th>
                <th>图片</th>
                <th>请求关键参数</th>
                <th>返回关键参数</th>
                <th>错误</th>
                <th>错误详情</th>
                <th>URL</th>
              </tr>
            </thead>
            <tbody>
              {page.data.length === 0 ? (
                <tr>
                  <td colSpan={15} className="table-empty">暂无请求记录</td>
                </tr>
              ) : page.data.map((request) => {
                const hasMismatch = getParamMismatchReasons(request).length > 0;
                return (
                  <tr key={request.requestId}>
                    <td>{formatDate(request.createdAt)}</td>
                    <td>
                      <span className="status-pill neutral">{operationLabel(request.operation)}</span>
                    </td>
                    <td>
                      <span className={`status-pill ${request.success ? 'ok' : 'bad'}`}>
                        {request.success ? <CheckCircle2 size={13} /> : <XCircle size={13} />}
                        {request.statusCode}
                      </span>
                    </td>
                    <td>{request.model ?? '-'}</td>
                    <td>{request.size ?? '-'}</td>
                    <td>{formatMs(request.totalMs)}</td>
                    <td>{formatMs(request.openaiMs)}</td>
                    <td>{formatMs(request.decodeMs)}</td>
                    <td>{formatMs(request.uploadMs)}</td>
                    <td>{request.imageCount} / {formatBytes(request.imageBytes)}</td>
                    <td className={hasMismatch ? 'params-cell params-cell-warning' : 'params-cell'}>
                      <ParamCell
                        summary={formatRequestParamSummary(request.requestParams)}
                        onView={() => setDetailRequest(request)}
                      />
                    </td>
                    <td className={hasMismatch ? 'params-cell params-cell-warning' : 'params-cell'}>
                      <ParamCell
                        summary={formatResponseParamSummary(request.responseParams)}
                        onView={() => setDetailRequest(request)}
                      />
                    </td>
                    <td>{request.errorCode ?? '-'}</td>
                    <td className="error-message-cell">
                      <ErrorCell request={request} onView={() => setErrorDetailRequest(request)} />
                    </td>
                    <td>
                      {request.imageUrls[0] ? (
                        <button className="icon-button" onClick={() => void navigator.clipboard.writeText(request.imageUrls[0] ?? '')} title="复制 URL">
                          <Copy size={14} />
                        </button>
                      ) : '-'}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <Pagination page={page} onPageChange={onPageChange} onPageSizeChange={onPageSizeChange} />
      </section>
      {detailRequest ? <ParamDetailsModal request={detailRequest} onClose={() => setDetailRequest(null)} /> : null}
      {errorDetailRequest ? <ErrorDetailsModal request={errorDetailRequest} onClose={() => setErrorDetailRequest(null)} /> : null}
    </>
  );
}

function ParamCell({ summary, onView }: { summary: string; onView: () => void }) {
  return (
    <div className="params-summary">
      <span>{summary}</span>
      <button className="mini-action-button" type="button" onClick={onView}>
        <Eye size={13} />
        查看
      </button>
    </div>
  );
}

function ErrorCell({ request, onView }: { request: RequestRecord; onView: () => void }) {
  const summary = formatErrorSummary(request);
  if (summary === '-') {
    return <span>-</span>;
  }

  return (
    <div className="params-summary">
      <span>{summary}</span>
      <button className="mini-action-button" type="button" onClick={onView}>
        <Eye size={13} />
        查看
      </button>
    </div>
  );
}

function ParamDetailsModal({ request, onClose }: { request: RequestRecord; onClose: () => void }) {
  const mismatchReasons = getParamMismatchReasons(request);

  useEffect(() => {
    function closeOnEscape(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        onClose();
      }
    }
    window.addEventListener('keydown', closeOnEscape);
    return () => window.removeEventListener('keydown', closeOnEscape);
  }, [onClose]);

  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={(event) => {
      if (event.currentTarget === event.target) {
        onClose();
      }
    }}>
      <section className="params-modal" role="dialog" aria-modal="true" aria-labelledby="params-modal-title">
        <div className="modal-header">
          <div>
            <p className="eyebrow">参数详情</p>
            <h2 id="params-modal-title">{operationLabel(request.operation)}请求对比</h2>
            <span>{formatDate(request.createdAt)} · {request.requestId}</span>
          </div>
          <button className="icon-button" type="button" onClick={onClose} title="关闭">
            <X size={16} />
          </button>
        </div>

        {mismatchReasons.length > 0 ? (
          <div className="params-diff-alert">
            <AlertTriangle size={16} />
            <span>{mismatchReasons.join('，')}</span>
          </div>
        ) : null}

        <div className="params-json-grid">
          <JsonPanel title="请求关键参数" value={request.requestParams} />
          <JsonPanel title="返回关键参数" value={request.responseParams} />
        </div>
      </section>
    </div>
  );
}

function ErrorDetailsModal({ request, onClose }: { request: RequestRecord; onClose: () => void }) {
  useEffect(() => {
    function closeOnEscape(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        onClose();
      }
    }
    window.addEventListener('keydown', closeOnEscape);
    return () => window.removeEventListener('keydown', closeOnEscape);
  }, [onClose]);

  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={(event) => {
      if (event.currentTarget === event.target) {
        onClose();
      }
    }}>
      <section className="params-modal params-modal-narrow" role="dialog" aria-modal="true" aria-labelledby="error-modal-title">
        <div className="modal-header">
          <div>
            <p className="eyebrow">错误详情</p>
            <h2 id="error-modal-title">{request.errorCode ?? '未知错误'}</h2>
            <span>{formatDate(request.createdAt)} · {request.requestId}</span>
          </div>
          <button className="icon-button" type="button" onClick={onClose} title="关闭">
            <X size={16} />
          </button>
        </div>
        <JsonPanel title="错误信息" value={buildErrorDetails(request)} />
      </section>
    </div>
  );
}

function JsonPanel({ title, value }: { title: string; value: Record<string, unknown> | undefined }) {
  const json = formatJson(value);

  return (
    <article className="json-panel">
      <div className="json-panel-header">
        <h3>{title}</h3>
        <button className="mini-action-button" type="button" onClick={() => void navigator.clipboard.writeText(json)}>
          <Copy size={13} />
          复制
        </button>
      </div>
      <pre>{json}</pre>
    </article>
  );
}

function Pagination({ page, onPageChange, onPageSizeChange }: {
  page: PaginatedRecords | PaginatedAsyncTasks | PaginatedCallbacks;
  onPageChange: (page: number) => void;
  onPageSizeChange: (pageSize: number) => void;
}) {
  const hasPrevious = page.page > 1;
  const hasNext = page.page < page.totalPages;

  function jump(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const formData = new FormData(event.currentTarget);
    const nextPage = Number.parseInt(String(formData.get('page') ?? ''), 10);
    if (!Number.isFinite(nextPage)) {
      return;
    }
    onPageChange(Math.min(page.totalPages, Math.max(1, nextPage)));
  }

  return (
    <div className="pagination">
      <span>
        共 {formatNumber(page.total)} 条，第 {formatNumber(page.page)} / {formatNumber(page.totalPages)} 页
      </span>
      <div className="pagination-actions">
        <label className="page-size-select">
          <span>每页</span>
          <select
            value={page.pageSize}
            onChange={(event) => onPageSizeChange(Number(event.target.value))}
          >
            {pageSizeOptions.map((pageSize) => (
              <option key={pageSize} value={pageSize}>{pageSize} 条</option>
            ))}
          </select>
        </label>
        <button className="ghost-button" disabled={!hasPrevious} onClick={() => onPageChange(page.page - 1)}>
          上一页
        </button>
        <form className="page-jump-form" onSubmit={jump}>
          <span>跳至</span>
          <input
            name="page"
            type="number"
            min={1}
            max={page.totalPages}
            defaultValue={page.page}
            aria-label="跳转页码"
          />
          <button className="ghost-button" type="submit">确定</button>
        </form>
        <button className="ghost-button" disabled={!hasNext} onClick={() => onPageChange(page.page + 1)}>
          下一页
        </button>
      </div>
    </div>
  );
}

async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  if (!response.ok) {
    let message = `Request failed: ${response.status}`;
    try {
      const body = await response.json() as { error?: { message?: string } };
      message = body.error?.message || message;
    } catch {
      // Keep the status-based fallback when the response is not JSON.
    }
    throw new Error(message);
  }
  return response.json() as Promise<T>;
}

function formatMs(value: number): string {
  if (!Number.isFinite(value) || value <= 0) {
    return '0 ms';
  }
  if (value < 1000) {
    return `${Math.round(value)} ms`;
  }
  return `${(value / 1000).toFixed(1)} s`;
}

function formatBytes(value: number): string {
  if (!Number.isFinite(value) || value <= 0) {
    return '0 B';
  }
  const units = ['B', 'KB', 'MB', 'GB'];
  let size = value;
  let unit = 0;
  while (size >= 1024 && unit < units.length - 1) {
    size /= 1024;
    unit += 1;
  }
  return `${size.toFixed(unit === 0 ? 0 : 1)} ${units[unit]}`;
}

function formatNumber(value: number): string {
  return new Intl.NumberFormat('zh-CN').format(value);
}

function getScalarParam(params: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = params?.[key];
  return ['string', 'number', 'boolean'].includes(typeof value) ? String(value) : undefined;
}

function formatParamParts(params: Record<string, unknown> | undefined, keys: string[]): string {
  if (!params || Object.keys(params).length === 0) {
    return '-';
  }

  const parts = keys
    .map((key) => {
      const value = getScalarParam(params, key);
      return value === undefined ? undefined : `${key}:${value}`;
    })
    .filter((part): part is string => Boolean(part));

  return parts.length > 0 ? parts.join(' | ') : '-';
}

function formatRequestParamSummary(params: Record<string, unknown> | undefined): string {
  return formatParamParts(params, ['model', 'n', 'size', 'quality', 'output_format', 'output_compression']);
}

function formatResponseParamSummary(params: Record<string, unknown> | undefined): string {
  if (!params || Object.keys(params).length === 0) {
    return '-';
  }

  const format = getScalarParam(params, 'format');
  const size = getScalarParam(params, 'size');
  const bytes = typeof params.bytes === 'number' ? formatBytes(params.bytes) : undefined;
  const count = getScalarParam(params, 'count');
  const parts = [format, size, bytes, count ? `count:${count}` : undefined].filter((part): part is string => Boolean(part));
  return parts.length > 0 ? parts.join(' | ') : '-';
}

function formatAsyncTaskParams(task: AsyncTaskRecord): string {
  const parameterSummary = formatParamParts(task.parameters, ['size', 'quality', 'n', 'output_format', 'output_compression']);
  return parameterSummary;
}

function formatTaskError(task: AsyncTaskRecord): string {
  const code = task.error_code ?? 'unknown_error';
  const message = task.error_message?.trim();
  if (!message) {
    return code;
  }
  const brief = message.length > 48 ? `${message.slice(0, 47)}...` : message;
  return `${code} · ${brief}`;
}

function formatSubmissionMode(task: AsyncTaskRecord): string {
  const mode = getScalarParam(task.metadata, 'submission_mode');
  if (mode === 'sync_wait') {
    return '同步等待';
  }
  if (mode === 'async') {
    return '异步提交';
  }
  return '未标记';
}

function formatExecutorLabel(task: AsyncTaskRecord): string {
  if (task.executor?.type === 'provider_direct_lease') {
    return '直连上游';
  }
  return task.executor?.type || task.provider || '-';
}

function formatLeaseId(task: AsyncTaskRecord): string {
  return task.executor?.lease_id || '-';
}

function formatChannelId(task: AsyncTaskRecord): string {
  return getScalarParam(task.metadata, 'channel_id') || '-';
}

function formatAsyncTaskUsage(task: AsyncTaskRecord): string {
  const totalTokens = getScalarParam(task.usage ?? undefined, 'total_tokens');
  const actualQuota = getScalarParam(task.usage ?? undefined, 'actual_quota');
  const usage = totalTokens ? `tokens:${totalTokens}` : actualQuota ? `quota:${actualQuota}` : 'usage:-';
  const raw = task.raw_response_truncated
    ? `raw:已清理${task.raw_response_omitted_fields?.length ? `(${task.raw_response_omitted_fields.length})` : ''}`
    : 'raw:完整';
  return `${usage} | ${raw}`;
}

function formatErrorSummary(request: RequestRecord): string {
  const message = request.errorMessage?.trim();
  if (!message) {
    return '-';
  }

  return message.length > 64 ? `${message.slice(0, 63)}...` : message;
}

function buildErrorDetails(request: RequestRecord): Record<string, unknown> {
  return {
    statusCode: request.statusCode,
    errorCode: request.errorCode ?? null,
    message: request.errorMessage ?? null,
    requestId: request.requestId,
    operation: operationLabel(request.operation),
    createdAt: request.createdAt
  };
}

function getParamMismatchReasons(request: RequestRecord): string[] {
  const reasons: string[] = [];
  const requestSize = getScalarParam(request.requestParams, 'size');
  const responseSize = getScalarParam(request.responseParams, 'size');
  const requestCount = getScalarParam(request.requestParams, 'n');
  const responseCount = getScalarParam(request.responseParams, 'count');

  if (requestSize && responseSize && requestSize !== responseSize) {
    reasons.push(`尺寸不一致：请求 ${requestSize}，返回 ${responseSize}`);
  }
  if (requestCount && responseCount && requestCount !== responseCount) {
    reasons.push(`数量不一致：请求 ${requestCount}，返回 ${responseCount}`);
  }

  return reasons;
}

function formatJson(value: Record<string, unknown> | undefined): string {
  if (!value || Object.keys(value).length === 0) {
    return '{}';
  }

  return JSON.stringify(value, null, 2);
}

function formatDate(value: string): string {
  return new Intl.DateTimeFormat('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit'
  }).format(new Date(value));
}

function formatRelativeDuration(value: string): string {
  const timestamp = new Date(value).getTime();
  if (!Number.isFinite(timestamp)) {
    return '-';
  }
  const seconds = Math.max(0, Math.floor((Date.now() - timestamp) / 1000));
  if (seconds < 60) {
    return `${seconds} 秒前`;
  }
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) {
    return `${minutes} 分钟前`;
  }
  const hours = Math.floor(minutes / 60);
  if (hours < 48) {
    return `${hours} 小时前`;
  }
  return formatDate(value);
}

function shortId(value: string): string {
  return value.length > 18 ? `${value.slice(0, 8)}...${value.slice(-6)}` : value;
}

function formatWorkerIps(value: string[]): string {
  return value.length > 0 ? value.join(', ') : '-';
}

function operationLabel(operation: RequestRecord['operation']): string {
  if (operation === 'manual_upload') {
    return '本地上传';
  }
  return operation === 'edit' ? '图生图' : '文生图';
}

function asyncOperationLabel(operation: AsyncTaskRecord['operation'] | string): string {
  return operation === 'edit' ? '图生图' : '文生图';
}

function percent(value: number, total: number): number {
  if (!Number.isFinite(value) || !Number.isFinite(total) || total <= 0) {
    return 0;
  }
  return (value / total) * 100;
}

createRoot(document.getElementById('root')!).render(<App />);
