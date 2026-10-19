import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { Notify } from "../hooks/useFiles";
import { listen } from "@tauri-apps/api/event";
import { getVersion } from "@tauri-apps/api/app";
import { openUrl } from "@tauri-apps/plugin-opener";
import { confirm } from "@tauri-apps/plugin-dialog";
import { check, type Update } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import { UsbFormatCard } from "../components/UsbFormatCard";
import {
  AlertTriangle,
  Boxes,
  CheckCircle2,
  Download,
  ExternalLink,
  FileAudio,
  Layers,
  Loader2,
  Music2,
  Play,
  RefreshCw,
  RotateCw,
  Server,
  Sparkles,
  Trash2,
  XCircle,
} from "lucide-react";
import type {
  ComponentProgress,
  DemucsInfo,
  FfmpegInfo,
  FfmpegInstallProgress,
  OllamaInfo,
  OllamaStatus,
  YtDlpInfo,
} from "../types";
import { formatBytes } from "../types";
import { Badge, Button, Card, cn, inputClass } from "../components/ui";

interface Props {
  ollamaUrl: string;
  notify: Notify;
  onOllamaChanged: () => void;
  onFfmpegChanged: () => void;
}

/** Solid general-purpose models that fit typical desktop hardware. */
const RECOMMENDED_MODELS = [
  "qwen2.5:7b",
  "llama3.1:8b",
  "gemma2:9b",
  "qwen2.5:14b",
  "deepseek-r1:14b",
];

function ProgressBar({ value }: { value: number | null }) {
  return (
    <div className="h-1.5 w-full overflow-hidden rounded-full bg-secondary">
      <div
        className={cn("h-full rounded-full bg-primary transition-all", value === null && "w-1/3 animate-pulse")}
        style={value === null ? undefined : { width: `${Math.round(value * 100)}%` }}
      />
    </div>
  );
}

/** Maps opaque Tauri updater errors to a plain-language explanation, with the raw error kept for debugging. */
function describeUpdateError(e: unknown): string {
  const raw = e instanceof Error ? e.message : String(e);
  const lower = raw.toLowerCase();
  let hint: string;
  if (lower.includes("error sending request") || lower.includes("dns") || lower.includes("network")) {
    hint = "Could not reach the update server — check your internet connection.";
  } else if (lower.includes("404") || lower.includes("not found")) {
    hint = "No update endpoint found — a release may not be published yet.";
  } else if (lower.includes("signature")) {
    hint = "The update failed signature verification — it may be corrupted or tampered with.";
  } else if (lower.includes("json") || lower.includes("parse") || lower.includes("deserialize")) {
    hint = "The update server returned an unexpected response.";
  } else {
    hint = "Update check failed.";
  }
  return `${hint} (${raw})`;
}

function InfoTile({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg bg-secondary/50 px-3 py-2">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="truncate font-mono text-sm font-medium" title={value}>
        {value}
      </div>
    </div>
  );
}

