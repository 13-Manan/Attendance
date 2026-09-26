// The student portal's navigation, decided in one pure place.

export interface PortalLink {
  href: string;
  label: string;
}

/**
 * Overview, attendance and the account — and face enrollment only where the
 * institution lets students enrol themselves. A link to a page that can only
 * say "not enabled here" is a placeholder, so it is not offered; the page
 * itself, and the policy behind it, are unchanged.
 *
 * Nothing here is a staff destination: a student account reaches the portal
 * and nothing else.
 */
export function portalLinks(options: { faceEnrollment: boolean }): PortalLink[] {
  return [
    { href: "/portal", label: "Overview" },
    { href: "/portal/attendance", label: "My attendance" },
    ...(options.faceEnrollment ? [{ href: "/portal/enroll-face", label: "Face enrollment" }] : []),
    { href: "/portal/account", label: "Account" },
  ];
}
