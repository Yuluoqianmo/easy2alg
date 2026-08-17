import {
  Box,
  Check,
  CheckCircle2,
  ChevronRight,
  CircleHelp,
  Clock3,
  Folder,
  FolderOpen,
  History,
  Layers3,
  LibraryBig,
  LoaderCircle,
  PackageCheck,
  Play,
  Plus,
  RotateCcw,
  Search,
  Settings,
  ShieldCheck,
  Sparkles,
  Trash2,
  TriangleAlert,
  X,
  Zap,
} from "lucide-react";
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type Dispatch,
  type ReactElement,
  type SetStateAction,
} from "react";
import type { Easy2AlgApi } from "../../shared/ipc";
import type {
  AllegroInstall,
  AllegroVersion,
  AppSettings,
  ConversionPlan,
  GenerationProgress,
  HistoryEntry,
  NormalizedFootprint,
  QueueItem,
} from "../../shared/schemas";
import { createMockApi } from "./mock-api";

type Page = "convert" | "history" | "settings";

const createUnavailableApi = (): Easy2AlgApi => {
  const unavailable = async (): Promise<never> => {
    throw new Error(
      "软件后台服务未能启动。请关闭当前软件并使用完整安装包或免安装包重新打开。",
    );
  };
  return {
    getAppInfo: unavailable,
    getSettings: unavailable,
    saveSettings: unavailable,
    chooseLibraryDirectory: unavailable,
    chooseAllegroExecutable: unavailable,
    detectAllegro: unavailable,
    fetchComponent: unavailable,
    createPlan: unavailable,
    generate: unavailable,
    onGenerationProgress: () => () => undefined,
    getHistory: unavailable,
    openPath: unavailable,
  };
};

const isBrowserPreview =
  import.meta.env.DEV &&
  (window.location.protocol === "http:" || window.location.protocol === "https:");
const api: Easy2AlgApi =
  window.easy2alg ??
  (isBrowserPreview ? createMockApi() : createUnavailableApi());
const emptySettings: AppSettings = {
  allegroVersion: "23.1",
  libraryDirectory: "",
  setupCompleted: false,
  allegroExecutablePath: null,
};

const AllegroVersionOptions: readonly {
  readonly value: AllegroVersion;
  readonly label: string;
}[] = [
  { value: "23.1", label: "Cadence Allegro 23.1" },
  { value: "22.1", label: "Cadence Allegro 22.1" },
  { value: "17.4", label: "Cadence Allegro 17.4" },
  { value: "17.2", label: "Cadence Allegro 17.2" },
  { value: "16.6", label: "Cadence Allegro 16.6" },
];

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const splitIds = (value: string): readonly string[] => [
  ...new Set(
    value
      .toUpperCase()
      .split(/[\s,;，；]+/)
      .map((id) => id.trim())
      .filter((id) => id.length > 0),
  ),
];

const formatDate = (iso: string): string =>
  new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(iso));

const FootprintPreview = ({ footprint }: { readonly footprint: NormalizedFootprint }): ReactElement => {
  const width = Math.max(footprint.bounds.maxX - footprint.bounds.minX, 1);
  const height = Math.max(footprint.bounds.maxY - footprint.bounds.minY, 1);
  const margin = Math.max(width, height) * 0.15;
  const viewBox = `${footprint.bounds.minX - margin} ${-footprint.bounds.maxY - margin} ${width + margin * 2} ${height + margin * 2}`;
  return (
    <svg className="footprint-svg" viewBox={viewBox} aria-label="封装俯视预览">
      <defs>
        <pattern id="grid" width="1" height="1" patternUnits="userSpaceOnUse">
          <path d="M 1 0 L 0 0 0 1" fill="none" stroke="#dfe4ea" strokeWidth="0.025" />
        </pattern>
      </defs>
      <rect
        x={footprint.bounds.minX - margin}
        y={footprint.bounds.minY - margin}
        width={width + margin * 2}
        height={height + margin * 2}
        fill="url(#grid)"
      />
      <g transform="scale(1 -1)">
      {footprint.lines.map((line, index) => (
        <line
          key={`line-${index}`}
          x1={line.start.x}
          y1={line.start.y}
          x2={line.end.x}
          y2={line.end.y}
          stroke={
            line.layer === "silkscreen"
              ? "#f4a31a"
              : line.layer === "courtyard"
                ? "#7d8794"
                : "#8f9ba8"
          }
          strokeWidth={Math.max(line.width, 0.06)}
          strokeDasharray={line.layer === "courtyard" ? "0.25 0.18" : undefined}
        />
      ))}
      {footprint.pads.map((pad) => (
        <g
          key={`${pad.number}-${pad.center.x}-${pad.center.y}`}
          transform={`translate(${pad.center.x} ${pad.center.y}) rotate(${pad.rotation})`}
        >
          <rect
            x={-pad.width / 2}
            y={-pad.height / 2}
            width={pad.width}
            height={pad.height}
            rx={pad.shape === "roundedRectangle" ? Math.min(pad.width, pad.height) * 0.2 : pad.shape === "oval" ? Math.min(pad.width, pad.height) / 2 : 0}
            fill={pad.number === "1" ? "#e2b856" : "#d4a73f"}
            stroke="#a87919"
            strokeWidth="0.05"
          />
          {pad.holeWidth > 0 ? (
            <ellipse
              rx={pad.holeWidth / 2}
              ry={Math.max(pad.holeHeight, pad.holeWidth) / 2}
              fill="#f4f6f8"
              stroke="#687481"
              strokeWidth="0.05"
            />
          ) : null}
          <text
            x="0"
            y="0"
            textAnchor="middle"
            dominantBaseline="central"
            fontSize={Math.max(Math.min(pad.width, pad.height) * 0.42, 0.18)}
            fill="#5e4d25"
            transform={`scale(1 -1) rotate(${-pad.rotation})`}
          >
            {pad.number}
          </text>
        </g>
      ))}
      {footprint.circles.map((circle, index) => (
        <circle
          key={`circle-${index}`}
          cx={circle.center.x}
          cy={circle.center.y}
          r={circle.radius}
          fill="none"
          stroke="#f4a31a"
          strokeWidth={circle.width}
        />
      ))}
      </g>
    </svg>
  );
};

