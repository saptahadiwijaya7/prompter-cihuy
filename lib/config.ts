// Konfigurasi koneksi bawaan.
// PRIORITAS: environment variable Vercel (NEXT_PUBLIC_GAS_URL /
// NEXT_PUBLIC_GAS_TOKEN) — isi sekali di dashboard Vercel, tidak akan
// tertimpa saat kode di-update. Nilai di bawah hanya fallback.
// Pengguna cukup memasukkan PASSWORD = 6 karakter terakhir token.

export const APP_CONFIG = {
  gasUrl:
    process.env.NEXT_PUBLIC_GAS_URL ?? "https://script.google.com/macros/s/AKfycbw8RWTNoXWKacKlgqxLOXncoRdpn2OkoWrR4Aq4sP9AfIVeciSi9v7SyyIZSlnRpWFz/exec",
  gasToken:
    process.env.NEXT_PUBLIC_GAS_TOKEN ??
    "e8ad7c883e9d4b738e1e7013b5fa7060",
};

/** Konfigurasi bawaan dianggap terisi jika URL valid dan token cukup panjang. */
export function hasBuiltInConfig(): boolean {
  return (
    APP_CONFIG.gasUrl.startsWith("https://") && APP_CONFIG.gasToken.length >= 6
  );
}

/** Password aplikasi = 6 karakter terakhir token. */
export function passwordOf(token: string): string {
  return token.slice(-6);
}

// ── Supabase Realtime (opsional) untuk remote latensi rendah ──
// anon key aman ditaruh di client (public by design). Isi via env var
// Vercel: NEXT_PUBLIC_SUPABASE_URL & NEXT_PUBLIC_SUPABASE_ANON_KEY.
export const SUPABASE_CONFIG = {
  url: process.env.NEXT_PUBLIC_SUPABASE_URL ?? "https://fuqbylijcummxjfuqpou.supabase.co",
  anonKey: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImZ1cWJ5bGlqY3VtbXhqZnVxcG91Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODQ3OTQzOTEsImV4cCI6MjEwMDM3MDM5MX0.sFn7paCzshdITcjxplc2nd9-0izr2uQefj2wQCiIdrw",
};

/** True jika Supabase Realtime dikonfigurasi (jalur cepat aktif). */
export function hasRealtime(): boolean {
  return (
    SUPABASE_CONFIG.url.startsWith("https://") &&
    SUPABASE_CONFIG.anonKey.length > 20
  );
}
