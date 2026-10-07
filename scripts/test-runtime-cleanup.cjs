const fs = require('node:fs/promises');
const path = require('node:path');
const net = require('node:net');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { cleanRuntimeFixtures } = require('../backend/dist/storage/runtime-fixtures');
(async () => {
    const root = path.resolve('.runtime', 'cleanup-check-' + randomUUID());
    await fs.mkdir(root);
    let listener;
    try {
        for (const name of ['postgres-workshop_test_browser_deadbeef', 'workshop_test_browser_deadbeef', 'postgres-local', 'backup-before-upgrade-1', 'workshop_test_integration_deadbeef']) {
            await fs.mkdir(path.join(root, name)); await fs.writeFile(path.join(root, name, 'keep.txt'), 'test');
        }
        const protectedRoot = path.join(root, 'workshop_test_integration_deadbeef');
        listener = net.createServer(); await new Promise((resolve, reject) => { listener.once('error', reject); listener.listen(55433, '127.0.0.1', resolve); });
        const active = await cleanRuntimeFixtures([protectedRoot], root);
        assert.ok(active.every(action => action.status === 'SKIPPED'));
        await fs.access(path.join(root, 'postgres-workshop_test_browser_deadbeef'));
        await new Promise(resolve => listener.close(resolve)); listener = null;
        const removed = await cleanRuntimeFixtures([protectedRoot], root);
        assert.equal(removed.filter(a => a.status === 'DELETED').length, 2);
        await assert.rejects(fs.access(path.join(root, 'postgres-workshop_test_browser_deadbeef')));
        for (const name of ['postgres-local', 'backup-before-upgrade-1', 'workshop_test_integration_deadbeef']) await fs.access(path.join(root, name, 'keep.txt'));
        const invalid = path.join(root, 'postgres-workshop_test_integration_aaaaaaaa'); await fs.mkdir(invalid);
        await fs.writeFile(path.join(invalid, 'postmaster.pid'), 'invalid\ninvalid');
        const rejected = await cleanRuntimeFixtures([protectedRoot], root);
        assert.ok(rejected.some(a => a.status === 'FAILED'));
        await fs.access(invalid);
        console.log('PASS stopped fixtures removed immediately; running tests, business storage, local database, backups and invalid markers preserved');
    } finally {
        if (listener) await new Promise(resolve => listener.close(resolve));
        const absolute = await fs.realpath(root), parent = await fs.realpath(path.resolve('.runtime'));
        assert.ok(absolute.startsWith(parent + path.sep));
        await fs.rm(absolute, { recursive: true, force: true });
    }
})().catch(error => { console.error(error.message); process.exitCode = 1; });
