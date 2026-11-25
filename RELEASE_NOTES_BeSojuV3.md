# Release Notes — `BeSojuV3` (SOJU FnB Backend v3.0)

**Branch:** `BeSojuV3`  
**Repository:** `https://github.com/adittiadwikurniawan/SojuBe.git`  
**Base Branch:** `database-backend-v2.0`  
**Release Date:** 2026-11-25

---

## Ringkasan Rilis

`BeSojuV3` adalah upgrade besar backend SOJU FnB (Express 5 + TypeScript + Prisma 5 + MySQL) yang menghadirkan pondasi **Keamanan & Multi-User RBAC**, **Autentikasi Admin & Pelanggan lengkap (Verifikasi Email + Reset Password)**, **Penyimpanan Gambar S3-Compatible (MinIO/R2/Supabase)**, **Hybrid RAG AI Assistant (`@google/genai`)**, **Containerization (Docker)**, serta **201 Automated Tests + 16 Golden RAG Evaluation Cases**.

---

## Fitur & Perubahan Utama

### 1. Database Schema & Migrasi (`TASK-001`)
- Penambahan migrasi incremental `20261123092500_uas_auth_storage_rag_foundation`:
  - `Pengguna`: kolom `aktif` (default `true`), `terakhirMasukPada`, `dibuatOleh`, `diubahPada`.
  - `Pelanggan`: kolom `emailTerverifikasiPada`.
  - `Produk`: kolom `gambarUrl` (tetap backward-compatible dengan BLOB `gambarData`).
  - `PasswordResetToken`: penyimpanan token single-use berbasis hash `SHA-256` dengan `purpose` (`RESET_PASSWORD`, `VERIFY_EMAIL`, `ADMIN_INVITE`) dan `targetType` (`ADMIN`, `CUSTOMER`).
  - Model Hybrid RAG: `AiDocument`, `AiChunk` (`embedding Json`, `roleScope`), `AiConversation`, `AiMessage` (`routePath`, `citations`, `actions`).

### 2. Security Middleware, CORS, Health Check & Test Harness (`TASK-002`)
- Pemasangan `helmet` (`crossOriginResourcePolicy: 'cross-origin'`) dan `express-rate-limit` khusus endpoint autentikasi (`/api/v1/auth/*`, `/api/customer/auth`) dan AI (`/api/v1/ai/*`).
- Multi-origin CORS mendukung `CORS_ORIGIN`, `localhost` / `127.0.0.1` (termasuk port acak Flutter Web pada mode non-production), LAN `192.168.x.x` (non-production), serta native mobile client tanpa header `Origin`.
- Endpoint `GET /api/health` untuk readiness/liveness check konektivitas MySQL (`200` connected / `503` disconnected).
- Setup Vitest + Supertest (`npm test`) dan template `.env.example`.

### 3. Email Service & S3-Compatible Storage (`TASK-003`, `TASK-004`)
- `src/services/emailService.ts`: integrasi resmi **Resend SDK** untuk email reset password, verifikasi email pelanggan, dan undangan admin, dengan fallback aman ke console log lokal saat `RESEND_API_KEY` kosong.
- `src/services/storageService.ts`: upload gambar produk ke S3-compatible storage (MinIO path-style / Cloudflare R2 / Supabase Storage) dengan validasi MIME & batas 5 MB, serta fallback aman ke BLOB lama tanpa regresi.

