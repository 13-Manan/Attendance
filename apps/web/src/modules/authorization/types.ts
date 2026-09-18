export type { PermissionKey, SystemRoleDefinition } from "./permissions";

export class ForbiddenError extends Error {
  readonly reason: string;

  constructor(reason: string) {
    super(`Forbidden: ${reason}`);
    this.name = "ForbiddenError";
    this.reason = reason;
  }
}

export class UnauthenticatedError extends Error {
  constructor() {
    super("Unauthenticated");
    this.name = "UnauthenticatedError";
  }
}
