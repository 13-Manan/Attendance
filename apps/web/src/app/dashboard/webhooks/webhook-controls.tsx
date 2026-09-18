"use client";

import { useActionState, useState } from "react";
import {
  createWebhookAction,
  stopWebhookAction,
  updateWebhookAction,
  type CredentialActionState,
} from "@/modules/api-credentials/actions";
import type { WebhookSummary } from "@/modules/api-credentials/types";
import { WEBHOOK_EVENTS } from "@/modules/integrations/types";
import { Panel } from "@/components/ui/panel";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";

const initialState: CredentialActionState = {};

/**
 * Controls for the webhook endpoints screen.
 *
 * The banner and the one-time reveal are local copies of the ones on the API
 * keys screen, for the reason recorded in
 * `institutions/settings/retention-form.tsx`: they are a handful of lines, and
 * sharing them would couple two screens that must be able to change apart.
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
 * The signing secret, shown once.
 *
 * The receiver needs it to verify the `X-Signature` header on every delivery,
 * so unlike an API key it is stored — but it is never selected by this
 * module's repository and so never travels back to a browser again. If it is
 * lost, the endpoint has to be registered again; that is worse for an
 * administrator and better for everyone whose attendance record travels
 * through it.
 */
function SecretReveal({ state }: { state: CredentialActionState }) {
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
      <p className="text-xs text-amber-900">
        Give this to whoever runs the receiving system. They use it to verify that a delivery came
        from here and was not tampered with in transit.
      </p>
    </div>
  );
}

/**
 * The event checkboxes.
 *
 * An unknown event name is refused by the service rather than quietly dropped
 * — the reasoning is in `api-credentials/policy.ts` — so this list is the only
 * place an administrator can pick from, and it is generated from
 * `WEBHOOK_EVENTS`. A new event added to the platform appears here without
 * this file being touched.
 */
function EventChoices({ selected }: { selected?: readonly string[] }) {
  return (
    <fieldset className="flex flex-col gap-2">
      <legend className="text-sm font-medium text-neutral-700">Send which events?</legend>
      {WEBHOOK_EVENTS.map((event) => (
        <label key={event} className="flex items-center gap-2 text-sm text-neutral-700">
          <input
            type="checkbox"
            name="eventTypes"
            value={event}
            defaultChecked={selected?.includes(event) ?? false}
          />
          <span className="font-mono text-xs text-neutral-900">{event}</span>
        </label>
      ))}
    </fieldset>
  );
}

export function AddWebhookForm() {
  const [state, formAction, pending] = useActionState(createWebhookAction, initialState);
  const [open, setOpen] = useState(false);

  if (!open && !state.secret) {
    return (
      <div className="flex flex-col gap-3">
        <Banner state={state} />
        <div>
          <Button type="button" onClick={() => setOpen(true)}>
            + Add an endpoint
          </Button>
        </div>
      </div>
    );
  }

  return (
    <Panel
      title="Add a webhook endpoint"
      description="Nothing is sent until an event actually happens. The signing secret is shown once, here."
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
          <Field label="Delivery URL" htmlFor="url">
            <Input
              id="url"
              name="url"
              required
              inputMode="url"
              placeholder="https://erp.example.edu/hooks/attendance"
            />
          </Field>
          <p className="text-xs text-neutral-500">
            Must be a public HTTPS address. Addresses inside this network — localhost, private
            ranges, the cloud metadata service — are refused, because an endpoint that points back
            at us is a way to make this server fetch things on someone else&apos;s behalf.
          </p>

          <EventChoices />

          <div>
            <Button type="submit" disabled={pending}>
              {pending ? "Registering…" : "Register endpoint"}
            </Button>
          </div>
        </form>
      </div>
    </Panel>
  );
}

/**
 * Editing one endpoint.
 *
 * Its own action state per row: a refused URL belongs next to the endpoint it
 * was typed into, not at the top of a list of five. "Stop" is a separate
 * action from unticking "receiving events" and saving, because stopping is the
 * thing someone does in a hurry when an endpoint is misbehaving, and it should
 * not require getting the rest of the form right first.
 */
export function EditWebhookForm({ endpoint }: { endpoint: WebhookSummary }) {
  const [state, formAction, pending] = useActionState(updateWebhookAction, initialState);
  const [stopState, stopAction, stopping] = useActionState(stopWebhookAction, initialState);
  const [open, setOpen] = useState(false);

  return (
    <div className="flex flex-col gap-3 rounded-md border border-neutral-200 p-3">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <div className="flex flex-col gap-0.5">
          <p className="break-all text-sm font-medium text-neutral-900">{endpoint.url}</p>
          <p className="text-xs text-neutral-500">
            {endpoint.isActive ? "Receiving events" : "Stopped — nothing is delivered"} ·{" "}
            {endpoint.eventTypes.length === 0
              ? "no events"
              : endpoint.eventTypes.join(", ")}
          </p>
        </div>
        <div className="flex gap-2">
          <Button type="button" variant="secondary" onClick={() => setOpen(!open)}>
            {open ? "Close" : "Edit"}
          </Button>
          {endpoint.isActive ? (
            <form action={stopAction}>
              <input type="hidden" name="id" value={endpoint.id} />
              <Button type="submit" variant="secondary" disabled={stopping}>
                {stopping ? "Stopping…" : "Stop"}
              </Button>
            </form>
          ) : null}
        </div>
      </div>

      <Banner state={stopState} />

      {open ? (
        <form action={formAction} className="flex max-w-2xl flex-col gap-4">
          <Banner state={state} />
          <input type="hidden" name="id" value={endpoint.id} />

          <Field label="Delivery URL" htmlFor={`url-${endpoint.id}`}>
            <Input
              id={`url-${endpoint.id}`}
              name="url"
              required
              inputMode="url"
              defaultValue={endpoint.url}
            />
          </Field>

          <EventChoices selected={endpoint.eventTypes} />

          <label className="flex items-center gap-2 text-sm text-neutral-700">
            <input type="checkbox" name="isActive" defaultChecked={endpoint.isActive} />
            Receiving events
          </label>
          <p className="text-xs text-neutral-500">
            Unticking this keeps the endpoint and its history and stops delivery. The signing
            secret is not changed, so it will work again if you tick it back on.
          </p>

          <div>
            <Button type="submit" disabled={pending}>
              {pending ? "Saving…" : "Save endpoint"}
            </Button>
          </div>
        </form>
      ) : null}
    </div>
  );
}
