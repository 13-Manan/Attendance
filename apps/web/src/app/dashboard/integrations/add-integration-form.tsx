"use client";

import { useActionState, useState } from "react";
import { createConnectionAction, type ActionState } from "@/modules/integrations/actions";
import type { ProviderSummary } from "@/modules/integrations/providers/registry";
import type { IntegrationResource } from "@/modules/integrations/types";
import { Panel } from "@/components/ui/panel";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { FormBanner, Select, HeaderRows } from "./controls";

const initialState: ActionState = {};

/**
 * [+ Add Integration].
 *
 * The form is driven by the selected provider's declared capabilities rather
 * than by a hardcoded list of fields per vendor. Picking "CSV drop" hides the
 * base URL and shows a delimiter; picking a provider that cannot run
 * unattended removes "Scheduled" from the sync modes. That is the adapter
 * system showing through the UI — a new provider added to the registry gets a
 * correct form here without this file being touched.
 */
export function AddIntegrationForm({
  providers,
  syncableResources,
}: {
  providers: ProviderSummary[];
  syncableResources: IntegrationResource[];
}) {
  const [state, formAction, pending] = useActionState(createConnectionAction, initialState);
  const [open, setOpen] = useState(false);
  // Typed as the raw string a <select> yields, not as IntegrationKind: the
  // value comes from the DOM, and the service is the thing that decides
  // whether it names a provider.
  const [kind, setKind] = useState<string>(providers[0]?.kind ?? "rest");

  const provider = providers.find((candidate) => candidate.kind === kind) ?? providers[0];
  const capabilities = provider?.capabilities;

  if (!open) {
    return (
      <div>
        <Button type="button" onClick={() => setOpen(true)}>
          + Add integration
        </Button>
      </div>
    );
  }

  const modes = [
    { value: "MANUAL", label: "Manual — only when someone clicks Sync now" },
    ...(capabilities?.scheduled
      ? [{ value: "SCHEDULED", label: "Scheduled — a full pull on an interval" }]
      : []),
    ...(capabilities?.incremental
      ? [{ value: "INCREMENTAL", label: "Incremental — only what changed since the last run" }]
      : []),
  ];

  return (
    <Panel
      title="Add an integration"
      description="Nothing is contacted until you save and then test the connection."
      action={
        <Button type="button" variant="secondary" onClick={() => setOpen(false)}>
          Cancel
        </Button>
      }
    >
      <form action={formAction} className="flex max-w-2xl flex-col gap-4">
        <Field label="Name" htmlFor="name">
          <Input id="name" name="name" required placeholder="College ERP (production)" />
        </Field>

        <Field label="System type" htmlFor="kind">
          <Select id="kind" name="kind" value={kind} onChange={(event) => setKind(event.target.value)}>
            {providers.map((candidate) => (
              <option key={candidate.kind} value={candidate.kind}>
                {candidate.label}
              </option>
            ))}
          </Select>
        </Field>

        {capabilities?.pull ? (
          <>
            <Field label="Base URL" htmlFor="baseUrl">
              <Input
                id="baseUrl"
                name="baseUrl"
                required
                placeholder="https://erp.example.edu/api"
                inputMode="url"
              />
            </Field>
            <Field label="Health-check path (optional)" htmlFor="testPath">
              <Input id="testPath" name="testPath" placeholder="/ping" />
            </Field>
          </>
        ) : null}

        {capabilities?.push ? (
          <Field label="Delivery URL" htmlFor="deliveryUrl">
            <Input id="deliveryUrl" name="deliveryUrl" placeholder="https://erp.example.edu/hooks" />
          </Field>
        ) : null}

        {kind === "csv" ? (
          <Field label="Delimiter (optional)" htmlFor="delimiter">
            <Input id="delimiter" name="delimiter" maxLength={2} placeholder="," className="max-w-24" />
          </Field>
        ) : null}

        <fieldset className="flex flex-col gap-2">
          <legend className="text-sm font-medium text-neutral-700">Records to sync</legend>
          {/* Only what this build can actually import. An administrator is
              never offered a checkbox that quietly does nothing. */}
          {syncableResources.map((resource) => (
            <label key={resource} className="flex items-center gap-2 text-sm text-neutral-700">
              <input type="checkbox" name="resources" value={resource} defaultChecked />
              {resource}
            </label>
          ))}
        </fieldset>

        <Field label="Sync mode" htmlFor="syncMode">
          <Select id="syncMode" name="syncMode" defaultValue="MANUAL">
            {modes.map((mode) => (
              <option key={mode.value} value={mode.value}>
                {mode.label}
              </option>
            ))}
          </Select>
        </Field>

        <Field label="Interval in minutes (scheduled and incremental only)" htmlFor="intervalMinutes">
          <Input
            id="intervalMinutes"
            name="intervalMinutes"
            type="number"
            min={5}
            defaultValue={60}
            className="max-w-32"
          />
        </Field>

        <HeaderRows
          description="Sent with every request to the system above. Held server-side and never sent back to a browser — once saved you will see [redacted] in its place."
          initial={[{ name: "Authorization", value: "" }]}
        />

        <FormBanner state={state} />

        <div>
          <Button type="submit" disabled={pending}>
            {pending ? "Adding…" : "Add integration"}
          </Button>
        </div>
      </form>
    </Panel>
  );
}
