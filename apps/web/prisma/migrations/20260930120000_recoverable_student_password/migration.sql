-- A student account's current password, encrypted so that authorised college
-- staff can reveal it on request (student accounts only).
--
-- Never the password itself: AES-256-GCM ciphertext, its 12-byte nonce and its
-- 16-byte authentication tag, sealed under STUDENT_PASSWORD_ENCRYPTION_KEY — a
-- key held in Key Vault and never in this database — with the account's id as
-- additional authenticated data. "keyVersion" says which key sealed it.
--
-- One row per account at most ("userId" is unique), replaced in the same
-- transaction as "User"."passwordHash" whenever the password is set, so no
-- earlier password is kept. Deleted with its account.
--
-- Additive: no existing table changes, and no existing account gets a row —
-- an account created before this has no recoverable password until it is
-- next reset or changed. Authentication does not read this table.

-- CreateTable
CREATE TABLE "RecoverableStudentPassword" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "ciphertext" BYTEA NOT NULL,
    "nonce" BYTEA NOT NULL,
    "authTag" BYTEA NOT NULL,
    "keyVersion" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RecoverableStudentPassword_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "RecoverableStudentPassword_userId_key" ON "RecoverableStudentPassword"("userId");

-- AddForeignKey
ALTER TABLE "RecoverableStudentPassword" ADD CONSTRAINT "RecoverableStudentPassword_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
