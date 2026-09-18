export default function HomePage() {
  return (
    <main className="flex flex-1 flex-col items-center justify-center gap-4 p-8 text-center">
      <h1 className="text-2xl font-semibold">Attendance Platform</h1>
      <p className="max-w-md text-sm text-neutral-500">
        Foundation phase — architecture scaffold only. See{" "}
        <code className="rounded bg-neutral-500/10 px-1 py-0.5">ARCHITECTURE.md</code>{" "}
        at the repo root for module and API boundaries.
      </p>
    </main>
  );
}
