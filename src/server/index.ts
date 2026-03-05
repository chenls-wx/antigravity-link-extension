import express, { Router } from 'express';
import https from 'https';
import http from 'http';
import fs from 'fs';
import path from 'path';
import os from 'os';
import selfsigned from 'selfsigned';
import { WebSocketServer, WebSocket } from 'ws';
import { discoverInstances, connectCDP } from '../services/cdp';
import { injectFile, injectMessage, captureSnapshot, captureSnapshotDebug, clickElement } from '../services/antigravity';
import { CDPConnection, Snapshot, CDPInfo } from '../types';
import { authMiddleware } from '../middleware/auth';
import { securityMiddleware } from '../middleware/security';

// Config defaults (aligned with root server)
const MAX_UPLOAD_SIZE_MB = 50;
const POLL_INTERVAL = 3000;
const HTTP_TIMEOUT = 2000;

const TOKEN_FILENAME = '.token';
const CERT_FILENAME = 'cert.pem';
const KEY_FILENAME = 'key.pem';

interface State {
    cdpConnections: CDPConnection[];
    lastSnapshot: Snapshot | null;
    lastSnapshotHash: string | null;
    activePort: number | null;
    activeTargetId: string | null;
    snapshotCache: Map<number, Snapshot>;
    wssRef: WebSocketServer | null;
    pollInterval: NodeJS.Timeout | null;
    missedSnapshots: number;
    reinitInProgress: boolean;
    lastCdpInitAttemptAt: number;
}

export class AntigravityServer {
    private app: express.Express;
    private server?: http.Server | https.Server;
    private wss?: WebSocketServer;
    private uploadsDir: string;
    private publicDir: string;
    private extensionPath: string;
    private port: number;
    private useHttps: boolean;
    private preferredHost: string;
    private _localUrl = '';
    private _secureUrl = '';
    private authToken: string;
    private state: State;
    private useAuth: boolean;

    constructor(port: number, extensionPath: string, workspaceRoot?: string, useHttps = true, preferredHost = '') {
        this.port = port;
        this.useHttps = useHttps;
        this.preferredHost = preferredHost.trim();
        this.extensionPath = extensionPath;
        this.app = express();
        // Prefer workspace root uploads/public (matches npm run dev), fall back to extension path
        const rootBase = workspaceRoot || process.cwd();
        const rootUploads = path.join(rootBase, 'uploads');
        const rootPublic = path.join(rootBase, 'public');
        this.uploadsDir = fs.existsSync(rootUploads) ? rootUploads : path.join(extensionPath, 'uploads');
        this.publicDir = fs.existsSync(rootPublic) ? rootPublic : path.join(extensionPath, 'public');
        this.state = {
            cdpConnections: [],
            lastSnapshot: null,
            lastSnapshotHash: null,
            activePort: null,
            activeTargetId: null,
            snapshotCache: new Map(),
            wssRef: null,
            pollInterval: null,
            missedSnapshots: 0,
            reinitInProgress: false,
            lastCdpInitAttemptAt: 0
        };
        this.useAuth = true;
        this.authToken = this.loadOrCreateToken(extensionPath);

        if (!fs.existsSync(this.uploadsDir)) {
            fs.mkdirSync(this.uploadsDir, { recursive: true });
        }

        this.configureMiddleware();
        this.configureRoutes();
    }

    public get localUrl() { return this._localUrl; }
    public get secureUrl() { return this._secureUrl; }
    public get token() { return this.authToken; }

    private loadOrCreateToken(basePath: string): string {
        const tokenPath = path.join(basePath, TOKEN_FILENAME);
        if (process.env.AUTH_TOKEN) return process.env.AUTH_TOKEN;
        if (fs.existsSync(tokenPath)) {
            return fs.readFileSync(tokenPath, 'utf8').trim();
        }
        const token = Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
        fs.writeFileSync(tokenPath, token);
        return token;
    }


    private configureMiddleware() {
        this.app.use(express.json({ limit: `${MAX_UPLOAD_SIZE_MB}mb` }));
        this.app.use(express.urlencoded({ limit: `${MAX_UPLOAD_SIZE_MB}mb`, extended: true }));
        this.app.use(express.static(this.publicDir, {
            etag: false,
            lastModified: false,
            maxAge: 0,
            setHeaders: (res) => {
                res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
                res.setHeader('Pragma', 'no-cache');
                res.setHeader('Expires', '0');
            }
        }));
        if (this.useAuth) {
            this.app.use(authMiddleware(this.authToken));
        }
        this.app.use(securityMiddleware);
    }

