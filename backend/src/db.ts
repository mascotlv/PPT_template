import { PrismaClient } from './generated/prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
export function database(url: string) { return new PrismaClient({ adapter: new PrismaPg({ connectionString: url, max: 12, connectionTimeoutMillis: 5000 }) }); }
export type DB = ReturnType<typeof database>;
