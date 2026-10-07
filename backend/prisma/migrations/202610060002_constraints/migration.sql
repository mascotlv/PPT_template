ALTER TABLE "Price" ADD CONSTRAINT "price_positive" CHECK (amount > 0 AND amount <= 100000000), ADD CONSTRAINT "price_currency" CHECK (currency IN ('CNY','USD'));
ALTER TABLE "Order" ADD CONSTRAINT "order_amount_positive" CHECK (amount > 0), ADD CONSTRAINT "order_status" CHECK (status IN ('AWAITING_PAYMENT','PAID','CLOSED'));
ALTER TABLE "Payment" ADD CONSTRAINT "payment_amount_positive" CHECK (amount > 0), ADD CONSTRAINT "payment_currency" CHECK (currency IN ('CNY','USD'));
ALTER TABLE "Refund" ADD CONSTRAINT "refund_amount_positive" CHECK (amount > 0), ADD CONSTRAINT "refund_currency" CHECK (currency IN ('CNY','USD'));
CREATE FUNCTION protect_refund_total() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE payment_amount integer; refunded integer; payment_currency text;
BEGIN
  SELECT amount,currency INTO payment_amount,payment_currency FROM "Payment" WHERE id=NEW."paymentId" FOR UPDATE;
  IF NEW.currency <> payment_currency THEN RAISE EXCEPTION 'Refund currency mismatch'; END IF;
  IF NEW.status IN ('APPROVED','PROCESSING','SUCCEEDED') THEN
    SELECT COALESCE(SUM(amount),0) INTO refunded FROM "Refund" WHERE "paymentId"=NEW."paymentId" AND id<>NEW.id AND status IN ('APPROVED','PROCESSING','SUCCEEDED');
    IF refunded+NEW.amount>payment_amount THEN RAISE EXCEPTION 'Refund exceeds payment'; END IF;
  END IF;
  RETURN NEW;
END; $$;
CREATE TRIGGER refund_total_guard BEFORE INSERT OR UPDATE ON "Refund" FOR EACH ROW EXECUTE FUNCTION protect_refund_total();
