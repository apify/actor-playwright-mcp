/**
 * Serves as an Actor MCP SSE server entry point.
 * This file needs to be named `main.ts` to be recognized by the Apify platform.
 */

// TODO: We need to install browser in dockerfile

import * as fs from 'node:fs';
import * as os from 'node:os';
import path from 'node:path';

import type { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { createServer } from '@playwright/mcp';
import { Actor } from 'apify';
import type { Request, Response } from 'express';
import express from 'express';
import type { LaunchOptions } from 'playwright';

import log from '@apify/log';

const HEADER_READINESS_PROBE = 'X-Readiness-Probe';

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
    log.info('Actor is running in the STANDBY mode.');
    startExpressServer(PORT, server).catch((e) => {
        log.error(`Failed to start Express server: ${e}`);
        process.exit(1);
    });
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

function getHelpMessage(host: string): string {
    return `Connect to ${host}/sse to establish a connection.`;
}

function getActorRunData() {
    return {
        actorId: Actor.getEnv().actorId,
        actorRunId: Actor.getEnv().actorRunId,
        startedAt: new Date().toISOString(),
    };
}

/**
 * Processes an SSE message to detect and save image content to KV store
 * @param message - The message to process
 * @param sessionId - The session ID associated with the message
 */
async function saveImagesFromMessage(message: any, sessionId: string): Promise<void> {
    try {
        // Parse the message if it's a string
        const messageObj = typeof message === 'string' ? JSON.parse(message) : message;

        // Check if the message contains image content
        const hasImageContent = messageObj?.result?.content?.some(
            (item: any) => item?.type === 'image' && item?.data
        );
        const kv = await Actor.openKeyValueStore();
        if (hasImageContent) {
            log.info('Message contains image content. Saving to Key-Value store...');
            // Extract and save each image in the message
            for (const [index, item] of messageObj.result.content.entries()) {
                if (item.type === 'image' && item.data) {
                    try {
                        // Base64 data might start with a data URL prefix, extract just the base64 part
                        let base64Data = item.data;
                        if (base64Data.includes(';base64,')) {
                            base64Data = base64Data.split(';base64,')[1];
                        }
                        // Create a Buffer from the base64 data
                        const imageBuffer = Buffer.from(base64Data, 'base64');
                        const imageKey = `image-${sessionId}-${Date.now()}-${index}`;
                        await kv.setValue(imageKey, imageBuffer, { contentType: 'image/jpeg' });
                        log.info(`Saved image to Key-Value store with key: ${imageKey}`);
                    } catch (imageError) {
                        log.error(`Failed to process image data: ${imageError}`);
                    }
                }
            }
        }
    } catch (error) {
        log.error(`Error processing message content: ${error}`);
    }
}

async function startExpressServer(port: number, server: Server) {
    const app = express();
    let transportSSE: SSEServerTransport;
    const sessions = new Map<string, SSEServerTransport>();

    function respondWithError(res: Response, error: unknown, logMessage: string, statusCode = 500) {
        log.error(`${logMessage}: ${error}`);
        if (!res.headersSent) {
            res.status(statusCode).json({
                jsonrpc: '2.0',
                error: {
                    code: statusCode === 500 ? -32603 : -32000,
                    message: statusCode === 500 ? 'Internal server error' : 'Bad Request',
                },
                id: null,
            });
        }
    }

    app.get('/', async (req: Request, res: Response) => {
        if (req.headers && req.get(HEADER_READINESS_PROBE) !== undefined) {
            log.debug('Received readiness probe');
            res.status(200).json({ message: 'Server is ready' }).end();
            return;
        }
        try {
            log.info('Received GET message at root');
            res.setHeader('Content-Type', 'text/event-stream');
            res.setHeader('Cache-Control', 'no-cache');
            res.setHeader('Connection', 'keep-alive');
            res.status(200).json({
                message: `Actor is using Model Context Protocol. ${getHelpMessage(HOST)}`,
                data: getActorRunData(),
            }).end();
        } catch (error) {
            respondWithError(res, error, 'Error in GET /');
        }
    });

    app.get('/sse', async (_req: Request, res: Response) => {
        try {
            log.info('Received GET message at /sse');
            transportSSE = new SSEServerTransport('/message', res);

            const originalSend = transportSSE.send.bind(transportSSE);
            transportSSE.send = async (message) => {
                log.info(`Sent SSE message to session ${transportSSE.sessionId}`);
                await Actor.pushData({ message });
                // Process message and extract/save any image content
                await saveImagesFromMessage(message, transportSSE.sessionId);
                return originalSend(message);
            };

            sessions.set(transportSSE.sessionId, transportSSE);
            res.on('close', () => {
                sessions.delete(transportSSE.sessionId);
                server.close().catch((e) => log.error(e));
            });
            await server.connect(transportSSE);
        } catch (error) {
            respondWithError(res, error, 'Error in GET /sse');
        }
    });

    app.post('/message', async (req: Request, res: Response) => {
        try {
            log.info('Received POST message at /message');
            const { searchParams } = new URL(`http://localhost${req.url}`);
            const sessionId = searchParams.get('sessionId');
            if (!sessionId) {
                res.status(400).json({
                    jsonrpc: '2.0',
                    error: {
                        code: -32000,
                        message: 'Bad Request: Missing sessionId',
                    },
                    id: null,
                });
                return;
            }
            const transport = sessions.get(sessionId);
            if (!transport) {
                res.status(404).json({
                    jsonrpc: '2.0',
                    error: {
                        code: -32000,
                        message: 'Bad Request: Session not found',
                    },
                    id: null,
                });
                return;
            }
            log.info(`Received POST message for sessionId: ${sessionId}`);
            await transport.handlePostMessage(req, res);
        } catch (error) {
            respondWithError(res, error, 'Error in POST /message');
        }
    });

    app.listen(port, () => {
        const url = Actor.isAtHome() ? `${HOST}` : `http://localhost:${port}`;
        log.info(`Listening on ${url}`);
        log.info('Put this in your client config:');
        log.info(JSON.stringify({
            mcpServers: {
                playwright: {
                    url,
                },
            },
        }, undefined, 2));
    });
}
