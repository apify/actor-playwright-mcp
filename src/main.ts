/**
 * Serves as an Actor MCP SSE server entry point.
 * This file needs to be named `main.ts` to be recognized by the Apify platform.
 */

import assert from 'node:assert';
import * as fs from 'node:fs';
import http from 'node:http';
import * as os from 'node:os';
import path from 'node:path';

import type { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { createServer } from '@playwright/mcp';
import { Actor } from 'apify';
import type { LaunchOptions } from 'playwright';

import log from '@apify/log';

export type ToolCapability = 'core' | 'tabs' | 'pdf' | 'history' | 'wait' | 'files' | 'install';

export type Input = {
    browser:| 'chrome' | 'firefox' | 'webkit' | 'msedge'
        | 'chrome-beta' | 'chrome-canary' | 'chrome-dev'
        | 'msedge-beta' | 'msedge-canary' | 'msedge-dev'
        | 'chromium';
    capabilities?: ToolCapability[];
    cdpEndpoint?: string;
    executablePath?: string;
    headless?: boolean;
    port?: number;
    userDataDir?: string;
    vision?: boolean;
};

const STANDBY_MODE = Actor.getEnv().metaOrigin === 'STANDBY';

await Actor.init();

const HOST = Actor.isAtHome() ? process.env.ACTOR_STANDBY_URL as string : 'http://localhost';
const PORT = Actor.isAtHome() ? Number(process.env.ACTOR_STANDBY_PORT) : 3001;

if (!process.env.APIFY_TOKEN) {
    log.error('APIFY_TOKEN is required but not set in the environment variables.');
    process.exit(1);
}

const input = (await Actor.getInput<Partial<Input>>()) ?? ({} as Input);
log.info(`Loaded input: ${JSON.stringify(input)} `);

let browserName: 'chromium' | 'firefox' | 'webkit';
let channel: string | undefined;

switch (input.browser) {
    case 'chrome':
    case 'chrome-beta':
    case 'chrome-canary':
    case 'chrome-dev':
    case 'msedge':
    case 'msedge-beta':
    case 'msedge-canary':
    case 'msedge-dev':
        browserName = 'chromium';
        channel = input.browser;
        break;
    case 'chromium':
        browserName = 'chromium';
        break;
    case 'firefox':
        browserName = 'firefox';
        break;
    case 'webkit':
        browserName = 'webkit';
        break;
    default:
        browserName = 'chromium';
        channel = 'chrome';
}

if (STANDBY_MODE) {
    const launchOptions: LaunchOptions = {
        headless: (input.headless ?? (os.platform() === 'linux' && !process.env.DISPLAY)),
        channel,
        executablePath: input.executablePath,
    };
    input.userDataDir = input.userDataDir ?? await createUserDataDir(browserName);

    type CreateServerOptions = {
        browserName: 'chromium' | 'firefox' | 'webkit';
        userDataDir: string;
        launchOptions: LaunchOptions;
        vision: boolean;
        cdpEndpoint?: string;
        capabilities?: ToolCapability[];
    };

    const server = createServer({
        browserName,
        userDataDir: input.userDataDir,
        launchOptions,
        vision: !!input.vision,
        cdpEndpoint: input.cdpEndpoint,
        capabilities: input.capabilities,
    } as CreateServerOptions) as Server;

    setupExitWatchdog(server);
    // const app = createExpressApp(HOST);
    log.info('Actor is running in the STANDBY mode.');
    startSSEServer(PORT, server).catch((e) => {
        log.error(`Failed to start SSE server: ${e}`);
        process.exit(1);
    });
    // app.listen(PORT, () => {
    //     log.info(`The Actor web server is listening for user requests at ${HOST}`);
    // });
} else {
    const msg = `Actor is not designed to run in the NORMAL model (use this mode only for debugging purposes)`;
    log.error(msg);
    await Actor.fail(msg);
}

function setupExitWatchdog(server: Server) {
    const handleExit = async () => {
        setTimeout(() => process.exit(0), 15000);
        await server.close();
        process.exit(0);
    };

    process.stdin.on('close', handleExit);
    process.on('SIGINT', handleExit);
    process.on('SIGTERM', handleExit);
}

async function createUserDataDir(browserNameDir: 'chromium' | 'firefox' | 'webkit') {
    let cacheDirectory: string;
    if (process.platform === 'linux') {
        cacheDirectory = process.env.XDG_CACHE_HOME || path.join(os.homedir(), '.cache');
    } else if (process.platform === 'darwin') {
        cacheDirectory = path.join(os.homedir(), 'Library', 'Caches');
    } else if (process.platform === 'win32') {
        cacheDirectory = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
    } else {
        throw new Error(`Unsupported platform: ${process.platform}`);
    }
    const result = path.join(cacheDirectory, 'ms-playwright', `mcp-${browserNameDir}-profile`);
    await fs.promises.mkdir(result, { recursive: true });
    return result;
}

async function startSSEServer(port: number, server: Server) {
    const sessions = new Map<string, SSEServerTransport>();
    const httpServer = http.createServer(async (req, res) => {
        if (req.method === 'POST') {
            const { searchParams } = new URL(`http://localhost${req.url}`);
            const sessionId = searchParams.get('sessionId');
            if (!sessionId) {
                res.statusCode = 400;
                res.end('Missing sessionId');
                return;
            }
            const transport = sessions.get(sessionId);
            if (!transport) {
                res.statusCode = 404;
                res.end('Session not found');
                return;
            }

            await transport.handlePostMessage(req, res);
        } else if (req.method === 'GET') {
            const transport = new SSEServerTransport('/sse', res);
            sessions.set(transport.sessionId, transport);
            res.on('close', () => {
                sessions.delete(transport.sessionId);
                server.close().catch((e) => log.error(e));
            });
            await server.connect(transport);
        } else {
            res.statusCode = 405;
            res.end('Method not allowed');
        }
    });

    httpServer.listen(port, () => {
        const address = httpServer.address();
        assert(address, 'Could not bind server socket');
        let url: string;
        if (typeof address === 'string') {
            url = address;
        } else {
            const resolvedPort = address.port;
            let resolvedHost = address.family === 'IPv4' ? address.address : `[${address.address}]`;
            if (resolvedHost === '0.0.0.0' || resolvedHost === '[::]') resolvedHost = 'localhost';
            url = `http://${resolvedHost}:${resolvedPort}`;
        }
        log.info(`Listening on ${url}`);
        log.info('Put this in your client config:');
        log.info(JSON.stringify({
            mcpServers: {
                playwright: {
                    url: Actor.isAtHome() ? `${HOST}/sse` : `${url}/sse`,
                },
            },
        }, undefined, 2));
    });
}
