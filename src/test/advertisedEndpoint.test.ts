import assert from 'assert';
import path from 'path';
import { AntigravityServer } from '../server/index';

describe('AntigravityServer advertised endpoint', () => {
    const extensionPath = path.join(__dirname, '../../');
    const workspaceRoot = path.join(__dirname, '../../../');

    it('uses preferred host directly in generated URL', async () => {
        const server = new AntigravityServer(3015, extensionPath, workspaceRoot, false, '203.0.113.10');
        const urls = await server.start();
        try {
            assert.ok(urls.localUrl.includes('http://203.0.113.10:3015/'));
        } finally {
            server.stop();
        }
    });

    it('uses preferred host and port in generated URL', async () => {
        const server = new AntigravityServer(3016, extensionPath, workspaceRoot, false, '203.0.113.10:8443');
        const urls = await server.start();
        try {
            assert.ok(urls.localUrl.includes('http://203.0.113.10:8443/'));
        } finally {
            server.stop();
        }
    });
});
