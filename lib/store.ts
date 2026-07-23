// Tipe data + helper koneksi Google Docs (via Apps Script) + preset localStorage.

export type ThemeMode = "dark" | "light";
export type SourceControl = "tablet" | "remote";

export interface PrompterSettings {
  fontSize: number; // px
  speed: number; // px per detik
  mirrorH: boolean;
  mirrorV: boolean;
  theme: ThemeMode;
  readLinePos: number; // posisi garis baca, % dari atas layar (15–60)
  lineHeight: number; // 1.2–2.0
  docUrl: string; // link Google Docs
  sourceControl: SourceControl; // sumber naskah dikelola dari mana
  noteSize: number; // ukuran font catatan [Teks], px, tidak ikut slider utama
  noteColor: string; // warna font catatan [Teks]
  slashColor: string; // warna penanda jeda "/" dan "//" ("auto" = ikut teks)
  useCountdown: boolean; // tampilkan hitung mundur 3-2-1 sebelum mulai
}

export const DEFAULT_SETTINGS: PrompterSettings = {
  fontSize: 56,
  speed: 40,
  mirrorH: false,
  mirrorV: false,
  theme: "dark",
  readLinePos: 30,
  lineHeight: 1.5,
  docUrl: "",
  sourceControl: "tablet",
  noteSize: 20,
  noteColor: "#ff453a",
  slashColor: "auto",
  useCountdown: true,
};

export interface Preset {
  id: string;
  name: string;
  settings: PrompterSettings;
  savedAt: string;
}

const LS_KEYS = {
  settings: "prompter.settings.v1",
  presets: "prompter.presets.v1",
  gasUrl: "prompter.gasUrl.v1",
  gasToken: "prompter.gasToken.v1",
  lastScript: "prompter.lastScript.v1",
  unlocked: "prompter.unlocked.v1",
  room: "prompter.room.v1",
} as const;

function safeGet(key: string): string | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function safeSet(key: string, value: string) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(key, value);
  } catch {
    /* penyimpanan penuh / private mode — abaikan */
  }
}

export function loadSettings(): PrompterSettings {
  const raw = safeGet(LS_KEYS.settings);
  if (!raw) return { ...DEFAULT_SETTINGS };
  try {
    return { ...DEFAULT_SETTINGS, ...(JSON.parse(raw) as Partial<PrompterSettings>) };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export function saveSettings(s: PrompterSettings) {
  safeSet(LS_KEYS.settings, JSON.stringify(s));
}

export function loadPresets(): Preset[] {
  const raw = safeGet(LS_KEYS.presets);
  if (!raw) return [];
  try {
    const arr = JSON.parse(raw) as Preset[];
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

export function savePresets(presets: Preset[]) {
  safeSet(LS_KEYS.presets, JSON.stringify(presets));
}

export function loadGasConfig(): { url: string; token: string } {
  return {
    url: safeGet(LS_KEYS.gasUrl) ?? "",
    token: safeGet(LS_KEYS.gasToken) ?? "",
  };
}

export function saveGasConfig(url: string, token: string) {
  safeSet(LS_KEYS.gasUrl, url.trim());
  safeSet(LS_KEYS.gasToken, token.trim());
}

export function loadLastScript(): string {
  return safeGet(LS_KEYS.lastScript) ?? "";
}

export function saveLastScript(text: string) {
  safeSet(LS_KEYS.lastScript, text);
}

export function loadUnlocked(): boolean {
  return safeGet(LS_KEYS.unlocked) === "1";
}

export function saveUnlocked(v: boolean) {
  safeSet(LS_KEYS.unlocked, v ? "1" : "0");
}

export function loadRoom(): string {
  return safeGet(LS_KEYS.room) ?? "";
}

export function saveRoom(code: string) {
  safeSet(LS_KEYS.room, code);
}

/** Ekstrak ID dokumen dari link Google Docs (atau terima ID mentah). */
export function extractDocId(input: string): string | null {
  const trimmed = input.trim();
  if (!trimmed) return null;
  const m = trimmed.match(/\/document\/d\/([a-zA-Z0-9_-]{20,})/);
  if (m) return m[1];
  if (/^[a-zA-Z0-9_-]{20,}$/.test(trimmed)) return trimmed;
  return null;
}

export interface FetchResult {
  ok: boolean;
  text?: string;
  error?: string;
}

/** Ambil isi naskah dari Apps Script web app. */
export async function fetchDocText(
  gasUrl: string,
  docId: string,
  token: string,
  signal?: AbortSignal
): Promise<FetchResult> {
  const url = new URL(gasUrl);
  url.searchParams.set("docId", docId);
  if (token) url.searchParams.set("token", token);
  const res = await fetch(url.toString(), {
    method: "GET",
    redirect: "follow",
    signal,
  });
  if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
  const data = (await res.json()) as { ok: boolean; text?: string; error?: string };
  if (!data.ok) return { ok: false, error: data.error ?? "unknown" };
  return { ok: true, text: data.text ?? "" };
}
