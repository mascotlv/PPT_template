import { parseConfig } from './config';
import { database } from './db';
import { upgradeCommerce } from './commerce/upgrade';
const config = parseConfig(process.env);
if (config.APP_ENV === 'production')
    throw new Error('Demo commerce upgrade forbidden in production');
const db = database(config.DATABASE_URL);
upgradeCommerce(db, config).then(result => console.log(JSON.stringify(result))).catch(() => { console.error('Commerce upgrade failed. Check migrations and current reference-rate connectivity; credentials are withheld.'); process.exitCode = 1; }).finally(() => db.$disconnect());
