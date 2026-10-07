import { parseConfig } from './config';
import { database } from './db';
import { ShopService } from './modules/shop.service';
import { JobRunner } from './jobs/runner';
const config = parseConfig(process.env);
const db = database(config.DATABASE_URL);
const runner = new JobRunner(new ShopService(db, config));
let stopped = false;
async function loop() { while (!stopped) {
    try {
        await runner.tick();
    }
    catch {
        console.error('Worker cycle failed (details withheld)');
    }
    await new Promise(r => setTimeout(r, 1000));
} await db.$disconnect(); }
process.on('SIGTERM', () => { stopped = true; });
process.on('SIGINT', () => { stopped = true; });
void loop();
