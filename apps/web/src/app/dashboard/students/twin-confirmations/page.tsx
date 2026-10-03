import { redirect } from "next/navigation";
import { requireUser } from "@/modules/auth-tenancy/session";
import { ForbiddenError } from "@/modules/authorization/types";
import { listKnownTwinPairs, listTwinConfirmations } from "@/modules/twin-confirmation/service";
import type { KnownTwinPairList, TwinConfirmationList } from "@/modules/twin-confirmation/types";
import { PageTrail } from "@/components/nav/page-trail";
import { KnownPairsSection } from "./known-pairs";
import { TwinConfirmationListView } from "./twin-views";

interface PageProps {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

const BASE = "/dashboard/students/twin-confirmations";

/**
 * Twin / lookalike confirmations for the institution: a principal or director
 * sees every pair, a school's class teacher the pairs within their own
 * classes. Who may see what is decided in modules/twin-confirmation; anybody
 * who may not review at all is sent to /unauthorized.
 */
export default async function TwinConfirmationsPage({ searchParams }: PageProps) {
  const user = await requireUser();
  const query = await searchParams;

  let list: TwinConfirmationList;
  let known: KnownTwinPairList;
  try {
    [list, known] = await Promise.all([listTwinConfirmations(user), listKnownTwinPairs(user)]);
  } catch (error) {
    if (error instanceof ForbiddenError) redirect("/unauthorized");
    throw error;
  }

  const decided = typeof query.decided === "string" ? query.decided : null;
  // Sent from a student's record to mark a pair with them in it.
  const declare = typeof query.declare === "string" ? query.declare : null;

  return (
    <div className="flex w-full max-w-4xl flex-col gap-5">
      <PageTrail
        items={[{ label: "Students", href: "/dashboard/students" }, { label: "Twin / Lookalike confirmations" }]}
      />
      <header className="flex flex-col gap-1">
        <h1 className="text-xl font-semibold tracking-tight text-neutral-900 sm:text-2xl">
          Twin / Lookalike confirmations
        </h1>
        <p className="max-w-3xl text-sm text-neutral-500">
          When a student&apos;s face matches another enrolled student, face enrollment stops until somebody who
          knows both of them decides. Confirm a pair only if they are two different people; a student can never
          confirm this for themselves.
        </p>
      </header>
      <TwinConfirmationListView
        list={list}
        itemHref={(pair) => `${BASE}/${encodeURIComponent(pair)}`}
        decided={decided}
        known={
          <KnownPairsSection
            list={known}
            departmentId={null}
            initialStudentId={declare}
            studentHref={(studentId) => `/dashboard/students/${encodeURIComponent(studentId)}`}
          />
        }
      />
    </div>
  );
}
