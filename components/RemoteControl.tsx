"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { APP_CONFIG, hasBuiltInConfig, hasRealtime, passwordOf } from "@/lib/config";
import { formatDuration, splitSegments, toParagraphs } from "@/lib/formatter";
import { joinChannel, RealtimeHandle } from "@/lib/realtime";
import {
  pullText,
  pushManualText,
  remoteSync,
  RemoteCommand,
  TabletStatus,
} from "@/lib/remote";
import {
  DEFAULT_SETTINGS,
  extractDocId,
  loadGasConfig,
  loadRoom,
  loadUnlocked,
  PrompterSettings,
  saveRoom,
  saveUnlocked,
} from "@/lib/store";

type Step = "password" | "room" | "control";

export default function RemoteControl() {
  const builtIn = hasBuiltInConfig();
  const [step, setStep] = useState<Step>("password");
  const [passwordInput, setPasswordInput] = useState("");
  const [saveState, setSaveState] = useState<"idle" | "ok" | "fail">("idle");
  const [roomInput, setRoomInput] = useState("");
  const [room, setRoom] = useState("");

  const [manualGas, setManualGas] = useState({ url: "", token: "" });
  const [settings, setSettings] = useState<PrompterSettings>(DEFAULT_SETTINGS);
  const [status, setStatus] = useState<TabletStatus | null>(null);
  const [linked, setLinked] = useState(false); // sudah pernah terima status
  const [relayError, setRelayError] = useState("");

  // ── Naskah & tampilan ──
  const [fullView, setFullView] = useState(false); // default: tampilan remote
  const [remoteRaw, setRemoteRaw] = useState("");
  const [follow, setFollow] = useState(true); // auto-ikuti baris aktif
  const lastVerRef = useRef("");
  const pullingRef = useRef(false);
  const lastLocalEditRef = useRef(0);
  const jumpNonceRef = useRef(0);
  const textBoxRef = useRef<HTMLDivElement>(null);

  const paragraphs = useMemo(() => toParagraphs(remoteRaw), [remoteRaw]);
  const activeIdx = status?.activeIdx ?? -1;

  // ── Sumber naskah (saat dikelola dari remote) ──
  const [srcMode, setSrcMode] = useState<"docs" | "manual">("docs");
  const [docUrlInput, setDocUrlInput] = useState("");
  const [manualInput, setManualInput] = useState("");
  const [srcMsg, setSrcMsg] = useState("");
  const docSeededRef = useRef(false);
  const docNonceRef = useRef(0);
  const manualNonceRef = useRef(0);
  const sourceByRemote = settings.sourceControl === "remote";
  const docConnected = status?.docConnected ?? false;

  const seededRef = useRef(false); // slider sudah di-seed dari status tablet
  const pendingRef = useRef<Partial<PrompterSettings>>({});
  const debounceRef = useRef<number>(0);
  const rtRef = useRef<RealtimeHandle | null>(null);
  const rtReadyRef = useRef(false);
  const [rtReady, setRtReady] = useState(false);
  const playNonceRef = useRef(0);
  const resetNonceRef = useRef(0);
  const busyRef = useRef(false);

  const gasUrl = builtIn ? APP_CONFIG.gasUrl : manualGas.url;
  const gasToken = builtIn ? APP_CONFIG.gasToken : manualGas.token;

  // ── Hidrasi ──
  useEffect(() => {
    setManualGas(loadGasConfig());
    const savedRoom = loadRoom();
    if (savedRoom) setRoomInput(savedRoom);
    if (loadUnlocked() || !builtIn) setStep("room");
  }, [builtIn]);

  useEffect(() => {
    document.documentElement.classList.toggle("dark", settings.theme === "dark");
  }, [settings.theme]);

  // ── Kirim perintah ──
  const sendCmd = useCallback(
    (cmd: Omit<RemoteCommand, "seq">) => {
      if (!room) return;
      const full: RemoteCommand = { seq: Date.now(), ...cmd };
      // Jalur cepat: kirim via realtime kalau sudah tersambung.
      if (rtRef.current && rtReadyRef.current) {
        rtRef.current.sendCmd(full);
        return;
      }
      // Fallback: relay Apps Script.
      if (!gasUrl) return;
      void remoteSync(gasUrl, gasToken, room, full)
        .then((res) => {
          if (!res.ok) setRelayError(res.error ?? "Relay gagal");
          else {
            setRelayError("");
            if (res.status) {
              setStatus(res.status);
              setLinked(true);
            }
          }
        })
        .catch(() => setRelayError("Koneksi relay gagal"));
    },
    [gasUrl, gasToken, room]
  );

  // Terapkan status yang diterima dari tablet (dipakai realtime & polling).
  const applyStatus = useCallback((st: TabletStatus) => {
    setStatus(st);
    setLinked(true);
    setRelayError("");
    // Ikuti setting dari tablet, TAPI jangan menimpa perubahan yang baru
    // saja dikirim dari remote (jeda 1,2 detik) agar slider tidak "balik".
    if (Date.now() - lastLocalEditRef.current > 1200) {
      setSettings((prev) => {
        const merged = { ...prev, ...st.settings };
        // pertahankan field yang sedang menunggu dikirim (pending)
        return { ...merged, ...pendingRef.current };
      });
    }
    seededRef.current = true;
  }, []);

  // Perubahan slider dikirim dengan debounce agar tidak membanjiri kanal.
  const patchRemote = useCallback(
    (p: Partial<PrompterSettings>) => {
      lastLocalEditRef.current = Date.now();
      setSettings((prev) => ({ ...prev, ...p }));
      pendingRef.current = { ...pendingRef.current, ...p };
      window.clearTimeout(debounceRef.current);
      debounceRef.current = window.setTimeout(() => {
        const payload = pendingRef.current;
        pendingRef.current = {};
        sendCmd({ settings: payload });
      }, 150);
    },
    [sendCmd]
  );

  // ── Jalur cepat: Supabase Realtime ──
  useEffect(() => {
    if (step !== "control" || !room || !hasRealtime()) return;
    const handle = joinChannel(room, {
      onStatus: (st) => applyStatus(st),
      onReady: (ready) => {
        rtReadyRef.current = ready;
        setRtReady(ready);
      },
    });
    rtRef.current = handle;
    return () => {
      handle?.close();
      rtRef.current = null;
      rtReadyRef.current = false;
      setRtReady(false);
    };
  }, [step, room, applyStatus]);

  // ── Fallback: polling status via Apps Script (bila realtime tak aktif) ──
  useEffect(() => {
    if (rtReady) return;
    if (step !== "control" || !gasUrl || !room) return;
    let stopped = false;
    const controller = new AbortController();

    const poll = async () => {
      if (busyRef.current || stopped) return;
      busyRef.current = true;
      try {
        const res = await remoteSync(gasUrl, gasToken, room, undefined, controller.signal);
        if (stopped) return;
        if (res.ok) {
          if (res.status) applyStatus(res.status);
          else setRelayError("");
        } else {
          setRelayError(res.error ?? "Relay gagal");
        }
      } catch {
        if (!stopped) setRelayError("Koneksi relay gagal");
      } finally {
        busyRef.current = false;
      }
    };

    void poll();
    const iv = setInterval(() => void poll(), 2000);
    return () => {
      stopped = true;
      controller.abort();
      clearInterval(iv);
    };
  }, [rtReady, step, gasUrl, gasToken, room, applyStatus]);

  // ── Tarik naskah dari relay saat versinya berubah ──
  // Dep hanya nilai textVersion (string), BUKAN objek status — supaya
  // status realtime yang datang cepat (600ms) tidak membatalkan pull
  // Apps Script yang butuh ~1 detik untuk selesai.
  useEffect(() => {
    const version = status?.textVersion;
    if (step !== "control" || !version || !gasUrl || !room) return;
    if (version === lastVerRef.current || pullingRef.current) return;
    pullingRef.current = true;
    pullText(gasUrl, gasToken, room)
      .then((res) => {
        if (res.ok && typeof res.text === "string" && res.text) {
          lastVerRef.current = version;
          setRemoteRaw(res.text);
        }
      })
      .catch(() => {})
      .finally(() => {
        pullingRef.current = false;
      });
  }, [step, status?.textVersion, gasUrl, gasToken, room]);

  // ── Auto-ikuti baris aktif di panel naskah ──
  useEffect(() => {
    if (!follow || activeIdx < 0) return;
    const box = textBoxRef.current;
    if (!box) return;
    const el = box.querySelector<HTMLElement>(`[data-ridx="${activeIdx}"]`);
    el?.scrollIntoView({ block: "center", behavior: "smooth" });
  }, [activeIdx, follow, fullView]);

  // ── Tap baris → tablet melompat ke baris itu ──
  const handleJumpTo = useCallback(
    (idx: number) => {
      jumpNonceRef.current = Date.now();
      sendCmd({ jumpTo: idx, jumpNonce: jumpNonceRef.current });
      // optimistik: highlight langsung pindah tanpa menunggu status
      setStatus((s) => (s ? { ...s, activeIdx: idx } : s));
    },
    [sendCmd]
  );

  // ── Sumber naskah dari remote ──
  // Seed link Docs sekali dari kondisi tablet
  useEffect(() => {
    if (docSeededRef.current || !status?.settings?.docUrl) return;
    docSeededRef.current = true;
    setDocUrlInput(status.settings.docUrl);
  }, [status]);

  const handleDocConnect = useCallback(() => {
    if (!extractDocId(docUrlInput)) {
      setSrcMsg("Link Google Docs tidak valid");
      return;
    }
    setSrcMsg("");
    docNonceRef.current = Date.now();
    sendCmd({
      docUrl: docUrlInput.trim(),
      docAction: "connect",
      docNonce: docNonceRef.current,
    });
    setStatus((s) => (s ? { ...s, docConnected: true } : s));
  }, [docUrlInput, sendCmd]);

  const handleDocDisconnect = useCallback(() => {
    docNonceRef.current = Date.now();
    sendCmd({ docAction: "disconnect", docNonce: docNonceRef.current });
    setStatus((s) => (s ? { ...s, docConnected: false } : s));
  }, [sendCmd]);

  const handleApplyManual = useCallback(() => {
    if (!gasUrl || !room || !manualInput.trim()) return;
    setSrcMsg("Mengirim naskah…");
    void pushManualText(gasUrl, gasToken, room, manualInput)
      .then((res) => {
        if (!res.ok) {
          setSrcMsg(res.error ?? "Gagal mengirim naskah");
          return;
        }
        manualNonceRef.current = Date.now();
        sendCmd({ manualNonce: manualNonceRef.current });
        setSrcMsg("Naskah terkirim ke tablet ✓");
        window.setTimeout(() => setSrcMsg(""), 2500);
      })
      .catch(() => setSrcMsg("Gagal mengirim naskah"));
  }, [gasUrl, gasToken, room, manualInput, sendCmd]);

  // ── Gate handlers ──
  const handleUnlock = () => {
    if (passwordInput.trim().toLowerCase() === passwordOf(APP_CONFIG.gasToken).toLowerCase()) {
      saveUnlocked(true);
      setSaveState("ok");
      window.setTimeout(() => {
        setSaveState("idle");
        setStep("room");
      }, 500);
    } else {
      setSaveState("fail");
      window.setTimeout(() => setSaveState("idle"), 700);
    }
  };

  const handleJoinRoom = () => {
    const code = roomInput.trim();
    if (!/^\d{4}$/.test(code)) return;
    setRoom(code);
    saveRoom(code);
    seededRef.current = false;
    setLinked(false);
    setStep("control");
  };

  const tabletPlaying = status?.playing ?? false;

  const sendPlayPause = (play: "start" | "pause") => {
    playNonceRef.current = Date.now();
    sendCmd({ play, playNonce: playNonceRef.current });
    // optimistik: perbarui tampilan tombol tanpa menunggu status berikutnya
    setStatus((s) => (s ? { ...s, playing: play === "start" } : s));
  };

  const sendReset = () => {
    resetNonceRef.current = Date.now();
    sendCmd({ resetNonce: resetNonceRef.current });
  };

  // ── UI ──
  return (
    <div
      className={`mx-auto flex min-h-dvh flex-col bg-panel ${
        fullView && step === "control" ? "max-w-none" : "max-w-md"
      }`}
    >
      <header className="flex items-center justify-between border-b border-edge bg-panel2 px-4 py-3">
        <div className="flex items-baseline gap-2">
          <span className="text-sm font-bold tracking-[0.25em]">
            PROMPTER CIHUY
          </span>
          <span className="font-num text-[10px] text-inkdim">REMOTE</span>
        </div>
        {step === "control" && (
          <div className="flex items-center gap-2">
            <button
              onClick={() => setFullView((v) => !v)}
              className={`rounded-md border px-2.5 py-1 text-[11px] font-semibold ${
                fullView
                  ? "border-amber text-amber"
                  : "border-edge text-inkdim"
              }`}
              title="Tampilan penuh dengan naskah (untuk laptop)"
            >
              {fullView ? "▣ Penuh" : "▢ Penuh"}
            </button>
            <span className="flex items-center gap-2 rounded-full border border-edge px-3 py-1">
              <span
                className={`h-2.5 w-2.5 rounded-full ${
                  relayError
                    ? "bg-tally tally-live"
                    : linked
                      ? "bg-emerald-500"
                      : "bg-amber"
                }`}
              />
              <span className="font-num text-[11px] text-inkdim">
                {relayError ? "PUTUS" : linked ? room : "MENCARI…"}
              </span>
            </span>
            {rtReady && (
              <span
                className="rounded-full border border-emerald-500 px-2 py-0.5 text-[9px] font-bold tracking-wider text-emerald-500"
                title="Perintah lewat jalur realtime (latensi rendah)"
              >
                ⚡ CEPAT
              </span>
            )}
          </div>
        )}
      </header>

      <main className="flex-1 p-4 text-sm">
        {step === "password" && (
          <div className="mx-auto mt-16 max-w-xs space-y-3">
            <h1 className="text-center text-xs font-bold tracking-[0.2em] text-inkdim">
              PASSWORD KONEKSI
            </h1>
            <input
              type="password"
              maxLength={6}
              autoComplete="off"
              value={passwordInput}
              onChange={(e) => setPasswordInput(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && handleUnlock()}
              placeholder="6 karakter"
              className={`font-num w-full rounded-lg border bg-panel2 px-3 py-3 text-center text-lg tracking-[0.4em] outline-none ${
                saveState === "fail" ? "save-fail border-tally" : "border-edge"
              }`}
            />
            <button
              onClick={handleUnlock}
              className={`w-full rounded-lg py-3 text-sm font-bold tracking-widest ${
                saveState === "ok"
                  ? "save-ok bg-emerald-600 text-white"
                  : saveState === "fail"
                    ? "save-fail border border-tally text-tally"
                    : "bg-ink text-panel2"
              }`}
            >
              {saveState === "ok"
                ? "✓"
                : saveState === "fail"
                  ? "PASSWORD SALAH"
                  : "MASUK"}
            </button>
          </div>
        )}

        {step === "room" && (
          <div className="mx-auto mt-16 max-w-xs space-y-3">
            <h1 className="text-center text-xs font-bold tracking-[0.2em] text-inkdim">
              KODE RUANG
            </h1>
            <p className="text-center text-[11px] leading-relaxed text-inkdim">
              Aktifkan Remote di panel tablet prompter, lalu masukkan 4 digit
              kode yang muncul.
            </p>
            <input
              inputMode="numeric"
              maxLength={4}
              value={roomInput}
              onChange={(e) => setRoomInput(e.target.value.replace(/\D/g, ""))}
              onKeyDown={(e) => e.key === "Enter" && handleJoinRoom()}
              placeholder="0000"
              className="font-num w-full rounded-lg border border-edge bg-panel2 px-3 py-3 text-center text-2xl tracking-[0.5em] outline-none"
            />
            <button
              onClick={handleJoinRoom}
              disabled={!/^\d{4}$/.test(roomInput.trim())}
              className="w-full rounded-lg bg-ink py-3 text-sm font-bold tracking-widest text-panel2 disabled:opacity-40"
            >
              SAMBUNGKAN
            </button>
            {!builtIn && !manualGas.url && (
              <p className="text-center text-[11px] text-tally">
                Konfigurasi koneksi belum ada di perangkat ini. Buka halaman
                utama dulu dan isi Pengaturan koneksi.
              </p>
            )}
          </div>
        )}

        {step === "control" && (
          <div
            className={
              fullView
                ? "md:grid md:grid-cols-[380px_minmax(0,1fr)] md:items-start md:gap-5"
                : ""
            }
          >
            <div className="space-y-5">
            {/* Kelola sumber naskah */}
            <section className="rounded-xl border border-edge bg-panel2 p-3">
              <div className="flex items-center justify-between">
                <span className="text-[11px] font-bold tracking-[0.2em] text-inkdim">
                  SUMBER NASKAH
                </span>
                <div className="flex overflow-hidden rounded-lg border border-edge">
                  {(["tablet", "remote"] as const).map((c) => (
                    <button
                      key={c}
                      onClick={() => patchRemote({ sourceControl: c })}
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

              {sourceByRemote ? (
                <div className="mt-3">
                  <div className="mb-3 flex overflow-hidden rounded-lg border border-edge">
                    {(["docs", "manual"] as const).map((m) => (
                      <button
                        key={m}
                        onClick={() => setSrcMode(m)}
                        className={`flex-1 px-3 py-1.5 text-xs font-semibold ${
                          srcMode === m
                            ? "bg-panel text-ink"
                            : "bg-transparent text-inkdim"
                        }`}
                      >
                        {m === "docs" ? "Google Docs" : "Teks manual"}
                      </button>
                    ))}
                  </div>

                  {srcMode === "docs" ? (
                    <>
                      <input
                        value={docUrlInput}
                        onChange={(e) => setDocUrlInput(e.target.value)}
                        placeholder="https://docs.google.com/document/d/…"
                        className="mb-2 w-full rounded-lg border border-edge bg-panel px-3 py-2 text-xs outline-none placeholder:text-inkdim/60"
                      />
                      {!docConnected ? (
                        <button
                          onClick={handleDocConnect}
                          className="w-full rounded-lg bg-ink py-2.5 text-xs font-bold tracking-widest text-panel2"
                        >
                          HUBUNGKAN
                        </button>
                      ) : (
                        <button
                          onClick={handleDocDisconnect}
                          className="w-full rounded-lg border border-tally py-2.5 text-xs font-bold tracking-widest text-tally"
                        >
                          PUTUSKAN
                        </button>
                      )}
                      {docConnected && (
                        <p className="font-num mt-2 text-[11px] text-inkdim">
                          Live sync:{" "}
                          {status?.syncNote === "ok"
                            ? "tersinkron"
                            : status?.syncNote === "error"
                              ? "gagal — dicoba ulang"
                              : status?.syncNote === "offline"
                                ? "tablet offline"
                                : "menyambung…"}
                        </p>
                      )}
                    </>
                  ) : (
                    <>
                      <textarea
                        value={manualInput}
                        onChange={(e) => setManualInput(e.target.value)}
                        rows={5}
                        placeholder="Tempel naskah di sini…"
                        className="mb-2 w-full rounded-lg border border-edge bg-panel px-3 py-2 text-xs outline-none placeholder:text-inkdim/60"
                      />
                      <button
                        onClick={handleApplyManual}
                        className="w-full rounded-lg bg-ink py-2.5 text-xs font-bold tracking-widest text-panel2"
                      >
                        TERAPKAN KE TABLET
                      </button>
                    </>
                  )}
                  {srcMsg && (
                    <p className="mt-2 text-[11px] text-inkdim">{srcMsg}</p>
                  )}
                </div>
              ) : (
                <p className="mt-2 text-[11px] leading-relaxed text-inkdim">
                  Naskah dikelola dari tablet. Pilih <b>Remote</b> untuk
                  mengganti naskah dari sini.
                </p>
              )}
            </section>

            {/* Status tablet */}
            <section className="rounded-xl border border-edge bg-panel2 p-3">
              <div className="mb-2 flex items-center justify-between">
                <span className="text-[11px] font-bold tracking-[0.2em] text-inkdim">
                  STATUS TABLET
                </span>
                <span className="font-num text-[11px] text-inkdim">
                  {status
                    ? `${status.kata} kata · ± ${formatDuration(status.durasi)}`
                    : "menunggu…"}
                </span>
              </div>
              <div className="h-2 overflow-hidden rounded-full bg-edge">
                <div
                  className="h-full rounded-full bg-tally transition-[width] duration-500"
                  style={{ width: `${status?.progress ?? 0}%` }}
                />
              </div>
              <div className="mt-1 flex justify-between">
                <span className="font-num text-[11px] text-inkdim">
                  {status?.progress ?? 0}%
                </span>
                <span className="font-num text-[11px] text-inkdim">
                  {tabletPlaying ? "▶ BERJALAN" : "❚❚ JEDA"}
                </span>
              </div>
              {relayError && (
                <p className="mt-2 text-[11px] text-tally">{relayError}</p>
              )}
            </section>

            {/* Transport */}
            <section className="grid grid-cols-3 gap-2">
              <button
                onClick={() => sendPlayPause(tabletPlaying ? "pause" : "start")}
                className={`col-span-2 rounded-xl py-5 text-base font-black tracking-widest ${
                  tabletPlaying
                    ? "border-2 border-amber text-amber"
                    : "bg-tally text-white"
                }`}
              >
                {tabletPlaying ? "❚❚ JEDA" : "▶ MULAI"}
              </button>
              <button
                onClick={sendReset}
                className="rounded-xl border border-edge py-5 text-base font-bold text-inkdim"
              >
                ↺ Reset
              </button>
            </section>

            <label className="flex items-center justify-center gap-2 rounded-xl border border-edge bg-panel2 py-3 text-xs">
              <input
                type="checkbox"
                checked={settings.useCountdown}
                onChange={(e) => patchRemote({ useCountdown: e.target.checked })}
                className="h-4 w-4 accent-current"
              />
              Hitung mundur 3-2-1 sebelum mulai
            </label>

            {/* Gerakan & tampilan */}
            <section className="space-y-4 rounded-xl border border-edge bg-panel2 p-3">
              <SliderRow
                label="Kecepatan"
                value={settings.speed}
                unit="px/s"
                min={5}
                max={200}
                step={5}
                onChange={(v) => patchRemote({ speed: v })}
              />
              <SliderRow
                label="Ukuran huruf"
                value={settings.fontSize}
                unit="px"
                min={20}
                max={120}
                step={2}
                onChange={(v) => patchRemote({ fontSize: v })}
              />
              <SliderRow
                label="Jarak baris"
                value={settings.lineHeight}
                unit=""
                min={1.2}
                max={2.2}
                step={0.1}
                decimals={1}
                onChange={(v) => patchRemote({ lineHeight: v })}
              />
              <SliderRow
                label="Posisi garis baca"
                value={settings.readLinePos}
                unit="%"
                min={15}
                max={60}
                step={1}
                onChange={(v) => patchRemote({ readLinePos: v })}
              />
              <SliderRow
                label="Ukuran catatan [cue]"
                value={settings.noteSize}
                unit="px"
                min={12}
                max={48}
                step={1}
                onChange={(v) => patchRemote({ noteSize: v })}
              />
              <div>
                <div className="mb-1 flex items-center justify-between">
                  <span className="text-xs text-inkdim">Warna catatan</span>
                  <span
                    className="font-num text-xs"
                    style={{ color: settings.noteColor }}
                  >
                    [cue]
                  </span>
                </div>
                <div className="flex justify-between gap-2">
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
                      onClick={() => patchRemote({ noteColor: c })}
                      aria-label={`Warna catatan ${c}`}
                      className={`h-9 w-9 rounded-full border ${
                        settings.noteColor === c
                          ? "border-2 border-ink ring-2 ring-amber"
                          : "border-edge"
                      }`}
                      style={{ backgroundColor: c }}
                    />
                  ))}
                </div>
              </div>

              <div>
                <div className="mb-1 flex items-center justify-between">
                  <span className="text-xs text-inkdim">Warna jeda</span>
                  <span
                    className="font-num text-xs"
                    style={
                      settings.slashColor === "auto"
                        ? { color: "rgb(var(--ink))" }
                        : { color: settings.slashColor }
                    }
                  >
                    / //
                  </span>
                </div>
                <div className="flex items-center gap-2">
                  <button
                    onClick={() => patchRemote({ slashColor: "auto" })}
                    className={`h-9 rounded-full border px-2.5 text-[11px] font-semibold ${
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
                      onClick={() => patchRemote({ slashColor: c })}
                      aria-label={`Warna jeda ${c}`}
                      className={`h-9 w-9 rounded-full border ${
                        settings.slashColor === c
                          ? "border-2 border-ink ring-2 ring-amber"
                          : "border-edge"
                      }`}
                      style={{ backgroundColor: c }}
                    />
                  ))}
                </div>
              </div>
            </section>

            <section className="grid grid-cols-3 gap-2">
              <ToggleBtn
                active={settings.mirrorH}
                onClick={() => patchRemote({ mirrorH: !settings.mirrorH })}
                label="Mirror H"
              />
              <ToggleBtn
                active={settings.mirrorV}
                onClick={() => patchRemote({ mirrorV: !settings.mirrorV })}
                label="Mirror V"
              />
              <ToggleBtn
                active={settings.theme === "light"}
                onClick={() =>
                  patchRemote({
                    theme: settings.theme === "dark" ? "light" : "dark",
                  })
                }
                label={settings.theme === "dark" ? "☾ Gelap" : "☀ Terang"}
              />
            </section>

            {!fullView && (
              <NaskahPanel
                tall={false}
                paragraphs={paragraphs}
                activeIdx={activeIdx}
                follow={follow}
                noteColor={settings.noteColor}
                slashColor={settings.slashColor}
                onToggleFollow={() => setFollow((v) => !v)}
                onJump={handleJumpTo}
                boxRef={textBoxRef}
              />
            )}

            <button
              onClick={() => {
                setStep("room");
                setStatus(null);
              }}
              className="w-full py-2 text-center text-[11px] text-inkdim underline underline-offset-2"
            >
              Ganti kode ruang
            </button>
            </div>

            {fullView && (
              <div className="mt-5 md:mt-0">
                <NaskahPanel
                  tall
                  paragraphs={paragraphs}
                  activeIdx={activeIdx}
                  follow={follow}
                  noteColor={settings.noteColor}
                  slashColor={settings.slashColor}
                  onToggleFollow={() => setFollow((v) => !v)}
                  onJump={handleJumpTo}
                  boxRef={textBoxRef}
                />
              </div>
            )}
          </div>
        )}
      </main>

      {status?.countdown != null && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70">
          <span
            key={status.countdown}
            className="countdown-pop font-num font-black text-white"
            style={{ fontSize: "40vmin" }}
          >
            {status.countdown}
          </span>
        </div>
      )}
    </div>
  );
}

function SliderRow({
  label,
  value,
  unit,
  min,
  max,
  step,
  decimals = 0,
  onChange,
}: {
  label: string;
  value: number;
  unit: string;
  min: number;
  max: number;
  step: number;
  decimals?: number;
  onChange: (v: number) => void;
}) {
  return (
    <div>
      <div className="mb-1 flex items-center justify-between">
        <span className="text-xs text-inkdim">{label}</span>
        <span className="font-num text-xs">
          {value.toFixed(decimals)} {unit}
        </span>
      </div>
      <div className="flex items-center gap-2">
        <button
          onClick={() => onChange(Math.max(min, Number((value - step).toFixed(decimals))))}
          className="h-11 w-11 shrink-0 rounded-lg border border-edge text-lg font-bold text-inkdim"
          aria-label={`Kurangi ${label}`}
        >
          −
        </button>
        <input
          type="range"
          min={min}
          max={max}
          step={step}
          value={value}
          onChange={(e) => onChange(Number(e.target.value))}
          aria-label={label}
        />
        <button
          onClick={() => onChange(Math.min(max, Number((value + step).toFixed(decimals))))}
          className="h-11 w-11 shrink-0 rounded-lg border border-edge text-lg font-bold text-inkdim"
          aria-label={`Tambah ${label}`}
        >
          +
        </button>
      </div>
    </div>
  );
}

function ToggleBtn({
  active,
  onClick,
  label,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
}) {
  return (
    <button
      onClick={onClick}
      className={`rounded-xl py-3 text-xs font-bold ${
        active
          ? "border-2 border-amber text-amber"
          : "border border-edge text-inkdim"
      }`}
    >
      {label}
    </button>
  );
}

function NaskahPanel({
  tall,
  paragraphs,
  activeIdx,
  follow,
  noteColor,
  slashColor,
  onToggleFollow,
  onJump,
  boxRef,
}: {
  tall: boolean;
  paragraphs: string[];
  activeIdx: number;
  follow: boolean;
  noteColor: string;
  slashColor: string;
  onToggleFollow: () => void;
  onJump: (idx: number) => void;
  boxRef: React.RefObject<HTMLDivElement | null>;
}) {
  return (
    <section className="rounded-xl border border-edge bg-panel2 p-3">
      <div className="mb-2 flex items-center justify-between">
        <span className="text-[11px] font-bold tracking-[0.2em] text-inkdim">
          NASKAH
        </span>
        <button
          onClick={onToggleFollow}
          className={`rounded-md border px-2 py-1 text-[11px] font-semibold ${
            follow ? "border-amber text-amber" : "border-edge text-inkdim"
          }`}
        >
          {follow ? "● Ikuti baris" : "○ Ikuti baris"}
        </button>
      </div>
      <div
        ref={boxRef}
        className={`overflow-y-auto rounded-lg border border-edge bg-panel p-1.5 ${
          tall ? "h-[calc(100dvh-130px)]" : "h-64"
        }`}
      >
        {paragraphs.length === 0 ? (
          <p className="p-3 text-center text-[11px] text-inkdim">
            Menunggu naskah dari tablet… Pastikan Remote aktif di tablet dan
            naskah sudah dimuat.
          </p>
        ) : (
          paragraphs.map((p, i) => (
            <button
              key={i}
              data-ridx={i}
              onClick={() => onJump(i)}
              className={`block w-full rounded-md px-2.5 py-2 text-left leading-snug ${
                tall ? "text-sm" : "text-[13px]"
              } ${
                i === activeIdx
                  ? "border-l-4 border-tally bg-tally/10 font-bold text-ink"
                  : "border-l-4 border-transparent text-inkdim hover:text-ink"
              }`}
            >
              {splitSegments(p).map((seg, j) =>
                seg.kind === "note" ? (
                  <span
                    key={j}
                    className="font-semibold"
                    style={{ color: noteColor }}
                  >
                    {seg.text}
                  </span>
                ) : seg.kind === "slash" ? (
                  <span
                    key={j}
                    style={
                      slashColor === "auto" ? undefined : { color: slashColor }
                    }
                  >
                    {seg.text}
                  </span>
                ) : (
                  <span key={j}>{seg.text}</span>
                )
              )}
            </button>
          ))
        )}
      </div>
      <p className="mt-2 text-[11px] text-inkdim">
        Ketuk baris untuk memindahkan prompter ke baris itu (± 1–3 detik).
      </p>
    </section>
  );
}
