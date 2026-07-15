// Konfigurasi koneksi bawaan (ditanam di kode).
// Isi kedua nilai ini sebelum deploy ke Vercel.
// Pengguna di tablet cukup memasukkan PASSWORD = 6 karakter terakhir token.

export const APP_CONFIG = {
  // Tempel URL Web App Apps Script (yang berakhiran /exec) di sini:
  gasUrl: "https://script.google.com/macros/s/AKfycbw8RWTNoXWKacKlgqxLOXncoRdpn2OkoWrR4Aq4sP9AfIVeciSi9v7SyyIZSlnRpWFz/exec",
  // Token dari Script Properties (hasil setupToken()):
  gasToken: "e8ad7c883e9d4b738e1e7013b5fa7060",
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
