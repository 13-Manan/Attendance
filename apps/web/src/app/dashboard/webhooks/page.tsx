import { requirePermissionOrRedirect } from "@/modules/auth-tenancy/session";
import { hasPermission } from "@/modules/authorization/service";
import { listWebhookDeliveries, listWebhooks } from "@/modules/api-credentials/service";
import { Panel, EmptyState } from "@/components/ui/panel";
import { TableScroll } from "@/components/ui/table-scroll";
import { AddWebhookForm, EditWebhookForm } from "./webhook-controls";

/**
 * Webhook endpoints, and what happened to the last few deliveries.
 *
 * ## Why the errors are on this page
 *
 * "Admin can … view errors" is the requirement, and the only version of it
 * that is any use puts the failures on the same screen as the endpoint that
 * produced them. An administrator whose ERP has stopped updating needs to see
 * `502` and `attendance.finalized` next to the URL, not be told to ask someone
 * for a log file they cannot reach.
 *
 * The attempts come from the audit log, where the dispatcher already writes
 * one row per attempt — there is no delivery table and the schema is frozen.
 * That is a constraint, and it shows: this is the most recent twenty attempts
 * across every endpoint, not a per-endpoint history with a retry button.
 */

const DELIVERY_LIMIT = 20;

function formatTimestamp(value: Date): string {
  return value.toISOString().replace("T", " ").slice(0, 19) + " UTC";
}

/**
 * Reads the attempt payload without trusting its shape.
 *
 * It is a JSON column written by an earlier version of the dispatcher as much
 * as by the current one, so every field is optional here and a missing one
 * renders as a dash rather than throwing on a page an administrator opened
 * precisely because something was already wrong.
 */
function readAttempt(payload: unknown): {
  eventType: string;
  endpointUrl: string;
  statusCode: string;
  attempt: string;
  reason: string | null;
} {
  const row = (payload ?? {}) as Record<string, unknown>;
  const text = (value: unknown, fallback = "—") =>
    value === null || value === undefined || value === "" ? fallback : String(value);
  const reason = row.failureReason;
  return {
    eventType: text(row.eventType),
    endpointUrl: text(row.endpointUrl),
    statusCode: text(row.statusCode),
    attempt: text(row.attempt),
    reason: reason === null || reason === undefined || reason === "" ? null : String(reason),
  };
}

export default async function WebhooksPage() {
  const user = await requirePermissionOrRedirect("institution.read");

  if (!user.institutionId) {
    return (
      <p className="text-sm text-neutral-500">
        Platform-level accounts aren&apos;t scoped to a single institution, so there are no
        webhook endpoints to manage here.
      </p>
    );
  }

  const [endpoints, deliveries] = await Promise.all([
    listWebhooks(user),
    listWebhookDeliveries(user, DELIVERY_LIMIT),
  ]);
  const canManage = hasPermission(user, "institution.update");
  const active = endpoints.filter((endpoint) => endpoint.isActive).length;
  const failures = deliveries.filter((row) => row.action === "webhook.delivery.failed").length;

  return (
    <div className="flex flex-col gap-5">
      <header className="flex flex-col gap-1">
        <h1 className="text-xl font-semibold text-neutral-900">Webhooks</h1>
        <p className="max-w-3xl text-sm text-neutral-500">
          Events this platform sends out as they happen — a register finalized, a correction
          recorded, a student added — so another system does not have to poll for them. Every
          delivery is signed.
        </p>
      </header>

      {canManage ? (
        <AddWebhookForm />
      ) : (
        <p className="text-xs text-neutral-500">
          You can see which endpoints exist and how their deliveries went, but changing them needs
          the institution-settings permission.
        </p>
      )}

      <Panel
        title="Endpoints"
        description={
          endpoints.length === 0
            ? "No endpoints are registered."
            : `${active} receiving of ${endpoints.length} registered.`
        }
      >
        {endpoints.length === 0 ? (
          <EmptyState>
            Nothing is registered. Add an endpoint if another system should be told about
            attendance as it is recorded, rather than asking the API for it on a timer.
          </EmptyState>
        ) : (
          <ul className="flex flex-col gap-3">
            {endpoints.map((endpoint) => (
              <li key={endpoint.id}>
                {canManage ? (
                  <EditWebhookForm endpoint={endpoint} />
                ) : (
                  <div className="flex flex-col gap-0.5 rounded-md border border-neutral-200 p-3">
                    <p className="break-all text-sm font-medium text-neutral-900">{endpoint.url}</p>
                    <p className="text-xs text-neutral-500">
                      {endpoint.isActive ? "Receiving events" : "Stopped"} ·{" "}
                      {endpoint.eventTypes.join(", ") || "no events"}
                    </p>
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
      </Panel>

      <Panel
        title="Recent deliveries"
        description={
          deliveries.length === 0
            ? "Nothing has been delivered yet."
            : `Last ${deliveries.length} attempts across every endpoint. ${failures} failed.`
        }
      >
        {deliveries.length === 0 ? (
          <EmptyState>
            No delivery has been attempted. This stays empty until an event happens that a
            registered endpoint is subscribed to.
          </EmptyState>
        ) : (
          <TableScroll minWidth="min-w-[48rem]">
            <table className="w-full border-collapse text-left">
              <thead>
                <tr className="border-b border-neutral-200 text-xs uppercase tracking-wide text-neutral-500">
                  <th className="py-2 pr-4 font-medium">When</th>
                  <th className="py-2 pr-4 font-medium">Event</th>
                  <th className="py-2 pr-4 font-medium">Endpoint</th>
                  <th className="py-2 pr-4 font-medium">Attempt</th>
                  <th className="py-2 font-medium">Result</th>
                </tr>
              </thead>
              <tbody>
                {deliveries.map((row) => {
                  const attempt = readAttempt(row.payload);
                  const failed = row.action === "webhook.delivery.failed";
                  return (
                    <tr key={row.id} className="border-b border-neutral-100 align-top">
                      <td className="py-3 pr-4 text-sm whitespace-nowrap text-neutral-600">
                        {formatTimestamp(row.createdAt)}
                      </td>
                      <td className="py-3 pr-4 font-mono text-xs text-neutral-900">
                        {attempt.eventType}
                      </td>
                      <td className="py-3 pr-4 text-sm break-all text-neutral-600">
                        {attempt.endpointUrl}
                      </td>
                      <td className="py-3 pr-4 text-sm text-neutral-600">{attempt.attempt}</td>
                      <td className="py-3">
                        <span
                          className={`text-sm font-medium ${failed ? "text-red-700" : "text-green-700"}`}
                        >
                          {failed ? "Failed" : "Delivered"} {attempt.statusCode}
                        </span>
                        {/* The receiver's own words. A failure summarised as
                            "delivery failed" is a failure nobody can fix. */}
                        {attempt.reason ? (
                          <p className="text-xs break-words text-neutral-600">{attempt.reason}</p>
                        ) : null}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </TableScroll>
        )}
      </Panel>
    </div>
  );
}
