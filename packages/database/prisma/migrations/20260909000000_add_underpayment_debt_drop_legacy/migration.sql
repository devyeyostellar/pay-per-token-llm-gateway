-- UnderpaymentDebt — the per-token debt ledger model exists in schema.prisma
-- but was never added to the migration history, so a FRESH database created
-- via `prisma migrate deploy` (the documented production path) was missing
-- the table and every debt-gate query (getOpenDebtTotal /
-- recordUnderpaymentDebt) crashed. This migration closes that gap.
--
-- All statements are guarded with IF [NOT] EXISTS so the migration is safe
-- on databases that were previously set up via `prisma db push` (which
-- creates the table directly from the schema).

CREATE TABLE IF NOT EXISTS "UnderpaymentDebt" (
    "id" TEXT NOT NULL,
    "providerId" TEXT NOT NULL,
    "payerAddress" TEXT NOT NULL,
    "quoteId" TEXT NOT NULL,
    "routeId" TEXT NOT NULL,
    "amount" BIGINT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'open',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "settledAt" TIMESTAMP(3),

    CONSTRAINT "UnderpaymentDebt_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "UnderpaymentDebt_quoteId_key" ON "UnderpaymentDebt"("quoteId");
CREATE INDEX IF NOT EXISTS "UnderpaymentDebt_payerAddress_providerId_status_idx" ON "UnderpaymentDebt"("payerAddress", "providerId", "status");
CREATE INDEX IF NOT EXISTS "UnderpaymentDebt_providerId_status_idx" ON "UnderpaymentDebt"("providerId", "status");

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'UnderpaymentDebt_providerId_fkey'
    ) THEN
        ALTER TABLE "UnderpaymentDebt"
            ADD CONSTRAINT "UnderpaymentDebt_providerId_fkey"
            FOREIGN KEY ("providerId") REFERENCES "Provider"("id")
            ON DELETE CASCADE ON UPDATE CASCADE;
    END IF;
END $$;

-- (The orphaned ApiKey/Session tables from the 2024-08-09 init migration
-- were already dropped by 20260812000000_remove_session_apikey_models — no
-- action needed here.)