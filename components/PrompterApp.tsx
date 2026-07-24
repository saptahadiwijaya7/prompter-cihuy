"use client";

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  countWords,
  estimateSeconds,
  formatDuration,
  splitSegments,
  toParagraphs,
} from "@/lib/formatter";
import {
  DEFAULT_SETTINGS,
  extractDocId,
  fetchDocText,
  loadGasConfig,
  loadLastScript,
  loadPresets,
  loadSettings,
  loadUnlocked,
  Preset,
  PrompterSettings,
  saveGasConfig,
  saveLastScript,
  savePresets,
  saveSettings,
  saveUnlocked,
} from "@/lib/store";
import { APP_CONFIG, hasBuiltInConfig, hasRealtime, passwordOf } from "@/lib/config";
import { joinChannel, RealtimeHandle } from "@/lib/realtime";
import {
  generateRoomCode,
  hashText,
  pullManualText,
  pushText,
  RemoteCommand,
  tabletSync,
  TabletStatus,
} from "@/lib/remote";
import { loadRoom, saveRoom } from "@/lib/store";

type SyncStatus = "idle" | "ok" | "error" | "offline";
type SourceMode = "docs" | "manual";

const POLL_MS = 2500;

const CONTOH_NASKAH = `Selamat pagi semuanya.

Hari ini kita akan membahas Accurate, software akuntansi terbaik di Indonesia.

Harga promo bulan ini hanya Rp2.500.000, hemat 2,5 juta dari harga normal!

Tempel link Google Docs di panel kiri, lalu tekan Hubungkan. Selamat mencoba.`;

