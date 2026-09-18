import { PrismaClient } from "@prisma/client";

// Standard Next.js dev hot-reload guard: without this, each module reload
// would open a new PrismaClient (and a new DB connection pool).
const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

export const prisma = globalForPrisma.prisma ?? new PrismaClient();

if (process.env.NODE_ENV !== "production") {
  globalForPrisma.prisma = prisma;
}
