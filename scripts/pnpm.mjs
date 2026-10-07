import { pnpm } from './common.mjs';
pnpm(process.argv.slice(2)).catch(()=>{process.exitCode=1;});
