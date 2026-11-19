-- Add roles to existing admin accounts and create customer storefront data.
ALTER TABLE `pengguna`
  ADD COLUMN `peran` ENUM('ADMIN', 'SUPER_ADMIN') NOT NULL DEFAULT 'ADMIN';

CREATE TABLE `pelanggan` (
  `id` INTEGER NOT NULL AUTO_INCREMENT,
  `nama` VARCHAR(100) NOT NULL,
  `email` VARCHAR(150) NOT NULL,
  `no_telepon` VARCHAR(30) NOT NULL,
  `alamat` TEXT NOT NULL,
  `password_hash` VARCHAR(255) NOT NULL,
  `keranjang` JSON NULL,
  `aktif` BOOLEAN NOT NULL DEFAULT true,
  `dibuat_pada` DATETIME(0) NOT NULL DEFAULT CURRENT_TIMESTAMP(0),
  `diubah_pada` DATETIME(0) NOT NULL,
  UNIQUE INDEX `pelanggan_email_key` (`email`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `pesanan_pelanggan` (
  `id` INTEGER NOT NULL AUTO_INCREMENT,
  `kode` VARCHAR(30) NOT NULL,
  `pelanggan_id` INTEGER NOT NULL,
  `nama_penerima` VARCHAR(100) NOT NULL,
  `email_penerima` VARCHAR(150) NOT NULL,
  `no_telepon` VARCHAR(30) NOT NULL,
  `alamat` TEXT NOT NULL,
  `total` DECIMAL(15, 2) NOT NULL,
  `status` ENUM('MENUNGGU_KONFIRMASI', 'DIPROSES', 'SELESAI', 'DIBATALKAN') NOT NULL DEFAULT 'MENUNGGU_KONFIRMASI',
  `dibuat_pada` DATETIME(0) NOT NULL DEFAULT CURRENT_TIMESTAMP(0),
  `diubah_pada` DATETIME(0) NOT NULL,
  UNIQUE INDEX `pesanan_pelanggan_kode_key` (`kode`),
  INDEX `pesanan_pelanggan_pelanggan_id_dibuat_pada_idx` (`pelanggan_id`, `dibuat_pada`),
  INDEX `pesanan_pelanggan_status_dibuat_pada_idx` (`status`, `dibuat_pada`),
  PRIMARY KEY (`id`),
  CONSTRAINT `pesanan_pelanggan_pelanggan_id_fkey`
    FOREIGN KEY (`pelanggan_id`) REFERENCES `pelanggan` (`id`) ON DELETE RESTRICT ON UPDATE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `item_pesanan_pelanggan` (
  `id` INTEGER NOT NULL AUTO_INCREMENT,
  `pesanan_id` INTEGER NOT NULL,
  `produk_id` INTEGER NULL,
  `nama_produk` VARCHAR(100) NOT NULL,
  `varian` VARCHAR(100) NULL,
  `satuan` VARCHAR(20) NULL,
  `harga` DECIMAL(15, 2) NOT NULL,
  `jumlah` INTEGER NOT NULL,
  `catatan` VARCHAR(255) NULL,
  `subtotal` DECIMAL(15, 2) NOT NULL,
  INDEX `item_pesanan_pelanggan_pesanan_id_idx` (`pesanan_id`),
  INDEX `item_pesanan_pelanggan_produk_id_idx` (`produk_id`),
  PRIMARY KEY (`id`),
  CONSTRAINT `item_pesanan_pelanggan_pesanan_id_fkey`
    FOREIGN KEY (`pesanan_id`) REFERENCES `pesanan_pelanggan` (`id`) ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT `item_pesanan_pelanggan_produk_id_fkey`
    FOREIGN KEY (`produk_id`) REFERENCES `produk` (`id`) ON DELETE SET NULL ON UPDATE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
