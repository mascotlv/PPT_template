ALTER TABLE "Category" ADD COLUMN "translations" JSONB NOT NULL DEFAULT '{}', ADD COLUMN "archived" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Product" ADD COLUMN "translations" JSONB NOT NULL DEFAULT '{}', ADD COLUMN "deletedAt" TIMESTAMP(3);
CREATE TABLE "Customer" (
 "id" TEXT PRIMARY KEY, "email" TEXT NOT NULL UNIQUE, "name" TEXT NOT NULL, "country" TEXT NOT NULL,
 "language" TEXT NOT NULL, "currency" TEXT NOT NULL, "passwordHash" TEXT NOT NULL,
 "emailVerifiedAt" TIMESTAMP(3), "disabled" BOOLEAN NOT NULL DEFAULT false,
 "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
ALTER TABLE "Session" ADD COLUMN "customerId" TEXT REFERENCES "Customer"("id") ON DELETE RESTRICT;
ALTER TABLE "Order" ADD COLUMN "customerId" TEXT REFERENCES "Customer"("id") ON DELETE RESTRICT,
 ADD COLUMN "country" TEXT, ADD COLUMN "pricingSnapshot" JSONB NOT NULL DEFAULT '{}';
CREATE TABLE "CustomerToken" (
 "id" TEXT PRIMARY KEY, "customerId" TEXT NOT NULL REFERENCES "Customer"("id") ON DELETE RESTRICT,
 "kind" TEXT NOT NULL CHECK("kind" IN ('VERIFY','RESET')), "tokenHash" TEXT NOT NULL UNIQUE,
 "expiresAt" TIMESTAMP(3) NOT NULL, "consumedAt" TIMESTAMP(3), "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE "FxSnapshot" (
 "id" TEXT PRIMARY KEY, "source" TEXT NOT NULL, "base" TEXT NOT NULL, "rates" JSONB NOT NULL,
 "fetchedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE "AnalyticsEvent" (
 "id" TEXT PRIMARY KEY, "sessionId" TEXT NOT NULL, "customerId" TEXT, "productId" TEXT,
 "country" TEXT, "kind" TEXT NOT NULL CHECK("kind" IN ('HOME_VIEW','CATALOG_VIEW','PRODUCT_VIEW','PRODUCT_CLICK')),
 "day" TEXT NOT NULL, "dedupKey" TEXT NOT NULL UNIQUE, "isTest" BOOLEAN NOT NULL,
 "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX "Customer_country_createdAt_idx" ON "Customer"("country","createdAt");
CREATE INDEX "FxSnapshot_fetchedAt_idx" ON "FxSnapshot"("fetchedAt");
CREATE INDEX "AnalyticsEvent_createdAt_kind_idx" ON "AnalyticsEvent"("createdAt","kind");
CREATE INDEX "AnalyticsEvent_productId_createdAt_idx" ON "AnalyticsEvent"("productId","createdAt");
CREATE INDEX "AnalyticsEvent_country_createdAt_idx" ON "AnalyticsEvent"("country","createdAt");
ALTER TABLE "Price" DROP CONSTRAINT "price_currency";
ALTER TABLE "Payment" DROP CONSTRAINT "payment_currency";
ALTER TABLE "Refund" DROP CONSTRAINT "refund_currency";
ALTER TABLE "Price" ADD CONSTRAINT "price_currency" CHECK(currency IN ('CNY','USD','EUR','JPY','KRW','GBP','CAD','AUD','CHF','HKD','SGD','NZD','TWD','BRL','MXN','INR','AED','SAR','RUB','SEK','NOK','DKK','PLN','THB','IDR','MYR','PHP','ZAR','TRY'));
ALTER TABLE "Payment" ADD CONSTRAINT "payment_currency" CHECK(currency IN ('CNY','USD','EUR','JPY','KRW','GBP','CAD','AUD','CHF','HKD','SGD','NZD','TWD','BRL','MXN','INR','AED','SAR','RUB','SEK','NOK','DKK','PLN','THB','IDR','MYR','PHP','ZAR','TRY'));
ALTER TABLE "Refund" ADD CONSTRAINT "refund_currency" CHECK(currency IN ('CNY','USD','EUR','JPY','KRW','GBP','CAD','AUD','CHF','HKD','SGD','NZD','TWD','BRL','MXN','INR','AED','SAR','RUB','SEK','NOK','DKK','PLN','THB','IDR','MYR','PHP','ZAR','TRY'));
