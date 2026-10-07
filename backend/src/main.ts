import { parseConfig } from './config';
import { createApp } from './app';
async function main() { const c = parseConfig(process.env); const { app } = await createApp(c); await app.listen(c.PORT, c.APP_ENV === 'local' ? '127.0.0.1' : '0.0.0.0'); console.log(`Backend listening on port ${c.PORT} (${c.APP_ENV}, ${c.PAYMENT_MODE})`); }
main().catch(() => { console.error('Backend startup failed; check required configuration and database readiness'); process.exit(1); });
