"use client";

import { useActionState, useState } from "react";
import {
  createApiKeyAction,
  revokeApiKeyAction,
  type CredentialActionState,
} from "@/modules/api-credentials/actions";
import type { ApiKeySummary } from "@/modules/api-credentials/types";
import {
  API_SCOPES,
  SCOPE_DESCRIPTIONS,
  SENSITIVE_SCOPES,
  type ApiScope,
} from "@/modules/integrations/scopes";
import { Panel } from "@/components/ui/panel";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";

const initialState: CredentialActionState = {};

/**
 * Controls for the API keys screen.
 *
 * Local copies of the small banner/note primitives, for the reason recorded in
 * `institutions/settings/retention-form.tsx`: these are four lines each, and a
 * shared control would couple this screen to an unrelated one.
 *
 * `role="alert"` for a refusal, `role="status"` for a success and for the
 * one-time secret — a screen reader should interrupt for "that failed" and
 * announce, without interrupting, the value the reader now has to copy.
 */
function Banner({ state }: { state: CredentialActionState }) {
  if (state.error) {
    return (
      <p role="alert" className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">
        {state.error}
      </p>
    );
  }
  if (state.message) {
    return (
      <p role="status" className="rounded-md bg-green-50 px-3 py-2 text-sm text-green-800">
        {state.message}
      </p>
    );
  }
  return null;
}

/**
 * The one and only time this value is ever on a screen.
 *
 * It is rendered from the action's return value, which came back in the same
 * response as the request that created it. It was never stored in a readable
 * form — `ApiKey.hashedKey` is an HMAC — so there is no "show it again"
 * anywhere in this product, and the panel says so rather than letting someone
 * navigate away expecting to find it later.
 *
 * A read-only input rather than a `<code>` block so the value can be selected
 * with one click on a phone, where selecting text inside a paragraph is a
 * fight.
 */
export function SecretReveal({ state }: { state: CredentialActionState }) {
  if (!state.secret) return null;
  return (
    <div
      role="status"
      className="flex flex-col gap-2 rounded-md border border-amber-300 bg-amber-50 p-3"
    >
      <p className="text-sm font-medium text-amber-900">{state.secretLabel}</p>
      <input
        readOnly
        value={state.secret}
        aria-label={state.secretLabel}
        onFocus={(event) => event.currentTarget.select()}
        className="w-full rounded-md border border-amber-300 bg-white px-3 py-2 font-mono text-sm text-neutral-900"
      />
      <p className="text-xs text-amber-900">{state.secretNotice}</p>
    </div>
  );
}

/** Scopes grouped by the resource they name, in catalogue order. */
function scopeGroups(): Array<{ resource: string; scopes: ApiScope[] }> {
  const groups: Array<{ resource: string; scopes: ApiScope[] }> = [];
  for (const scope of API_SCOPES) {
    const resource = scope.split(":")[0];
    const existing = groups.find((group) => group.resource === resource);
    if (existing) existing.scopes.push(scope);
    else groups.push({ resource, scopes: [scope] });
  }
  return groups;
}

/**
 * Issuing a key.
 *
 * Every scope is an explicit checkbox and nothing is pre-ticked. The catalogue
 * declines to let write imply read (see `integrations/scopes.ts`), and a form
 * that ticked a sensible default would put that decision back where nobody
 * re-reads it. The four scopes in `SENSITIVE_SCOPES` are marked in the list
 * rather than hidden behind a second step: an administrator granting
 * `attendance:write` should see, at the moment they tick it, that they are
 * handing a machine the ability to change a register with no faculty member
 * present.
 */
export function IssueKeyForm() {
  const [state, formAction, pending] = useActionState(createApiKeyAction, initialState);
  const [open, setOpen] = useState(false);

  if (!open && !state.secret) {
    return (
      <div className="flex flex-col gap-3">
        <Banner state={state} />
        <div>
          <Button type="button" onClick={() => setOpen(true)}>
            + Issue a key
          </Button>
        </div>
      </div>
    );
  }

  return (
    <Panel
      title="Issue an API key"
      description="The key is shown once, on this screen, and cannot be recovered afterwards."
      action={
        <Button type="button" variant="secondary" onClick={() => setOpen(false)}>
          Close
        </Button>
      }
    >
      <div className="flex flex-col gap-4">
        <Banner state={state} />
        <SecretReveal state={state} />

        <form action={formAction} className="flex max-w-2xl flex-col gap-4">
          <Field label="What will use this key?" htmlFor="name">
            <Input
              id="name"
              name="name"
              required
              maxLength={80}
              placeholder="Fee portal nightly sync"
            />
          </Field>
          <p className="text-xs text-neutral-500">
            Name it after the system, not the person. It is the only thing you will have to go on
            when deciding, a year from now, whether this key is still needed.
          </p>

          <fieldset className="flex flex-col gap-3">
            <legend className="text-sm font-medium text-neutral-700">What may it do?</legend>
            <p className="text-xs text-neutral-500">
              Nothing is granted by default, and write access does not include read access. Tick
              only what the integration actually calls.
            </p>
            {scopeGroups().map((group) => (
              <div key={group.resource} className="flex flex-col gap-1.5">
                <p className="text-xs font-semibold uppercase tracking-wide text-neutral-500">
                  {group.resource}
                </p>
                {group.scopes.map((scope) => (
                  <label key={scope} className="flex items-start gap-2 text-sm text-neutral-700">
                    <input type="checkbox" name="scopes" value={scope} className="mt-1" />
                    <span>
                      <span className="font-mono text-xs text-neutral-900">{scope}</span>{" "}
                      {SCOPE_DESCRIPTIONS[scope]}
                      {SENSITIVE_SCOPES.has(scope) ? (
                        <span className="ml-1 rounded bg-amber-100 px-1.5 py-0.5 text-xs font-medium text-amber-900">
                          changes data
                        </span>
                      ) : null}
                    </span>
                  </label>
                ))}
              </div>
            ))}
          </fieldset>

          <div>
            <Button type="submit" disabled={pending}>
              {pending ? "Issuing…" : "Issue key"}
            </Button>
          </div>
        </form>
      </div>
    </Panel>
  );
}

/**
 * Revoking one key.
 *
 * Its own component, and its own action state, so a failure on one row is
 * reported on that row instead of at the top of a table of twenty. The
 * confirmation step is deliberate: revocation takes effect on the next request
 * the integration makes, which is usually within seconds, and the sentence
 * says so rather than leaving someone to discover it from a support ticket.
 */
export function RevokeKeyButton({ apiKey }: { apiKey: ApiKeySummary }) {
  const [state, formAction, pending] = useActionState(revokeApiKeyAction, initialState);
  const [confirming, setConfirming] = useState(false);

  if (state.error) {
    return (
      <span role="alert" className="text-xs text-red-700">
        {state.error}
      </span>
    );
  }

  if (!confirming) {
    return (
      <Button type="button" variant="secondary" onClick={() => setConfirming(true)}>
        Revoke
      </Button>
    );
  }

  return (
    <form action={formAction} className="flex flex-col items-start gap-1.5">
      <input type="hidden" name="id" value={apiKey.id} />
      <p className="text-xs text-neutral-600">
        Anything still using “{apiKey.name}” will be refused from its next request.
      </p>
      <div className="flex gap-2">
        <Button type="submit" variant="danger" disabled={pending}>
          {pending ? "Revoking…" : "Revoke it"}
        </Button>
        <Button type="button" variant="secondary" onClick={() => setConfirming(false)}>
          Keep it
        </Button>
      </div>
    </form>
  );
}