### 4. Auth Lifecycle & SUPER_ADMIN Multi-User RBAC (`TASK-005` – `TASK-009`)
- `src/services/tokenService.ts`: token kriptografis 32-byte disimpan hanya sebagai hash `SHA-256`, TTL 30–60 menit, atomic single-use consumption, dan isolasi lintas target (`ADMIN` vs `CUSTOMER`).
- **Admin Auth**: penegakan `Pengguna.aktif` (`403` jika nonaktif), pencatatan `terakhirMasukPada`, serta `POST /api/v1/auth/forgot-password` & `POST /api/v1/auth/reset-password` dengan respons generik anti-enumerasi.
- **Customer Auth**: verifikasi email (`verifikasi-email`, `kirim-ulang-verifikasi`), lupa/reset password (`lupa-password`, `reset-password`), dan `POST /api/customer/ubah-password`.
- **Multi-User Management (`SUPER_ADMIN` only)**: `GET/POST/PATCH/DELETE /api/v1/users/*` + `POST /api/v1/users/:id/reset-password` lengkap dengan proteksi self-disable, self-demote, proteksi `SUPER_ADMIN` aktif terakhir, serta pencatatan `LogAudit`.
- Penyelarasan RBAC `/api/v1/products` (`ADMIN` & `SUPER_ADMIN`) dan isolasi ketat JWT `CUSTOMER` vs `ADMIN`/`SUPER_ADMIN`.

### 5. Hybrid RAG AI Assistant & Guardrails (`TASK-010` – `TASK-015`)
- Integrasi resmi `@google/genai` (`gemini-3.8-flash` & `gemini-embedding-001`).
- **Ingestion Pipeline (`ingestionService.ts`)**: chunking & embedding SOP/FAQ/Produk/CMS dengan kebijakan **No-PII** (menolak tabel `Pelanggan`/`PesananPelanggan` dan menyaring email/nomor telepon).
- **Deterministic SQL Tools (`sqlToolsService.ts`)**: query read-only ter-allowlist untuk ringkasan omzet/penjualan, transaksi terbaru, pesanan pelanggan, dan statistik produk dengan sitasi `[SQL-1]`.
- **Vector Retrieval (`vectorRetriever.ts`)**: cosine similarity `top_k = 3`, threshold relevansi, dan isolasi `roleScope` (`ADMIN` tidak dapat mengakses dokumen `SUPER_ADMIN`).
- **Human-in-the-Loop Action Draft (`actionDraftService.ts`)**: parsing intent tulis (`/add jual`, `/add beli`, dll.) menjadi draft card dengan `requiresConfirmation: true` dan **zero auto-commit**.
- **Intent Router & Prompt Guard (`intentRouter.ts`, `promptGuard.ts`, `aiChatService.ts`)**: routing deterministik (Write → Draft, Numeric → SQL, Knowledge → Vector RAG, Out-of-document → Refusal Bahasa Indonesia) + pembungkus `<untrusted_document>` anti prompt-injection.
- **HTTP Routes (`/api/v1/ai/*`)**: `POST /chat`, `GET /conversations`, `GET /conversations/:id` (`ADMIN` & `SUPER_ADMIN`, scoped ke user sendiri), serta `POST /reindex` & `POST /documents` (`SUPER_ADMIN` only + `LogAudit`).

### 6. Containerization & Golden Evaluation (`TASK-029`, `TASK-031`)
- Multi-stage `Dockerfile` (`node:22-alpine`) dengan `prisma generate`, `npx prisma migrate deploy && node dist/index.js`, `HEALTHCHECK` ke `/api/health`, serta `.dockerignore`.
- Golden Evaluation Suite (`npm run test:rag`) dengan **16 kasus uji** lintas 4 kategori wajib (`SQL_TOOL`, `VECTOR_RAG`, `REFUSAL`, `SECURITY_RBAC_INJECTION`).

---

## Verifikasi & Kualitas

| Pemeriksaan | Perintah | Hasil |
|---|---|---|
| TypeScript Build | `npm run build` | **PASS** (0 errors) |
| Unit & Integration Tests | `npm test` | **PASS** (16/16 test files, 201/201 tests) |
| Hybrid RAG Golden Eval | `npm run test:rag` | **PASS** (18/18 assertions, 16 golden cases) |

---

## Panduan Upgrade / Menjalankan Lokal

```bash
git checkout BeSojuV3
npm install
npx prisma generate
npx prisma migrate deploy
npm run prisma:seed
# (Opsional) Promosikan akun admin menjadi SUPER_ADMIN:
SUPER_ADMIN_EMAIL=admin@bukudapur.com npm run prisma:set-super-admin
npm run dev
```
