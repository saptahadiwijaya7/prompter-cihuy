# Prompter Cihuy — v0.5.0-alpha

Teleprompter PWA untuk tablet Android dengan **live sync Google Docs**.

## Fitur

- **Live sync Google Docs** via Google Apps Script (polling 2,5 detik), posisi baca tidak lompat saat naskah berubah (anchor per paragraf)
- **Formatter otomatis**: KAPITAL semua, `,` → `/`, `.` → `//`, dengan proteksi angka Indonesia (`Rp2.500.000`, `2,5 juta`) dan singkatan umum
- **Fullscreen**, **mirror horizontal/vertikal**, **kecepatan px/detik**, **ukuran huruf**, **jarak baris**
- **Garis baca** dengan posisi bisa diatur (default 30% dari atas, ideal untuk kamera di atas kaca) + highlight baris aktif
- **Preset** (termasuk link naskah) tersimpan di localStorage
- **Dark / light mode**
- **Countdown 3-2-1**, ketuk layar untuk jeda/lanjut, jeda otomatis di akhir naskah
- **Wake Lock** — layar tablet tidak mati selama scroll berjalan
- **Offline fallback** — naskah terakhir tetap tampil kalau WiFi putus, dengan indikator status sync (lampu tally)
- **Estimasi durasi baca** (± 140 kata/menit)
- **Keyboard / remote Bluetooth**: `Spasi` jeda-lanjut, `↑↓` kecepatan, `R` reset, `F` fullscreen, `M` mirror
- **Mode teks manual** sebagai fallback tanpa Google Docs
- **Password koneksi**: URL Apps Script + token ditanam di kode (`lib/config.ts`); pengguna cukup memasukkan password (6 karakter terakhir token) sekali per perangkat
- **Proteksi URL/domain/email** di formatter: `accurate.id`, `https://accurate.id/promo`, `halo@accurate.id` tampil utuh
- **Remote control** dari HP di halaman `/remote` — play/pause/reset, kecepatan, ukuran huruf, jarak baris, posisi garis baca, mirror, tema — via relay Apps Script (CacheService), tanpa server tambahan. Pairing dengan kode ruang 4 digit.

## Setup

### 1. Apps Script (jembatan Google Docs)

1. Buka [script.google.com](https://script.google.com) → **New project** → paste isi `apps-script/Code.gs`.
2. Jalankan fungsi `setupToken()` sekali → izinkan akses → salin token dari **Logs**.
   (Token tersimpan di **Script Properties**, jadi aman saat Code.gs di-paste ulang.)
3. **Deploy → New deployment → Web app**
   - Execute as: **Me**
   - Who has access: **Anyone**
4. Salin URL `/exec`.

> Dokumen naskah harus bisa diakses akun pemilik script (milik sendiri atau di-share ke akun itu). Tidak perlu "Publish to web".

### 2. Isi konfigurasi bawaan

Buka `lib/config.ts` → isi `gasUrl` dengan URL `/exec` dan pastikan `gasToken` sesuai token di Script Properties. Password aplikasi otomatis = **6 karakter terakhir token**.

> Kalau `gasUrl` dibiarkan placeholder, aplikasi otomatis menampilkan input manual URL + token (mode lama) — berguna untuk deployment tanpa konfigurasi bawaan.

### 3. Deploy aplikasi ke Vercel

```bash
npm install
npm run build   # verifikasi
```

Push ke GitHub → import di Vercel. **Tidak ada environment variable yang dibutuhkan** — URL Apps Script + token diisi dari UI (Pengaturan koneksi) dan tersimpan di localStorage perangkat.

### 4. Di tablet

1. Buka URL Vercel di Chrome → menu → **Add to Home screen** (terpasang sebagai aplikasi, fullscreen + landscape).
2. Buka **Pengaturan koneksi Apps Script** → masukkan **password** (6 karakter terakhir token) → Simpan koneksi. Cukup sekali per perangkat.
3. Tempel link Google Docs → **HUBUNGKAN**.

## Update Code.gs di kemudian hari

Paste kode baru → **Deploy → Manage deployments → Edit → New version**. Token tidak perlu disentuh (Script Properties).

## Struktur

```
app/            layout, page, globals.css
components/     PrompterApp.tsx (engine scroll, polling, UI)
lib/            formatter.ts (aturan konversi), store.ts (preset & koneksi)
public/         manifest.json, sw.js, ikon PWA
apps-script/    Code.gs
```

## Remote control

1. **Tablet**: panel kiri → bagian **REMOTE** → *Aktifkan remote* → catat kode 4 digit.
2. **HP**: buka `https://<url-vercel>/remote` → masukkan password (sama, 6 karakter terakhir token) → masukkan kode ruang → **Sambungkan**.
3. HP menampilkan status live (progress %, berjalan/jeda, jumlah kata) dan semua kontrol dengan tombol besar (+/− per slider, cocok untuk jempol).
4. **Panel NASKAH**: remote menampilkan naskah yang sama persis dengan tablet (dikirim tablet lewat relay, jadi mode Google Docs maupun teks manual sama-sama tampil). Baris yang sedang di garis baca di-highlight dan otomatis diikuti (toggle *Ikuti baris*). **Ketuk/klik baris mana pun → tablet melompat ke baris itu** tepat di garis baca.
5. **Tampilan penuh** (tombol *▢ Penuh* di header): layout dua kolom untuk laptop — kontrol di kiri, naskah besar di kanan. Default tetap tampilan remote kompak.
6. **Kelola sumber naskah**: toggle *Tablet / Remote* di bagian SUMBER NASKAH (ada di kedua sisi, tersinkron). Saat **Remote**: menu ganti naskah (link Google Docs / teks manual) pindah ke halaman remote dan hilang dari tablet — praktis untuk pergantian naskah antar-take tanpa menyentuh tablet. Saat **Tablet** (default): sebaliknya. Sisi yang tidak memegang kendali tetap melihat toggle-nya agar kendali bisa diambil kembali kapan saja.

**Catatan latensi**: perintah lewat relay polling, jadi butuh ± 1,5–3 detik untuk sampai ke tablet. Untuk adjustment tampilan ini nyaman; untuk cue play/pause yang presisi detik, tetap gunakan Spasi/remote Bluetooth di tablet, atau tekan MULAI dari HP sedikit lebih awal (ada countdown 3-2-1 di tablet).

**Update Apps Script diperlukan**: paste `Code.gs` v0.5.0 → Deploy → Manage deployments → Edit → **New version**. Token & URL tidak berubah.
