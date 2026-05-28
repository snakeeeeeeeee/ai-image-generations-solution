import React, { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import {
  Activity,
  AlertTriangle,
  BarChart3,
  CheckCircle2,
  Clock3,
  Copy,
  Database,
  ImageIcon,
  Link as LinkIcon,
  Loader2,
  Lock,
  LogOut,
  MemoryStick,
  RefreshCw,
  Server,
  UploadCloud,
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
  operation: 'generation' | 'edit';
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
  errors: ErrorRecord[];
  requests: PaginatedRecords;
  images: PaginatedRecords;
}

interface PaginatedRecords {
  data: RequestRecord[];
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
}

type AuthState = 'checking' | 'authenticated' | 'anonymous';
type RefreshIntervalMs = 5000 | 15000 | 30000 | 60000;

const adminBasePath = new URL(import.meta.env.BASE_URL, window.location.origin).pathname.replace(/\/+$/, '');
const adminPath = (path = '') => `${adminBasePath}${path}`;
const refreshIntervals: Array<{ label: string; value: RefreshIntervalMs }> = [
  { label: '5 秒', value: 5000 },
  { label: '15 秒', value: 15000 },
  { label: '30 秒', value: 30000 },
  { label: '1 分钟', value: 60000 }
];
const requestPageSize = 20;
const imagePageSize = 10;

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
  const [refreshIntervalMs, setRefreshIntervalMs] = useState<RefreshIntervalMs>(5000);
  const [requestPage, setRequestPage] = useState(1);
  const [imagePage, setImagePage] = useState(1);
  const [error, setError] = useState('');

  async function load(options: { silent?: boolean; requestPage?: number; imagePage?: number } = {}) {
    if (options.silent) {
      setRefreshing(true);
    } else {
      setLoading(true);
    }
    setError('');
    try {
      const nextRequestPage = options.requestPage ?? requestPage;
      const nextImagePage = options.imagePage ?? imagePage;
      const [summary, requests, images, errors] = await Promise.all([
        fetchJson<{ runtime: RuntimeStats; summary: Summary }>(adminPath('/api/summary')),
        fetchJson<PaginatedRecords>(adminPath(`/api/requests?page=${nextRequestPage}&page_size=${requestPageSize}`)),
        fetchJson<PaginatedRecords>(adminPath(`/api/images?page=${nextImagePage}&page_size=${imagePageSize}`)),
        fetchJson<{ data: ErrorRecord[] }>(adminPath('/api/errors'))
      ]);
      setRequestPage(requests.page);
      setImagePage(images.page);
      setData({
        runtime: summary.runtime,
        summary: summary.summary,
        errors: errors.data,
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
  }, [refreshIntervalMs, requestPage, imagePage]);

  async function logout() {
    await fetch(adminPath('/logout'), { method: 'POST' });
    history.replaceState(null, '', adminPath('/login'));
    onLogout();
  }

  function changeRequestPage(page: number) {
    setRequestPage(page);
    void load({ silent: true, requestPage: page });
  }

  function changeImagePage(page: number) {
    setImagePage(page);
    void load({ silent: true, imagePage: page });
  }

  const memoryPercent = data ? percent(data.runtime.memory.rssBytes, data.runtime.memory.maxRssBytes) : 0;
  const processingPercent = data
    ? percent(data.runtime.activeImageProcessing, data.runtime.maxConcurrentImageProcessing)
    : 0;
  const r2UploadError = data?.errors.find((item) => item.code === 'r2_upload_failed');

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
          <section className="status-grid">
            <StatusTile
              icon={<Server size={19} />}
              label="服务状态"
              value={memoryPercent >= 90 ? '内存高水位' : '运行正常'}
              tone={memoryPercent >= 90 ? 'warning' : 'success'}
              detail={`RSS ${formatBytes(data.runtime.memory.rssBytes)} / ${formatBytes(data.runtime.memory.maxRssBytes)}`}
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

          <section className="panel chart-panel">
            <div className="panel-heading">
              <div>
                <h2>最近 1 小时请求趋势</h2>
                <p>按分钟聚合成功、失败和平均耗时。</p>
              </div>
            </div>
            <div className="chart-wrap">
              <ResponsiveContainer width="100%" height={260}>
                <ComposedChart data={data.summary.requestsLastHour}>
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

          <ErrorPanel errors={data.errors} />
          <ImageTable page={data.images} onPageChange={changeImagePage} />
          <RequestTable page={data.requests} onPageChange={changeRequestPage} />
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

function ErrorPanel({ errors }: { errors: ErrorRecord[] }) {
  return (
    <section className="panel">
      <div className="panel-heading">
        <div>
          <h2>错误分布</h2>
          <p>按错误码聚合。</p>
        </div>
      </div>
      <div className="error-list">
        {errors.length === 0 ? (
          <div className="empty-state"><CheckCircle2 size={18} /> 暂无错误记录</div>
        ) : errors.map((error) => (
          <div className="error-row" key={error.code}>
            <div>
              <strong>{error.code}</strong>
              <span>最近 {formatDate(error.lastSeenAt)}</span>
            </div>
            <b>{error.count}</b>
          </div>
        ))}
      </div>
    </section>
  );
}

function ImageTable({ page, onPageChange }: { page: PaginatedRecords; onPageChange: (page: number) => void }) {
  return (
    <section className="panel table-panel">
      <div className="panel-heading">
        <div>
          <h2>最近图片</h2>
          <p>分页展示成功生成的图片 URL。</p>
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
      <Pagination page={page} onPageChange={onPageChange} />
    </section>
  );
}

function RequestTable({ page, onPageChange }: { page: PaginatedRecords; onPageChange: (page: number) => void }) {
  return (
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
              <th>错误</th>
              <th>URL</th>
            </tr>
          </thead>
          <tbody>
            {page.data.length === 0 ? (
              <tr>
                <td colSpan={12} className="table-empty">暂无请求记录</td>
              </tr>
            ) : page.data.map((request) => (
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
                <td>{request.errorCode ?? '-'}</td>
                <td>
                  {request.imageUrls[0] ? (
                    <button className="icon-button" onClick={() => void navigator.clipboard.writeText(request.imageUrls[0] ?? '')} title="复制 URL">
                      <Copy size={14} />
                    </button>
                  ) : '-'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <Pagination page={page} onPageChange={onPageChange} />
    </section>
  );
}

function Pagination({ page, onPageChange }: { page: PaginatedRecords; onPageChange: (page: number) => void }) {
  const hasPrevious = page.page > 1;
  const hasNext = page.page < page.totalPages;

  return (
    <div className="pagination">
      <span>
        共 {formatNumber(page.total)} 条，第 {formatNumber(page.page)} / {formatNumber(page.totalPages)} 页
      </span>
      <div className="pagination-actions">
        <button className="ghost-button" disabled={!hasPrevious} onClick={() => onPageChange(page.page - 1)}>
          上一页
        </button>
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
    throw new Error(`Request failed: ${response.status}`);
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

function formatDate(value: string): string {
  return new Intl.DateTimeFormat('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit'
  }).format(new Date(value));
}

function operationLabel(operation: RequestRecord['operation']): string {
  return operation === 'edit' ? '图生图' : '文生图';
}

function percent(value: number, total: number): number {
  if (!Number.isFinite(value) || !Number.isFinite(total) || total <= 0) {
    return 0;
  }
  return (value / total) * 100;
}

createRoot(document.getElementById('root')!).render(<App />);
