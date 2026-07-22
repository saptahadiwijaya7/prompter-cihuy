// Formatter naskah -> format prompter.
// Aturan: huruf kapital semua, koma -> "/", titik -> "//", ":" dan ";" -> "/",
// "?" dan "!" -> "//".
// Proteksi: angka Indonesia ("Rp100.000", "2,5 juta") dan singkatan umum
// TIDAK ikut dikonversi.

const PLACE_DOT = "\u0001";
const PLACE_COMMA = "\u0002";

// Singkatan yang titiknya dipertahankan (dihapus saja titiknya agar tidak
// terbaca sebagai jeda panjang oleh talent).
const ABBREVIATIONS = [
  "No.",
  "no.",
  "Rp.",
  "Dr.",
  "dr.",
  "Ir.",
  "Bpk.",
  "Ibu.",
  "Sdr.",
  "a.n.",
  "d.a.",
  "u.p.",
  "u.b.",
  "dll.",
  "dsb.",
  "dst.",
  "tsb.",
  "Tbk.",
  "PT.",
  "CV.",
];

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// TLD umum agar "accurate.id", "google.com", "kemenkeu.go.id" tidak
// terkonversi menjadi jeda. Token yang mengandung pola domain/URL/email
// diproteksi SELURUH titiknya.
const TLD_PATTERN =
  "(?:co\\.id|ac\\.id|go\\.id|or\\.id|sch\\.id|web\\.id|my\\.id|id|com|net|org|io|ai|co|dev|app|xyz|me|tv|info|biz|store|online|site|link|cloud|tech)";

const DOMAIN_RE = new RegExp(`[\\w-]+\\.${TLD_PATTERN}(?![\\w-])`, "i");
const URLISH_RE = /^(https?:\/\/|www\.)/i;
const PLACE_TOKEN = "\u0003";
const PLACE_NOTE = "\u0004";

/** Regex catatan sutradara: [teks apa pun dalam satu baris]. */
export const NOTE_RE = /\[[^\][\n]*\]/g;

/** Ambil catatan [teks] keluar dari teks, ganti dengan placeholder. */
function extractNotes(t: string): { text: string; notes: string[] } {
  const notes: string[] = [];
  const text = t.replace(NOTE_RE, (m) => {
    const idx = notes.push(m) - 1;
    return `${PLACE_NOTE}${idx}${PLACE_NOTE}`;
  });
  return { text, notes };
}

function restoreNotes(t: string, notes: string[]): string {
  return t.replace(new RegExp(`${PLACE_NOTE}(\\d+)${PLACE_NOTE}`, "g"), (_, i) =>
    notes[Number(i)] ?? ""
  );
}

/** Ambil token URL/domain/email keluar dari teks, ganti dengan placeholder. */
function extractProtectedTokens(t: string): { text: string; tokens: string[] } {
  const tokens: string[] = [];
  const text = t
    .split(/(\s+)/)
    .map((tok) => {
      if (!tok || /\s/.test(tok)) return tok;
      // pisahkan tanda baca penutup kalimat di akhir token
      const core = tok.replace(/[.,;:!?]+$/, "");
      if (core && (URLISH_RE.test(core) || DOMAIN_RE.test(core))) {
        const tail = tok.slice(core.length);
        const idx = tokens.push(core) - 1;
        return `${PLACE_TOKEN}${idx}${PLACE_TOKEN}${tail}`;
      }
      return tok;
    })
    .join("");
  return { text, tokens };
}

function restoreProtectedTokens(t: string, tokens: string[]): string {
  return t.replace(new RegExp(`${PLACE_TOKEN}(\\d+)${PLACE_TOKEN}`, "g"), (_, i) =>
    (tokens[Number(i)] ?? "").toUpperCase()
  );
}

