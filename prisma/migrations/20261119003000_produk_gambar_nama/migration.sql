-- Keep the uploaded filename so product image changes are readable in the audit history.
ALTER TABLE `produk`
  ADD COLUMN `gambar_nama` VARCHAR(255) NULL;
