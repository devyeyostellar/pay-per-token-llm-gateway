-- Add the PayoutProposal table for multisig payout automation (#40).
-- Mirrors the on-chain multisig proposal ledger: status transitions are
-- written by the gateway payout service as proposals are proposed, approved,
-- and executed through the multisig Soroban contract.

-- CreateTable
CREATE TABLE "PayoutProposal" (
    "id" TEXT NOT NULL,
    "providerId" TEXT NOT NULL,
    "proposalId" INTEGER,
    "destination" TEXT NOT NULL,
    "amount" BIGINT NOT NULL,
    "asset" TEXT NOT NULL DEFAULT 'USDC',
    "status" TEXT NOT NULL DEFAULT 'pending',
    "approvals" JSONB,
    "threshold" INTEGER,
    "txHash" TEXT,
    "error" TEXT,
    "executedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PayoutProposal_pkey" PRIMARY KEY ("id")
);

-- AddForeignKey
ALTER TABLE "PayoutProposal" ADD CONSTRAINT "PayoutProposal_providerId_fkey" FOREIGN KEY ("providerId") REFERENCES "Provider"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- CreateIndex
CREATE INDEX "PayoutProposal_providerId_status_idx" ON "PayoutProposal"("providerId", "status");

-- CreateIndex
CREATE INDEX "PayoutProposal_status_idx" ON "PayoutProposal"("status");

-- CreateIndex
CREATE INDEX "PayoutProposal_createdAt_idx" ON "PayoutProposal"("createdAt");