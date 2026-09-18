import { requirePermissionOrRedirect } from "@/modules/auth-tenancy/session";
import { prisma } from "@/lib/prisma";
import { listActiveEmbeddingMetadataForStudent } from "@/modules/face-enrollment/repository";
import { SelfEnrollmentClient } from "./self-enrollment-client";

export default async function StudentSelfEnrollFacePage() {
  const user = await requirePermissionOrRedirect("faceEmbedding.enroll.own");

  // We look up the CALLER's linked Student profile server-side — the client
  // never learns another studentId, and the Server Action doesn't accept
  // one either (see modules/face-enrollment/actions.ts#enrollOwnFace).
  const student = await prisma.student.findUnique({ where: { userId: user.userId } });
  if (!student) {
    return (
      <div className="mx-auto flex max-w-md flex-col gap-4">
        <h1 className="text-xl font-semibold text-neutral-900">Face enrollment</h1>
        <p className="text-sm text-neutral-500">
          Your account is not linked to a student profile. Please contact your institution&apos;s admin.
        </p>
      </div>
    );
  }

  const embeddings = await listActiveEmbeddingMetadataForStudent(student.id);

  return (
    <div className="mx-auto flex max-w-md flex-col gap-6">
      <header>
        <h1 className="text-xl font-semibold text-neutral-900">Face enrollment</h1>
        <p className="text-xs text-neutral-500">
          Your face template is protected biometric data. It is used only to mark you present in your enrolled
          classes; the raw camera image is never stored.
        </p>
      </header>

      <SelfEnrollmentClient />

      <section className="flex flex-col gap-2">
        <h2 className="text-sm font-semibold text-neutral-900">
          Your active samples ({embeddings.length})
        </h2>
        {embeddings.length === 0 ? (
          <p className="text-sm text-neutral-500">No face samples enrolled yet.</p>
        ) : (
          <ul className="flex flex-col gap-1 text-sm text-neutral-500">
            {embeddings.map((e) => (
              <li key={e.id}>Enrolled {e.createdAt.toISOString().slice(0, 16).replace("T", " ")}</li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