export function ComponentsPage({ ollamaUrl, notify, onOllamaChanged, onFfmpegChanged }: Props) {
  const [info, setInfo] = useState<OllamaInfo | null>(null);
  const [demucs, setDemucs] = useState<DemucsInfo | null>(null);
  const [demucsInstalling, setDemucsInstalling] = useState(false);
  const [demucsLog, setDemucsLog] = useState("");
  const [ffmpeg, setFfmpeg] = useState<FfmpegInfo | null>(null);
  const [ffmpegInstalling, setFfmpegInstalling] = useState(false);
  const [ffmpegProgress, setFfmpegProgress] = useState<FfmpegInstallProgress | null>(null);
  const [ytdlp, setYtdlp] = useState<YtDlpInfo | null>(null);
  const [ytdlpInstalling, setYtdlpInstalling] = useState(false);
  const [ytdlpProgress, setYtdlpProgress] = useState<{ downloaded: number; total: number } | null>(null);
  const isWindows = navigator.userAgent.includes("Windows");
  const [models, setModels] = useState<string[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [installing, setInstalling] = useState(false);
  const [starting, setStarting] = useState(false);
  const [pulling, setPulling] = useState(false);
  const [pullName, setPullName] = useState("");
  const [deletingModel, setDeletingModel] = useState<string | null>(null);
  const [progress, setProgress] = useState<ComponentProgress | null>(null);
  const pollTimer = useRef<number | null>(null);

  const [appVersion, setAppVersion] = useState<string | null>(null);
  const [checkingUpdate, setCheckingUpdate] = useState(false);
  const [update, setUpdate] = useState<Update | null>(null);
  const [updateChecked, setUpdateChecked] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const [downloadProgress, setDownloadProgress] = useState<{ done: number; total: number } | null>(
    null,
  );
  const [installed, setInstalled] = useState(false);

  useEffect(() => {
    getVersion().then(setAppVersion).catch(() => setAppVersion(null));
  }, []);

  const checkForUpdate = async () => {
    setCheckingUpdate(true);
    try {
      const result = await check();
      setUpdate(result);
      setUpdateChecked(true);
      if (!result) notify("You're on the latest version", "success");
    } catch (e) {
      notify(describeUpdateError(e), "error");
    } finally {
      setCheckingUpdate(false);
    }
  };

  const installUpdate = async () => {
    if (!update) return;
    setDownloading(true);
    setDownloadProgress(null);
    try {
      let total = 0;
      let done = 0;
      await update.downloadAndInstall((event) => {
        if (event.event === "Started") {
          total = event.data.contentLength ?? 0;
          setDownloadProgress({ done: 0, total });
        } else if (event.event === "Progress") {
          done += event.data.chunkLength;
          setDownloadProgress({ done, total });
        }
      });
      setInstalled(true);
      notify(`Version ${update.version} installed — restart to apply`, "success");
    } catch (e) {
      notify(`Update failed: ${describeUpdateError(e)}`, "error");
    } finally {
      setDownloading(false);
    }
  };

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const i = await invoke<OllamaInfo>("ollama_info", { url: ollamaUrl });
      setInfo(i);
      if (i.running) {
        const status = await invoke<OllamaStatus>("check_ollama", { url: ollamaUrl });
        setModels(status.models);
      } else {
        setModels(null);
      }
      onOllamaChanged();
      return i;
    } catch (e) {
      notify(String(e), "error");
      return null;
    } finally {
      setLoading(false);
    }
  }, [ollamaUrl, notify, onOllamaChanged]);

  const refreshDemucs = useCallback(async () => {
    try {
      setDemucs(await invoke<DemucsInfo>("demucs_info"));
    } catch (e) {
      notify(String(e), "error");
    }
  }, [notify]);

  const installDemucs = async () => {
    setDemucsInstalling(true);
    setDemucsLog("");
    try {
      await invoke("install_demucs");
      notify("Demucs installed", "success");
      await refreshDemucs();
    } catch (e) {
      notify(String(e), "error");
    } finally {
      setDemucsInstalling(false);
    }
  };

  const refreshFfmpeg = useCallback(async () => {
    try {
      setFfmpeg(await invoke<FfmpegInfo>("ffmpeg_info"));
    } catch {
      setFfmpeg({ installed: false, managed: false });
    }
    onFfmpegChanged();
  }, [onFfmpegChanged]);

  const installFfmpeg = async () => {
    setFfmpegInstalling(true);
    setFfmpegProgress(null);
    try {
      await invoke("install_ffmpeg");
      notify("FFmpeg installed", "success");
      await refreshFfmpeg();
    } catch (e) {
      notify(String(e), "error");
    } finally {
      setFfmpegInstalling(false);
      setFfmpegProgress(null);
    }
  };

  const refreshYtdlp = useCallback(async () => {
    try {
      setYtdlp(await invoke<YtDlpInfo>("ytdlp_info"));
    } catch (e) {
      notify(String(e), "error");
    }
  }, [notify]);

  const installYtdlp = async () => {
    setYtdlpInstalling(true);
    setYtdlpProgress(null);
    try {
      await invoke("install_ytdlp");
      notify("yt-dlp installed", "success");
      await refreshYtdlp();
    } catch (e) {
      notify(String(e), "error");
    } finally {
      setYtdlpInstalling(false);
      setYtdlpProgress(null);
    }
  };

  useEffect(() => {
    refresh();
    refreshFfmpeg();
    refreshDemucs();
    refreshYtdlp();
    const unlisten = listen<ComponentProgress>("component-progress", (e) => {
      setProgress(e.payload);
    });
    const unlistenDemucs = listen<{ phase: string; line: string }>(
      "demucs-install-progress",
      (e) => {
        const text = String(e.payload.line ?? "").split("\r").pop()?.trim() ?? "";
        if (text) setDemucsLog(text);
      },
    );
    const unlistenFfmpeg = listen<FfmpegInstallProgress>("ffmpeg-install-progress", (e) => {
      setFfmpegProgress(e.payload);
    });
    const unlistenYtdlp = listen<{ phase: string; downloaded: number; total: number }>(
      "ytdlp-install-progress",
      (e) => setYtdlpProgress(e.payload),
    );
    return () => {
      unlisten.then((fn) => fn());
      unlistenDemucs.then((fn) => fn());
      unlistenFfmpeg.then((fn) => fn());
      unlistenYtdlp.then((fn) => fn());
      if (pollTimer.current) window.clearTimeout(pollTimer.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** Polls until the server comes up (e.g. while the installer runs). */
  const pollUntilRunning = (attempts: number) => {
    if (pollTimer.current) window.clearTimeout(pollTimer.current);
    if (attempts <= 0) return;
    pollTimer.current = window.setTimeout(async () => {
      const i = await refresh();
      if (!i?.running) pollUntilRunning(attempts - 1);
    }, 3000);
  };

  const install = async () => {
    setInstalling(true);
    setProgress(null);
    try {
      await invoke("install_ollama");
      notify("Installer launched — follow the setup wizard", "success");
      pollUntilRunning(60);
    } catch (e) {
      notify(String(e), "error");
    } finally {
      setInstalling(false);
      setProgress(null);
    }
  };

  const start = async () => {
    setStarting(true);
    try {
      await invoke("start_ollama");
      pollUntilRunning(10);
    } catch (e) {
      notify(String(e), "error");
      setStarting(false);
    }
  };

  useEffect(() => {
    if (info?.running) setStarting(false);
  }, [info?.running]);

  const pull = async (model: string) => {
    const name = model.trim();
    if (!name) return;
    setPulling(true);
    setProgress(null);
    try {
      await invoke("pull_model", { url: ollamaUrl, model: name });
      notify(`Model ${name} installed`, "success");
      setPullName("");
      await refresh();
    } catch (e) {
      notify(`Could not pull ${name}: ${e}`, "error");
    } finally {
      setPulling(false);
      setProgress(null);
    }
  };

  const deleteModel = async (name: string) => {
    const ok = await confirm(`Delete model "${name}"? You'll need to pull it again to use it.`, {
      title: "Delete Model",
      kind: "warning",
    });
    if (!ok) return;
    setDeletingModel(name);
    try {
      await invoke("delete_model", { url: ollamaUrl, model: name });
      notify(`Model ${name} deleted`, "success");
      await refresh();
    } catch (e) {
      notify(`Could not delete ${name}: ${e}`, "error");
    } finally {
      setDeletingModel(null);
    }
  };

  const ollamaProgress = progress?.component === "ollama" ? progress : null;
  const modelProgress = progress?.component === "model" ? progress : null;

  return (
    <div className="mx-auto max-w-3xl space-y-4 p-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold">Components</h1>
          <p className="text-sm text-muted-foreground">
            Optional tools — Ollama powers AI Clean, FFmpeg powers Convert, Demucs powers Stems
          </p>
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={() => {
            void refresh();
            void refreshFfmpeg();
          }}
          disabled={loading}
        >
          <RefreshCw className={loading ? "animate-spin" : ""} />
          Refresh
        </Button>
      </div>

      <UsbFormatCard notify={notify} />

      {/* Vatra Wave (the app) itself */}
      <Card className="p-5">
        <div className="flex items-start justify-between gap-4">
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-secondary">
              <Sparkles className="h-5 w-5 text-muted-foreground" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <span className="font-semibold">Vatra Wave</span>
                <Badge className="bg-secondary">v{appVersion ?? "…"}</Badge>
                {update && (
                  <Badge className="gap-1 bg-primary/15 text-primary">
                    <CheckCircle2 className="h-3 w-3" /> v{update.version} available
                  </Badge>
                )}
              </div>
              <button
                onClick={() => void openUrl("https://github.com/sergioalexo/music-tag-cleaner/releases")}
                className="mt-0.5 flex items-center gap-1 text-xs text-muted-foreground hover:text-primary"
              >
                Release notes <ExternalLink className="h-3 w-3" />
              </button>
              <div className="mt-0.5 text-[11px] text-muted-foreground">Formerly Music Tag Cleaner</div>
            </div>
          </div>

          <div className="flex shrink-0 gap-2">
            {installed ? (
              <Button size="sm" onClick={() => void relaunch()}>
                <RefreshCw />
                Restart to Apply
              </Button>
            ) : update ? (
              <Button size="sm" onClick={installUpdate} disabled={downloading}>
                {downloading ? <Loader2 className="animate-spin" /> : <Download />}
                {downloading ? "Installing…" : `Install v${update.version}`}
              </Button>
            ) : (
              <Button
                variant="secondary"
                size="sm"
                onClick={checkForUpdate}
                disabled={checkingUpdate}
              >
                <RotateCw className={checkingUpdate ? "animate-spin" : ""} />
                {checkingUpdate ? "Checking…" : "Check for Updates"}
              </Button>
            )}
          </div>
        </div>

        {updateChecked && !update && !checkingUpdate && (
          <p className="mt-3 text-xs text-muted-foreground">
            You're running the latest version.
          </p>
        )}

        {update?.body && (
          <p className="mt-3 whitespace-pre-wrap rounded-md bg-secondary/50 p-3 text-xs text-muted-foreground">
            {update.body}
          </p>
        )}

        {downloading && (
          <div className="mt-3">
            <ProgressBar
              value={
                downloadProgress && downloadProgress.total > 0
                  ? downloadProgress.done / downloadProgress.total
                  : null
              }
            />
            <div className="mt-1 text-xs text-muted-foreground">
              {downloadProgress && downloadProgress.total > 0
                ? `Downloading ${formatBytes(downloadProgress.done)} / ${formatBytes(downloadProgress.total)}`
                : "Downloading update…"}
            </div>
          </div>
        )}
      </Card>

      {/* Ollama runtime */}
      <Card className="p-5">
        <div className="flex items-start justify-between gap-4">
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-secondary">
              <Server className="h-5 w-5 text-muted-foreground" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <span className="font-semibold">Ollama</span>
                {info === null ? (
                  <Badge>…</Badge>
                ) : info.running ? (
                  <Badge className="gap-1 bg-primary/15 text-primary">
                    <CheckCircle2 className="h-3 w-3" /> Running
                  </Badge>
                ) : info.installed ? (
                  <Badge className="gap-1 bg-secondary text-amber-500">
                    <XCircle className="h-3 w-3" /> Not running
                  </Badge>
                ) : (
                  <Badge className="gap-1 bg-destructive/15 text-destructive">
                    <XCircle className="h-3 w-3" /> Not installed
                  </Badge>
                )}
              </div>
              <button
                onClick={() => void openUrl("https://ollama.com")}
                className="mt-0.5 flex items-center gap-1 text-xs text-muted-foreground hover:text-primary"
              >
                ollama.com <ExternalLink className="h-3 w-3" />
              </button>
            </div>
          </div>

          <div className="flex shrink-0 gap-2">
            {info && !info.installed && (
              <Button size="sm" onClick={install} disabled={installing}>
                {installing ? <Loader2 className="animate-spin" /> : <Download />}
                Install
              </Button>
            )}
            {info && info.installed && !info.running && (
              <Button size="sm" onClick={start} disabled={starting}>
                {starting ? <Loader2 className="animate-spin" /> : <Play />}
                Start Ollama
              </Button>
            )}
          </div>
        </div>

        <div className="mt-4 grid grid-cols-2 gap-3 text-sm">
          <InfoTile label="Server version" value={info?.serverVersion ?? "—"} />
          <InfoTile label="Install path" value={info?.installPath ?? "—"} />
        </div>

        {installing && (
          <div className="mt-3">
            <ProgressBar
              value={
                ollamaProgress && ollamaProgress.total > 0
                  ? ollamaProgress.downloaded / ollamaProgress.total
                  : null
              }
            />
            <div className="mt-1 text-xs text-muted-foreground">
              {ollamaProgress?.phase === "launching"
                ? "Launching installer — follow the setup wizard"
                : `Downloading installer ${formatBytes(ollamaProgress?.downloaded ?? 0)}${
                    ollamaProgress && ollamaProgress.total > 0
                      ? ` / ${formatBytes(ollamaProgress.total)}`
                      : ""
                  }`}
            </div>
          </div>
        )}
      </Card>

      {/* FFmpeg — used by Convert */}
      <Card className="p-5">
        <div className="flex items-start justify-between gap-4">
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-secondary">
              <FileAudio className="h-5 w-5 text-muted-foreground" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <span className="font-semibold">FFmpeg</span>
                {ffmpeg === null ? (
                  <Badge>…</Badge>
                ) : ffmpeg.installed ? (
                  <Badge className="gap-1 bg-primary/15 text-primary">
                    <CheckCircle2 className="h-3 w-3" />
                    {ffmpeg.managed ? "Installed" : "On PATH"}
                  </Badge>
                ) : (
                  <Badge className="gap-1 bg-destructive/15 text-destructive">
                    <XCircle className="h-3 w-3" /> Not installed
                  </Badge>
                )}
              </div>
              <button
                onClick={() =>
                  void openUrl("https://github.com/BtbN/FFmpeg-Builds/releases")
                }
                className="mt-0.5 flex items-center gap-1 text-xs text-muted-foreground hover:text-primary"
              >
                Static builds (BtbN) <ExternalLink className="h-3 w-3" />
              </button>
            </div>
          </div>

          <div className="flex shrink-0 gap-2">
            {ffmpeg && !ffmpeg.installed && (
              <Button size="sm" onClick={installFfmpeg} disabled={ffmpegInstalling}>
                {ffmpegInstalling ? <Loader2 className="animate-spin" /> : <Download />}
                Install
              </Button>
            )}
          </div>
        </div>

        <p className="mt-3 text-xs text-muted-foreground">
          Used by <span className="font-medium">Convert</span> to transcode between formats (MP3,
          FLAC, ALAC, AAC, WAV, AIFF, Ogg, Opus). Not needed for tag editing.
          {ffmpeg && !ffmpeg.installed && !isWindows && (
            <> Install it with <span className="font-mono">brew install ffmpeg</span> (macOS) or your
            package manager — it's detected automatically.</>
          )}
        </p>

        <div className="mt-4 grid grid-cols-2 gap-3 text-sm">
          <InfoTile label="Version" value={ffmpeg?.version ?? "—"} />
          <InfoTile label="Path" value={ffmpeg?.ffmpegPath ?? "—"} />
        </div>

        {ffmpegInstalling && (
          <div className="mt-3">
            <ProgressBar
              value={
                ffmpegProgress && ffmpegProgress.total > 0 && ffmpegProgress.phase === "downloading"
                  ? ffmpegProgress.downloaded / ffmpegProgress.total
                  : null
              }
            />
            <div className="mt-1 text-xs text-muted-foreground">
              {ffmpegProgress?.phase === "extracting"
                ? "Extracting…"
                : `Downloading ${formatBytes(ffmpegProgress?.downloaded ?? 0)}${
                    ffmpegProgress && ffmpegProgress.total > 0
                      ? ` / ${formatBytes(ffmpegProgress.total)}`
                      : ""
                  }`}
            </div>
          </div>
        )}
      </Card>

      {/* yt-dlp — used by YouTube Music Import */}
      <Card className="p-5">
        <div className="flex items-start justify-between gap-4">
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-secondary">
              <Music2 className="h-5 w-5 text-muted-foreground" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <span className="font-semibold">yt-dlp</span>
                {ytdlp === null ? (
                  <Badge>…</Badge>
                ) : ytdlp.installed ? (
                  ytdlp.stale ? (
                    <Badge className="gap-1 bg-amber-500/15 text-amber-600 dark:text-amber-400">
                      <AlertTriangle className="h-3 w-3" /> Outdated
                    </Badge>
                  ) : (
                    <Badge className="gap-1 bg-primary/15 text-primary">
                      <CheckCircle2 className="h-3 w-3" /> Installed
                    </Badge>
                  )
                ) : (
                  <Badge className="gap-1 bg-destructive/15 text-destructive">
                    <XCircle className="h-3 w-3" /> Not installed
                  </Badge>
                )}
              </div>
              <button
                onClick={() => void openUrl("https://github.com/yt-dlp/yt-dlp")}
                className="mt-0.5 flex items-center gap-1 text-xs text-muted-foreground hover:text-primary"
              >
                yt-dlp/yt-dlp <ExternalLink className="h-3 w-3" />
              </button>
            </div>
          </div>

          <div className="flex shrink-0 gap-2">
            {ytdlp && (!ytdlp.installed || ytdlp.stale) && (
              <Button size="sm" onClick={installYtdlp} disabled={ytdlpInstalling}>
                {ytdlpInstalling ? <Loader2 className="animate-spin" /> : <Download />}
                {ytdlp.installed ? "Update" : "Install"}
              </Button>
            )}
          </div>
        </div>

        <p className="mt-3 text-xs text-muted-foreground">
          Powers <span className="font-medium">YouTube Music Import</span> — reads playlist and track
          metadata only, never downloads audio.
          {ytdlp?.stale && (
            <>
              {" "}
              Your copy is from {ytdlp.version?.slice(0, 7)} — YouTube often breaks old versions.
              Update it.
            </>
          )}
        </p>

        <div className="mt-4 grid grid-cols-2 gap-3 text-sm">
          <InfoTile label="Version" value={ytdlp?.version ?? "—"} />
          <InfoTile label="Path" value={ytdlp?.path ?? "—"} />
        </div>

        {ytdlpInstalling && (
          <div className="mt-3">
            <ProgressBar
              value={
                ytdlpProgress && ytdlpProgress.total > 0
                  ? ytdlpProgress.downloaded / ytdlpProgress.total
                  : null
              }
            />
            <div className="mt-1 text-xs text-muted-foreground">
              {`Downloading ${formatBytes(ytdlpProgress?.downloaded ?? 0)}${
                ytdlpProgress && ytdlpProgress.total > 0 ? ` / ${formatBytes(ytdlpProgress.total)}` : ""
              }`}
            </div>
          </div>
        )}
      </Card>

      {/* Demucs — used by Separate Stems */}
      <Card className="p-5">
        <div className="flex items-start justify-between gap-4">
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-secondary">
              <Layers className="h-5 w-5 text-muted-foreground" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <span className="font-semibold">Demucs</span>
                {demucs === null ? (
                  <Badge>…</Badge>
                ) : demucs.installed ? (
                  <Badge className="gap-1 bg-primary/15 text-primary">
                    <CheckCircle2 className="h-3 w-3" /> Installed
                  </Badge>
                ) : demucs.pythonFound ? (
                  <Badge className="gap-1 bg-amber-500/15 text-amber-600 dark:text-amber-400">
                    <XCircle className="h-3 w-3" /> Not installed
                  </Badge>
                ) : (
                  <Badge className="gap-1 bg-destructive/15 text-destructive">
                    <XCircle className="h-3 w-3" /> No Python
                  </Badge>
                )}
                {demucs?.installed && demucs.device === "cuda" && (
                  <Badge className="bg-secondary">GPU</Badge>
                )}
              </div>
              <button
                onClick={() => void openUrl("https://github.com/adefossez/demucs")}
                className="mt-0.5 flex items-center gap-1 text-xs text-muted-foreground hover:text-primary"
              >
                adefossez/demucs <ExternalLink className="h-3 w-3" />
              </button>
            </div>
          </div>

          <div className="flex shrink-0 gap-2">
            <Button variant="ghost" size="sm" onClick={refreshDemucs} disabled={demucsInstalling}>
              <RefreshCw />
            </Button>
            {demucs && !demucs.installed && demucs.pythonFound && (
              <Button size="sm" onClick={installDemucs} disabled={demucsInstalling}>
                {demucsInstalling ? <Loader2 className="animate-spin" /> : <Download />}
                {demucsInstalling ? "Installing…" : "Install"}
              </Button>
            )}
            {demucs && !demucs.pythonFound && (
              <Button size="sm" onClick={() => void openUrl("https://www.python.org/downloads/")}>
                <ExternalLink />
                Get Python
              </Button>
            )}
          </div>
        </div>

        <p className="mt-3 text-xs text-muted-foreground">
          Powers <span className="font-medium">Separate Stems</span> — splits a track into drums,
          bass, vocals and everything else, for acapellas, instrumentals and edits. Not needed for
          tag editing.
          {demucs && !demucs.pythonFound && (
            <>
              {" "}
              Demucs is a Python package (it pulls in PyTorch), so it needs Python 3.9+ installed
              first. On Windows, tick <span className="font-mono">Add python.exe to PATH</span> in
              the installer.
            </>
          )}
          {demucs?.installed && demucs.device !== "cuda" && (
            <>
              {" "}
              Running on CPU — separation works but takes minutes per track. A CUDA GPU with a
              matching PyTorch build is roughly ten times faster.
            </>
          )}
        </p>

        <div className="mt-4 grid grid-cols-2 gap-3 text-sm">
          <InfoTile label="Demucs" value={demucs?.demucsVersion ?? "—"} />
          <InfoTile label="PyTorch" value={demucs?.torchVersion ?? "—"} />
          <InfoTile
            label="Python"
            value={demucs?.pythonVersion ? `${demucs.pythonVersion} (${demucs.pythonPath})` : "—"}
          />
          <InfoTile
            label="Device"
            value={demucs?.device === "cuda" ? (demucs.gpuName ?? "CUDA GPU") : (demucs?.device ?? "—")}
          />
        </div>

        {demucsInstalling && (
          <div className="mt-3">
            <ProgressBar value={null} />
            <div className="mt-1 truncate text-xs text-muted-foreground" title={demucsLog}>
              {demucsLog || "Starting pip…"}
            </div>
          </div>
        )}
      </Card>

      {/* Models */}
      <Card className="p-5">
        <div className="flex items-start justify-between gap-4">
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-secondary">
              <Boxes className="h-5 w-5 text-muted-foreground" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <span className="font-semibold">AI Models</span>
                {models !== null && (
                  <Badge className="bg-secondary">
                    {models.length} installed
                  </Badge>
                )}
              </div>
              <div className="mt-0.5 text-xs text-muted-foreground">
                Used by AI Clean — pick one in Settings
              </div>
            </div>
          </div>
        </div>

        {!info?.running ? (
          <p className="mt-4 text-sm text-muted-foreground">
            Start Ollama to manage models.
          </p>
        ) : (
          <>
            {models && models.length > 0 && (
              <ul className="mt-4 space-y-1">
                {models.map((m) => (
                  <li
                    key={m}
                    className="flex items-center gap-2 rounded-lg bg-secondary/50 px-3 py-2 font-mono text-sm"
                  >
                    <CheckCircle2 className="h-3.5 w-3.5 text-primary" />
                    <span className="flex-1">{m}</span>
                    <button
                      onClick={() => deleteModel(m)}
                      disabled={deletingModel === m}
                      className="flex h-6 w-6 items-center justify-center rounded text-muted-foreground hover:bg-destructive/15 hover:text-destructive disabled:opacity-50"
                      title={`Delete ${m}`}
                    >
                      {deletingModel === m ? (
                        <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      ) : (
                        <Trash2 className="h-3.5 w-3.5" />
                      )}
                    </button>
                  </li>
                ))}
              </ul>
            )}
            {models && models.length === 0 && (
              <p className="mt-4 text-sm text-muted-foreground">
                No models installed yet — pull one below to enable AI Clean.
              </p>
            )}

            <div className="mt-4 flex gap-2">
              <input
                type="text"
                className={cn(inputClass, "flex-1")}
                list="recommended-models"
                placeholder="Model to pull, e.g. qwen2.5:7b"
                value={pullName}
                onChange={(e) => setPullName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !pulling) pull(pullName);
                }}
                disabled={pulling}
              />
              <datalist id="recommended-models">
                {RECOMMENDED_MODELS.filter((m) => !models?.includes(m)).map((m) => (
                  <option key={m} value={m} />
                ))}
              </datalist>
              <Button onClick={() => pull(pullName)} disabled={pulling || !pullName.trim()}>
                {pulling ? <Loader2 className="animate-spin" /> : <Download />}
                Pull
              </Button>
            </div>
            <div className="mt-2 flex flex-wrap gap-1.5">
              {RECOMMENDED_MODELS.filter((m) => !models?.includes(m)).map((m) => (
                <button
                  key={m}
                  className="rounded-md border px-2 py-0.5 font-mono text-[11px] text-muted-foreground transition-colors hover:border-primary hover:text-primary disabled:opacity-50"
                  onClick={() => setPullName(m)}
                  disabled={pulling}
                >
                  {m}
                </button>
              ))}
            </div>

            {pulling && (
              <div className="mt-3">
                <ProgressBar
                  value={
                    modelProgress && modelProgress.total > 0
                      ? modelProgress.downloaded / modelProgress.total
                      : null
                  }
                />
                <div className="mt-1 text-xs text-muted-foreground">
                  {modelProgress
                    ? `${modelProgress.phase}${
                        modelProgress.total > 0
                          ? ` — ${formatBytes(modelProgress.downloaded)} / ${formatBytes(modelProgress.total)}`
                          : ""
                      }`
                    : "Contacting Ollama…"}
                </div>
              </div>
            )}
          </>
        )}
      </Card>
    </div>
  );
}
