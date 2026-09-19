import type { SystemStatus } from "@/modules/institutions/overview";
import { Panel } from "@/components/ui/panel";

type Tone = "ok" | "warning" | "bad";

const DOT_CLASSES: Record<Tone, string> = {
  ok: "bg-emerald-500",
  warning: "bg-amber-500",
  bad: "bg-red-500",
};

const TONE_WORDS: Record<Tone, string> = {
  ok: "Healthy",
  warning: "Degraded",
  bad: "Unavailable",
};

function StatusRow({
  label,
  tone,
  value,
  detail,
}: {
  label: string;
  tone: Tone;
  value: string;
  detail?: string;
}) {
  return (
    <li className="flex flex-wrap items-start justify-between gap-x-4 gap-y-1 py-2.5">
      <div className="flex min-w-0 flex-col gap-0.5">
        <span className="text-sm text-neutral-900">{label}</span>
        {detail ? <span className="text-xs text-neutral-500">{detail}</span> : null}
      </div>
      <span className="flex shrink-0 items-center gap-2">
        {/* The dot is decorative — colour alone must never be the only carrier
            of the status, so the word beside it says the same thing and the
            screen-reader text says it again unambiguously. */}
        <span aria-hidden className={`size-2 rounded-full ${DOT_CLASSES[tone]}`} />
        <span className="text-xs font-medium text-neutral-700">{value}</span>
        <span className="sr-only">({TONE_WORDS[tone]})</span>
      </span>
    </li>
  );
}

/**
 * System status, reported rather than reassured.
 *
 * The recognition row is the one that matters and it is deliberately blunt: a
 * reachable service running placeholder or licence-unverified weights is shown
 * as *not cleared for production*, because "face recognition: healthy" in
 * front of an administrator is a claim about a capability this deployment may
 * not have. A service that answers is not a model that may be used on real
 * students — those are two different facts and this panel keeps them apart.
 *
 * Nothing here implies accuracy, and nothing here is a substitute for the
 * faculty confirmation step: recognition assists, a human decides.
 */
export function SystemStatusPanel({ status }: { status: SystemStatus }) {
  const face = status.faceService;

  let faceTone: Tone;
  let faceValue: string;
  let faceDetail: string;

  if (face.health === "unavailable") {
    faceTone = "warning";
    faceValue = "Unreachable";
    faceDetail = "Registers can still be taken and confirmed by hand.";
  } else if (face.productionEligible) {
    faceTone = "ok";
    faceValue = "Available";
    faceDetail = `${face.modelName} · ${face.modelVersion}`;
  } else {
    faceTone = "warning";
    faceValue = "Not production-cleared";
    faceDetail = `${face.modelName} · ${face.modelVersion} — this model is not licence-verified for production use. Treat any result as a suggestion for review.`;
  }

  return (
    <Panel
      title="System status"
      description="Recognition assists attendance. Faculty confirmation is always what decides a register."
    >
      <ul className="flex flex-col divide-y divide-neutral-100">
        <StatusRow
          label="Database"
          tone={status.database === "operational" ? "ok" : "bad"}
          value={status.database === "operational" ? "Connected" : "Unavailable"}
          detail={
            status.database === "operational"
              ? "Institution records loaded for this page."
              : undefined
          }
        />
        <StatusRow
          label="Face recognition service"
          tone={faceTone}
          value={faceValue}
          detail={faceDetail}
        />
      </ul>
    </Panel>
  );
}
