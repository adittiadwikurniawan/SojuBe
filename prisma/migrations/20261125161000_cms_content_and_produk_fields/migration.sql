-- Migration: Add cms_content table and missing produk fields
CREATE TABLE IF NOT EXISTS `cms_content` (
  `id` INT NOT NULL AUTO_INCREMENT,
  `key` VARCHAR(100) NOT NULL,
  `judul` VARCHAR(255) NOT NULL,
  `sub_judul` TEXT NULL,
  `konten` TEXT NULL,
  `aktif` BOOLEAN NOT NULL DEFAULT TRUE,
  `dibuat_oleh` INT NOT NULL,
  `dibuat_pada` DATETIME(0) NOT NULL DEFAULT CURRENT_TIMESTAMP(0),
  `diubah_pada` DATETIME(0) NOT NULL DEFAULT CURRENT_TIMESTAMP(0) ON UPDATE CURRENT_TIMESTAMP(0),
  PRIMARY KEY (`id`),
  UNIQUE KEY `cms_content_key_key` (`key`),
  CONSTRAINT `cms_content_dibuat_oleh_fkey` FOREIGN KEY (`dibuat_oleh`) REFERENCES `pengguna` (`id`) ON DELETE RESTRICT ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

ALTER TABLE `produk`
  ADD COLUMN IF NOT EXISTS `gambar` TEXT NULL,
  ADD COLUMN IF NOT EXISTS `gambar_data` LONGBLOB NULL,
  ADD COLUMN IF NOT EXISTS `gambar_mime` VARCHAR(100) NULL,
  ADD COLUMN IF NOT EXISTS `deskripsi` TEXT NULL;
