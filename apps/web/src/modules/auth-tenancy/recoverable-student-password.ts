import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { SecretBoxError, openParts, sealParts } from "@/lib/secret-box";
import { studentPasswordKeyring } from "./student-password-keyring";

/**
 * A student account's current password, kept recoverable for the staff who
 * may reveal it — and nothing else.
 *
 * ## What is stored
 *
 * `RecoverableStudentPassword`: AES-256-GCM ciphertext, nonce and tag, under
 * the student-password key (`student-password-keyring.ts`), with the account's
 * id as additional authenticated data — a row copied onto another account
 * fails its tag check instead of revealing anybody's password. The plaintext
 * is never written anywhere; the key never enters the database.
 *
 * ## Always the current password
 *
 * Every write of a student's password — a new login, a reset, a change of
 * their own — replaces the hash and this row in one transaction, after
 * `lockAccountForPasswordWrite` has taken the account's row lock. Two writes
 * to one account therefore run one after the other, and whichever commits
 * last leaves its password in both: the hash and the recoverable copy never
 * name different passwords, and no earlier password survives a change.
 *
 * ## Who reads it
 *
 * `openRecoverablePassword` is called by the audited reveal and nowhere else
 * (modules/student-password-reveal). Authentication never reads this table;
 * `User.passwordHash` stays the only thing a password is checked against.
 *
 * Staff accounts never have a row: only the student flows write one, and a
 * staff member changing their own password removes any that exists.
 */

type Tx = Prisma.TransactionClient;

/** The additional authenticated data: the account a sealed password belongs to. */
function boundTo(userId: string): string {
  return `attendance:student-password:${userId}`;
}

/**
 * Throws the keyring's `SecretBoxError` unless student passwords can be sealed
 * now. Asked before any write, so an operation that would have to seal a
 * password refuses without having changed anything.
 */
export function requireStudentPasswordKey(): void {
  studentPasswordKeyring();
}

/**
 * Takes the account's row lock for the rest of the transaction and returns
 * the password hash as it stands under that lock — undefined when there is no
 * such account. Every student password write takes this before touching the
 * hash or the recoverable copy.
 */
export async function lockAccountForPasswordWrite(tx: Tx, userId: string): Promise<string | null | undefined> {
  const rows = await tx.$queryRaw<{ passwordHash: string | null }[]>`
    SELECT "passwordHash" FROM "User" WHERE "id" = ${userId} FOR UPDATE`;
  return rows.length === 0 ? undefined : rows[0].passwordHash;
}

/**
 * Seals the account's new current password and stores it in place of the
 * last one, inside the caller's transaction — which holds the account's lock,
 * and writes the matching hash. A failure to seal rolls the whole write back.
 */
export async function storeRecoverablePasswordWithin(tx: Tx, userId: string, password: string): Promise<void> {
  const sealed = sealParts(studentPasswordKeyring(), password, boundTo(userId));
  const data = {
    ciphertext: new Uint8Array(sealed.ciphertext),
    nonce: new Uint8Array(sealed.nonce),
    authTag: new Uint8Array(sealed.authTag),
    keyVersion: sealed.keyVersion,
  };
  await tx.recoverableStudentPassword.upsert({ where: { userId }, create: { userId, ...data }, update: data });
}

/** Removes an account's recoverable password, inside the caller's transaction: for an account that is not a student's. */
export async function discardRecoverablePasswordWithin(tx: Tx, userId: string): Promise<void> {
  await tx.recoverableStudentPassword.deleteMany({ where: { userId } });
}

export type RecoveredPassword =
  | { status: "available"; password: string }
  /** `none`: nothing stored — an account from before this, until it is next reset. `unreadable`: a row that will not open. */
  | { status: "unavailable"; reason: "none" | "unreadable" };

/**
 * The account's current password, for the audited reveal only.
 *
 * A row that will not open — sealed under a key this deployment does not
 * hold, altered, or copied from another account — reads as `unreadable`
 * rather than as an error, so the staff screen offers a reset instead of
 * failing. With no key configured at all, the keyring's `no_kek` is thrown:
 * that is a deployment fault, not a property of one account.
 */
export async function openRecoverablePassword(userId: string): Promise<RecoveredPassword> {
  const row = await prisma.recoverableStudentPassword.findUnique({
    where: { userId },
    select: { ciphertext: true, nonce: true, authTag: true, keyVersion: true },
  });
  if (!row) return { status: "unavailable", reason: "none" };
  const keyring = studentPasswordKeyring();
  try {
    const password = openParts(
      keyring,
      {
        keyVersion: row.keyVersion,
        nonce: Buffer.from(row.nonce),
        authTag: Buffer.from(row.authTag),
        ciphertext: Buffer.from(row.ciphertext),
      },
      boundTo(userId),
    );
    return { status: "available", password };
  } catch (error) {
    if (error instanceof SecretBoxError) return { status: "unavailable", reason: "unreadable" };
    throw error;
  }
}
