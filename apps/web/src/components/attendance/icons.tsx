import type { SVGProps } from "react";

/**
 * The few icons the attendance screens use, drawn inline so no icon package is
 * needed. One stroke weight and one 24-unit grid, so they sit together; every
 * one is decorative (`aria-hidden`) — the control it sits in carries the label.
 */
function Icon({ children, ...props }: SVGProps<SVGSVGElement>) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      {...props}
    >
      {children}
    </svg>
  );
}

export function CameraIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <Icon {...props}>
      <path d="M4 8h3l2-3h6l2 3h3a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V9a1 1 0 0 1 1-1Z" />
      <circle cx="12" cy="13" r="3.5" />
    </Icon>
  );
}

export function CheckIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <Icon {...props}>
      <path d="m5 12.5 4.5 4.5L19 7.5" />
    </Icon>
  );
}

export function ArrowLeftIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <Icon {...props}>
      <path d="M19 12H5" />
      <path d="m11 6-6 6 6 6" />
    </Icon>
  );
}

export function SwitchCameraIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <Icon {...props}>
      <path d="M4 8h3l2-3h6l2 3h3a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V9a1 1 0 0 1 1-1Z" />
      <path d="M9.5 12.5a2.5 2.5 0 0 1 4.3-1.7l.7.7" />
      <path d="M14.5 10v1.5H13" />
      <path d="M14.5 14.5a2.5 2.5 0 0 1-4.3 1.7l-.7-.7" />
      <path d="M9.5 17v-1.5H11" />
    </Icon>
  );
}

export function PlusIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <Icon {...props}>
      <path d="M12 5v14" />
      <path d="M5 12h14" />
    </Icon>
  );
}

export function RetakeIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <Icon {...props}>
      <path d="M4 12a8 8 0 0 1 13.7-5.6L20 9" />
      <path d="M20 4v5h-5" />
      <path d="M20 12a8 8 0 0 1-13.7 5.6L4 15" />
      <path d="M4 20v-5h5" />
    </Icon>
  );
}

export function AlertIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <Icon {...props}>
      <path d="M12 3 2.5 19.5h19L12 3Z" />
      <path d="M12 10v4" />
      <path d="M12 17.5h.01" />
    </Icon>
  );
}

/** "Not started": an empty circle. */
export function CircleIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <Icon {...props}>
      <circle cx="12" cy="12" r="8.5" />
    </Icon>
  );
}

/** "In progress": a clock — still, unlike the spinner, because nothing is loading. */
export function ClockIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <Icon {...props}>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M12 7.5V12l3 2" />
    </Icon>
  );
}

/** A spinner that respects reduced motion: it simply stops turning. */
export function Spinner({ className = "", ...props }: SVGProps<SVGSVGElement>) {
  return (
    <Icon className={`motion-safe:animate-spin ${className}`} {...props}>
      <path d="M12 3a9 9 0 1 0 9 9" />
    </Icon>
  );
}
