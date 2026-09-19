import { requirePermissionOrRedirect } from "@/modules/auth-tenancy/session";
import { hasPermission } from "@/modules/authorization/service";
import { getRetentionPolicy } from "@/modules/privacy/service";
import { getAdminSettings } from "@/modules/admin-settings/service";
import { getInstitutionProfileForRequest } from "@/modules/institution-profile/service";
import { listTimezoneOptions } from "@/modules/institution-profile/policy";
import { RetentionForm, RetentionSweepPanel } from "./retention-form";
import { AttendanceSettingsForm, FixedAttendanceRules } from "./attendance-settings-form";
import { FacePolicyForm } from "./face-policy-form";
import { SelfEnrollmentForm } from "./self-enrollment-form";
import { InstitutionProfileForm, InstitutionProfileSummary } from "./profile-form";

export default async function InstitutionSettingsPage() {
  // Server-side enforced: a user without institution.read never sees this
  // page's content, no matter what URL they type — see proxy.ts's doc
  // comment and ARCHITECTURE.md.
  const user = await requirePermissionOrRedirect("institution.read");

  if (!user.institutionId) {
    return (
      <p className="text-sm text-neutral-500">
        Platform-level accounts aren&apos;t scoped to a single institution.
      </p>
    );
  }

  // The profile carries the name, type, time zone, contact details and the
  // academic-unit labels, all resolved. It is read with the same
  // `institution.read` this page already required; saving it needs
  // `institution.update`, which the service re-checks.
  const profile = await getInstitutionProfileForRequest(user);

  // The policy is read with the same `institution.read` this page already
  // required; editing it needs `institution.update` and running the sweep needs
  // `faceEmbedding.manage`, so a reader sees the policy without being offered
  // controls the server would refuse. Both are re-checked in the service — this
  // decides what to render, not what is allowed.
  const retentionPolicy = await getRetentionPolicy(user);
  const mayEditPolicy = hasPermission(user, "institution.update");
  const mayRunSweep = hasPermission(user, "faceEmbedding.manage");

  // Attendance and recognition settings, read with the same `institution.read`
  // and gated for editing by the same `institution.update` as the retention
  // policy above. The service re-checks both.
  const adminSettings = await getAdminSettings(user);

  return (
    <div className="flex max-w-2xl flex-col gap-6">
      <h1 className="text-xl font-semibold text-neutral-900">Institution Settings</h1>

      {mayEditPolicy ? (
        <InstitutionProfileForm
          profile={profile}
          timezones={listTimezoneOptions(profile.timezone)}
        />
      ) : (
        <InstitutionProfileSummary profile={profile} />
      )}

      {mayEditPolicy ? (
        <AttendanceSettingsForm
          attendanceMode={adminSettings.attendanceMode}
          lowAttendanceThreshold={adminSettings.lowAttendanceThreshold}
          policy={adminSettings.attendancePolicy}
        />
      ) : (
        <dl className="grid grid-cols-[max-content_1fr] gap-x-6 gap-y-2 text-sm">
          <dt className="text-neutral-500">Low attendance threshold</dt>
          <dd className="text-neutral-900">{adminSettings.lowAttendanceThreshold}%</dd>
          <dt className="text-neutral-500">Correcting a finalized register</dt>
          <dd className="text-neutral-900">
            {adminSettings.attendancePolicy.correctionWindowDays === 0
              ? "Allowed with no time limit"
              : `Allowed for ${adminSettings.attendancePolicy.correctionWindowDays} days after finalization`}
            {adminSettings.attendancePolicy.requireReasonAfterFinalization
              ? ", and a written reason is required"
              : ""}
          </dd>
        </dl>
      )}

      {/* Shown to everyone who can read settings, editable by nobody: these
          are product invariants, not configuration. */}
      <FixedAttendanceRules />

      {mayEditPolicy ? (
        <FacePolicyForm
          policy={adminSettings.facePolicy}
          currentWarnings={adminSettings.faceWarnings}
          changedFields={adminSettings.faceChangedFields}
        />
      ) : (
        <dl className="grid grid-cols-[max-content_1fr] gap-x-6 gap-y-2 text-sm">
          <dt className="text-neutral-500">Present threshold</dt>
          <dd className="text-neutral-900">{adminSettings.facePolicy.presentMin}</dd>
          <dt className="text-neutral-500">Review threshold</dt>
          <dd className="text-neutral-900">{adminSettings.facePolicy.reviewMin}</dd>
        </dl>
      )}

      {mayEditPolicy ? (
        <SelfEnrollmentForm
          enabled={adminSettings.selfEnrollmentEnabled}
          defaultForType={adminSettings.selfEnrollmentDefault}
          institutionType={adminSettings.institutionType}
        />
      ) : (
        <dl className="grid grid-cols-[max-content_1fr] gap-x-6 gap-y-2 text-sm">
          <dt className="text-neutral-500">Student self-enrollment</dt>
          <dd className="text-neutral-900">
            {adminSettings.selfEnrollmentEnabled
              ? "Students may enrol their own face from the student portal"
              : "Faces are enrolled by staff only"}
          </dd>
        </dl>
      )}

      {mayEditPolicy ? (
        <RetentionForm policy={retentionPolicy} />
      ) : (
        // Visible to anyone who can read institution settings, editable by
        // nobody else: a teacher asked "how long do you keep my students'
        // faces?" should be able to answer without an administrator.
        <dl className="grid grid-cols-[max-content_1fr] gap-x-6 gap-y-2 text-sm">
          <dt className="text-neutral-500">Face template retention</dt>
          <dd className="text-neutral-900">
            {retentionPolicy.faceTemplateRetentionDays === 0
              ? "No age limit while the student is active"
              : `${retentionPolicy.faceTemplateRetentionDays} days from enrollment`}
          </dd>
          <dt className="text-neutral-500">When a student leaves</dt>
          <dd className="text-neutral-900">
            {retentionPolicy.onStudentInactive === "DELETE"
              ? "Face data deleted"
              : retentionPolicy.deactivatedTemplateGraceDays === 0
                ? "Face data deactivated, then kept until deleted by hand"
                : `Face data deactivated, then deleted after ${retentionPolicy.deactivatedTemplateGraceDays} days`}
          </dd>
          <dt className="text-neutral-500">Classroom photographs</dt>
          <dd className="text-neutral-900">
            {retentionPolicy.classroomImageStorage === "NEVER"
              ? "Never stored"
              : `Stored, then deleted after ${retentionPolicy.classroomImageRetentionDays} days`}
          </dd>
        </dl>
      )}

      {mayRunSweep ? <RetentionSweepPanel /> : null}
    </div>
  );
}
