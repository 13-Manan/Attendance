// Liveness check for the web app itself. Deliberately has no dependency on
// Prisma/env so it works even before DATABASE_URL is configured.
export async function GET() {
  return Response.json({ status: "ok" });
}
