import { redirect } from "next/navigation";
import { requireUser } from "@/modules/auth-tenancy/session";
import { hasPermission } from "@/modules/authorization/service";
import { getInstitutionIdentity } from "@/modules/institutions/repository";
import { Breadcrumbs } from "@/components/nav/breadcrumbs";
import { Sidebar } from "@/components/nav/sidebar";
import { Topbar } from "@/components/nav/topbar";
import { SyncProvider } from "@/components/offline/sync-provider";

export default async function DashboardLayout({ children }: LayoutProps<"/dashboard">) {
  // The real security boundary for everything under /dashboard — proxy.ts
  // only redirects on cookie presence as a UX nicety, this is what actually
  // enforces authentication (see ARCHITECTURE.md).
  const user = await requireUser();

  // A student's account has no staff screen. `/dashboard` itself already sends
  // one to the portal; this does the same for every page under it. It matters
  // because the STUDENT role holds `cohort.read` for the portal's sake, which
  // on its own opens the institution-wide class directory — and a student
  // account a head of department created, and whose first password they were
  // shown, must not open a directory the head's own role deliberately lacks.
  // The same test as dashboard/page.tsx: only a student account reads its own
  // attendance without reading anyone else's.
  if (!hasPermission(user, "attendanceRecord.read") && hasPermission(user, "attendanceRecord.read.own")) {
    redirect("/portal");
  }

  // Two columns, so the sidebar can call a thing by the name this institution
  // uses for it and the topbar can say which institution that is. Deliberately
  // not the whole row: this runs on every staff page, and nothing in the
  // chrome reads the settings JSON.
  //
  // The id comes from the server session, never from a route param or a
  // header — which is what makes the institution shown here the same one
  // every query on the page below is scoped to.
  const institution = user.institutionId
    ? await getInstitutionIdentity(user.institutionId)
    : null;

  // SyncProvider wraps the whole dashboard rather than the capture flow, so a
  // register queued in a classroom keeps syncing while the teacher is reading
  // a report. It renders no markup of its own — the layout below is unchanged.
  return (
    <SyncProvider userId={user.userId}>
      <div className="flex min-h-screen flex-col">
        <Topbar user={user} institutionName={institution?.name ?? null} />
        {/* Stacked on phones and tablets in portrait, side-by-side from `md`.
            `min-w-0` lets wide content (a roster table) scroll inside main
            instead of stretching the flex row and pushing the nav off-screen. */}
        <div className="flex flex-1 flex-col md:flex-row">
          <Sidebar user={user} institutionKind={institution?.type ?? null} />
          <main className="min-w-0 flex-1 p-4 sm:p-6">
            {/* Renders nothing on /dashboard itself. */}
            <Breadcrumbs />
            {children}
          </main>
        </div>
      </div>
    </SyncProvider>
  );
}