/** Transform satu blok teks mentah menjadi teks prompter. */
export function formatPrompterText(raw: string): string {
  let t = raw;

  // 0a) Lindungi catatan sutradara [Teks] — tampil verbatim, tidak
  //     di-kapital dan tanda bacanya tidak dikonversi.
  const notes = extractNotes(t);
  t = notes.text;

  // 0b) Lindungi token URL, domain, dan email secara utuh
  //    (accurate.id, https://accurate.id/promo, halo@accurate.id)
  const protectedTokens = extractProtectedTokens(t);
  t = protectedTokens.text;

  // 1) Lindungi titik & koma di antara dua digit (100.000 / 2,5)
  t = t.replace(/(\d)\.(?=\d)/g, `$1${PLACE_DOT}`);
  t = t.replace(/(\d),(?=\d)/g, `$1${PLACE_COMMA}`);

  // 2) Lindungi singkatan umum (titiknya dihilangkan)
  for (const abbr of ABBREVIATIONS) {
    const bare = abbr.replace(/\./g, "");
    t = t.replace(new RegExp(`(^|[\\s(])${escapeRegExp(abbr)}`, "g"), `$1${bare}`);
  }
  // Pola inisial berantai seperti "P.T." atau "a.n." yang belum terdaftar
  t = t.replace(/\b([A-Za-z])\.(?=[A-Za-z]\.)/g, "$1");
  t = t.replace(/\b([A-Za-z])\.(?=[A-Za-z]\b)/g, "$1");

  // 3) Elipsis "..." -> satu jeda panjang
  t = t.replace(/\.{2,}/g, "//");

  // 4) Konversi tanda baca.
  //    Titik -> "//". Koma, titik dua, titik koma -> "/".
  //    Tanda tanya "?" dan seru "!" DIBIARKAN apa adanya (bukan jeda).
  t = t.replace(/\./g, "//");
  t = t.replace(/[,;:]/g, "/");

  // 5) Kembalikan angka
  t = t.replace(new RegExp(PLACE_DOT, "g"), ".");
  t = t.replace(new RegExp(PLACE_COMMA, "g"), ",");

  // 6) Normalisasi spasi: tepat satu spasi sebelum & sesudah setiap
  //    "/" atau "//" — berlaku untuk hasil konversi maupun slash yang
  //    memang sudah ada di naskah sumber.
  t = t.replace(/\s*(\/+)\s*/g, " $1 ");
  t = t.replace(/\s{2,}/g, " ");
  t = t.trim();

  // 7) Kapital semua
  t = t.toUpperCase();

  // 8) Kembalikan token URL/domain/email apa adanya (versi kapital)
  t = restoreProtectedTokens(t, protectedTokens.tokens);

  // 9) Kembalikan catatan sutradara persis seperti aslinya
  t = restoreNotes(t, notes.notes);

  return t;
}

export type SegKind = "text" | "note" | "slash";

export interface Segment {
  kind: SegKind;
  text: string;
}

/** Pecah paragraf terformat menjadi segmen: teks biasa, catatan [Teks],
 *  dan penanda jeda "/" atau "//" (agar bisa diwarnai terpisah). */
export function splitSegments(p: string): Segment[] {
  const out: Segment[] = [];
  const parts = p.split(/(\[[^\][\n]*\])/g).filter((s) => s.length > 0);
  for (const part of parts) {
    if (/^\[[^\][\n]*\]$/.test(part)) {
      out.push({ kind: "note", text: part });
      continue;
    }
    for (const s of part.split(/(\/+)/g).filter((x) => x.length > 0)) {
      out.push({ kind: /^\/+$/.test(s) ? "slash" : "text", text: s });
    }
  }
  return out;
}

/** Pecah teks mentah menjadi paragraf prompter (baris kosong = pemisah). */
export function toParagraphs(raw: string): string[] {
  return raw
    .replace(/\r\n/g, "\n")
    .split(/\n+/)
    .map((p) => formatPrompterText(p.trim()))
    .map((p) => p.replace(/\s{2,}/g, " ").trim())
    .filter((p) => p.length > 0);
}

/** Hitung jumlah kata dari teks mentah (untuk estimasi durasi baca).
 *  Catatan sutradara [Teks] tidak dihitung karena tidak dibaca talent. */
export function countWords(raw: string): number {
  const spoken = raw.replace(NOTE_RE, " ");
  const words = spoken.trim().split(/\s+/).filter(Boolean);
  return words.length;
}

/** Estimasi durasi baca dalam detik (default 140 kata per menit). */
export function estimateSeconds(raw: string, wpm = 140): number {
  return Math.round((countWords(raw) / wpm) * 60);
}

export function formatDuration(totalSeconds: number): string {
  const m = Math.floor(totalSeconds / 60);
  const s = totalSeconds % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}
