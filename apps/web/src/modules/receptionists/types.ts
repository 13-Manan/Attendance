/** A refusal the principal can act on, in a sentence. Never a stack trace or a key. */
export class ReceptionistError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReceptionistError";
  }
}

export interface ReceptionistSummary {
  id: string;
  name: string;
  email: string;
  /** Optional; kept with the account's audit history (no schema column for it). */
  phone: string | null;
  status: "ACTIVE" | "INACTIVE";
  /** The access switches that are on — ids from `catalog.ts`. */
  access: string[];
  createdAt: Date;
  lastLoginAt: Date | null;
  /** Still owes the change from a temporary password. */
  mustChangePassword: boolean;
}

/** Shown to the principal once, straight after it is issued. */
export interface IssuedReceptionistPassword {
  email: string;
  password: string;
}

export interface NewReceptionist {
  receptionist: ReceptionistSummary;
  password: string;
}
