import crypto from "crypto";
import bcrypt from "bcryptjs";
import { PrismaClient, StaffRole, Gender, IdentifierType } from "@prisma/client";

const prisma = new PrismaClient();

function hashIdentifier(value: string): string {
  const pepper = process.env.PII_HASH_PEPPER || "dev_pepper";
  return crypto
    .createHmac("sha256", pepper)
    .update(value.trim().toLowerCase())
    .digest("hex");
}

function maskPhone(phone: string): string {
  const digits = phone.replace(/\D/g, "");
  const last4 = digits.slice(-4);
  return `***-***-${last4}`;
}

function maskCurp(curp: string): string {
  return `${curp.slice(0, 4)}**********${curp.slice(-4)}`;
}

async function main() {
  console.log("Iniciando seed de Salud Digna Omnicanal...");

  // 1. Usuarios operativos RBAC (Asesor Call Center y Administrador)
  const advisorPassword = await bcrypt.hash("Asesor2026!", 10);
  const adminPassword = await bcrypt.hash("Admin2026!", 10);

  const advisor = await prisma.staffUser.upsert({
    where: { email: "asesor@saluddigna.demo" },
    update: {},
    create: {
      email: "asesor@saluddigna.demo",
      passwordHash: advisorPassword,
      role: StaffRole.ASESOR,
      fullName: "Carlos Méndez (Asesor Call Center)",
      active: true,
    },
  });

  const admin = await prisma.staffUser.upsert({
    where: { email: "admin@saluddigna.demo" },
    update: {},
    create: {
      email: "admin@saluddigna.demo",
      passwordHash: adminPassword,
      role: StaffRole.ADMIN,
      fullName: "Laura Soto (Admin Transformación Digital)",
      active: true,
    },
  });

  // 2. Paciente demo oficial del caso de uso ("Ana") con los 9 campos del registro
  const anaPhone = "+526670000001";
  const anaCurp = "MORA950412MSLRRN01";

  const ana = await prisma.patient.upsert({
    where: { curp: anaCurp },
    update: {},
    create: {
      firstName: "Ana Sofía",
      paternalLastName: "Morales",
      maternalLastName: "Ramírez",
      birthDate: new Date("1995-04-12"),
      gender: Gender.FEMENINO,
      birthState: "Sinaloa",
      country: "México",
      curp: anaCurp,
      phone: anaPhone,
    },
  });

  // 3. Identity Links (Identity Resolution con hash + mascara PII)
  const phoneHash = hashIdentifier(anaPhone);
  const curpHash = hashIdentifier(anaCurp);

  await prisma.identityLink.upsert({
    where: {
      uq_identity_type_hash: {
        identifierType: IdentifierType.PHONE,
        identifierHash: phoneHash,
      },
    },
    update: {},
    create: {
      patientId: ana.id,
      identifierType: IdentifierType.PHONE,
      identifierHash: phoneHash,
      identifierMasked: maskPhone(anaPhone),
      verified: true,
      verifiedAt: new Date(),
    },
  });

  await prisma.identityLink.upsert({
    where: {
      uq_identity_type_hash: {
        identifierType: IdentifierType.CURP,
        identifierHash: curpHash,
      },
    },
    update: {},
    create: {
      patientId: ana.id,
      identifierType: IdentifierType.CURP,
      identifierHash: curpHash,
      identifierMasked: maskCurp(anaCurp),
      verified: true,
      verifiedAt: new Date(),
    },
  });

  console.log("Seed completado con exito:");
  console.log(` - Asesor:   ${advisor.email} (pass: Asesor2026!)`);
  console.log(` - Admin:    ${admin.email} (pass: Admin2026!)`);
  console.log(` - Paciente: ${ana.firstName} ${ana.paternalLastName} (${ana.phone})`);
}

main()
  .catch((err) => {
    console.error("Error ejecutando seed:", err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
