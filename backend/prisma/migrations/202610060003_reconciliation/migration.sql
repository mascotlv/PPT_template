ALTER TABLE "Payment" ADD COLUMN "queriedAt" TIMESTAMP(3);
CREATE INDEX "Payment_status_queriedAt_idx" ON "Payment" (status,"queriedAt");
