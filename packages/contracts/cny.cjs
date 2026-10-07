// rates are foreign major currency units per CNY. Return RMB cents.
function cnyMinor(amount, currency, rate, digits) {
    if (!Number.isSafeInteger(amount) || amount < 0) return null;
    if (currency === 'CNY') return amount;
    if (!Number.isInteger(digits) || digits < 0 || !/^\d+(\.\d{1,12})?$/.test(String(rate))) return null;
    const [whole, fraction = ''] = String(rate).split('.');
    const numerator = BigInt(whole + fraction);
    if (numerator === 0n) return null;
    const denominator = numerator * 10n ** BigInt(digits);
    const value = (BigInt(amount) * 100n * 10n ** BigInt(fraction.length) + denominator / 2n) / denominator;
    return value <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(value) : null;
}
module.exports = { cnyMinor };
