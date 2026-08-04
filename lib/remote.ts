// Protokol remote control lewat relay Apps Script (CacheService).
// Tablet  : action=tsync  → kirim status, terima perintah.
// Remote  : action=rsync  → kirim perintah (opsional), terima status.

import type { PrompterSettings } from "@/lib/store";

export interface RemoteCommand {
  seq: number; // Date.now() saat perintah dibuat
  settings?: Partial<PrompterSettings>;
  play?: "start" | "pause";
  playNonce?: number; // berubah setiap tombol play/pause ditekan
  resetNonce?: number; // berubah setiap tombol reset ditekan
  jumpTo?: number; // indeks paragraf tujuan
  jumpNonce?: number; // berubah setiap baris di-tap dari remote
  docUrl?: string; // link Google Docs baru (dikirim bersama docAction)
  docAction?: "connect" | "disconnect";
  docNonce?: number; // berubah setiap aksi hubungkan/putuskan dari remote
  manualNonce?: number; // berubah saat remote menerapkan naskah manual
}

export interface TabletStatus {
  ts: number;
  playing: boolean;
  progress: number;
  kata: number;
  durasi: number; // detik
  settings: PrompterSettings;
  activeIdx: number; // paragraf yang sedang di garis baca
  textVersion: string; // hash naskah — remote menarik ulang saat berubah
  docConnected: boolean; // live sync Google Docs sedang aktif
  syncNote: string; // "ok" | "error" | "offline" | "idle"
  countdown: number | null; // angka hitung mundur yang sedang tampil (3/2/1) atau null
}

interface RelayResponse {
  ok: boolean;
  error?: string;
  cmd?: RemoteCommand | null;
  status?: TabletStatus | null;
  text?: string;
}

async function callRelay(
  gasUrl: string,
  token: string,
  params: Record<string, string>,
  signal?: AbortSignal
): Promise<RelayResponse> {
  const url = new URL(gasUrl);
  url.searchParams.set("token", token);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const res = await fetch(url.toString(), { method: "GET", redirect: "follow", signal });
  if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
  return (await res.json()) as RelayResponse;
}

/** Dipanggil tablet: kirim status terkini, terima perintah terbaru. */
export function tabletSync(
  gasUrl: string,
  token: string,
  room: string,
  status: TabletStatus,
  signal?: AbortSignal
): Promise<RelayResponse> {
  return callRelay(
    gasUrl,
    token,
    { action: "tsync", room, status: JSON.stringify(status) },
    signal
  );
}

/** Dipanggil remote (HP): kirim perintah bila ada, terima status tablet. */
export function remoteSync(
  gasUrl: string,
  token: string,
  room: string,
  cmd?: RemoteCommand,
  signal?: AbortSignal
): Promise<RelayResponse> {
  const params: Record<string, string> = { action: "rsync", room };
  if (cmd) params.cmd = JSON.stringify(cmd);
  return callRelay(gasUrl, token, params, signal);
}

export function generateRoomCode(): string {
  return String(Math.floor(1000 + Math.random() * 9000));
}

/** Hash ringan (djb2) untuk mendeteksi perubahan naskah. */
export function hashText(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) {
    h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  }
  return `${s.length}-${(h >>> 0).toString(36)}`;
}

/** Tablet mendorong naskah mentah ke relay (POST, aman untuk naskah panjang). */
export async function pushText(
  gasUrl: string,
  token: string,
  room: string,
  text: string
): Promise<{ ok: boolean; error?: string }> {
  const url = new URL(gasUrl);
  url.searchParams.set("token", token);
  url.searchParams.set("action", "text_push");
  url.searchParams.set("room", room);
  const res = await fetch(url.toString(), {
    method: "POST",
    redirect: "follow",
    headers: { "Content-Type": "text/plain;charset=utf-8" },
    body: text,
  });
  if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
  return (await res.json()) as { ok: boolean; error?: string };
}

/** Remote menarik naskah mentah dari relay. */
export async function pullText(
  gasUrl: string,
  token: string,
  room: string,
  signal?: AbortSignal
): Promise<{ ok: boolean; text?: string; error?: string }> {
  const res = await callRelay(
    gasUrl,
    token,
    { action: "text_pull", room },
    signal
  );
  return res as { ok: boolean; text?: string; error?: string };
}

/** Remote mendorong naskah manual untuk diterapkan tablet (POST). */
export async function pushManualText(
  gasUrl: string,
  token: string,
  room: string,
  text: string
): Promise<{ ok: boolean; error?: string }> {
  const url = new URL(gasUrl);
  url.searchParams.set("token", token);
  url.searchParams.set("action", "mtext_push");
  url.searchParams.set("room", room);
  const res = await fetch(url.toString(), {
    method: "POST",
    redirect: "follow",
    headers: { "Content-Type": "text/plain;charset=utf-8" },
    body: text,
  });
  if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
  return (await res.json()) as { ok: boolean; error?: string };
}

/** Tablet menarik naskah manual yang dikirim remote. */
export async function pullManualText(
  gasUrl: string,
  token: string,
  room: string,
  signal?: AbortSignal
): Promise<{ ok: boolean; text?: string; error?: string }> {
  const res = await callRelay(
    gasUrl,
    token,
    { action: "mtext_pull", room },
    signal
  );
  return res as { ok: boolean; text?: string; error?: string };
}
