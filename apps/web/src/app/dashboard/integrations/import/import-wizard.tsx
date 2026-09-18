"use client";

import { useActionState, useState, startTransition } from "react";
import {
  commitImportAction,
  previewImportAction,
  type CommitActionState,
  type PreviewActionState,
} from "@/modules/integrations/actions";
import { Panel, EmptyState } from "@/components/ui/panel";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { FormBanner } from "../controls";

const emptyPreview: PreviewActionState = {};
const emptyCommit: CommitActionState = {};

type TargetField = { key: string; label: string; storedAs: string; required: boolean };

/**
 * Upload → preview → map → commit → summary.
 *
 * The file is held in client state rather than left in the `<input>` because
 * the same bytes are needed twice — once to preview and again to commit — and
 * an action submission resets an uncontrolled form. Re-uploading at commit is
 * deliberate besides: the roster can change between the two steps, so the
 * commit re-plans against the roster as it is now and reports what actually
 * happened, rather than replaying a prediction.
 */
export function ImportWizard({ targetFields }: { targetFields: TargetField[] }) {
  const [preview, previewDispatch, previewing] = useActionState(previewImportAction, emptyPreview);
  const [commit, commitDispatch, committing] = useActionState(commitImportAction, emptyCommit);

  const [file, setFile] = useState<File | null>(null);
  const [delimiter, setDelimiter] = useState("");
  // Edited mappings live here, keyed by target, and start empty so the
  // server's suggestions win until the administrator actually overrides one.
  const [overrides, setOverrides] = useState<Record<string, string>>({});

  function sourceFor(target: string): string {
    if (target in overrides) return overrides[target];
    return preview.preview?.mappings.find((mapping) => mapping.target === target)?.source ?? "";
  }

  function submit(dispatch: (payload: FormData) => void, includeMappings: boolean) {
    if (!file) return;
    const formData = new FormData();
    formData.set("file", file);
    formData.set("resource", "students");
    if (delimiter) formData.set("delimiter", delimiter);
    if (includeMappings) {
      for (const field of targetFields) {
        const source = sourceFor(field.key);
        if (!source) continue;
        formData.append("mappingSource", source);
        formData.append("mappingTarget", field.key);
      }
    }
    startTransition(() => dispatch(formData));
  }

  const result = commit.result;

  return (
    <div className="flex flex-col gap-5">
      {/* Step 1 — the file */}
      <Panel title="1. Choose a file" description="CSV, or an .xlsx export from Excel or Google Sheets.">
        <div className="flex flex-col gap-3">
          <Field label="Roster file" htmlFor="file">
            <input
              id="file"
              type="file"
              accept=".csv,.xlsx,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
              onChange={(event) => setFile(event.target.files?.[0] ?? null)}
              className="text-sm"
            />
          </Field>

          <Field label="Delimiter (optional — detected automatically)" htmlFor="delimiter">
            <Input
              id="delimiter"
              value={delimiter}
              onChange={(event) => setDelimiter(event.target.value)}
              maxLength={2}
              placeholder="auto"
              className="max-w-24"
            />
          </Field>

          <div>
            <Button
              type="button"
              disabled={!file || previewing}
              onClick={() => submit(previewDispatch, false)}
            >
              {previewing ? "Reading…" : "Preview"}
            </Button>
          </div>

          <FormBanner state={{ error: preview.error }} />
        </div>
      </Panel>

      {preview.preview ? (
        <>
          {/* Step 2 — what the parser saw */}
          <Panel
            title="2. What we read"
            description={`${preview.preview.format.toUpperCase()} · ${preview.preview.totalRows} data rows · ${preview.preview.headers.length} columns`}
          >
            <div className="overflow-x-auto">
              <table className="w-full min-w-max text-xs">
                <thead>
                  <tr className="border-b border-neutral-200 text-left text-neutral-500">
                    {preview.preview.headers.map((header, index) => (
                      <th key={index} className="px-2 py-1 font-medium">
                        {header || <span className="italic">(unnamed)</span>}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {/* Verbatim rows, not mapped ones. The point of this table is
                      to let someone confirm the parser read their file the way
                      they read it — a transformed preview would hide exactly
                      the delimiter and encoding problems it should surface. */}
                  {preview.preview.sampleRows.map((row, rowIndex) => (
                    <tr key={rowIndex} className="border-b border-neutral-100">
                      {preview.preview!.headers.map((header, cellIndex) => (
                        <td key={cellIndex} className="px-2 py-1 text-neutral-800">
                          {row[header] ?? ""}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {preview.preview.unmappedColumns.length > 0 ? (
              <p className="text-xs text-neutral-500">
                Not imported: {preview.preview.unmappedColumns.join(", ")}. That is fine — extra
                columns are ignored, not an error.
              </p>
            ) : null}
          </Panel>

          {/* Step 3 — mapping */}
          <Panel
            title="3. Match the columns"
            description="Filled in from the column names where we recognised them. Change anything that is wrong."
          >
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs text-neutral-500">
                  <th className="pb-1 font-medium">Their column</th>
                  <th className="pb-1 font-medium">Our field</th>
                </tr>
              </thead>
              <tbody>
                {targetFields.map((field) => (
                  <tr key={field.key}>
                    <td className="py-1 pr-2">
                      <select
                        aria-label={`Source column for ${field.label}`}
                        value={sourceFor(field.key)}
                        onChange={(event) =>
                          setOverrides((current) => ({ ...current, [field.key]: event.target.value }))
                        }
                        className="w-full rounded-md border border-neutral-300 bg-white px-3 py-2 text-sm"
                      >
                        <option value="">— not in this file —</option>
                        {preview.preview!.headers
                          .filter((header) => header !== "")
                          .map((header) => (
                            <option key={header} value={header}>
                              {header}
                            </option>
                          ))}
                      </select>
                    </td>
                    <td className="py-1">
                      <span className="text-neutral-800">
                        {field.label}
                        {field.required ? <span className="text-red-600"> *</span> : null}
                      </span>
                      <span className="block text-xs text-neutral-500">{field.storedAs}</span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>

            {preview.preview.mappingProblems.length > 0 ? (
              <p role="alert" className="rounded-md bg-amber-50 px-3 py-2 text-xs text-amber-900">
                {preview.preview.mappingProblems.map((problem) => problem.message).join(" ")}
              </p>
            ) : null}

            <div>
              <Button
                type="button"
                variant="secondary"
                disabled={previewing}
                onClick={() => submit(previewDispatch, true)}
              >
                {previewing ? "Re-checking…" : "Re-check with this mapping"}
              </Button>
            </div>
          </Panel>

          {/* Step 4 — what would change */}
          <Panel title="4. What would change" description={preview.preview.description}>
            <dl className="grid grid-cols-2 gap-x-6 gap-y-1 text-sm sm:grid-cols-5">
              <Stat label="Create" value={preview.preview.summary.create} />
              <Stat label="Update" value={preview.preview.summary.update} />
              <Stat label="Unchanged" value={preview.preview.summary.unchanged} />
              <Stat label="Duplicates" value={preview.preview.summary.duplicate} />
              <Stat label="Errors" value={preview.preview.summary.error} tone="error" />
            </dl>

            <RowProblems
              title="Rows with problems"
              rows={preview.preview.errors}
              empty="No row-level problems."
            />
            <RowProblems
              title="Duplicate student codes in this file"
              rows={preview.preview.duplicates}
              empty="No duplicates."
            />

            <div className="flex flex-col gap-2">
              <Button
                type="button"
                disabled={committing || preview.preview.mappingProblems.length > 0}
                onClick={() => submit(commitDispatch, true)}
                className="self-start"
              >
                {committing
                  ? "Importing…"
                  : `Import ${preview.preview.summary.create + preview.preview.summary.update} students`}
              </Button>
              {preview.preview.mappingProblems.length > 0 ? (
                <p className="text-xs text-neutral-500">
                  Fix the mapping above before importing.
                </p>
              ) : null}
            </div>
          </Panel>
        </>
      ) : null}

      {/* Step 5 — what actually happened */}
      {commit.error || result ? (
        <Panel title="5. Import summary" description={result?.description}>
          <FormBanner state={{ error: commit.error }} />
          {result ? (
            <>
              <dl className="grid grid-cols-2 gap-x-6 gap-y-1 text-sm sm:grid-cols-4">
                <Stat label="Created" value={result.created} />
                <Stat label="Updated" value={result.updated} />
                <Stat label="Unchanged" value={result.unchanged} />
                <Stat label="Failed" value={result.failed} tone="error" />
              </dl>

              <RowProblems
                title="Rows that were not imported"
                rows={result.failures}
                empty="Every row was imported."
              />

              {result.errorReport ? <ErrorReportLink report={result.errorReport} /> : null}
            </>
          ) : null}
        </Panel>
      ) : null}
    </div>
  );
}

function Stat({ label, value, tone }: { label: string; value: number; tone?: "error" }) {
  return (
    <div className="flex flex-col">
      <dt className="text-xs text-neutral-500">{label}</dt>
      <dd
        className={`text-lg font-semibold ${
          tone === "error" && value > 0 ? "text-red-700" : "text-neutral-900"
        }`}
      >
        {value}
      </dd>
    </div>
  );
}

function RowProblems({
  title,
  rows,
  empty,
}: {
  title: string;
  rows: Array<{ line: number; key: string | null; messages: string[] }>;
  empty: string;
}) {
  return (
    <div className="flex flex-col gap-1">
      <p className="text-xs font-medium text-neutral-700">{title}</p>
      {rows.length === 0 ? (
        <EmptyState>{empty}</EmptyState>
      ) : (
        <ul className="flex flex-col gap-1">
          {rows.slice(0, 50).map((row, index) => (
            <li key={index} className="text-xs text-neutral-700">
              {/* The line number is the line in their file, not the index in
                  our array — it is the only thing that lets someone open the
                  spreadsheet and go straight to the problem. */}
              <span className="font-medium">Line {row.line}</span>
              {row.key ? ` (${row.key})` : ""} — {row.messages.join("; ")}
            </li>
          ))}
          {rows.length > 50 ? (
            <li className="text-xs text-neutral-500">
              …and {rows.length - 50} more. Download the report below for the full list.
            </li>
          ) : null}
        </ul>
      )}
    </div>
  );
}

/**
 * Turns the base64 report the action returned into a download.
 *
 * A `data:` URL rather than a route on our origin: the report is derived
 * entirely from a file the user uploaded a moment ago, so serving it would
 * mean giving those bytes a URL, a lifetime and an access rule of their own —
 * three things to get wrong for no benefit over handing them straight back.
 */
function ErrorReportLink({
  report,
}: {
  report: { filename: string; contentType: string; base64: string };
}) {
  return (
    <a
      href={`data:${report.contentType};base64,${report.base64}`}
      download={report.filename}
      className="self-start text-sm font-medium text-neutral-900 underline underline-offset-4"
    >
      Download error report ({report.filename})
    </a>
  );
}
