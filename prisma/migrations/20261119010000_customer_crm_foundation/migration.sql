-- Customer management and CRM draft foundation. Email delivery is not enabled here.
ALTER TABLE `pelanggan`
  ADD COLUMN `terakhir_masuk_pada` DATETIME(0) NULL,
  ADD COLUMN `promosi_diizinkan` BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN `promosi_disetujui_pada` DATETIME(0) NULL,
  ADD COLUMN `promosi_berhenti_pada` DATETIME(0) NULL,
  ADD INDEX `pelanggan_aktif_terakhir_masuk_pada_idx` (`aktif`, `terakhir_masuk_pada`),
  ADD INDEX `pelanggan_promosi_diizinkan_idx` (`promosi_diizinkan`);

CREATE TABLE `kampanye_pelanggan` (
  `id` INTEGER NOT NULL AUTO_INCREMENT,
  `judul` VARCHAR(150) NOT NULL,
  `subjek` VARCHAR(200) NOT NULL,
  `isi` TEXT NOT NULL,
  `segmen` ENUM('SEMUA_BERIZIN', 'BELUM_PERNAH_MEMESAN', 'TIDAK_MEMESAN_LAGI') NOT NULL,
  `hari_tidak_memesan` INTEGER NULL,
  `status` ENUM('DRAF') NOT NULL DEFAULT 'DRAF',
  `dibuat_oleh` INTEGER NOT NULL,
  `dibuat_pada` DATETIME(0) NOT NULL DEFAULT CURRENT_TIMESTAMP(0),
  `diubah_pada` DATETIME(0) NOT NULL,
  INDEX `kampanye_pelanggan_dibuat_pada_idx` (`dibuat_pada`),
  PRIMARY KEY (`id`),
  CONSTRAINT `kampanye_pelanggan_dibuat_oleh_fkey`
    FOREIGN KEY (`dibuat_oleh`) REFERENCES `pengguna` (`id`) ON DELETE RESTRICT ON UPDATE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
