-- UAS Foundation Migration (TASK-001 / AD-02)
-- 1. Pengguna: aktif, terakhir_masuk_pada, dibuat_oleh, diubah_pada
-- 2. Pelanggan: email_terverifikasi_pada
-- 3. Produk: gambar_url (preserving legacy BLOB columns untouched)
-- 4. PasswordResetToken (SHA-256 single-use tokens)
-- 5. Hybrid RAG tables: ai_document, ai_chunk, ai_conversation, ai_message

ALTER TABLE `pengguna`
  ADD COLUMN `aktif` BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN `terakhir_masuk_pada` DATETIME(0) NULL,
  ADD COLUMN `dibuat_oleh` INTEGER NULL,
  ADD COLUMN `diubah_pada` DATETIME(0) NOT NULL DEFAULT CURRENT_TIMESTAMP(0),
  ADD INDEX `pengguna_aktif_peran_idx` (`aktif`, `peran`);

ALTER TABLE `pengguna`
  MODIFY COLUMN `diubah_pada` DATETIME(0) NOT NULL;

ALTER TABLE `pelanggan`
  ADD COLUMN `email_terverifikasi_pada` DATETIME(0) NULL;

ALTER TABLE `produk`
  ADD COLUMN `gambar_url` TEXT NULL;

CREATE TABLE `password_reset_token` (
  `id` INTEGER NOT NULL AUTO_INCREMENT,
  `token_hash` VARCHAR(64) NOT NULL,
  `purpose` ENUM('RESET_PASSWORD', 'VERIFY_EMAIL', 'ADMIN_INVITE') NOT NULL,
  `target_type` ENUM('ADMIN', 'CUSTOMER') NOT NULL,
  `pengguna_id` INTEGER NULL,
  `pelanggan_id` INTEGER NULL,
  `expires_at` DATETIME(0) NOT NULL,
  `used_at` DATETIME(0) NULL,
  `created_at` DATETIME(0) NOT NULL DEFAULT CURRENT_TIMESTAMP(0),
  UNIQUE INDEX `password_reset_token_token_hash_key` (`token_hash`),
  INDEX `password_reset_token_purpose_expires_at_idx` (`purpose`, `expires_at`),
  INDEX `password_reset_token_pengguna_id_idx` (`pengguna_id`),
  INDEX `password_reset_token_pelanggan_id_idx` (`pelanggan_id`),
  PRIMARY KEY (`id`),
  CONSTRAINT `password_reset_token_pengguna_id_fkey`
    FOREIGN KEY (`pengguna_id`) REFERENCES `pengguna` (`id`) ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT `password_reset_token_pelanggan_id_fkey`
    FOREIGN KEY (`pelanggan_id`) REFERENCES `pelanggan` (`id`) ON DELETE CASCADE ON UPDATE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `ai_document` (
  `id` INTEGER NOT NULL AUTO_INCREMENT,
  `title` VARCHAR(200) NOT NULL,
  `source_type` ENUM('SOP', 'FAQ', 'PRODUK', 'CMS', 'MANUAL') NOT NULL,
  `source_ref` VARCHAR(150) NULL,
  `role_scope` ENUM('ALL_ADMIN', 'SUPER_ADMIN') NOT NULL DEFAULT 'ALL_ADMIN',
  `content` LONGTEXT NOT NULL,
  `aktif` BOOLEAN NOT NULL DEFAULT true,
  `created_by` INTEGER NULL,
  `created_at` DATETIME(0) NOT NULL DEFAULT CURRENT_TIMESTAMP(0),
  `updated_at` DATETIME(0) NOT NULL,
  INDEX `ai_document_source_type_aktif_idx` (`source_type`, `aktif`),
  INDEX `ai_document_role_scope_aktif_idx` (`role_scope`, `aktif`),
  PRIMARY KEY (`id`),
  CONSTRAINT `ai_document_created_by_fkey`
    FOREIGN KEY (`created_by`) REFERENCES `pengguna` (`id`) ON DELETE SET NULL ON UPDATE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `ai_chunk` (
  `id` INTEGER NOT NULL AUTO_INCREMENT,
  `document_id` INTEGER NOT NULL,
  `chunk_index` INTEGER NOT NULL,
  `content` TEXT NOT NULL,
  `embedding` JSON NOT NULL,
  `role_scope` ENUM('ALL_ADMIN', 'SUPER_ADMIN') NOT NULL,
  `created_at` DATETIME(0) NOT NULL DEFAULT CURRENT_TIMESTAMP(0),
  INDEX `ai_chunk_document_id_idx` (`document_id`),
  INDEX `ai_chunk_role_scope_idx` (`role_scope`),
  PRIMARY KEY (`id`),
  CONSTRAINT `ai_chunk_document_id_fkey`
    FOREIGN KEY (`document_id`) REFERENCES `ai_document` (`id`) ON DELETE CASCADE ON UPDATE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `ai_conversation` (
  `id` INTEGER NOT NULL AUTO_INCREMENT,
  `pengguna_id` INTEGER NOT NULL,
  `title` VARCHAR(200) NOT NULL,
  `created_at` DATETIME(0) NOT NULL DEFAULT CURRENT_TIMESTAMP(0),
  `updated_at` DATETIME(0) NOT NULL,
  INDEX `ai_conversation_pengguna_id_updated_at_idx` (`pengguna_id`, `updated_at`),
  PRIMARY KEY (`id`),
  CONSTRAINT `ai_conversation_pengguna_id_fkey`
    FOREIGN KEY (`pengguna_id`) REFERENCES `pengguna` (`id`) ON DELETE CASCADE ON UPDATE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `ai_message` (
  `id` INTEGER NOT NULL AUTO_INCREMENT,
  `conversation_id` INTEGER NOT NULL,
  `role` ENUM('USER', 'ASSISTANT') NOT NULL,
  `content` LONGTEXT NOT NULL,
  `route_path` ENUM('SQL_TOOL', 'VECTOR_RAG', 'ACTION_DRAFT', 'REFUSAL') NULL,
  `citations` JSON NULL,
  `actions` JSON NULL,
  `created_at` DATETIME(0) NOT NULL DEFAULT CURRENT_TIMESTAMP(0),
  INDEX `ai_message_conversation_id_created_at_idx` (`conversation_id`, `created_at`),
  PRIMARY KEY (`id`),
  CONSTRAINT `ai_message_conversation_id_fkey`
    FOREIGN KEY (`conversation_id`) REFERENCES `ai_conversation` (`id`) ON DELETE CASCADE ON UPDATE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
