import { createServer, Server } from 'node:http';
import { Client } from 'pg';
import { createHash } from 'node:crypto';

export const fixtureTranslation = (text: string, language: string) => `${language} translated ${createHash('sha256').update(text).digest('hex').slice(0, 12)}`;

export async function contentProvider(databaseUrl: string) {
    const server: Server = createServer(async (req, res) => {
        let raw = ''; for await (const chunk of req) raw += chunk;
        const input = JSON.parse(raw);
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ translatedText: fixtureTranslation(input.q, input.target) }));
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const db = new Client({ connectionString: databaseUrl }); await db.connect();
    const previous = (await db.query('SELECT value FROM "Setting" WHERE key=$1', ['chat-translation-config'])).rows[0];
    const value = { provider: 'libretranslate', url: `http://127.0.0.1:${(server.address() as { port: number }).port}/translate`, encryptedKey: '' };
    await db.query('INSERT INTO "Setting" (key,value,"updatedAt") VALUES ($1,$2,NOW()) ON CONFLICT (key) DO UPDATE SET value=$2,"updatedAt"=NOW()', ['chat-translation-config', JSON.stringify(value)]);
    return async () => {
        if (previous) await db.query('UPDATE "Setting" SET value=$2 WHERE key=$1', ['chat-translation-config', JSON.stringify(previous.value)]);
        else await db.query('DELETE FROM "Setting" WHERE key=$1', ['chat-translation-config']);
        await db.end(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
    };
}
