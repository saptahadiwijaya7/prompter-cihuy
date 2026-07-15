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

  // 0) Lindungi token URL, domain, dan email secara utuh
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

  // 4) Konversi tanda baca
  t = t.replace(/[.?!]/g, "//");
  t = t.replace(/[,;:]/g, "/");

  // 5) Kembalikan angka
  t = t.replace(new RegExp(PLACE_DOT, "g"), ".");
  t = t.replace(new RegExp(PLACE_COMMA, "g"), ",");

  // 6) Rapikan spasi: "kata /" -> "kata/", "//kata" -> "// kata"
  t = t.replace(/\s+([/]+)/g, "$1");
  t = t.replace(/(\/+)(?=[^/\s])/g, "$1 ");

  // 7) Kapital semua
  t = t.toUpperCase();

  // 8) Kembalikan token URL/domain/email apa adanya (versi kapital)
  t = restoreProtectedTokens(t, protectedTokens.tokens);

  return t;
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

/** Hitung jumlah kata dari teks mentah (untuk estimasi durasi baca). */
export function countWords(raw: string): number {
  const words = raw.trim().split(/\s+/).filter(Boolean);
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
