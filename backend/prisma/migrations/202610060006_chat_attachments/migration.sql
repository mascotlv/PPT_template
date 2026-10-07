-- Chat attachments: allow a message to carry one uploaded file alongside (or instead of) text.
ALTER TABLE "ChatMessage" ALTER COLUMN "content" SET DEFAULT '';
ALTER TABLE "ChatMessage" DROP CONSTRAINT IF EXISTS "ChatMessage_content_check";
ALTER TABLE "ChatMessage" ADD CONSTRAINT "ChatMessage_content_check" CHECK (length("content") <= 2000);
CREATE TABLE "ChatAttachment" (
  "id" TEXT NOT NULL,
  "messageId" TEXT NOT NULL,
  "key" TEXT NOT NULL,
  "filename" TEXT NOT NULL,
  "mimetype" TEXT NOT NULL,
  "size" INTEGER NOT NULL,
  "sha256" TEXT NOT NULL,
  "kind" TEXT NOT NULL DEFAULT 'FILE',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ChatAttachment_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ChatAttachment_messageId_fkey" FOREIGN KEY ("messageId") REFERENCES "ChatMessage"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "ChatAttachment_kind_check" CHECK ("kind" IN ('IMAGE','FILE')),
  CONSTRAINT "ChatAttachment_size_check" CHECK ("size" > 0)
);
CREATE UNIQUE INDEX "ChatAttachment_messageId_key" ON "ChatAttachment"("messageId");
CREATE INDEX "ChatAttachment_createdAt_idx" ON "ChatAttachment"("createdAt");