    // CDP helpers
    private scoreTarget(target: { title?: string; url?: string }): number {
        const title = (target.title || '').toLowerCase();
        const url = (target.url || '').toLowerCase();
        let score = 0;
        if (url.includes('workbench') || url.includes('jetski')) score += 6;
        if (title.includes('antigravity-link')) score += 6;
        if (title.includes('launchpad')) score += 2; // lower priority than chat
        if (title.includes('antigravity')) score += 2;
        if (title.includes('auth.ts')) score -= 6;
        if (url.includes('devtools') || title.includes('visual studio code')) score -= 8;
        if (title.includes('vscode-webview')) score -= 8;
        if (url.includes('/chat') || url.includes('/assistant')) score += 4;
        if (url.includes('workbench.html')) score += 5;
        return score;
    }

    private isWorkbenchTarget(target: { title?: string; url?: string }): boolean {
        const title = (target.title || '').toLowerCase();
        const url = (target.url || '').toLowerCase();
        return url.includes('workbench') ||
            url.includes('jetski') ||
            title.includes('antigravity') ||
            title.includes('launchpad');
    }

    // Prefer chat targets (exclude QR/devtools/extension webviews)
    private isChatTarget(target: { title?: string; url?: string }): boolean {
        const title = (target.title || '').toLowerCase();
        const url = (target.url || '').toLowerCase();
        if (title.includes('devtools') || url.includes('devtools')) return false;
        if (title.includes('vscode-webview')) return false;
        if (title.includes('auth.ts')) return false;
        return this.isWorkbenchTarget(target);
    }

