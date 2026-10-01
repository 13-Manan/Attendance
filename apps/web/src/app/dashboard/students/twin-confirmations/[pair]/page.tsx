import { notFound, redirect } from "next/navigation";
import { requireUser } from "@/modules/auth-tenancy/session";
import { ForbiddenError } from "@/modules/authorization/types";
import { getTwinConfirmation } from "@/modules/twin-confirmation/service";
import { TwinConfirmationError, type TwinConfirmationDetail } from "@/modules/twin-confirmation/types";
import { PageTrail } from "@/components/nav/page-trail";
import { TwinConfirmationReviewView } from "../twin-views";

interface PageProps {
  params: Promise<{ pair: string }>;
}

const LIST = "/dashboard/students/twin-confirmations";

/**
 * One pair, for a reviewer to decide. A pair that does not exist and a pair
 * outside the reviewer's authority are the same 404, so the page cannot be
 * used to learn which students elsewhere have a conflict.
 */
export default async function TwinConfirmationReviewPage({ params }: PageProps) {
  const user = await requireUser();
  const { pair } = await params;

  let detail: TwinConfirmationDetail;
  try {
    detail = await getTwinConfirmation(user, decodeURIComponent(pair));
  } catch (error) {
    if (error instanceof ForbiddenError) redirect("/unauthorized");
    if (error instanceof TwinConfirmationError) notFound();
    throw error;
  }

  const { blocked, matched } = detail.item;
  return (
    <div className="flex w-full max-w-4xl flex-col gap-5">
      <PageTrail
        items={[
          { label: "Students", href: "/dashboard/students" },
          { label: "Twin / Lookalike confirmations", href: LIST },
          { label: `${blocked.firstName} ${blocked.lastName} & ${matched.firstName} ${matched.lastName}` },
        ]}
      />
      <header className="flex flex-col gap-1">
        <h1 className="text-xl font-semibold tracking-tight text-neutral-900">Review twin / lookalike confirmation</h1>
        <p className="text-sm text-neutral-500">
          Decide whether these two students are different people. The decision applies to this pair only.
        </p>
      </header>
      <TwinConfirmationReviewView detail={detail} departmentId={null} listHref={LIST} />
    </div>
  );
}
