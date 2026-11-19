import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  const email = process.env.SUPER_ADMIN_EMAIL?.trim().toLowerCase();
  if (!email) throw new Error('Atur SUPER_ADMIN_EMAIL ke email akun admin yang akan menjadi Super Admin.');
  const user = await prisma.pengguna.findUnique({ where: { email }, select: { id: true, email: true } });
  if (!user) throw new Error(`Admin dengan email ${email} tidak ditemukan. Buat akun Admin lebih dahulu.`);
  await prisma.pengguna.update({ where: { id: user.id }, data: { peran: 'SUPER_ADMIN' } });
  console.log(`Role Super Admin diberikan ke ${user.email}.`);
}

main()
  .catch((error) => { console.error(error); process.exitCode = 1; })
  .finally(async () => { await prisma.$disconnect(); });
