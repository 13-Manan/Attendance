import Link from "next/link";
import { requirePermissionOrRedirect } from "@/modules/auth-tenancy/session";
import {
  buildAcademicUnitTree,
  listAcademicUnitsForRequest,
  type AcademicUnitTreeNode,
} from "@/modules/academic-structure/service";
import { getInstitutionById } from "@/modules/institutions/repository";
import { resolveAcademicUnitLabels } from "@/modules/institutions/service";

function renderNode(
  node: AcademicUnitTreeNode,
  labels: Record<string, string>,
  depth: number,
): React.ReactNode {
  return (
    <li key={node.id} className="flex flex-col">
      <span className="flex items-baseline gap-2">
        <span className="text-neutral-900" style={{ paddingLeft: depth * 12 }}>
          {node.name}
        </span>
        <span className="text-xs text-neutral-500">{labels[node.kind] ?? node.kind}</span>
        {node.code && <span className="text-xs text-neutral-400">({node.code})</span>}
      </span>
      {node.children.length > 0 && (
        <ul className="flex flex-col">{node.children.map((c) => renderNode(c, labels, depth + 1))}</ul>
      )}
    </li>
  );
}

export default async function AcademicUnitsPage() {
  const user = await requirePermissionOrRedirect("academicStructure.manage");
  if (!user.institutionId) {
    return <p className="text-sm text-neutral-500">Platform-level accounts aren&apos;t scoped to an institution.</p>;
  }

  const [units, institution] = await Promise.all([
    listAcademicUnitsForRequest(user, user.institutionId),
    getInstitutionById(user.institutionId),
  ]);
  const tree = buildAcademicUnitTree(units);
  const labels = (institution ? resolveAcademicUnitLabels(institution) : {}) as Record<string, string>;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold text-neutral-900">
          {institution?.type === "COLLEGE" ? "Departments / Semesters / Courses" : "Classes / Sections"}
        </h2>
        <Link
          href="/dashboard/academic/units/new"
          className="rounded-md bg-neutral-900 px-4 py-2 text-sm font-medium text-white hover:bg-neutral-700"
        >
          New unit
        </Link>
      </div>
      {tree.length === 0 ? (
        <p className="text-sm text-neutral-500">No academic units yet.</p>
      ) : (
        <ul className="flex flex-col gap-1 text-sm">{tree.map((n) => renderNode(n, labels, 0))}</ul>
      )}
    </div>
  );
}
