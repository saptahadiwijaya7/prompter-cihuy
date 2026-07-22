// Konfigurasi koneksi bawaan.
// PRIORITAS: environment variable Vercel (NEXT_PUBLIC_GAS_URL /
// NEXT_PUBLIC_GAS_TOKEN) — isi sekali di dashboard Vercel, tidak akan
// tertimpa saat kode di-update. Nilai di bawah hanya fallback.
// Pengguna cukup memasukkan PASSWORD = 6 karakter terakhir token.

export const APP_CONFIG = {
  gasUrl:
    process.env.NEXT_PUBLIC_GAS_URL ?? "PASTE_URL_WEB_APP_DISINI",
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
