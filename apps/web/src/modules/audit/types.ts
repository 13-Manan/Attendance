// Exactly the security-sensitive events the product requires — do not add
// event types beyond this list without a matching product requirement.
export type AuditAction =
  | "auth.login.success"
  | "auth.login.failure"
  | "auth.logout"
  | "student.created"
  | "student.updated"
  | "user.role_changed"
  | "attendance.corrected"
  | "attendance.finalized"
  | "attendance_session.created"
  // Phase 4 classroom capture wizard — auditing "who started/resumed/
  // cancelled a capture session" is required because these transitions
  // move an AttendanceSession into and out of the CAPTURING state during
  // which classroom images are momentarily processed.
  | "attendance_capture.started"
  | "attendance_capture.resumed"
  | "attendance_capture.cancelled"
  // Phase 6 attendance engine — the moment advisory recognition output
  // becomes an actual attendance register. Audited because this is where a
  // student first acquires a recorded attendance status, and because the
  // roster scope used decides who could have been recorded at all.
  | "attendance.candidates_generated"
  | "academic_unit.created"
  | "academic_session.created"
  | "academic_session.archived"
  | "cohort.created"
  | "cohort_faculty.assigned"
  | "subject.created"
  | "cohort_subject.attached"
  | "student_subject_enrollment.created"
  | "enrollment.created"
  | "enrollment.updated"
  | "face_enrollment.created"
  | "face_enrollment.deactivated"
  // Phase 11 face-data retention. `deactivated` above is a soft delete and was
  // the only erasure this system could record; these two are the rows that
  // prove a biometric template actually stopped existing.
  //
  // `face_enrollment.deleted` is a person deciding — an administrator erasing
  // one student's face data on request. `face_data.retention_purged` is the
  // policy deciding, and carries the sweep summary plus the policy that was in
  // force, so "why did this template disappear on the 14th" is answerable from
  // the log alone rather than from whatever the settings happen to say today.
  //
  // Both are additions to a TypeScript union over a `String` column, so no
  // migration is involved and no existing row changes meaning.
  // `retention_policy_updated` is the third: shortening a retention period is
  // not a settings tweak, it is a scheduled instruction to destroy biometric
  // data, and it has to be attributable to the person who gave it. Nothing
  // else in this catalogue covers an institution settings change, so there is
  // no existing action to reuse here.
  | "face_enrollment.deleted"
  | "face_data.retention_purged"
  | "face_data.retention_policy_updated"
  // Phase 13 institution administration. The product requirement is that an
  // administrator can run the whole institution without a code change, and the
  // corollary is that every such change has to be attributable — a setting a
  // person can alter without leaving a trace is a code change with worse
  // accountability, not better.
  //
  // `institution.face_policy_updated` is the one that matters most: it records
  // a change to the similarity thresholds that decide whether a student is
  // marked present without a human looking. Its payload carries the previous
  // policy, the new policy, and the warnings the administrator was shown, so
  // an attendance dispute three weeks later can be answered from the log.
  //
  // `user.created`, `user.deactivated` and `user.reactivated` cover faculty
  // administration. `user.role_changed` above already existed and is not
  // duplicated here — granting a role and creating an account are different
  // facts about a person and both are needed to explain how someone came to
  // have access.
  | "institution.attendance_policy_updated"
  | "institution.face_policy_updated"
  | "user.created"
  | "user.updated"
  | "user.deactivated"
  | "user.reactivated"
  | "cohort_faculty.removed"
  | "cohort_subject.faculty_assigned"
  // Phase 10 Integration Hub. The product requirement is explicit: log the
  // API client, endpoint, timestamp, status, request id, resource and failure
  // reason for the public integration surface, and record what an integration
  // did on an institution's data.
  //
  // `api.resource.read` is reserved for endpoints marked `audit: "always"` —
  // ordinary successful reads go to the structured access log instead, so a
  // roster poll cannot bury the rows below it. See the `audit` option in
  // modules/integrations/api-route.ts for that reasoning in full.
  | "api.request.denied"
  | "api.resource.read"
  | "api.resource.written"
  | "api_key.created"
  | "api_key.revoked"
  | "integration.created"
  | "integration.updated"
  | "integration.deleted"
  | "integration.connection_tested"
  | "integration.sync.started"
  | "integration.sync.completed"
  | "integration.sync.failed"
  | "integration.import.completed"
  | "webhook_endpoint.created"
  | "webhook_endpoint.updated"
  | "webhook_endpoint.deleted"
  // One row per delivery attempt. This is the durable delivery history the
  // Integration Center reads: the schema has no WebhookDelivery table, and an
  // audit row already carries institution, API client, timestamp and a JSON
  // payload for the status and failure reason.
  | "webhook.delivery.succeeded"
  | "webhook.delivery.failed";

export interface RecordAuditLogInput {
  action: AuditAction;
  entityType: string;
  entityId: string;
  institutionId?: string | null;
  actorUserId?: string | null;
  actorApiKeyId?: string | null;
  beforeJson?: unknown;
  afterJson?: unknown;
  ipAddress?: string | null;
  userAgent?: string | null;
}
