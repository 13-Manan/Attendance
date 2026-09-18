import Link from "next/link";

export default function UnauthorizedPage() {
  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-3 p-8 text-center">
      <h1 className="text-2xl font-semibold text-neutral-900">403 — Not authorized</h1>
      <p className="max-w-sm text-sm text-neutral-500">
        Your account doesn&apos;t have permission to view this page. If you believe this is a
        mistake, contact your institution administrator.
      </p>
      <Link href="/dashboard" className="mt-2 text-sm font-medium text-neutral-900 underline">
        Back to dashboard
      </Link>
    </main>
  );
}
