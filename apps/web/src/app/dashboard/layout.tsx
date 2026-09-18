import { requireUser } from "@/modules/auth-tenancy/session";
import { getInstitutionType } from "@/modules/institutions/repository";
import { Sidebar } from "@/components/nav/sidebar";
import { Topbar } from "@/components/nav/topbar";
import { SyncProvider } from "@/components/offline/sync-provider";

export default async function DashboardLayout({ children }: LayoutProps<"/dashboard">) {
  // The real security boundary for everything under /dashboard — proxy.ts
  // only redirects on cookie presence as a UX nicety, this is what actually
  // enforces authentication (see ARCHITECTURE.md).
  const user = await requireUser();

  // One enum value, so the sidebar can call a thing by the name this
  // institution uses for it. Deliberately not the whole institution: this runs
  // on every staff page, and nothing here needs its settings.
  const institutionKind = user.institutionId ? await getInstitutionType(user.institutionId) : null;

  // SyncProvider wraps the whole dashboard rather than the capture flow, so a
  // register queued in a classroom keeps syncing while the teacher is reading
  // a report. It renders no markup of its own — the layout below is unchanged.
  return (
    <SyncProvider>
      <div className="flex min-h-screen flex-col">
        <Topbar user={user} />
        {/* Stacked on phones and tablets in portrait, side-by-side from `md`.
            `min-w-0` lets wide content (a roster table) scroll inside main
            instead of stretching the flex row and pushing the nav off-screen. */}
        <div className="flex flex-1 flex-col md:flex-row">
          <Sidebar user={user} institutionKind={institutionKind} />
          <main className="min-w-0 flex-1 p-4 sm:p-6">{children}</main>
        </div>
      </div>
    </SyncProvider>
  );
}
