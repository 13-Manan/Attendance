import { requirePermissionOrRedirect } from "@/modules/auth-tenancy/session";
import { hasPermission } from "@/modules/authorization/service";
import { listApiKeys } from "@/modules/api-credentials/service";
import type { ApiKeySummary } from "@/modules/api-credentials/types";
import { SENSITIVE_SCOPES } from "@/modules/integrations/scopes";
import { Panel, EmptyState } from "@/components/ui/panel";
import { TableScroll } from "@/components/ui/table-scroll";
import { IssueKeyForm, RevokeKeyButton } from "./key-controls";

/**
 * API keys.
 *
 * Read-gated on `institution.read` here, write-gated on `institution.update`
 * in the service. `canManage` decides whether the issuing form and the revoke
 * buttons render at all, so a read-only viewer sees an honest inventory of
 * what exists rather than a row of controls that all fail — the same shape as
 * the Integration Center.
 *
 * ## What this page can and cannot show
 *
 * It can show every key's name, scopes, age and last use. It cannot show any
 * key's value, now or ever: the stored column is an HMAC and the repository
 * does not select it. The plaintext appears exactly once, in the response to
 * the request that created it, and this page never fetches it.
 *
 * ## Why "last used" is the column that earns its width
 *
 * The question an administrator actually has is "can I revoke this?", and the
 * honest answer is "nothing has called with it since March". A key list
 * without it is a list nobody ever prunes, which is how an institution ends up
 * with eleven live credentials and no idea who holds them.
 */

function formatTimestamp(value: Date | null, fallback: string): string {
  if (!value) return fallback;
  return value.toISOString().replace("T", " ").slice(0, 16) + " UTC";
}

function StatusCell({ apiKey }: { apiKey: ApiKeySummary }) {
  if (apiKey.isActive) {
    return <span className="text-sm text-green-700">Active</span>;
  }
  return (
    <span className="text-sm text-neutral-500">
      Revoked {formatTimestamp(apiKey.revokedAt, "")}
    </span>
  );
}

// Widened deliberately: the scopes on a stored key are strings from a database
// column, and one of them may name a scope this build no longer defines.
const SENSITIVE: ReadonlySet<string> = SENSITIVE_SCOPES;

function ScopeList({ scopes }: { scopes: readonly string[] }) {
  if (scopes.length === 0) {
    return <span className="text-sm text-neutral-500">No scopes</span>;
  }
  return (
    <ul className="flex flex-wrap gap-1">
      {scopes.map((scope) => (
        <li
          key={scope}
          className={`rounded px-1.5 py-0.5 font-mono text-xs ${
            SENSITIVE.has(scope) ? "bg-amber-100 text-amber-900" : "bg-neutral-100 text-neutral-700"
          }`}
        >
          {scope}
        </li>
      ))}
    </ul>
  );
}

export default async function ApiKeysPage() {
  const user = await requirePermissionOrRedirect("institution.read");

  if (!user.institutionId) {
    return (
      <p className="text-sm text-neutral-500">
        Platform-level accounts aren&apos;t scoped to a single institution, so there are no API
        keys to manage here.
      </p>
    );
  }

  const keys = await listApiKeys(user);
  const canManage = hasPermission(user, "institution.update");
  const active = keys.filter((key) => key.isActive).length;

  return (
    <div className="flex flex-col gap-5">
      <header className="flex flex-col gap-1">
        <span className="text-xs font-semibold uppercase tracking-wider text-neutral-500">
          Connect
        </span>
        <h1 className="text-xl font-semibold tracking-tight text-neutral-900 sm:text-2xl">
          API keys
        </h1>
        <p className="max-w-3xl text-sm text-neutral-500">
          Credentials other systems use to call this platform&apos;s versioned API. Each key
          carries only the scopes it was given, and each one&apos;s use is recorded against it in
          the audit log.
        </p>
      </header>

      {canManage ? (
        <IssueKeyForm />
      ) : (
        <p className="text-xs text-neutral-500">
          You can see which keys exist, but issuing and revoking them needs the
          institution-settings permission.
        </p>
      )}

      <Panel
        title="Issued keys"
        description={
          keys.length === 0
            ? "No keys have been issued."
            : `${active} active of ${keys.length} issued. Revoked keys are kept so the audit log still explains what they did.`
        }
      >
        {keys.length === 0 ? (
          <EmptyState>
            No keys yet. A key is only needed when another system calls this platform — faculty
            and students sign in instead.
          </EmptyState>
        ) : (
          <TableScroll minWidth="min-w-[48rem]">
            <table className="w-full border-collapse text-left">
              <thead>
                <tr className="border-b border-neutral-200 text-xs uppercase tracking-wide text-neutral-500">
                  <th className="py-2 pr-4 font-medium">Name</th>
                  <th className="py-2 pr-4 font-medium">Scopes</th>
                  <th className="py-2 pr-4 font-medium">Issued</th>
                  <th className="py-2 pr-4 font-medium">Last used</th>
                  <th className="py-2 pr-4 font-medium">Status</th>
                  {canManage ? <th className="py-2 font-medium">Action</th> : null}
                </tr>
              </thead>
              <tbody>
                {keys.map((apiKey) => (
                  <tr key={apiKey.id} className="border-b border-neutral-100 align-top">
                    <td className="py-3 pr-4 text-sm font-medium text-neutral-900">
                      {apiKey.name}
                    </td>
                    <td className="py-3 pr-4">
                      <ScopeList scopes={apiKey.scopes} />
                    </td>
                    <td className="py-3 pr-4 text-sm text-neutral-600">
                      {formatTimestamp(apiKey.createdAt, "—")}
                    </td>
                    <td className="py-3 pr-4 text-sm text-neutral-600">
                      {/* "Never" is the answer that most often justifies a
                          revocation, so it is stated rather than left blank. */}
                      {formatTimestamp(apiKey.lastUsedAt, "Never")}
                    </td>
                    <td className="py-3 pr-4">
                      <StatusCell apiKey={apiKey} />
                    </td>
                    {canManage ? (
                      <td className="py-3">
                        {apiKey.isActive ? <RevokeKeyButton apiKey={apiKey} /> : null}
                      </td>
                    ) : null}
                  </tr>
                ))}
              </tbody>
            </table>
          </TableScroll>
        )}
      </Panel>
    </div>
  );
}
