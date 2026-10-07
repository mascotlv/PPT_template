ALTER TABLE "SupportTicket" ALTER COLUMN "orderId" DROP NOT NULL;
ALTER TABLE "SupportTicket" ADD COLUMN "title" TEXT, ADD COLUMN "source" TEXT NOT NULL DEFAULT 'CUSTOMER', ADD COLUMN "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;
ALTER TABLE "SupportTicket" ADD CONSTRAINT "SupportTicket_status_check" CHECK ("status" IN ('OPEN','RESOLVED','IGNORED'));
ALTER TABLE "SupportTicket" ADD CONSTRAINT "SupportTicket_source_check" CHECK ("source" IN ('CUSTOMER','MEMO'));
ALTER TABLE "SupportTicket" ADD CONSTRAINT "SupportTicket_owner_check" CHECK ("source" = 'MEMO' OR "orderId" IS NOT NULL);
CREATE INDEX "SupportTicket_status_createdAt_idx" ON "SupportTicket"("status","createdAt");
CREATE TABLE "ChatConversation" (
  "id" TEXT NOT NULL, "customerId" TEXT NOT NULL, "status" TEXT NOT NULL DEFAULT 'OPEN',
  "buyerSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "sellerSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ChatConversation_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ChatConversation_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "ChatConversation_status_check" CHECK ("status" IN ('OPEN','RESOLVED','IGNORED'))
);
CREATE UNIQUE INDEX "ChatConversation_customerId_key" ON "ChatConversation"("customerId");
CREATE INDEX "ChatConversation_updatedAt_idx" ON "ChatConversation"("updatedAt");
CREATE TABLE "ChatMessage" (
  "id" TEXT NOT NULL, "conversationId" TEXT NOT NULL, "sender" TEXT NOT NULL, "actorId" TEXT NOT NULL,
  "content" TEXT NOT NULL, "clientId" TEXT NOT NULL, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ChatMessage_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ChatMessage_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "ChatConversation"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "ChatMessage_sender_check" CHECK ("sender" IN ('BUYER','SELLER')),
  CONSTRAINT "ChatMessage_content_check" CHECK (length("content") BETWEEN 1 AND 2000)
);
CREATE UNIQUE INDEX "ChatMessage_conversationId_clientId_key" ON "ChatMessage"("conversationId","clientId");
CREATE INDEX "ChatMessage_conversationId_createdAt_id_idx" ON "ChatMessage"("conversationId","createdAt","id");