    private isSnapshotUsable(snapshot: Snapshot): boolean {
        const html = String(snapshot?.html || '');
        if (!html || html.length < 64) return false;

        const controlsMeta: any = (snapshot as any).controlsMeta || {};
        const surfaceSignals: any = (snapshot as any).surfaceSignals || {};
        const modeText = String(controlsMeta?.mode?.text || '').trim();
        const modelText = String(controlsMeta?.model?.text || '').trim();
        const hasControlMeta = !!(modeText || modelText);

        const hasCascade = !!surfaceSignals.hasCascade || /id\s*=\s*["'](?:cascade|conversation|chat)["']/i.test(html);
        const hasComposer = !!surfaceSignals.hasComposer ||
            /contenteditable\s*=\s*["']true["']/i.test(html) ||
            /data-lexical-editor/i.test(html) ||
            /role\s*=\s*["']textbox["']/i.test(html);
        const hasMessages = !!surfaceSignals.hasMessages ||
            /data-message-id|role\s*=\s*["']article["']|class\s*=\s*["'][^"']*message/i.test(html);

        const commandPaletteSignals =
            /developer:\s|reload window|recently used|other commands|command palette|type a command/i.test(html) ||
            !!surfaceSignals.hasCommandPalette;

        if (commandPaletteSignals && !hasCascade && !hasComposer && !hasMessages && !hasControlMeta) {
            return false;
        }

        return hasCascade || hasComposer || hasMessages || hasControlMeta;
    }

    private async probeCandidateForChat(candidate: CDPInfo): Promise<{ ok: boolean; score: number; reason: string; connection?: CDPConnection }> {
        const probeExpression = `(() => {
            const q = (s) => document.querySelector(s);
            const hasCascade = !!q('#cascade, #conversation, #chat, [id*="cascade"], [id*="conversation"], [id*="chat"]');
            const hasComposer = !!q('[data-lexical-editor="true"][contenteditable="true"], [contenteditable="true"][role="textbox"], textarea');
            const hasMessages = !!q('[data-message-id], [data-testid*="message" i], [class*="message"], article, [role="article"]');
            const hasCommandPalette = !!q('.quick-input-widget, [id*="quickInput" i], [aria-label*="Type a command" i]');
            return { hasCascade, hasComposer, hasMessages, hasCommandPalette, title: String(document.title || ''), href: String(location.href || '') };
        })()`;

        try {
            const conn = await connectCDP(candidate.url, candidate.id, candidate.title);
            const ctxIds = conn.contexts.map(c => c.id);
            let bestScore = -999;
            let bestDiag: any = null;
            let hadResult = false;

            for (const ctxId of ctxIds) {
                try {
                    const result = await conn.call("Runtime.evaluate", {
                        expression: probeExpression,
                        returnByValue: true,
                        contextId: ctxId
                    });
                    const value = result?.result?.value;
                    if (!value) continue;
                    hadResult = true;
                    const score =
                        (value.hasCascade ? 6 : 0) +
                        (value.hasComposer ? 7 : 0) +
                        (value.hasMessages ? 5 : 0) +
                        (value.hasCommandPalette ? -5 : 0);
                    if (score > bestScore) {
                        bestScore = score;
                        bestDiag = value;
                    }
                } catch { }
            }

            if (!hadResult) {
                try {
                    const result = await conn.call("Runtime.evaluate", {
                        expression: probeExpression,
                        returnByValue: true
                    });
                    const value = result?.result?.value;
                    if (value) {
                        const score =
                            (value.hasCascade ? 6 : 0) +
                            (value.hasComposer ? 7 : 0) +
                            (value.hasMessages ? 5 : 0) +
                            (value.hasCommandPalette ? -5 : 0);
                        bestScore = score;
                        bestDiag = value;
                        hadResult = true;
                    }
                } catch { }
            }

            const titleScore = this.scoreTarget(candidate);
            const finalScore = (hadResult ? bestScore : -10) + titleScore;
            const isPaletteOnly = !!bestDiag?.hasCommandPalette && !bestDiag?.hasCascade && !bestDiag?.hasComposer && !bestDiag?.hasMessages;
            const ok = finalScore >= 4 && !isPaletteOnly;
            const reason = ok ? 'chat_surface' : (isPaletteOnly ? 'command_palette_surface' : 'weak_chat_signal');
            console.log(`[TRACE] cdp.probe ${JSON.stringify({ id: candidate.id, title: candidate.title, score: finalScore, reason, diag: bestDiag || null })}`);
            if (!ok) {
                try { conn.ws.close(); } catch { }
                return { ok: false, score: finalScore, reason };
            }
            return { ok: true, score: finalScore, reason, connection: conn };
        } catch (error) {
            return { ok: false, score: -999, reason: (error as Error)?.message || 'connect_failed' };
        }
    }

    private async initCDP(targetId?: string): Promise<void> {
        const instances = await discoverInstances();
        console.log(`[TRACE] cdp.init discovered=${instances.length} targetId=${targetId || 'auto'}`);

        // Select target by id if provided, else best-scoring chat target, else best overall
        let chosen = targetId ? instances.find(i => i.id === targetId) : null;
        if (!chosen) {
            const chatTargets = instances.filter(i => this.isChatTarget(i));
            const prioritizedChat = [...chatTargets].sort((a, b) => this.scoreTarget(b) - this.scoreTarget(a));
            chosen = prioritizedChat[0] || [...instances].sort((a, b) => this.scoreTarget(b) - this.scoreTarget(a))[0];
        }

        // Close existing
        this.state.cdpConnections.forEach(c => { try { c.ws.close(); } catch { } });
        this.state.cdpConnections = [];
        this.state.activeTargetId = null;
        this.state.activePort = null;

        // User explicitly selected a target: honor it first and keep it if it connects.
        if (targetId && chosen) {
            try {
                const conn = await connectCDP(chosen.url, chosen.id, chosen.title);
                this.state.cdpConnections.push(conn);
                this.state.activePort = chosen.port;
                this.state.activeTargetId = chosen.id;
                await this.updateSnapshot();
                return;
            } catch {
                // fall through to probing fallback candidates
            }
        }

        const prioritized = [...instances].sort((a, b) => this.scoreTarget(b) - this.scoreTarget(a));
        const candidates = chosen ? [chosen, ...prioritized.filter(t => t.id !== chosen!.id)] : prioritized;
        if (candidates.length === 0) {
            console.log('[TRACE] cdp.init no_candidates_after_discovery');
            return;
        }

        let selectedConn: CDPConnection | null = null;
        let selectedTarget: CDPInfo | null = null;
        let fallbackConn: CDPConnection | null = null;
        let fallbackTarget: CDPInfo | null = null;

        for (const candidate of candidates) {
            const probe = await this.probeCandidateForChat(candidate);
            if (probe.ok && probe.connection) {
                selectedConn = probe.connection;
                selectedTarget = candidate;
                break;
            }

            if (!fallbackConn) {
                try {
                    fallbackConn = await connectCDP(candidate.url, candidate.id, candidate.title);
                    fallbackTarget = candidate;
                } catch { }
            }
        }

        if (!selectedConn && fallbackConn && fallbackTarget) {
            selectedConn = fallbackConn;
            selectedTarget = fallbackTarget;
            console.log(`[TRACE] cdp.fallback_target ${JSON.stringify({ id: fallbackTarget.id, title: fallbackTarget.title })}`);
        }

        if (selectedConn && selectedTarget) {
            this.state.cdpConnections.push(selectedConn);
            this.state.activePort = selectedTarget.port;
            this.state.activeTargetId = selectedTarget.id;
        }

        await this.updateSnapshot();
    }

    private async updateSnapshot(): Promise<boolean> {
        if (this.state.cdpConnections.length === 0) {
            const now = Date.now();
            if (!this.state.reinitInProgress && (now - this.state.lastCdpInitAttemptAt > 2000)) {
                this.state.reinitInProgress = true;
                this.state.lastCdpInitAttemptAt = now;
                console.log('[TRACE] cdp.reconnect attempting init from empty-connection state');
                try {
                    await this.initCDP();
                } catch (err) {
                    console.log('[TRACE] cdp.reconnect failed:', (err as Error).message);
                } finally {
                    this.state.reinitInProgress = false;
                }
            }
            return false;
        }

        // Only capture from active target (first/only connection)
        const cdp = this.state.activeTargetId
            ? this.state.cdpConnections.find(c => c.id === this.state.activeTargetId)
            : this.state.cdpConnections[0];
        if (!cdp) return false;
        try {
            const snapshot = await captureSnapshot(cdp);
            if (snapshot && !snapshot.error) {
                if (!this.isSnapshotUsable(snapshot)) {
                    console.log('[TRACE] snapshot.rejected unusable surface');
                    this.state.missedSnapshots += 1;
                    return false;
                }
                const hash = this.hashString(snapshot.html);
                if (hash !== this.state.lastSnapshotHash) {
                    this.state.lastSnapshot = snapshot;
                    this.state.lastSnapshotHash = hash;
                    this.state.missedSnapshots = 0;
                    if (this.state.activePort) this.state.snapshotCache.set(this.state.activePort, snapshot);
                    this.broadcastSnapshot(snapshot);
                    return true;
                }
                this.state.missedSnapshots = 0;
                return false;
            } else if (snapshot && snapshot.error) {
                console.error(`⚠️ Capture Error (${cdp.title}):`, snapshot.error);
            }
        } catch (err) {
            console.error('Snapshot error:', (err as Error).message);
        }

        this.state.missedSnapshots += 1;
        if (this.state.missedSnapshots >= 3 && !this.state.reinitInProgress) {
            this.state.reinitInProgress = true;
            console.log('[TRACE] snapshot.missed_reinit attempting CDP rebind');
            try {
                await this.initCDP();
            } catch (err) {
                console.log('[TRACE] snapshot.missed_reinit failed:', (err as Error).message);
            } finally {
                this.state.reinitInProgress = false;
                this.state.missedSnapshots = 0;
            }
        }
        return false;
    }

    private broadcastSnapshot(snapshot: Snapshot): void {
        if (!this.wss) return;
        const message = JSON.stringify({
            type: 'snapshot',
            data: snapshot,
            timestamp: new Date().toISOString()
        });
        this.wss.clients.forEach(client => {
            if (client.readyState === WebSocket.OPEN) {
                client.send(message);
            }
        });
    }

    private hashString(input: string): string {
        let hash = 0;
        for (let i = 0; i < input.length; i++) {
            const chr = input.charCodeAt(i);
            hash = ((hash << 5) - hash) + chr;
            hash |= 0;
        }
        return hash.toString();
    }

    private isPrivateIPv4(ip: string): boolean {
        if (!ip || !/^\d+\.\d+\.\d+\.\d+$/.test(ip)) return false;
        const parts = ip.split('.').map(n => Number(n));
        if (parts.length !== 4 || parts.some(n => Number.isNaN(n) || n < 0 || n > 255)) return false;
        if (parts[0] === 10) return true;
        if (parts[0] === 192 && parts[1] === 168) return true;
        if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) return true;
        return false;
    }

    private pickBestLocalIp(interfaces: NodeJS.Dict<os.NetworkInterfaceInfo[]>): string {
        const candidates: { name: string; addr: string }[] = [];
        for (const name of Object.keys(interfaces)) {
            for (const iface of interfaces[name] || []) {
                if (!iface.internal && iface.family === 'IPv4') {
                    candidates.push({ name, addr: iface.address });
                }
            }
        }
        if (candidates.length === 0) return 'localhost';

        const scored = candidates.map(c => {
            const lname = c.name.toLowerCase();
            let score = 0;
            if (this.isPrivateIPv4(c.addr)) score += 20;
            if (c.addr.startsWith('192.168.')) score += 8;
            if (lname.includes('wi-fi') || lname.includes('wireless')) score += 5;
            if (lname.includes('ethernet') || /^en\d+$/i.test(c.name) || /^eth\d+$/i.test(c.name)) score += 4;
            if (lname.includes('virtual') || lname.includes('vbox') || lname.includes('wsl') || lname.includes('vpn') || lname.includes('tailscale')) score -= 15;
            return { ...c, score };
        }).sort((a, b) => b.score - a.score);

        return scored[0]?.addr || 'localhost';
    }

    private parsePreferredEndpoint(): { host: string; port?: number } | null {
        if (!this.preferredHost) return null;
        try {
            const parsed = new URL(this.preferredHost.includes('://') ? this.preferredHost : `http://${this.preferredHost}`);
            if (!parsed.hostname) return null;
            const preferredPort = parsed.port ? Number(parsed.port) : undefined;
            if (preferredPort && (Number.isNaN(preferredPort) || preferredPort < 1 || preferredPort > 65535)) {
                console.warn(`[Antigravity Link] Ignoring invalid preferredHost port in "${this.preferredHost}"`);
                return { host: parsed.hostname };
            }
            return { host: parsed.hostname, port: preferredPort };
        } catch {
            return null;
        }
    }

    private findBrainFile(filename: string): string | null {
        const brainDir = path.join(os.homedir(), '.gemini', 'antigravity', 'brain');
        if (!fs.existsSync(brainDir)) return null;
        try {
            const entries = fs.readdirSync(brainDir, { withFileTypes: true })
                .filter(e => e.isDirectory())
                .map(e => {
                    const full = path.join(brainDir, e.name);
                    try { return { full, mtime: fs.statSync(full).mtimeMs }; } catch { return { full, mtime: 0 }; }
                })
                .sort((a, b) => b.mtime - a.mtime);
            for (const entry of entries) {
                const filePath = path.join(entry.full, filename);
                if (fs.existsSync(filePath)) return filePath;
            }
        } catch { }
        return null;
    }

    private configureRoutes() {
        const router = Router();

        router.get('/ping', (_req, res) => res.send('pong'));

        router.get('/sys', (_req, res) => {
            res.json({
                interfaces: os.networkInterfaces(),
                platform: os.platform(),
                arch: os.arch(),
                uptime: os.uptime()
            });
        });

        router.get('/snapshot', (_req, res) => {
            if (!this.state.lastSnapshot) return res.status(503).json({ error: 'No snapshot available yet' });
            res.json(this.state.lastSnapshot);
        });

        router.get('/task', (_req, res) => {
            const brainDir = path.join(os.homedir(), '.gemini', 'antigravity', 'brain');
            const filePath = this.findBrainFile('task.md.resolved');
            if (!filePath) return res.status(404).json({ error: 'Task file not found', searched: brainDir });
            try {
                const content = fs.readFileSync(filePath, 'utf8');
                res.json({ content, path: filePath });
            } catch (e) {
                res.status(500).json({ error: (e as Error).message });
            }
        });

        router.get('/walkthrough', (_req, res) => {
            const brainDir = path.join(os.homedir(), '.gemini', 'antigravity', 'brain');
            const filePath = this.findBrainFile('walkthrough.md.resolved');
            if (!filePath) return res.status(404).json({ error: 'Walkthrough file not found', searched: brainDir });
            try {
                const content = fs.readFileSync(filePath, 'utf8');
                res.json({ content, path: filePath });
            } catch (e) {
                res.status(500).json({ error: (e as Error).message });
            }
        });

        router.get('/plan', (_req, res) => {
            const brainDir = path.join(os.homedir(), '.gemini', 'antigravity', 'brain');
            const candidates = [
                'implementation_plan.md.resolved', 'plan.md.resolved',
                'implementation_plan.md', 'plan.md'
            ];
            for (const name of candidates) {
                const filePath = this.findBrainFile(name);
                if (filePath) {
                    try {
                        const content = fs.readFileSync(filePath, 'utf8');
                        return res.json({ content, path: filePath });
                    } catch (e) {
                        return res.status(500).json({ error: (e as Error).message });
                    }
                }
            }
            res.status(404).json({ error: 'Plan file not found', searched: brainDir });
        });

        router.get('/instances', async (_req, res) => {
            try {
                const instances = await discoverInstances();
                console.log(`[TRACE] api.instances activeTargetId=${this.state.activeTargetId || 'none'} activePort=${this.state.activePort || 'none'} count=${instances.length}`);
                res.json({
                    activeTargetId: this.state.activeTargetId,
                    activePort: this.state.activePort,
                    instances: instances.map(i => ({ id: i.id, port: i.port, url: i.url, title: i.title }))
                });
            } catch (e) {
                console.log('[TRACE] api.instances error:', (e as Error).message);
                res.status(500).json({ error: (e as Error).message });
            }
        });

        router.post('/instance', async (req, res) => {
            const { targetId } = req.body as { targetId: string };
            if (!targetId) return res.status(400).json({ error: 'targetId required' });
            try {
                if (this.state.activeTargetId !== targetId || !this.state.lastSnapshot) {
                    await this.initCDP(targetId);
                } else if (this.state.lastSnapshot) {
                    this.broadcastSnapshot(this.state.lastSnapshot);
                }
                res.json({ success: true, activeTargetId: this.state.activeTargetId, activePort: this.state.activePort });
            } catch (e) {
                res.status(500).json({ error: (e as Error).message });
            }
        });

        router.post('/send', async (req, res) => {
            const { message } = req.body as { message?: string };
            if (!message) return res.status(400).json({ error: 'Message required' });
            const cdp = this.state.activeTargetId
                ? this.state.cdpConnections.find(c => c.id === this.state.activeTargetId)
                : this.state.cdpConnections[0];
            if (!cdp) return res.status(503).json({ error: 'CDP not connected' });
            const activeCdp = cdp;
            try {
                const result = await injectMessage(activeCdp, message);
                if (result.ok) return res.json({ success: true, method: result.method, target: activeCdp.title });
                res.status(500).json({ success: false, reason: result.reason });
            } catch (e) {
                res.status(500).json({ error: (e as Error).message });
            }
        });

        router.post('/click', async (req, res) => {
            const { text, tag, x, y, selector } = req.body as { text?: string, tag?: string, x?: number, y?: number, selector?: string };
            const cdp = this.state.activeTargetId
                ? this.state.cdpConnections.find(c => c.id === this.state.activeTargetId)
                : this.state.cdpConnections[0];
            if (!cdp) return res.status(503).json({ error: 'CDP not connected' });
            const activeCdp = cdp;

            try {
                const result = await clickElement(activeCdp, text, tag, x, y, selector);
                if (result.success) {
                    setTimeout(() => this.updateSnapshot(), 50);
                    return res.json({ success: true, target: activeCdp.title });
                }
                res.status(404).json({ error: 'Could not find element to click in active target' });
            } catch (e) {
                res.status(500).json({ error: (e as Error).message });
            }
        });

        router.post('/upload', async (req, res) => {
            const { name, content, targetSelector } = req.body as { name: string, content: string, targetSelector?: string };
            if (!name || !content) return res.status(400).json({ error: 'Name and content required' });

            const cdp = this.state.activeTargetId
                ? this.state.cdpConnections.find(c => c.id === this.state.activeTargetId)
                : this.state.cdpConnections[0];
            if (!cdp) return res.status(503).json({ error: 'CDP not connected' });

            try {
                const activeCdp = cdp;
                const base64Data = content.replace(/^data:.*,/, '');
                const buffer = Buffer.from(base64Data, 'base64');
                const maxBytes = MAX_UPLOAD_SIZE_MB * 1024 * 1024;
                if (buffer.length > maxBytes) {
                    return res.status(413).json({ error: `File too large. Max ${MAX_UPLOAD_SIZE_MB}MB.` });
                }
                if (!fs.existsSync(this.uploadsDir)) fs.mkdirSync(this.uploadsDir, { recursive: true });
                const safeName = `${Date.now()}-${path.basename(name)}`;
                const targetPath = path.join(this.uploadsDir, safeName);
                fs.writeFileSync(targetPath, buffer);

                const injectionResult = await injectFile(activeCdp, targetPath, targetSelector);
                if (injectionResult.ok) {
                    res.json({ success: true, path: targetPath, injected: true });
                } else {
                    res.json({ success: true, path: targetPath, injected: false, reason: injectionResult.reason || 'injection_failed' });
                }
            } catch (e) {
                res.status(500).json({ error: (e as Error).message });
            }
        });

        this.app.use('/', router);

        // Debug: list targets and active binding
        router.get('/debug/targets', async (_req, res) => {
            try {
                const instances = await discoverInstances();
                res.json({
                    activeTargetId: this.state.activeTargetId,
                    activePort: this.state.activePort,
                    connected: this.state.cdpConnections.map(c => ({ title: c.title, url: c.url, contexts: c.contexts.length })),
                    instances: instances.map(i => ({ id: i.id, port: i.port, title: i.title, url: i.url }))
                });
            } catch (e) {
                res.status(500).json({ error: (e as Error).message });
            }
        });

        router.get('/debug/snapshot-meta', (_req, res) => {
            const snapshot = this.state.lastSnapshot;
            if (!snapshot) {
                return res.status(503).json({
                    error: 'No snapshot available yet',
                    activeTargetId: this.state.activeTargetId,
                    activePort: this.state.activePort
                });
            }

            const controlsMeta: any = (snapshot as any).controlsMeta || null;
            const surfaceSignals: any = (snapshot as any).surfaceSignals || null;
            const html = String(snapshot.html || '');
            res.json({
                activeTargetId: this.state.activeTargetId,
                activePort: this.state.activePort,
                usable: this.isSnapshotUsable(snapshot),
                htmlLength: html.length,
                hasCascadeInHtml: /id\s*=\s*["'](?:cascade|conversation|chat)["']/i.test(html),
                controlsMeta,
                surfaceSignals
            });
        });

        // Debug: probe file inputs
        router.get('/debug/upload-probe', async (_req, res) => {
            const script = `(() => {
                const results = { inputs: [], buttons: [], contextHtml: '' };
                function isVisible(el) {
                    const rect = el.getBoundingClientRect();
                    return rect.width > 0 && rect.height > 0 && window.getComputedStyle(el).visibility !== 'hidden';
                }
                function getDocs() {
                    const docs = [document];
                    const iframes = Array.from(document.querySelectorAll('iframe'));
                    for (const frame of iframes) {
                        try { if (frame.contentDocument) docs.push(frame.contentDocument); } catch (e) {}
                    }
                    return docs;
                }
                function collect(doc) {
                    doc.querySelectorAll('input[type="file"]').forEach(i => {
                        results.inputs.push({ id: i.id, className: i.className, visible: isVisible(i) });
                    });
                    doc.querySelectorAll('button, [role="button"]').forEach(b => {
                        const txt = (b.textContent || '').trim();
                        const aria = b.getAttribute('aria-label') || '';
                        if (txt.length > 0 || aria.length > 0) {
                            results.buttons.push({ text: txt, aria, visible: isVisible(b) });
                        }
                    });
                    // Capture open overlays in this doc
                    const overlays = Array.from(doc.querySelectorAll('.fixed, .absolute, [role="menu"], [role="dialog"], [role="listbox"]'))
                        .filter(el => isVisible(el))
                        .sort((a, b) => (b.getBoundingClientRect().width * b.getBoundingClientRect().height) - (a.getBoundingClientRect().width * a.getBoundingClientRect().height));
                    if (overlays.length > 0 && !results.contextHtml) {
                        const top = overlays[0];
                        results.contextHtml = top.outerHTML.slice(0, 50000); // cap to avoid huge payload
                    }
                }
                getDocs().forEach(collect);
                return results;
            })()`;

            try {
                if (this.state.cdpConnections.length === 0) return res.status(503).json({ error: 'CDP not connected' });

                const allResults: any[] = [];
                for (const cdp of this.state.cdpConnections) {
                    const targetResults: any[] = [];
                    for (const ctx of cdp.contexts) {
                        try {
                            const probeResult = await cdp.call("Runtime.evaluate", {
                                expression: script,
                                returnByValue: true,
                                contextId: ctx.id
                            });
                            if (probeResult.result?.value) {
                                targetResults.push({ contextId: ctx.id, name: ctx.name, origin: ctx.origin, data: probeResult.result.value });
                            }
                        } catch (e) {
                            targetResults.push({ contextId: ctx.id, error: (e as Error).message });
                        }
                    }
                    allResults.push({ target: cdp.title, url: cdp.url, contexts: targetResults });
                }
                res.json({ success: true, targets: allResults });
            } catch (e) {
                res.status(500).json({ error: (e as Error).message });
            }
        });

        // Debug: snapshot capture diagnostics
        router.get('/debug/capture', async (_req, res) => {
            if (this.state.cdpConnections.length === 0) return res.status(503).json({ error: 'CDP not connected' });

            const cdp = this.state.activeTargetId
                ? this.state.cdpConnections.find(c => c.id === this.state.activeTargetId)
                : this.state.cdpConnections[0];
            if (!cdp) return res.status(503).json({ error: 'CDP not connected' });

            try {
                const result = await captureSnapshotDebug(cdp);
                res.json({
                    debugVersion: 'capture-v7',
                    target: cdp.title,
                    url: cdp.url,
                    contextCount: cdp.contexts.length,
                    errors: result.errors,
                    contexts: result.contexts,
                    snapshotOk: !!result.snapshot
                });
            } catch (e) {
                res.status(500).json({ error: (e as Error).message });
            }
        });
    }

    public async start(): Promise<{ localUrl: string; secureUrl: string; token: string }> {
        return new Promise(async (resolve, reject) => {
            try {
                if (this.useHttps) {
                    const certPath = path.join(this.extensionPath, CERT_FILENAME);
                    const keyPath = path.join(this.extensionPath, KEY_FILENAME);
                    let cert: string | Buffer;
                    let key: string | Buffer;
                    if (fs.existsSync(certPath) && fs.existsSync(keyPath)) {
                        cert = fs.readFileSync(certPath);
                        key = fs.readFileSync(keyPath);
                    } else {
                        const attrs = [{ name: 'commonName', value: 'Antigravity Link Extension' }];
                        // @ts-ignore
                        const pems = await selfsigned.generate(attrs, { days: 365 });
                        cert = pems.cert;
                        key = pems.private;
                        fs.writeFileSync(certPath, cert);
                        fs.writeFileSync(keyPath, key);
                    }
                    this.server = https.createServer({ key, cert }, this.app);
                } else {
                    this.server = http.createServer(this.app);
                }

                this.wss = new WebSocketServer({ server: this.server });
                this.state.wssRef = this.wss;

                this.wss.on('connection', (ws, req) => {
                    if (this.useAuth) {
                        const url = new URL(req.url || '', `http://${req.headers.host}`);
                        const token = url.searchParams.get('token');
                        const headerToken = (req.headers.authorization || '').replace('Bearer ', '');
                        if (token !== this.authToken && headerToken !== this.authToken) {
                            ws.close(1008, 'Unauthorized');
                            return;
                        }
                    }
                    if (this.state.lastSnapshot) {
                        ws.send(JSON.stringify({ type: 'snapshot', data: this.state.lastSnapshot, timestamp: new Date().toISOString() }));
                    }
                    ws.on('message', (data) => {
                        try {
                            const msg = JSON.parse(data.toString());
                            if (msg.type === 'request_snapshot' && this.state.lastSnapshot) {
                                ws.send(JSON.stringify({ type: 'snapshot', data: this.state.lastSnapshot, timestamp: new Date().toISOString() }));
                            }
                        } catch { }
                    });
                });

                this.server.on('error', (e) => reject(e));

                this.server.listen(this.port, async () => {
                    const interfaces = os.networkInterfaces();
                    const preferredEndpoint = this.parsePreferredEndpoint();
                    const localIp = preferredEndpoint?.host || this.pickBestLocalIp(interfaces);
                    const advertisedPort = preferredEndpoint?.port || this.port;

                    const protocol = this.useHttps ? 'https' : 'http';
                    const authQuery = this.useAuth ? `?token=${this.authToken}` : '';

                    this._localUrl = `${protocol}://${localIp}:${advertisedPort}/${authQuery}`;
                    this._secureUrl = this.useHttps ? this._localUrl : '';

                    try {
                        await this.initCDP();
                    } catch (err) {
                        console.log('⚠️ Initial CDP connection failed, will keep polling...');
                    }

                    this.state.pollInterval = setInterval(() => this.updateSnapshot(), POLL_INTERVAL);

                    resolve({
                        localUrl: this._localUrl,
                        secureUrl: this._secureUrl,
                        token: this.authToken
                    });
                });
            } catch (e) {
                reject(e);
            }
        });
    }

    public stop() {
        if (this.state.pollInterval) clearInterval(this.state.pollInterval);
        this.state.pollInterval = null;
        this.wss?.close();
        this.server?.close();
        this.state.cdpConnections.forEach(c => c.ws.close());
        this.state.cdpConnections = [];
        this.state.activeTargetId = null;
        this.state.activePort = null;
    }
}