const NavButton = ({
  active,
  icon,
  label,
  onClick,
  testId,
}: {
  readonly active: boolean;
  readonly icon: ReactElement;
  readonly label: string;
  readonly onClick: () => void;
  readonly testId: string;
}): ReactElement => (
  <button
    className={`nav-button ${active ? "active" : ""}`}
    onClick={onClick}
    data-testid={testId}
    type="button"
  >
    {icon}
    <span>{label}</span>
  </button>
);

const SetupDialog = ({
  initial,
  installs,
  onInstallDetected,
  onSave,
}: {
  readonly initial: AppSettings;
  readonly installs: readonly AllegroInstall[];
  readonly onInstallDetected: (install: AllegroInstall) => void;
  readonly onSave: (settings: AppSettings) => Promise<void>;
}): ReactElement => {
  const configured = installs.find((install) => install.version === initial.allegroVersion);
  const initialVersion = configured?.version ?? installs[0]?.version ?? initial.allegroVersion;
  const [version, setVersion] = useState<AllegroVersion>(initialVersion);
  const [directory, setDirectory] = useState(initial.libraryDirectory);
  const [manualExecutablePath, setManualExecutablePath] = useState<string | null>(
    initialVersion === initial.allegroVersion ? initial.allegroExecutablePath : null,
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const selectedInstall =
    (manualExecutablePath === null
      ? installs.find((install) => install.version === version)
      : installs.find(
          (install) =>
            install.version === version &&
            install.executablePath.toLowerCase() === manualExecutablePath.toLowerCase(),
        )) ?? null;

  const chooseDirectory = async (): Promise<void> => {
    const selected = await api.chooseLibraryDirectory();
    if (selected !== null) {
      setDirectory(selected);
    }
  };
  const save = async (): Promise<void> => {
    setSaving(true);
    setError(null);
    try {
      await onSave({
        allegroVersion: version,
        libraryDirectory: directory,
        setupCompleted: true,
        allegroExecutablePath: manualExecutablePath,
      });
    } catch (saveError) {
      setError(errorMessage(saveError));
    } finally {
      setSaving(false);
    }
  };
  const chooseExecutable = async (): Promise<void> => {
    setError(null);
    try {
      const install = await api.chooseAllegroExecutable();
      if (install !== null) {
        onInstallDetected(install);
        setVersion(install.version);
        setManualExecutablePath(install.executablePath);
      }
    } catch (chooseError) {
      setError(errorMessage(chooseError));
    }
  };
  return (
    <div className="modal-backdrop">
      <section className="setup-dialog" aria-modal="true" role="dialog" data-testid="setup-dialog">
        <div className="setup-mark"><Zap size={25} /></div>
        <p className="eyebrow">安装检查</p>
        <h2>确认真实的 Allegro</h2>
        <p className="muted">只有检测到实际程序后才能生成封装，不再使用默认连接状态。</p>
        <label className="field-label" htmlFor="setup-version">Allegro 版本</label>
        <select
          id="setup-version"
          value={version}
          onChange={(event) => {
            setVersion(event.target.value as AllegroVersion);
            setManualExecutablePath(null);
          }}
        >
          {AllegroVersionOptions.map((option) => (
            <option value={option.value} key={option.value}>
              {option.label}
              {installs.some((install) => install.version === option.value) ? "（已检测）" : ""}
            </option>
          ))}
        </select>
        <div className={`detection-card ${selectedInstall === null ? "missing" : ""}`}>
          {selectedInstall === null ? (
            <>
              <TriangleAlert size={18} />
              <div><strong>未检测到 Allegro {version}</strong><span>可以选择实际的 allegro.exe</span></div>
            </>
          ) : (
            <>
              <Check size={18} />
              <div><strong>已检测 Allegro {selectedInstall.version}</strong><span>{selectedInstall.executablePath}</span></div>
            </>
          )}
          <button type="button" className="secondary-button" onClick={() => void chooseExecutable()}>
            手动选择
          </button>
        </div>
        {error === null ? null : <p className="setup-error">{error}</p>}
        <label className="field-label" htmlFor="setup-directory">封装库目录</label>
        <div className="directory-row">
          <input
            id="setup-directory"
            value={directory}
            onChange={(event) => setDirectory(event.target.value)}
            placeholder="选择保存目录"
          />
          <button type="button" className="icon-button" onClick={chooseDirectory} aria-label="选择目录">
            <FolderOpen size={18} />
          </button>
        </div>
        <button
          className="primary-button wide"
          type="button"
          disabled={directory.trim().length === 0 || selectedInstall === null || saving}
          onClick={save}
          data-testid="setup-confirm"
        >
          {saving ? <LoaderCircle className="spin" size={17} /> : <Check size={17} />}
          保存并开始
        </button>
      </section>
    </div>
  );
};

const ProgressSteps = [
  { stage: "preparing", label: "准备封装数据" },
  { stage: "launching", label: "启动 Allegro" },
  { stage: "generating", label: "生成焊盘和封装" },
  { stage: "verifying", label: "回读并检查封装" },
  { stage: "copying", label: "写入封装库目录" },
] as const;

const GenerationProgressDialog = ({
  progress,
  onClose,
  onOpenDirectory,
}: {
  readonly progress: GenerationProgress;
  readonly onClose: () => void;
  readonly onOpenDirectory: (absolutePath: string) => Promise<void>;
}): ReactElement => {
  const terminal = progress.stage === "completed" || progress.stage === "failed";
  const activeIndex =
    progress.stage === "completed"
      ? ProgressSteps.length
      : progress.stage === "failed"
        ? Math.min(Math.floor(progress.percent / 20), ProgressSteps.length - 1)
        : ProgressSteps.findIndex((step) => step.stage === progress.stage);
  return (
    <div className="progress-backdrop">
      <section
        className={`progress-dialog ${progress.stage}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby="generation-progress-title"
        data-testid="generation-progress-dialog"
      >
        <div className="progress-heading">
          <div className="progress-symbol">
            {progress.stage === "completed" ? (
              <Check size={24} />
            ) : progress.stage === "failed" ? (
              <X size={24} />
            ) : (
              <LoaderCircle className="spin" size={24} />
            )}
          </div>
          <div>
            <p>{progress.lcscId}</p>
            <h2 id="generation-progress-title">
              {progress.stage === "completed"
                ? "生成并验证完成"
                : progress.stage === "failed"
                  ? "生成未完成"
                  : "正在生成并验证"}
            </h2>
          </div>
        </div>
        <div className="progress-meter" aria-label={`完成 ${progress.percent}%`}>
          <i style={{ width: `${progress.percent}%` }} />
        </div>
        <div className="progress-percent">
          <span data-testid="generation-progress-message">{progress.message}</span>
          <strong data-testid="generation-progress-percent">{progress.percent}%</strong>
        </div>
        <div className="progress-steps">
          {ProgressSteps.map((step, index) => {
            const completed = progress.stage === "completed" || index < activeIndex;
            const active = index === activeIndex && !terminal;
            const failed = progress.stage === "failed" && index === activeIndex;
            return (
              <div
                className={`progress-step ${completed ? "completed" : ""} ${active ? "active" : ""} ${failed ? "failed" : ""}`}
                key={step.stage}
              >
                <span>
                  {completed ? (
                    <Check size={14} />
                  ) : failed ? (
                    <X size={14} />
                  ) : active ? (
                    <LoaderCircle className="spin" size={14} />
                  ) : (
                    index + 1
                  )}
                </span>
                <strong>{step.label}</strong>
              </div>
            );
          })}
        </div>
        {progress.stage === "failed" && progress.diagnosticDirectory !== null ? (
          <div className="progress-diagnostics">
            <span>本次临时文件已保留</span>
            <strong>{progress.diagnosticDirectory}</strong>
          </div>
        ) : null}
        {terminal ? (
          <div className="progress-actions">
            {progress.stage === "failed" && progress.diagnosticDirectory !== null ? (
              <button
                className="secondary-button"
                type="button"
                onClick={() => void onOpenDirectory(progress.diagnosticDirectory!)}
                data-testid="generation-progress-open-diagnostics"
              >
                <FolderOpen size={16} />打开临时文件
              </button>
            ) : null}
            <button
              className="primary-button progress-close"
              type="button"
              onClick={onClose}
              data-testid="generation-progress-close"
            >
              {progress.stage === "completed" ? "完成" : "关闭"}
            </button>
          </div>
        ) : (
          <p className="progress-note">请不要关闭软件或操作 Allegro 窗口</p>
        )}
      </section>
    </div>
  );
};

const ConverterPage = ({
  settings,
  allegroInstall,
  queue,
  setQueue,
  selectedId,
  setSelectedId,
  onGenerated,
}: {
  readonly settings: AppSettings;
  readonly allegroInstall: AllegroInstall | null;
  readonly queue: readonly QueueItem[];
  readonly setQueue: Dispatch<SetStateAction<readonly QueueItem[]>>;
  readonly selectedId: string | null;
  readonly setSelectedId: (id: string | null) => void;
  readonly onGenerated: (entry: HistoryEntry) => void;
}): ReactElement => {
  const [input, setInput] = useState("C2040");
  const [plans, setPlans] = useState<Readonly<Record<string, ConversionPlan>>>({});
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState<GenerationProgress | null>(null);
  const progressRef = useRef<GenerationProgress | null>(null);
  const selected = queue.find((item) => item.id === selectedId) ?? queue[0] ?? null;
  const selectedPlan = selected === null ? null : (plans[selected.id] ?? null);

  useEffect(
    () =>
      api.onGenerationProgress((item) => {
        progressRef.current = item;
        setProgress(item);
      }),
    [],
  );

  const updateItem = (id: string, patch: Partial<QueueItem>): void => {
    setQueue((current) =>
      current.map((item) => (item.id === id ? { ...item, ...patch } : item)),
    );
  };

  const importIds = async (): Promise<void> => {
    const ids = splitIds(input);
    if (ids.length === 0) {
      return;
    }
    const existing = new Set(queue.map((item) => item.id));
    const newItems = ids
      .filter((id) => !existing.has(id))
      .map<QueueItem>((id) => ({
        id,
        state: "loading",
        footprint: null,
        message: "正在读取器件信息…",
        selected: true,
      }));
    if (newItems.length === 0) {
      setSelectedId(ids[0] ?? null);
      return;
    }
    const nextQueue = [...queue, ...newItems];
    setQueue(nextQueue);
    setSelectedId(newItems[0]?.id ?? null);
    setInput("");
    const loaded = await Promise.all(
      newItems.map(async (item): Promise<{ item: QueueItem; plan: ConversionPlan | null }> => {
        try {
          const footprint = await api.fetchComponent(item.id);
          const plan = await api.createPlan(footprint);
          return {
            item: {
              ...item,
              state: plan.checks.some((check) => check.severity === "warning") ? "warning" : "ready",
              footprint,
              message: "已读取，等待生成",
            },
            plan,
          };
        } catch (error) {
          return {
            item: {
              ...item,
              state: "error",
              message: errorMessage(error),
            },
            plan: null,
          };
        }
      }),
    );
    const loadedMap = new Map(loaded.map((result) => [result.item.id, result.item]));
    setQueue(nextQueue.map((item) => loadedMap.get(item.id) ?? item));
    setPlans((current) => {
      const additions = Object.fromEntries(
        loaded
          .filter((result): result is { item: QueueItem; plan: ConversionPlan } => result.plan !== null)
          .map((result) => [result.item.id, result.plan]),
      );
      return { ...current, ...additions };
    });
  };

  const generateSelected = async (): Promise<void> => {
    const targets = queue.filter(
      (item) => item.selected && item.footprint !== null && plans[item.id] !== undefined,
    );
    if (targets.length === 0) {
      return;
    }
    setRunning(true);
    for (const target of targets) {
      updateItem(target.id, { state: "loading", message: "Allegro 正在生成并检查…" });
      const startingProgress: GenerationProgress = {
        lcscId: target.id,
        stage: "preparing",
        percent: 1,
        message: "正在提交生成任务",
        diagnosticDirectory: null,
        timestamp: new Date().toISOString(),
      };
      progressRef.current = startingProgress;
      setProgress(startingProgress);
      try {
        const result = await api.generate(plans[target.id]!);
        updateItem(target.id, { state: "generated", message: result.message });
        onGenerated({ ...result, id: `${result.lcscId}-${result.completedAt}` });
      } catch (error) {
        const previousProgress = progressRef.current;
        const reportedFailure =
          previousProgress?.lcscId === target.id &&
          previousProgress.stage === "failed"
            ? previousProgress
            : null;
        const message = reportedFailure?.message ?? errorMessage(error);
        updateItem(target.id, {
          state: "generationFailed",
          message: `上次生成失败，可直接重试：${message}`,
        });
        const failedProgress: GenerationProgress =
          reportedFailure ?? {
            lcscId: target.id,
            stage: "failed",
            percent:
              previousProgress?.lcscId === target.id
                ? Math.min(previousProgress.percent, 99)
                : 1,
            message,
            diagnosticDirectory: null,
            timestamp: new Date().toISOString(),
          };
        progressRef.current = failedProgress;
        setProgress(failedProgress);
      }
    }
    setRunning(false);
  };

  const readyCount = queue.filter(
    (item) =>
      item.selected &&
      (item.state === "ready" ||
        item.state === "warning" ||
        item.state === "generationFailed"),
  ).length;
  const retryCount = queue.filter(
    (item) => item.selected && item.state === "generationFailed",
  ).length;
  return (
    <>
    <main className="workbench">
      <aside className="left-rail">
        <div className="rail-header">
          <h2>待转换器件</h2>
          <span>{queue.length} 项</span>
        </div>
        <div className="input-block">
          <textarea
            value={input}
            onChange={(event) => setInput(event.target.value)}
            placeholder="输入或粘贴立创编号，如 C2040"
            data-testid="lcsc-input"
          />
          <div className="input-actions">
            <button className="primary-button" type="button" onClick={() => void importIds()} data-testid="import-button">
              <Search size={16} />查询
            </button>
            <button className="secondary-button" type="button" onClick={() => setInput("")}>
              <Plus size={16} />导入清单
            </button>
          </div>
        </div>
        <div className="queue-columns"><span>器件 / 封装</span><span>状态</span></div>
        <div className="rail-list">
          {queue.length === 0 ? (
            <div className="empty-state"><Layers3 size={28} /><strong>暂无器件</strong><span>先查询一个立创编号</span></div>
          ) : queue.map((item) => (
            <button
              type="button"
              key={item.id}
              className={`rail-item ${selected?.id === item.id ? "selected" : ""}`}
              onClick={() => setSelectedId(item.id)}
              data-testid={`queue-item-${item.id}`}
            >
              <input
                type="checkbox"
                checked={item.selected}
                onClick={(event) => event.stopPropagation()}
                onChange={(event) => updateItem(item.id, { selected: event.target.checked })}
                aria-label={`选择 ${item.id}`}
              />
              <span className={`source-dot ${item.state}`} />
              <div>
                <strong>{item.id}</strong><small>{item.footprint?.info.name ?? ""}</small>
                <em>{item.footprint?.info.sourcePackageName ?? item.message}</em>
              </div>
              <div className={`rail-state ${item.state}`}>
                {item.state === "loading" ? (
                  <LoaderCircle className="spin" size={15} />
                ) : item.state === "warning" ? (
                  <TriangleAlert size={15} />
                ) : item.state === "error" || item.state === "generationFailed" ? (
                  <X size={15} />
                ) : (
                  <Check size={15} />
                )}
              </div>
            </button>
          ))}
        </div>
        {queue.length > 0 ? (
          <button className="clear-list" type="button" onClick={() => { setQueue([]); setSelectedId(null); }}>
            <Trash2 size={14} />清空列表
          </button>
        ) : null}
      </aside>

      <section className="main-stage">
        <header className="stage-heading">
          <div><h2>封装预览</h2><span>{selected?.id ?? ""} · {selected?.footprint?.info.sourcePackageName ?? "请选择器件"}</span></div>
          <div className="stage-tools"><button type="button">−</button><span>100%</span><button type="button">＋</button><button type="button"><Layers3 size={16} /></button></div>
        </header>
        <div className="engineering-canvas">
          <div className="ruler-top">−6　　　　　−4　　　　　−2　　　　　 0　　　　　 2　　　　　 4　　　　　 6 mm</div>
          {selected?.footprint !== null && selected?.footprint !== undefined ? (
            <FootprintPreview footprint={selected.footprint} />
          ) : (
            <div className="empty-state large"><Box size={36} /><strong>这里会显示封装俯视图</strong><span>焊盘、丝印和外形可以在生成前确认</span></div>
          )}
          {selected?.footprint !== null && selected?.footprint !== undefined ? (
            <div className="canvas-legend"><span><i className="legend-pad" />铜焊盘</span><span><i className="legend-silk" />丝印</span><span><i className="legend-bound" />阻焊</span></div>
          ) : null}
        </div>
        <footer className="stage-footer">
          <div><span>ALLEGRO 库目录</span><strong><Folder size={14} />{settings.libraryDirectory}</strong></div>
          <div className="generation-side">
            <span>转换依据<br /><b>IPC-7352 · IPC-7525C</b></span>
            <button
              className="primary-button generate-main"
              type="button"
              disabled={readyCount === 0 || running || allegroInstall === null}
              onClick={() => void generateSelected()}
              data-testid="generate-button"
            >
              {running ? <LoaderCircle className="spin" size={17} /> : <Play size={17} fill="currentColor" />}
              {running
                ? "正在生成…"
                : allegroInstall === null
                  ? "未检测到 Allegro"
                  : retryCount > 0
                    ? "重新生成并验证"
                  : "生成并验证"}
            </button>
          </div>
        </footer>
      </section>

      <aside className="right-rail">
        <div className="inspector-header"><h2>检查结果</h2><span>{selectedPlan === null ? "等待数据" : `${selectedPlan.checks.filter((item) => item.severity === "pass").length} 通过`}</span></div>
        {selectedPlan === null || selected?.footprint === null ? (
          <div className="empty-state detail-empty"><Sparkles size={28} /><strong>等待器件数据</strong><span>读取完成后会列出检查结果</span></div>
        ) : (
          <div className="inspector-scroll">
            <section className="inspector-section">
              <h3>器件信息 <ChevronRight size={15} /></h3>
              <dl className="facts">
                <div><dt>立创编号</dt><dd>{selected.footprint.info.lcscId}</dd></div>
                <div><dt>制造商型号</dt><dd>{selected.footprint.info.manufacturerPartNumber || selected.footprint.info.name}</dd></div>
                <div><dt>原始封装</dt><dd>{selected.footprint.info.sourcePackageName}</dd></div>
                <div><dt>目标名称</dt><dd>{selected.footprint.info.targetPackageName}</dd></div>
              </dl>
            </section>
            <section className="inspector-section">
              <h3>自动检查 <ChevronRight size={15} /></h3>
              <div className="check-list">
                {selectedPlan.checks.map((item) => (
                  <div className="check-item" key={item.id}>
                    {item.severity === "warning" ? <TriangleAlert size={16} className="warning-icon" /> : <Check size={16} className="green-icon" />}
                    <div><strong>{item.label}</strong><span>{item.detail}</span></div>
                  </div>
                ))}
              </div>
            </section>
            <section className="inspector-section">
              <h3>图层显示 <ChevronRight size={15} /></h3>
              <div className="layer-list">
                <label><input type="checkbox" defaultChecked /><i className="copper" />铜焊盘 <span>{selected.footprint.pads.length}</span></label>
                <label><input type="checkbox" defaultChecked /><i className="silk" />顶层丝印 <span>{selected.footprint.lines.length}</span></label>
                <label><input type="checkbox" defaultChecked /><i className="mask" />阻焊开窗 <span>{selected.footprint.pads.length}</span></label>
                <label><input type="checkbox" defaultChecked /><i className="paste" />钢网开口 <span>{selected.footprint.pads.filter((pad) => pad.holeWidth === 0).length}</span></label>
                <label><input type="checkbox" defaultChecked /><i className="bound" />装配外形 <span>1</span></label>
              </div>
            </section>
            <section className="inspector-section model-section">
              <h3>三维模型 <ChevronRight size={15} /></h3>
              <div className="model-row"><Check size={15} />{selected.footprint.model3d?.name ?? "源数据未提供模型"}</div>
            </section>
          </div>
        )}
      </aside>
    </main>
    {progress !== null ? (
      <GenerationProgressDialog
        progress={progress}
        onClose={() => setProgress(null)}
        onOpenDirectory={api.openPath}
      />
    ) : null}
    </>
  );
};

const HistoryPage = ({
  history,
  settings,
}: {
  readonly history: readonly HistoryEntry[];
  readonly settings: AppSettings;
}): ReactElement => (
  <main className="page">
    <header className="page-heading">
      <div>
        <p className="eyebrow">转换记录</p>
        <h1>最近生成的封装</h1>
        <p>查看结果，也可以直接打开封装库目录。</p>
      </div>
      <button className="secondary-button" type="button" onClick={() => void api.openPath(settings.libraryDirectory)}>
        <FolderOpen size={17} />打开库目录
      </button>
    </header>
    <section className="history-card panel">
      {history.length === 0 ? (
        <div className="empty-state history-empty">
          <History size={34} />
          <strong>还没有转换记录</strong>
          <span>生成成功后会自动保存在这里</span>
        </div>
      ) : (
        history.map((entry) => (
          <div className="history-row" key={entry.id}>
            <div className="history-status"><Check size={18} /></div>
            <div className="history-main">
              <strong>{entry.lcscId}</strong>
              <span>{entry.targetPackageName}</span>
            </div>
            <span className="file-count">{entry.files.length} 个文件</span>
            <span className="history-time"><Clock3 size={14} />{formatDate(entry.completedAt)}</span>
            <button type="button" className="quiet-button" aria-label={`查看 ${entry.lcscId}`}>
              <ChevronRight size={18} />
            </button>
          </div>
        ))
      )}
    </section>
  </main>
);

const SettingsPage = ({
  settings,
  installs,
  onInstallDetected,
  onSave,
}: {
  readonly settings: AppSettings;
  readonly installs: readonly AllegroInstall[];
  readonly onInstallDetected: (install: AllegroInstall) => void;
  readonly onSave: (settings: AppSettings) => Promise<void>;
}): ReactElement => {
  const [draft, setDraft] = useState(settings);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const selectedInstall =
    (draft.allegroExecutablePath === null
      ? installs.find((install) => install.version === draft.allegroVersion)
      : installs.find(
          (install) =>
            install.version === draft.allegroVersion &&
            install.executablePath.toLowerCase() ===
              draft.allegroExecutablePath?.toLowerCase(),
        )) ?? null;
  const choose = async (): Promise<void> => {
    const selected = await api.chooseLibraryDirectory();
    if (selected !== null) {
      setDraft({ ...draft, libraryDirectory: selected });
    }
  };
  const chooseExecutable = async (): Promise<void> => {
    setError(null);
    try {
      const install = await api.chooseAllegroExecutable();
      if (install !== null) {
        onInstallDetected(install);
        setDraft({
          ...draft,
          allegroVersion: install.version,
          allegroExecutablePath: install.executablePath,
        });
      }
    } catch (chooseError) {
      setError(errorMessage(chooseError));
    }
  };
  const save = async (): Promise<void> => {
    setError(null);
    try {
      await onSave({ ...draft, setupCompleted: true });
      setSaved(true);
      window.setTimeout(() => setSaved(false), 1800);
    } catch (saveError) {
      setError(errorMessage(saveError));
    }
  };
  return (
    <main className="page narrow-page">
      <header className="page-heading">
        <div>
          <p className="eyebrow">设置</p>
          <h1>Allegro 与库目录</h1>
          <p>通常只需在第一次使用时确认。</p>
        </div>
      </header>
      <section className="settings-card panel">
        <div className="setting-section">
          <div className="setting-icon"><Zap size={21} /></div>
          <div className="setting-content">
            <label htmlFor="allegro-version">Allegro 版本</label>
            <p>选择电脑上已经安装的版本。</p>
            <select
              id="allegro-version"
              value={draft.allegroVersion}
              onChange={(event) => {
                setDraft({
                  ...draft,
                  allegroVersion: event.target.value as AllegroVersion,
                  allegroExecutablePath: null,
                });
                setSaved(false);
              }}
            >
              {AllegroVersionOptions.map((option) => (
                <option value={option.value} key={option.value}>
                  {option.label}
                  {installs.some((install) => install.version === option.value)
                    ? "（已检测）"
                    : ""}
                </option>
              ))}
            </select>
            <div className={`detection-card ${selectedInstall === null ? "missing" : ""}`}>
              {selectedInstall === null ? (
                <>
                  <TriangleAlert size={18} />
                  <div>
                    <strong>未检测到 Allegro {draft.allegroVersion}</strong>
                    <span>请确认版本，或选择实际的 allegro.exe</span>
                  </div>
                </>
              ) : (
                <>
                  <Check size={18} />
                  <div>
                    <strong>已检测 Allegro {selectedInstall.version}</strong>
                    <span>{selectedInstall.executablePath}</span>
                  </div>
                </>
              )}
              <button
                type="button"
                className="secondary-button"
                onClick={() => void chooseExecutable()}
                data-testid="choose-allegro-executable"
              >
                手动选择
              </button>
            </div>
          </div>
        </div>
        <div className="setting-section">
          <div className="setting-icon"><LibraryBig size={21} /></div>
          <div className="setting-content">
            <label htmlFor="library-directory">封装库目录</label>
            <p>生成的封装、焊盘和转换记录会分类保存在此目录。</p>
            <div className="directory-row">
              <input
                id="library-directory"
                value={draft.libraryDirectory}
                onChange={(event) => setDraft({ ...draft, libraryDirectory: event.target.value })}
              />
              <button type="button" className="icon-button" onClick={() => void choose()} aria-label="选择库目录">
                <FolderOpen size={18} />
              </button>
            </div>
          </div>
        </div>
        <div className="settings-actions">
          <span className={error === null ? "" : "settings-error"}>
            {error ?? (saved ? "已保存" : "")}
          </span>
          <button
            className="primary-button"
            type="button"
            onClick={() => void save()}
            disabled={
              selectedInstall === null || draft.libraryDirectory.trim().length === 0
            }
            data-testid="save-settings"
          >
            <Check size={17} />保存设置
          </button>
        </div>
      </section>
    </main>
  );
};

export const App = (): ReactElement => {
  const [page, setPage] = useState<Page>("convert");
  const [settings, setSettings] = useState<AppSettings>(emptySettings);
  const [queue, setQueue] = useState<readonly QueueItem[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [history, setHistory] = useState<readonly HistoryEntry[]>([]);
  const [installs, setInstalls] = useState<readonly AllegroInstall[]>([]);
  const [ready, setReady] = useState(false);
  const [fatalError, setFatalError] = useState<string | null>(null);

  useEffect(() => {
    Promise.all([api.getSettings(), api.getHistory(), api.detectAllegro()])
      .then(([loadedSettings, loadedHistory, detectedInstalls]) => {
        setSettings(loadedSettings);
        setHistory(loadedHistory);
        setInstalls(detectedInstalls);
        setReady(true);
      })
      .catch((error: unknown) => {
        setFatalError(errorMessage(error));
        setReady(true);
      });
  }, []);

  const selectedReady = useMemo(
    () => queue.filter((item) => item.selected && item.state !== "error").length,
    [queue],
  );
  const activeInstall = useMemo(
    () =>
      (settings.allegroExecutablePath === null
        ? installs.find((install) => install.version === settings.allegroVersion)
        : installs.find(
            (install) =>
              install.version === settings.allegroVersion &&
              install.executablePath.toLowerCase() ===
                settings.allegroExecutablePath?.toLowerCase(),
          )) ?? null,
    [installs, settings.allegroExecutablePath, settings.allegroVersion],
  );
  const addInstall = (install: AllegroInstall): void => {
    setInstalls((current) => [
      install,
      ...current.filter(
        (candidate) =>
          candidate.executablePath.toLowerCase() !== install.executablePath.toLowerCase(),
      ),
    ]);
  };
  const saveSettings = async (nextSettings: AppSettings): Promise<void> => {
    const saved = await api.saveSettings(nextSettings);
    setSettings(saved);
    setInstalls(await api.detectAllegro());
  };
  if (!ready) {
    return (
      <div className="app-loading">
        <div className="brand-mark small"><Zap size={21} /></div>
        <LoaderCircle className="spin" size={24} />
      </div>
    );
  }
  if (fatalError !== null) {
    return (
      <div className="fatal-card">
        <TriangleAlert size={28} />
        <h1>软件启动失败</h1>
        <p>{fatalError}</p>
        <button type="button" className="secondary-button" onClick={() => window.location.reload()}>
          <RotateCcw size={17} />重新载入
        </button>
      </div>
    );
  }
  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="brand">
          <div className="brand-mark"><span className="brand-trace" /></div>
          <div className="brand-copy"><strong>Easy2ALG</strong><span>封装转换与检查</span></div>
        </div>
        <div className="top-actions">
          <button className="top-action" type="button" onClick={() => setPage("history")} data-testid="nav-history">
            <History size={17} />转换记录
          </button>
          <button className="top-action" type="button" onClick={() => setPage("settings")} data-testid="nav-settings">
            <Settings size={17} />设置
          </button>
          <button className="top-action" type="button">
            <CircleHelp size={17} />帮助
          </button>
          {page !== "convert" ? (
            <button className="top-action back-action" type="button" onClick={() => setPage("convert")} data-testid="nav-convert">
              <ChevronRight className="back-icon" size={17} />返回转换
            </button>
          ) : null}
        </div>
      </header>
      {page === "convert" ? (
        <ConverterPage
          settings={settings}
          allegroInstall={activeInstall}
          queue={queue}
          setQueue={setQueue}
          selectedId={selectedId}
          setSelectedId={setSelectedId}
          onGenerated={(entry) => setHistory((current) => [entry, ...current])}
        />
      ) : page === "history" ? (
        <HistoryPage history={history} settings={settings} />
      ) : (
        <SettingsPage
          settings={settings}
          installs={installs}
          onInstallDetected={addInstall}
          onSave={saveSettings}
        />
      )}
      <footer className="statusbar">
        <span title={activeInstall?.executablePath}>
          Allegro {activeInstall?.version ?? settings.allegroVersion}
        </span>
        <i className={activeInstall === null ? "missing" : ""} />
        <span>{activeInstall === null ? "未检测到" : "已检测"}</span>
        <span>规则库 1.0</span>
        <span className="status-spacer" />
        <span>{selectedReady} 个器件已选择</span>
        <span>UTF-8</span>
      </footer>
      {!settings.setupCompleted || activeInstall === null ? (
        <SetupDialog
          initial={settings}
          installs={installs}
          onInstallDetected={addInstall}
          onSave={saveSettings}
        />
      ) : null}
    </div>
  );
};