export default function PrompterApp() {
  // ── State inti ──
  const [settings, setSettings] = useState<PrompterSettings>(DEFAULT_SETTINGS);
  const [hydrated, setHydrated] = useState(false);

  const [sourceMode, setSourceMode] = useState<SourceMode>("docs");
  const [manualText, setManualText] = useState("");
  const [rawText, setRawText] = useState(CONTOH_NASKAH);

  const [connected, setConnected] = useState(false);
  const [syncStatus, setSyncStatus] = useState<SyncStatus>("idle");
  const [syncError, setSyncError] = useState("");
  const [lastSyncAt, setLastSyncAt] = useState<Date | null>(null);

  const [gasUrl, setGasUrl] = useState("");
  const [gasToken, setGasToken] = useState("");
  const [showConn, setShowConn] = useState(false);
  const builtIn = hasBuiltInConfig();
  const [unlocked, setUnlocked] = useState(false);
  const [passwordInput, setPasswordInput] = useState("");
  const [saveState, setSaveState] = useState<"idle" | "ok" | "fail">("idle");

  // Nilai koneksi efektif: pakai konfigurasi bawaan jika sudah di-unlock,
  // selain itu pakai input manual.
  const effGasUrl = builtIn && unlocked ? APP_CONFIG.gasUrl : gasUrl;
  const effGasToken = builtIn && unlocked ? APP_CONFIG.gasToken : gasToken;

  const [playing, setPlaying] = useState(false);
  const [countdown, setCountdown] = useState<number | null>(null);
  const [progress, setProgress] = useState(0);
  const [activeIdx, setActiveIdx] = useState(0);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [panelOpen, setPanelOpen] = useState(true);

  const [presets, setPresets] = useState<Preset[]>([]);
  const [presetName, setPresetName] = useState("");

  // ── Remote control (sisi tablet) ──
  const [remoteOn, setRemoteOn] = useState(false);
  const [roomCode, setRoomCode] = useState("");
  const settingsRef = useRef<PrompterSettings>(DEFAULT_SETTINGS);
  const progressRef = useRef(0);
  const kataRef = useRef(0);
  const durasiRef = useRef(0);
  const lastCmdSeqRef = useRef(0);
  const lastPlayNonceRef = useRef(0);
  const lastResetNonceRef = useRef(0);
  const lastJumpNonceRef = useRef(0);
  const lastDocNonceRef = useRef(0);
  const lastManualNonceRef = useRef(0);
  const connectedRef = useRef(false);
  const syncStatusRef = useRef<SyncStatus>("idle");
  const pushedVersionRef = useRef("");
  const remoteBusyRef = useRef(false);
  const rtRef = useRef<RealtimeHandle | null>(null);
  const [rtReady, setRtReady] = useState(false);

  // ── Refs untuk engine scroll ──
  const stageRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const wrapperRef = useRef<HTMLDivElement>(null);
  const posRef = useRef(0);
  const playingRef = useRef(false);
  const speedRef = useRef(DEFAULT_SETTINGS.speed);
  const rafRef = useRef<number>(0);
  const lastTsRef = useRef<number | null>(null);
  const activeIdxRef = useRef(0);
  const wakeLockRef = useRef<{ release: () => Promise<void> } | null>(null);
  const anchorRef = useRef<{ index: number; text: string; delta: number } | null>(null);
  const pollBusyRef = useRef(false);
  const [stageH, setStageH] = useState(600);

  const paragraphs = useMemo(() => toParagraphs(rawText), [rawText]);
  const durasi = useMemo(() => estimateSeconds(rawText), [rawText]);
  const kata = useMemo(() => countWords(rawText), [rawText]);

  // ── Hidrasi dari localStorage ──
  useEffect(() => {
    const s = loadSettings();
    setSettings(s);
    setPresets(loadPresets());
    const gas = loadGasConfig();
    setGasUrl(gas.url);
    setGasToken(gas.token);
    setUnlocked(loadUnlocked());
    const last = loadLastScript();
    if (last) setRawText(last);
    setRoomCode(loadRoom() || generateRoomCode());
    document.documentElement.classList.toggle("dark", s.theme === "dark");
    setHydrated(true);
  }, []);

  useEffect(() => {
    settingsRef.current = settings;
  }, [settings]);

  useEffect(() => {
    kataRef.current = kata;
    durasiRef.current = durasi;
  }, [kata, durasi]);

  useEffect(() => {
    connectedRef.current = connected;
    syncStatusRef.current = syncStatus;
  }, [connected, syncStatus]);

  useEffect(() => {
    if (hydrated && roomCode) saveRoom(roomCode);
  }, [roomCode, hydrated]);

  useEffect(() => {
    if (!hydrated) return;
    saveSettings(settings);
    document.documentElement.classList.toggle("dark", settings.theme === "dark");
  }, [settings, hydrated]);

  useEffect(() => {
    speedRef.current = settings.speed;
  }, [settings.speed]);

  const patch = useCallback((p: Partial<PrompterSettings>) => {
    setSettings((prev) => ({ ...prev, ...p }));
  }, []);

  // ── Ukuran stage (untuk padding atas/bawah) ──
  useEffect(() => {
    const el = stageRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setStageH(el.clientHeight));
    ro.observe(el);
    setStageH(el.clientHeight);
    return () => ro.disconnect();
  }, []);

  // ── Baris aktif + progress ──
  const readingY = useCallback(
    () => (stageRef.current ? (stageRef.current.clientHeight * settings.readLinePos) / 100 : 0),
    [settings.readLinePos]
  );

  const findActiveParagraph = useCallback((): number => {
    const stage = stageRef.current;
    const content = contentRef.current;
    if (!stage || !content) return 0;
    const y = stage.scrollTop + readingY();
    const nodes = content.querySelectorAll<HTMLElement>("[data-par]");
    for (let i = 0; i < nodes.length; i++) {
      const el = nodes[i];
      if (el.offsetTop <= y && y < el.offsetTop + el.offsetHeight) return i;
      if (el.offsetTop > y) return Math.max(0, i - 1);
    }
    return Math.max(0, nodes.length - 1);
  }, [readingY]);

  const refreshHud = useCallback(() => {
    const stage = stageRef.current;
    if (!stage) return;
    const max = Math.max(1, stage.scrollHeight - stage.clientHeight);
    const pct = Math.min(100, Math.max(0, Math.round((stage.scrollTop / max) * 100)));
    progressRef.current = pct;
    setProgress((prev) => (prev === pct ? prev : pct));
    const idx = findActiveParagraph();
    if (idx !== activeIdxRef.current) {
      activeIdxRef.current = idx;
      setActiveIdx(idx);
    }
  }, [findActiveParagraph]);

  // ── Engine scroll (requestAnimationFrame) ──
  const stopScroll = useCallback(() => {
    playingRef.current = false;
    setPlaying(false);
    lastTsRef.current = null;
  }, []);

  const tick = useCallback(
    (ts: number) => {
      const stage = stageRef.current;
      if (stage && playingRef.current) {
        if (lastTsRef.current !== null) {
          const dt = (ts - lastTsRef.current) / 1000;
          posRef.current = Math.min(
            posRef.current + speedRef.current * dt,
            stage.scrollHeight - stage.clientHeight
          );
          stage.scrollTop = posRef.current;
          if (posRef.current >= stage.scrollHeight - stage.clientHeight - 0.5) {
            stopScroll(); // jeda otomatis di akhir naskah
          }
        }
        lastTsRef.current = ts;
        refreshHud();
      }
      rafRef.current = requestAnimationFrame(tick);
    },
    [refreshHud, stopScroll]
  );

  useEffect(() => {
    rafRef.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafRef.current);
  }, [tick]);

  // ── Wake lock ──
  const requestWakeLock = useCallback(async () => {
    try {
      const nav = navigator as Navigator & {
        wakeLock?: { request: (t: "screen") => Promise<{ release: () => Promise<void> }> };
      };
      if (nav.wakeLock) {
        wakeLockRef.current = await nav.wakeLock.request("screen");
      }
    } catch {
      /* tidak didukung / ditolak — bukan masalah fatal */
    }
  }, []);

  const releaseWakeLock = useCallback(() => {
    wakeLockRef.current?.release().catch(() => {});
    wakeLockRef.current = null;
  }, []);

  useEffect(() => {
    const onVis = () => {
      if (document.visibilityState === "visible" && playingRef.current) {
        void requestWakeLock();
      }
    };
    document.addEventListener("visibilitychange", onVis);
    return () => document.removeEventListener("visibilitychange", onVis);
  }, [requestWakeLock]);

  // ── Play / pause / reset ──
  const startPlaying = useCallback(() => {
    const stage = stageRef.current;
    if (!stage) return;
    posRef.current = stage.scrollTop;
    lastTsRef.current = null;
    playingRef.current = true;
    setPlaying(true);
    void requestWakeLock();
  }, [requestWakeLock]);

  const pausePlaying = useCallback(() => {
    stopScroll();
    releaseWakeLock();
  }, [stopScroll, releaseWakeLock]);

  const startWithCountdown = useCallback(() => {
    if (playingRef.current || countdown !== null) return;
    let n = 3;
    setCountdown(n);
    const iv = setInterval(() => {
      n -= 1;
      if (n <= 0) {
        clearInterval(iv);
        setCountdown(null);
        startPlaying();
      } else {
        setCountdown(n);
      }
    }, 800);
  }, [countdown, startPlaying]);

  // Mulai memutar, dengan hitung mundur bila diaktifkan di setting.
  const beginPlay = useCallback(() => {
    if (settingsRef.current.useCountdown) startWithCountdown();
    else startPlaying();
  }, [startWithCountdown, startPlaying]);

  const togglePlay = useCallback(() => {
    if (countdown !== null) return;
    if (playingRef.current) pausePlaying();
    else startPlaying();
  }, [countdown, pausePlaying, startPlaying]);

  const resetScroll = useCallback(() => {
    pausePlaying();
    posRef.current = 0;
    if (stageRef.current) stageRef.current.scrollTop = 0;
    refreshHud();
  }, [pausePlaying, refreshHud]);

  // ── Update konten tanpa kehilangan posisi baca (anchor paragraf) ──
  const applyNewText = useCallback(
    (newRaw: string) => {
      const stage = stageRef.current;
      const content = contentRef.current;
      if (stage && content) {
        const idx = findActiveParagraph();
        const nodes = content.querySelectorAll<HTMLElement>("[data-par]");
        const el = nodes[idx];
        if (el) {
          anchorRef.current = {
            index: idx,
            text: el.textContent ?? "",
            delta: el.offsetTop - stage.scrollTop,
          };
        }
      }
      setRawText(newRaw);
      saveLastScript(newRaw);
    },
    [findActiveParagraph]
  );

  useLayoutEffect(() => {
    const anchor = anchorRef.current;
    const stage = stageRef.current;
    const content = contentRef.current;
    if (!anchor || !stage || !content) return;
    anchorRef.current = null;
    const nodes = content.querySelectorAll<HTMLElement>("[data-par]");
    if (nodes.length === 0) return;
    // cari paragraf dengan teks sama, mulai dari indeks lama melebar ke sekitarnya
    let target = Math.min(anchor.index, nodes.length - 1);
    for (let r = 0; r < nodes.length; r++) {
      const cand = [anchor.index - r, anchor.index + r];
      const hit = cand.find(
        (i) => i >= 0 && i < nodes.length && nodes[i].textContent === anchor.text
      );
      if (hit !== undefined) {
        target = hit;
        break;
      }
    }
    const newTop = Math.max(0, nodes[target].offsetTop - anchor.delta);
    stage.scrollTop = newTop;
    posRef.current = newTop;
    refreshHud();
  }, [paragraphs, refreshHud]);

  // ── Polling live sync ──
  const docId = useMemo(() => extractDocId(settings.docUrl), [settings.docUrl]);

  useEffect(() => {
    if (!connected || !docId || !effGasUrl) return;
    let stopped = false;
    const controller = new AbortController();

    const poll = async () => {
      if (pollBusyRef.current || stopped) return;
      pollBusyRef.current = true;
      try {
        const res = await fetchDocText(effGasUrl, docId, effGasToken, controller.signal);
        if (stopped) return;
        if (res.ok && typeof res.text === "string") {
          setSyncStatus("ok");
          setSyncError("");
          setLastSyncAt(new Date());
          setRawText((prev) => {
            if (prev !== res.text) {
              // gunakan anchor agar posisi baca tidak lompat
              queueMicrotask(() => applyNewText(res.text as string));
            }
            return prev;
          });
        } else {
          setSyncStatus(navigator.onLine ? "error" : "offline");
          setSyncError(res.error ?? "");
        }
      } catch {
        if (!stopped) {
          setSyncStatus(navigator.onLine ? "error" : "offline");
        }
      } finally {
        pollBusyRef.current = false;
      }
    };

    void poll();
    const iv = setInterval(() => void poll(), POLL_MS);
    return () => {
      stopped = true;
      controller.abort();
      clearInterval(iv);
    };
  }, [connected, docId, effGasUrl, effGasToken, applyNewText]);

  const handleConnect = useCallback(() => {
    if (!docId) {
      setSyncStatus("error");
      setSyncError("Link Google Docs tidak valid");
      return;
    }
    if (!effGasUrl) {
      setShowConn(true);
      setSyncStatus("error");
      setSyncError(
        builtIn
          ? "Masukkan password dulu di Pengaturan koneksi"
          : "Isi dulu URL Apps Script di Pengaturan koneksi"
      );
      return;
    }
    if (!builtIn) saveGasConfig(gasUrl, gasToken);
    setSyncStatus("idle");
    setSyncError("");
    setConnected(true);
  }, [docId, effGasUrl, builtIn, gasUrl, gasToken]);

  // Verifikasi password (6 karakter terakhir token) dengan animasi.
  const handleUnlock = useCallback(() => {
    const expected = passwordOf(APP_CONFIG.gasToken);
    if (passwordInput.trim().toLowerCase() === expected.toLowerCase()) {
      setUnlocked(true);
      saveUnlocked(true);
      setSaveState("ok");
      setPasswordInput("");
      setSyncError("");
    } else {
      setSaveState("fail");
    }
    window.setTimeout(() => setSaveState("idle"), 700);
  }, [passwordInput]);

  const handleLock = useCallback(() => {
    setUnlocked(false);
    saveUnlocked(false);
    setConnected(false);
    setSyncStatus("idle");
  }, []);

  // ── Remote: tablet mengirim status & menerapkan perintah dari HP ──
  const jumpToParagraph = useCallback(
    (idx: number) => {
      const stage = stageRef.current;
      const content = contentRef.current;
      if (!stage || !content) return;
      const nodes = content.querySelectorAll<HTMLElement>("[data-par]");
      if (nodes.length === 0) return;
      const el = nodes[Math.max(0, Math.min(idx, nodes.length - 1))];
      const top = Math.max(0, el.offsetTop - readingY());
      stage.scrollTop = top;
      posRef.current = top;
      refreshHud();
    },
    [readingY, refreshHud]
  );

  const applyRemoteCmd = useCallback(
    (cmd: RemoteCommand) => {
      if (cmd.settings && Object.keys(cmd.settings).length > 0) {
        patch(cmd.settings);
      }
      if (
        typeof cmd.playNonce === "number" &&
        cmd.playNonce !== lastPlayNonceRef.current
      ) {
        lastPlayNonceRef.current = cmd.playNonce;
        if (cmd.play === "start" && !playingRef.current) beginPlay();
        if (cmd.play === "pause") pausePlaying();
      }
      if (
        typeof cmd.resetNonce === "number" &&
        cmd.resetNonce !== lastResetNonceRef.current
      ) {
        lastResetNonceRef.current = cmd.resetNonce;
        resetScroll();
      }
      if (
        typeof cmd.jumpNonce === "number" &&
        cmd.jumpNonce !== lastJumpNonceRef.current
      ) {
        lastJumpNonceRef.current = cmd.jumpNonce;
        if (typeof cmd.jumpTo === "number") jumpToParagraph(cmd.jumpTo);
      }
      // Sumber naskah dikelola dari remote:
      if (
        typeof cmd.docNonce === "number" &&
        cmd.docNonce !== lastDocNonceRef.current
      ) {
        lastDocNonceRef.current = cmd.docNonce;
        if (cmd.docAction === "connect") {
          const url = cmd.docUrl ?? settingsRef.current.docUrl;
          if (extractDocId(url)) {
            patch({ docUrl: url });
            setSyncStatus("idle");
            setSyncError("");
            setConnected(true);
          } else {
            setSyncStatus("error");
            setSyncError("Link Google Docs dari remote tidak valid");
          }
        } else if (cmd.docAction === "disconnect") {
          setConnected(false);
          setSyncStatus("idle");
        }
      }
      if (
        typeof cmd.manualNonce === "number" &&
        cmd.manualNonce !== lastManualNonceRef.current
      ) {
        lastManualNonceRef.current = cmd.manualNonce;
        if (effGasUrl && roomCode) {
          void pullManualText(effGasUrl, effGasToken, roomCode)
            .then((res) => {
              if (res.ok && typeof res.text === "string" && res.text) {
                setConnected(false);
                setSyncStatus("idle");
                setSourceMode("manual");
                setManualText(res.text);
                applyNewText(res.text);
              }
            })
            .catch(() => {});
        }
      }
    },
    [
      patch,
      startPlaying,
      beginPlay,
      pausePlaying,
      resetScroll,
      jumpToParagraph,
      effGasUrl,
      effGasToken,
      roomCode,
      applyNewText,
    ]
  );

  // Dorong naskah ke relay setiap kali berubah (sekali per versi),
  // agar remote menampilkan naskah yang sama persis.
  const textVersion = useMemo(() => hashText(rawText), [rawText]);
  const textVersionRef = useRef("");

  useEffect(() => {
    textVersionRef.current = textVersion;
  }, [textVersion]);

  useEffect(() => {
    if (!remoteOn || !effGasUrl || !roomCode) return;
    if (pushedVersionRef.current === textVersion) return;
    let cancelled = false;
    void pushText(effGasUrl, effGasToken, roomCode, rawText)
      .then((r) => {
        if (!cancelled && r.ok) pushedVersionRef.current = textVersion;
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [remoteOn, effGasUrl, effGasToken, roomCode, textVersion, rawText]);

  // Kode ruang atau sesi baru → naskah perlu didorong ulang.
  useEffect(() => {
    pushedVersionRef.current = "";
  }, [roomCode, remoteOn]);

  const buildStatus = useCallback(
    (): TabletStatus => ({
      ts: Date.now(),
      playing: playingRef.current,
      progress: progressRef.current,
      kata: kataRef.current,
      durasi: durasiRef.current,
      settings: settingsRef.current,
      activeIdx: activeIdxRef.current,
      textVersion: textVersionRef.current,
      docConnected: connectedRef.current,
      syncNote: syncStatusRef.current,
    }),
    []
  );

  // ── Jalur cepat: Supabase Realtime (jika dikonfigurasi) ──
  useEffect(() => {
    if (!remoteOn || !roomCode || !hasRealtime()) return;
    const handle = joinChannel(roomCode, {
      onCmd: (cmd) => applyRemoteCmd(cmd),
      onReady: (ready) => setRtReady(ready),
    });
    rtRef.current = handle;
    return () => {
      handle?.close();
      rtRef.current = null;
      setRtReady(false);
    };
  }, [remoteOn, roomCode, applyRemoteCmd]);

  // Kirim status via realtime (heartbeat ringan)
  useEffect(() => {
    if (!rtReady) return;
    const send = () => rtRef.current?.sendStatus(buildStatus());
    send();
    const iv = setInterval(send, 600);
    return () => clearInterval(iv);
  }, [rtReady, buildStatus]);

  // ── Fallback: polling Apps Script (dipakai bila realtime tidak aktif) ──
  useEffect(() => {
    if (rtReady) return; // realtime sudah menangani perintah & status
    if (!remoteOn || !effGasUrl || !roomCode) return;
    let stopped = false;
    const controller = new AbortController();

    const sync = async () => {
      if (remoteBusyRef.current || stopped) return;
      remoteBusyRef.current = true;
      try {
        const res = await tabletSync(
          effGasUrl,
          effGasToken,
          roomCode,
          buildStatus(),
          controller.signal
        );
        if (stopped) return;
        if (res.ok && res.cmd && res.cmd.seq > lastCmdSeqRef.current) {
          lastCmdSeqRef.current = res.cmd.seq;
          applyRemoteCmd(res.cmd);
        }
      } catch {
        /* koneksi relay gagal — dicoba lagi di tick berikutnya */
      } finally {
        remoteBusyRef.current = false;
      }
    };

    void sync();
    const iv = setInterval(() => void sync(), 1500);
    return () => {
      stopped = true;
      controller.abort();
      clearInterval(iv);
    };
  }, [rtReady, remoteOn, effGasUrl, effGasToken, roomCode, applyRemoteCmd, buildStatus]);

  const handleDisconnect = useCallback(() => {
    setConnected(false);
    setSyncStatus("idle");
  }, []);

  // ── Fullscreen ──
  useEffect(() => {
    const onFs = () => setIsFullscreen(Boolean(document.fullscreenElement));
    document.addEventListener("fullscreenchange", onFs);
    return () => document.removeEventListener("fullscreenchange", onFs);
  }, []);

  const toggleFullscreen = useCallback(() => {
    const el = wrapperRef.current;
    if (!el) return;
    if (document.fullscreenElement) {
      void document.exitFullscreen();
    } else {
      void el.requestFullscreen().catch(() => {});
      setPanelOpen(false);
    }
  }, []);

  // ── Keyboard shortcuts ──
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA")) return;
      switch (e.key) {
        case " ":
          e.preventDefault();
          togglePlay();
          break;
        case "ArrowUp":
          e.preventDefault();
          patch({ speed: Math.min(200, speedRef.current + 5) });
          break;
        case "ArrowDown":
          e.preventDefault();
          patch({ speed: Math.max(5, speedRef.current - 5) });
          break;
        case "r":
        case "R":
          resetScroll();
          break;
        case "f":
        case "F":
          toggleFullscreen();
          break;
        case "m":
        case "M":
          setSettings((s) => ({ ...s, mirrorH: !s.mirrorH }));
          break;
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [togglePlay, resetScroll, toggleFullscreen, patch]);

  // ── Preset ──
  const saveCurrentPreset = useCallback(() => {
    const name = presetName.trim();
    if (!name) return;
    const next: Preset = {
      id: `${Date.now()}`,
      name,
      settings: { ...settings },
      savedAt: new Date().toISOString(),
    };
    setPresets((prev) => {
      const filtered = prev.filter((p) => p.name !== name);
      const arr = [...filtered, next];
      savePresets(arr);
      return arr;
    });
    setPresetName("");
  }, [presetName, settings]);

  const applyPreset = useCallback((p: Preset) => {
    setSettings({ ...DEFAULT_SETTINGS, ...p.settings });
    setConnected(false);
    setSyncStatus("idle");
  }, []);

  const deletePreset = useCallback((id: string) => {
    setPresets((prev) => {
      const arr = prev.filter((p) => p.id !== id);
      savePresets(arr);
      return arr;
    });
  }, []);

  // ── Transform mirror ──
  const mirrorTransform = `${settings.mirrorH ? "scaleX(-1) " : ""}${
    settings.mirrorV ? "scaleY(-1)" : ""
  }`.trim();

  const tallyClass =
    syncStatus === "ok"
      ? "bg-emerald-500"
      : syncStatus === "error"
        ? "bg-tally tally-live"
        : syncStatus === "offline"
          ? "bg-amber"
          : "bg-inkdim/50";

  const tallyLabel =
    syncStatus === "ok"
      ? "TERSINKRON"
      : syncStatus === "error"
        ? "GAGAL SYNC"
        : syncStatus === "offline"
          ? "OFFLINE"
          : connected
            ? "MENYAMBUNG…"
            : "STANDBY";

  return (
    <div className="flex h-dvh flex-col overflow-hidden">
      {/* ── Header ── */}
      <header className="flex items-center gap-3 border-b border-edge bg-panel2 px-4 py-2">
        <button
          onClick={() => setPanelOpen((v) => !v)}
          className="rounded-md border border-edge px-2.5 py-1.5 text-sm text-inkdim hover:text-ink"
          aria-label="Buka/tutup panel kontrol"
        >
          ☰
        </button>
        <div className="flex items-baseline gap-2">
          <span className="text-sm font-bold tracking-[0.25em]">
            PROMPTER CIHUY
          </span>
          <span className="font-num text-[10px] text-inkdim">v0.9.2-alpha</span>
        </div>

        <div className="ml-auto flex items-center gap-3">
          <div className="flex items-center gap-2 rounded-full border border-edge px-3 py-1">
            <span className={`h-2.5 w-2.5 rounded-full ${tallyClass}`} />
            <span className="font-num text-[11px] tracking-wider text-inkdim">
              {tallyLabel}
            </span>
          </div>
          <button
            onClick={() => patch({ theme: settings.theme === "dark" ? "light" : "dark" })}
            className="rounded-md border border-edge px-2.5 py-1.5 text-sm text-inkdim hover:text-ink"
            title="Ganti tema terang/gelap"
          >
            {settings.theme === "dark" ? "☀ Terang" : "☾ Gelap"}
          </button>
          <button
            onClick={toggleFullscreen}
            className="rounded-md border border-edge px-2.5 py-1.5 text-sm text-inkdim hover:text-ink"
            title="Fullscreen (F)"
          >
            ⛶ Fullscreen
          </button>
        </div>
      </header>

      <div className="flex min-h-0 flex-1">
        {/* ── Panel kontrol ── */}
        {panelOpen && (
          <aside className="w-[340px] shrink-0 overflow-y-auto border-r border-edge bg-panel p-4 text-sm">
            {/* Sumber naskah */}
            <section className="mb-5">
              <h2 className="mb-2 text-[11px] font-bold tracking-[0.2em] text-inkdim">
                SUMBER NASKAH
              </h2>

              {/* Kelola sumber naskah dari mana */}
              <div className="mb-2 flex items-center justify-between">
                <span className="text-xs text-inkdim">Kelola dari</span>
                <div className="flex overflow-hidden rounded-lg border border-edge">
                  {(["tablet", "remote"] as const).map((c) => (
                    <button
                      key={c}
                      onClick={() => patch({ sourceControl: c })}
                      className={`px-3 py-1 text-[11px] font-semibold ${
                        settings.sourceControl === c
                          ? "bg-amber/15 text-amber"
                          : "text-inkdim"
                      }`}
                    >
                      {c === "tablet" ? "Tablet" : "Remote"}
                    </button>
                  ))}
                </div>
              </div>

              {settings.sourceControl === "remote" ? (
                <div className="rounded-lg border border-edge bg-panel2 p-3">
                  <p className="text-xs leading-relaxed text-inkdim">
                    Sumber naskah sedang dikelola dari <b>remote</b>. Ganti
                    naskah (link Google Docs / teks manual) lewat halaman
                    /remote.
                  </p>
                  <p className="mt-2 flex items-center gap-2 text-[11px] text-inkdim">
                    <span className={`h-2 w-2 rounded-full ${tallyClass}`} />
                    {tallyLabel}
                    {connected && syncStatus === "ok" && lastSyncAt && (
                      <span className="font-num">
                        · {lastSyncAt.toLocaleTimeString("id-ID")}
                      </span>
                    )}
                  </p>
                </div>
              ) : (
                <>
              <div className="mb-3 flex overflow-hidden rounded-lg border border-edge">
                {(["docs", "manual"] as const).map((m) => (
                  <button
                    key={m}
                    onClick={() => setSourceMode(m)}
                    className={`flex-1 px-3 py-1.5 text-xs font-semibold ${
                      sourceMode === m
                        ? "bg-panel2 text-ink"
                        : "bg-transparent text-inkdim"
                    }`}
                  >
                    {m === "docs" ? "Google Docs" : "Teks manual"}
                  </button>
                ))}
              </div>

              {sourceMode === "docs" ? (
                <>
                  <label className="mb-1 block text-xs text-inkdim" htmlFor="doclink">
                    Link Google Docs
                  </label>
                  <input
                    id="doclink"
                    value={settings.docUrl}
                    onChange={(e) => patch({ docUrl: e.target.value })}
                    placeholder="https://docs.google.com/document/d/…"
                    className="mb-2 w-full rounded-lg border border-edge bg-panel2 px-3 py-2 text-xs outline-none placeholder:text-inkdim/60"
                  />
                  {!connected ? (
                    <button
                      onClick={handleConnect}
                      className="w-full rounded-lg bg-ink py-2 text-xs font-bold tracking-widest text-panel2"
                    >
                      HUBUNGKAN
                    </button>
                  ) : (
                    <button
                      onClick={handleDisconnect}
                      className="w-full rounded-lg border border-tally py-2 text-xs font-bold tracking-widest text-tally"
                    >
                      PUTUSKAN
                    </button>
                  )}
                  {syncError && (
                    <p className="mt-2 text-xs text-tally">{syncError}</p>
                  )}
                  {connected && syncStatus === "ok" && lastSyncAt && (
                    <p className="font-num mt-2 text-[11px] text-inkdim">
                      Sync terakhir {lastSyncAt.toLocaleTimeString("id-ID")}
                    </p>
                  )}
                  {connected && syncStatus !== "ok" && syncStatus !== "idle" && (
                    <p className="mt-2 text-[11px] text-inkdim">
                      Menampilkan naskah terakhir yang tersimpan. Sync dicoba
                      ulang otomatis.
                    </p>
                  )}

                  <button
                    onClick={() => setShowConn((v) => !v)}
                    className="mt-3 text-[11px] text-inkdim underline underline-offset-2"
                  >
                    {showConn ? "Sembunyikan" : "Pengaturan"} koneksi Apps Script
                  </button>
                  {showConn && (
                    <div className="mt-2 space-y-2 rounded-lg border border-edge bg-panel2 p-3">
                      {builtIn ? (
                        unlocked ? (
                          <>
                            <p className="flex items-center gap-2 text-xs">
                              <span className="h-2 w-2 rounded-full bg-emerald-500" />
                              Koneksi aktif — URL &amp; token bawaan aplikasi.
                            </p>
                            <button
                              onClick={handleLock}
                              className="w-full rounded-md border border-edge py-1.5 text-xs font-semibold text-inkdim hover:text-tally"
                            >
                              Kunci ulang koneksi
                            </button>
                          </>
                        ) : (
                          <>
                            <label
                              className="mb-1 block text-xs text-inkdim"
                              htmlFor="connpass"
                            >
                              Password koneksi
                            </label>
                            <input
                              id="connpass"
                              type="password"
                              inputMode="text"
                              autoComplete="off"
                              maxLength={6}
                              value={passwordInput}
                              onChange={(e) => setPasswordInput(e.target.value)}
                              onKeyDown={(e) => {
                                if (e.key === "Enter") handleUnlock();
                              }}
                              placeholder="6 karakter"
                              className={`font-num w-full rounded-md border bg-panel px-2 py-1.5 text-center text-sm tracking-[0.4em] outline-none ${
                                saveState === "fail"
                                  ? "border-tally"
                                  : "border-edge"
                              }`}
                            />
                            <button
                              onClick={handleUnlock}
                              className={`w-full rounded-md py-1.5 text-xs font-semibold transition-colors ${
                                saveState === "ok"
                                  ? "save-ok bg-emerald-600 text-white"
                                  : saveState === "fail"
                                    ? "save-fail border border-tally text-tally"
                                    : "border border-edge"
                              }`}
                            >
                              {saveState === "ok"
                                ? "✓ Koneksi tersimpan"
                                : saveState === "fail"
                                  ? "Password salah"
                                  : "Simpan koneksi"}
                            </button>
                            <p className="text-[10px] leading-relaxed text-inkdim">
                              Cukup dimasukkan sekali per perangkat. Minta
                              password ke admin.
                            </p>
                          </>
                        )
                      ) : (
                        <>
                          <div>
                            <label
                              className="mb-1 block text-xs text-inkdim"
                              htmlFor="gasurl"
                            >
                              URL Web App (Apps Script)
                            </label>
                            <input
                              id="gasurl"
                              value={gasUrl}
                              onChange={(e) => setGasUrl(e.target.value)}
                              placeholder="https://script.google.com/macros/s/…/exec"
                              className="w-full rounded-md border border-edge bg-panel px-2 py-1.5 text-xs outline-none"
                            />
                          </div>
                          <div>
                            <label
                              className="mb-1 block text-xs text-inkdim"
                              htmlFor="gastoken"
                            >
                              Token
                            </label>
                            <input
                              id="gastoken"
                              value={gasToken}
                              onChange={(e) => setGasToken(e.target.value)}
                              placeholder="token dari Script Properties"
                              className="w-full rounded-md border border-edge bg-panel px-2 py-1.5 text-xs outline-none"
                            />
                          </div>
                          <button
                            onClick={() => {
                              saveGasConfig(gasUrl, gasToken);
                              setSaveState("ok");
                              window.setTimeout(() => setSaveState("idle"), 700);
                            }}
                            className={`w-full rounded-md py-1.5 text-xs font-semibold ${
                              saveState === "ok"
                                ? "save-ok bg-emerald-600 text-white"
                                : "border border-edge"
                            }`}
                          >
                            {saveState === "ok"
                              ? "✓ Koneksi tersimpan"
                              : "Simpan koneksi"}
                          </button>
                        </>
                      )}
                    </div>
                  )}
                </>
              ) : (
                <>
                  <textarea
                    value={manualText}
                    onChange={(e) => setManualText(e.target.value)}
                    rows={6}
                    placeholder="Tempel naskah di sini…"
                    className="mb-2 w-full rounded-lg border border-edge bg-panel2 px-3 py-2 text-xs outline-none placeholder:text-inkdim/60"
                  />
                  <button
                    onClick={() => {
                      setConnected(false);
                      applyNewText(manualText);
                    }}
                    className="w-full rounded-lg bg-ink py-2 text-xs font-bold tracking-widest text-panel2"
                  >
                    TERAPKAN NASKAH
                  </button>
                </>
              )}
                </>
              )}

              <p className="font-num mt-3 text-[11px] text-inkdim">
                {kata} kata · estimasi baca ± {formatDuration(durasi)} menit
              </p>
            </section>

            {/* Gerakan */}
            <section className="mb-5">
              <h2 className="mb-2 text-[11px] font-bold tracking-[0.2em] text-inkdim">
                GERAKAN
              </h2>
              <div className="mb-1 flex items-center justify-between">
                <label htmlFor="speed" className="text-xs text-inkdim">
                  Kecepatan
                </label>
                <span className="font-num text-xs">{settings.speed} px/s</span>
              </div>
              <input
                id="speed"
                type="range"
                min={5}
                max={200}
                step={5}
                value={settings.speed}
                onChange={(e) => patch({ speed: Number(e.target.value) })}
              />
              <div className="mt-3 grid grid-cols-3 gap-2">
                <button
                  onClick={playing ? pausePlaying : beginPlay}
                  className={`rounded-lg py-2.5 text-xs font-bold tracking-widest ${
                    playing
                      ? "border border-amber text-amber"
                      : "bg-tally text-white"
                  }`}
                >
                  {playing ? "❚❚ JEDA" : "▶ MULAI"}
                </button>
                <button
                  onClick={togglePlay}
                  className="rounded-lg border border-edge py-2.5 text-xs font-semibold text-inkdim"
                  title="Lanjut tanpa hitung mundur (Spasi)"
                >
                  Lanjut
                </button>
                <button
                  onClick={resetScroll}
                  className="rounded-lg border border-edge py-2.5 text-xs font-semibold text-inkdim"
                >
                  ↺ Reset
                </button>
              </div>
              <label className="mt-2 flex items-center gap-2 text-xs">
                <input
                  type="checkbox"
                  checked={settings.useCountdown}
                  onChange={(e) => patch({ useCountdown: e.target.checked })}
                  className="h-4 w-4 accent-current"
                />
                Hitung mundur 3-2-1 sebelum mulai
              </label>
              <p className="mt-2 text-[11px] leading-relaxed text-inkdim">
                Ketuk area naskah untuk jeda/lanjut. Spasi = jeda/lanjut, ↑↓ =
                kecepatan, R = reset, F = fullscreen, M = mirror.
              </p>
            </section>

            {/* Tampilan */}
            <section className="mb-5">
              <h2 className="mb-2 text-[11px] font-bold tracking-[0.2em] text-inkdim">
                TAMPILAN
              </h2>

              <div className="mb-1 flex items-center justify-between">
                <label htmlFor="fontsize" className="text-xs text-inkdim">
                  Ukuran huruf
                </label>
                <span className="font-num text-xs">{settings.fontSize} px</span>
              </div>
              <input
                id="fontsize"
                type="range"
                min={20}
                max={120}
                step={2}
                value={settings.fontSize}
                onChange={(e) => patch({ fontSize: Number(e.target.value) })}
              />

              <div className="mb-1 mt-3 flex items-center justify-between">
                <label htmlFor="lineheight" className="text-xs text-inkdim">
                  Jarak baris
                </label>
                <span className="font-num text-xs">{settings.lineHeight.toFixed(1)}</span>
              </div>
              <input
                id="lineheight"
                type="range"
                min={1.2}
                max={2.2}
                step={0.1}
                value={settings.lineHeight}
                onChange={(e) => patch({ lineHeight: Number(e.target.value) })}
              />

              <div className="mb-1 mt-3 flex items-center justify-between">
                <label htmlFor="readline" className="text-xs text-inkdim">
                  Posisi garis baca
                </label>
                <span className="font-num text-xs">{settings.readLinePos}%</span>
              </div>
              <input
                id="readline"
                type="range"
                min={15}
                max={60}
                step={1}
                value={settings.readLinePos}
                onChange={(e) => patch({ readLinePos: Number(e.target.value) })}
              />

              <div className="mb-1 mt-3 flex items-center justify-between">
                <label htmlFor="notesize" className="text-xs text-inkdim">
                  Ukuran catatan [cue]
                </label>
                <span className="font-num text-xs">{settings.noteSize} px</span>
              </div>
              <input
                id="notesize"
                type="range"
                min={12}
                max={48}
                step={1}
                value={settings.noteSize}
                onChange={(e) => patch({ noteSize: Number(e.target.value) })}
              />

              <div className="mb-1 mt-3 flex items-center justify-between">
                <span className="text-xs text-inkdim">Warna catatan</span>
                <span
                  className="font-num text-xs"
                  style={{ color: settings.noteColor }}
                >
                  [cue]
                </span>
              </div>
              <div className="flex gap-2">
                {[
                  "#ff453a",
                  "#ff9f0a",
                  "#ffd60a",
                  "#30d158",
                  "#0a84ff",
                  "#bf5af2",
                  "#ffffff",
                ].map((c) => (
                  <button
                    key={c}
                    onClick={() => patch({ noteColor: c })}
                    aria-label={`Warna catatan ${c}`}
                    className={`h-7 w-7 rounded-full border ${
                      settings.noteColor === c
                        ? "border-2 border-ink ring-2 ring-amber"
                        : "border-edge"
                    }`}
                    style={{ backgroundColor: c }}
                  />
                ))}
              </div>

              <div className="mb-1 mt-3 flex items-center justify-between">
                <span className="text-xs text-inkdim">Warna jeda</span>
                <span
                  className="font-num text-xs"
                  style={
                    settings.slashColor === "auto"
                      ? { color: "rgb(var(--stageink))" }
                      : { color: settings.slashColor }
                  }
                >
                  / //
                </span>
              </div>
              <div className="flex flex-wrap gap-2">
                <button
                  onClick={() => patch({ slashColor: "auto" })}
                  className={`h-7 rounded-full border px-2 text-[10px] font-semibold ${
                    settings.slashColor === "auto"
                      ? "border-2 border-ink ring-2 ring-amber text-ink"
                      : "border-edge text-inkdim"
                  }`}
                >
                  Auto
                </button>
                {[
                  "#ff453a",
                  "#ff9f0a",
                  "#ffd60a",
                  "#30d158",
                  "#0a84ff",
                  "#bf5af2",
                  "#8a8f98",
                ].map((c) => (
                  <button
                    key={c}
                    onClick={() => patch({ slashColor: c })}
                    aria-label={`Warna jeda ${c}`}
                    className={`h-7 w-7 rounded-full border ${
                      settings.slashColor === c
                        ? "border-2 border-ink ring-2 ring-amber"
                        : "border-edge"
                    }`}
                    style={{ backgroundColor: c }}
                  />
                ))}
              </div>

              <div className="mt-3 flex gap-4">
                <label className="flex items-center gap-2 text-xs">
                  <input
                    type="checkbox"
                    checked={settings.mirrorH}
                    onChange={(e) => patch({ mirrorH: e.target.checked })}
                    className="h-4 w-4 accent-current"
                  />
                  Mirror horizontal
                </label>
                <label className="flex items-center gap-2 text-xs">
                  <input
                    type="checkbox"
                    checked={settings.mirrorV}
                    onChange={(e) => patch({ mirrorV: e.target.checked })}
                    className="h-4 w-4 accent-current"
                  />
                  Mirror vertikal
                </label>
              </div>
            </section>

            {/* Preset */}
            <section className="mb-5">
              <h2 className="mb-2 text-[11px] font-bold tracking-[0.2em] text-inkdim">
                PRESET
              </h2>
              <div className="mb-2 flex gap-2">
                <input
                  value={presetName}
                  onChange={(e) => setPresetName(e.target.value)}
                  placeholder="Nama preset (mis. Studio A)"
                  className="min-w-0 flex-1 rounded-lg border border-edge bg-panel2 px-3 py-2 text-xs outline-none placeholder:text-inkdim/60"
                />
                <button
                  onClick={saveCurrentPreset}
                  className="shrink-0 rounded-lg border border-edge px-3 py-2 text-xs font-semibold"
                >
                  Simpan
                </button>
              </div>
              {presets.length === 0 ? (
                <p className="text-[11px] text-inkdim">
                  Belum ada preset. Atur tampilan, beri nama, lalu simpan —
                  termasuk link naskahnya.
                </p>
              ) : (
                <ul className="space-y-1.5">
                  {presets.map((p) => (
                    <li key={p.id} className="flex items-center gap-2">
                      <button
                        onClick={() => applyPreset(p)}
                        className="min-w-0 flex-1 truncate rounded-lg border border-edge bg-panel2 px-3 py-2 text-left text-xs font-semibold hover:border-inkdim"
                        title={`Font ${p.settings.fontSize} · ${p.settings.speed} px/s`}
                      >
                        {p.name}
                        <span className="font-num ml-2 font-normal text-inkdim">
                          {p.settings.fontSize}px · {p.settings.speed}px/s
                          {p.settings.mirrorH ? " · mirror" : ""}
                        </span>
                      </button>
                      <button
                        onClick={() => deletePreset(p.id)}
                        className="shrink-0 rounded-md border border-edge px-2 py-2 text-xs text-inkdim hover:text-tally"
                        aria-label={`Hapus preset ${p.name}`}
                      >
                        ✕
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </section>

            {/* Remote */}
            <section className="mb-5">
              <h2 className="mb-2 text-[11px] font-bold tracking-[0.2em] text-inkdim">
                REMOTE
              </h2>
              <button
                onClick={() => setRemoteOn((v) => !v)}
                className={`w-full rounded-lg py-2 text-xs font-bold tracking-widest ${
                  remoteOn
                    ? "border border-emerald-500 text-emerald-500"
                    : "border border-edge text-inkdim"
                }`}
              >
                {remoteOn ? "● REMOTE AKTIF" : "AKTIFKAN REMOTE"}
              </button>
              {remoteOn && (
                <div className="mt-2 rounded-lg border border-edge bg-panel2 p-3 text-center">
                  <p className="text-[11px] text-inkdim">Kode ruang</p>
                  <p className="font-num my-1 text-3xl font-black tracking-[0.35em]">
                    {roomCode}
                  </p>
                  <p className="text-[11px] leading-relaxed text-inkdim">
                    Buka <span className="font-num">/remote</span> di HP
                    (URL aplikasi ini + /remote), masukkan password dan kode
                    di atas.
                  </p>
                  <p className="mt-2 flex items-center justify-center gap-1.5 text-[10px]">
                    <span
                      className={`h-1.5 w-1.5 rounded-full ${
                        rtReady ? "bg-emerald-500" : "bg-amber"
                      }`}
                    />
                    <span className="text-inkdim">
                      {rtReady
                        ? "Jalur cepat aktif (realtime)"
                        : hasRealtime()
                          ? "Menyambung jalur cepat…"
                          : "Mode relay Apps Script (±1–3 dtk)"}
                    </span>
                  </p>
                  <button
                    onClick={() => setRoomCode(generateRoomCode())}
                    className="mt-2 rounded-md border border-edge px-3 py-1 text-[11px] text-inkdim"
                  >
                    Ganti kode
                  </button>
                </div>
              )}
            </section>
          </aside>
        )}

        {/* ── Stage prompter ── */}
        <div ref={wrapperRef} className="relative min-w-0 flex-1 bg-stage">
          <div
            ref={stageRef}
            onClick={togglePlay}
            className="stage-scroll h-full overflow-y-auto"
            style={{ backgroundColor: "rgb(var(--stage))" }}
          >
            <div
              ref={contentRef}
              style={{
                transform: mirrorTransform || undefined,
                paddingTop: (stageH * settings.readLinePos) / 100,
                paddingBottom: stageH * (1 - settings.readLinePos / 100),
              }}
              className="mx-auto max-w-[92%] px-6"
            >
              {paragraphs.map((p, i) => (
                <p
                  key={i}
                  data-par
                  data-active={i === activeIdx}
                  className="prompter-par mb-[0.9em] font-bold"
                  style={{
                    fontSize: settings.fontSize,
                    lineHeight: settings.lineHeight,
                    color: "rgb(var(--stageink))",
                  }}
                >
                  {splitSegments(p).map((seg, j) =>
                    seg.kind === "note" ? (
                      <span
                        key={j}
                        className="prompter-note"
                        style={{
                          fontSize: settings.noteSize,
                          color: settings.noteColor,
                        }}
                      >
                        {seg.text}
                      </span>
                    ) : seg.kind === "slash" ? (
                      <span
                        key={j}
                        style={
                          settings.slashColor === "auto"
                            ? undefined
                            : { color: settings.slashColor }
                        }
                      >
                        {seg.text}
                      </span>
                    ) : (
                      <span key={j}>{seg.text}</span>
                    )
                  )}
                </p>
              ))}
            </div>
          </div>

          {/* Garis baca */}
          <div
            aria-hidden
            className="pointer-events-none absolute inset-x-0"
            style={{ top: `${settings.readLinePos}%` }}
          >
            <div className="h-px w-full bg-tally/50" />
            <div className="absolute -top-2 left-1 h-0 w-0 border-y-8 border-l-[12px] border-y-transparent border-l-tally" />
          </div>

          {/* HUD mengambang */}
          <div className="pointer-events-none absolute right-3 top-3 flex items-center gap-2 rounded-full bg-black/50 px-3 py-1.5 backdrop-blur-sm">
            <span className={`h-2 w-2 rounded-full ${tallyClass}`} />
            <span className="font-num text-[11px] tracking-wider text-white/90">
              {progress}%
            </span>
            {playing && (
              <span className="font-num text-[11px] tracking-wider text-white/90">
                ▶ {settings.speed}
              </span>
            )}
          </div>

          {/* Tombol mengambang saat fullscreen */}
          {isFullscreen && (
            <div className="absolute bottom-4 left-1/2 flex -translate-x-1/2 items-center gap-2 rounded-full bg-black/55 px-3 py-2 opacity-40 backdrop-blur transition-opacity hover:opacity-100">
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  togglePlay();
                }}
                className="rounded-full bg-white/15 px-4 py-1.5 text-sm font-bold text-white"
              >
                {playing ? "❚❚" : "▶"}
              </button>
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  resetScroll();
                }}
                className="rounded-full bg-white/15 px-4 py-1.5 text-sm font-bold text-white"
              >
                ↺
              </button>
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  toggleFullscreen();
                }}
                className="rounded-full bg-white/15 px-4 py-1.5 text-sm font-bold text-white"
              >
                ⤢
              </button>
            </div>
          )}

          {/* Countdown */}
          {countdown !== null && (
            <div className="absolute inset-0 flex items-center justify-center bg-black/70">
              <span className="font-num text-[18vmin] font-black text-white">
                {countdown}
              </span>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
