import { parseConfig } from './config';
import { database } from './db';
import { normalizePurchaseFiles } from './storage/purchase-files';
const config = parseConfig(process.env), db = database(config.DATABASE_URL);
normalizePurchaseFiles(db, config).then(result => console.log(JSON.stringify(result))).catch(() => { console.error('File normalization failed; existing order records are preserved. Details withheld.'); process.exitCode = 1; }).finally(() => db.$disconnect());
