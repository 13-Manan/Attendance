// Exactly the security-sensitive events the product requires — do not add
// event types beyond this list without a matching product requirement.
export type AuditAction =
  | "auth.login.success"
  | "auth.login.failure"
  | "auth.logout"
  | "student.created"
  | "student.updated"
  // A student leaving and a student coming back, told apart from an ordinary
  // edit. Same single write path (modules/students/service.ts#updateStudent)
  // and the same one row — only the name of the action differs, chosen from
  // the status transition exactly as the webhook event is, so the log and the
  // webhook cannot disagree about what happened.
  | "student.archived"
  | "student.restored"
  // Phase 10 integration hub. Linking an external identifier is a change to
  // *who a record is* as far as another system is concerned, so it belongs in
  // the same trail as a role change rather than in integration logs only.
  | "integration.externalId.linked"
  | "integration.externalId.unlinked"
  // Phase 13 platform tier. Creating or suspending a tenant is the highest-
  // impact action in the product and is the one an incident review starts
  // from, so it is audited under the institution it concerns.
  | "platform.institution.created"
  | "platform.institution.suspended"
  | "platform.institution.restored"
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
  // Phase 2 academic administration. The creates above already existed; these
  // are the edits, which until this phase were only possible by hand in the
  // database and therefore left no trace at all. Renaming a class, moving an
  // academic year's dates or switching which year is the current one all
  // change what every report downstream is counting, so each is attributable.
  //
  // `academic_session.activated` is the one that carries the most: making a
  // year current takes that status away from whichever year held it, in the
  // same transaction, and the payload names the year that lost it — so "why
  // did last year stop being the default" is answerable from the log alone.
  //
  // `academic_session.archived` above already existed; `restored` is its undo,
  // and is its own action rather than an `updated` carrying a flag for the
  // same reason `student.restored` is: "who brought this back" is a question
  // people actually ask, and answering it should not require reading a diff.
  | "academic_unit.updated"
  | "academic_session.activated"
  | "academic_session.updated"
  | "academic_session.restored"
  | "cohort.updated"
  | "subject.updated"
  // Campus administration. A campus is the coarsest scope a role assignment
  // can be narrowed to (`UserRoleAssignment.campusId`), so closing one is a
  // change to who can see what, not only an entry in a list of addresses.
  | "campus.created"
  | "campus.updated"
  | "campus.closed"
  | "campus.reopened"
  // The institution's own profile: its name, timezone, contact details and the
  // words it uses for its own structure. Separate from the two policy actions
  // below because those change how attendance is decided and this does not —
  // an administrator auditing a disputed register should be able to exclude
  // it, and an administrator auditing a rename should be able to find it.
  | "institution.profile_updated"
  | "student_subject_enrollment.created"
  | "enrollment.created"
  | "enrollment.updated"
  | "face_enrollment.created"
  | "face_enrollment.deactivated"
  // Phase 3 enrollment lifecycle. `replaced` is one act, not a deactivation
  // followed by a creation: an administrator who replaces a student's whole
  // template set has made a single decision, and a log that shows five
  // retirements and one creation invites the reader to wonder whether the
  // sixth event was related.
  //
  // `refused` records an enrollment the system turned down because the face
  // already belongs to — or is too close to — another student at the same
  // institution. That is the one refusal worth a permanent row: it is either
  // the same person enrolled twice under two student records, which somebody
  // has to reconcile, or an attempt to enrol one student's face against
  // another's name. Neither should be discoverable only from a screenshot of a
  // red banner. Quality rejections are not logged — a blurred photograph is
  // not an event, and logging every retake would bury the two that matter.
  | "face_enrollment.replaced"
  | "face_enrollment.refused"
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
  // Whether students may enrol their own face. A change here opens or closes a
  // path by which biometric data enters the system without a member of staff
  // present, which is a different question from the thresholds above and needs
  // its own attributable row.
  | "institution.face_enrollment_policy_updated"
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
