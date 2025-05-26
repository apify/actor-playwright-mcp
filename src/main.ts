/**
 * Serves as an Actor MCP SSE server entry point.
 * This file needs to be named `main.ts` to be recognized by the Apify platform.
 */

// TODO: We need to install browser in dockerfile

import {SSEServerTransport} from '@modelcontextprotocol/sdk/server/sse.js';
import type {Connection} from '@playwright/mcp';
import {createConnection} from '@playwright/mcp';
import type {Config} from '@playwright/mcp/config.js';
import {Actor} from 'apify';
import type {Request, Response} from 'express';
import express from 'express';

import log from '@apify/log';

import type {CLIOptions} from './config.js';
import {configFromCLIOptions} from './config.js';
import type {ImageContentItem, Input} from './types.js';

const HEADER_READINESS_PROBE = 'X-Readiness-Probe';

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

if (STANDBY_MODE) {
    if (input.proxyConfiguration) {
        const proxy = await Actor.createProxyConfiguration(input.proxyConfiguration);
        input.proxyServer = await proxy?.newUrl();
    }
    // cliOptions expects a string, but input.caps is an array
    const cliOptions: CLIOptions = {
        ...input as CLIOptions,
        caps: Array.isArray(input.caps) ? input.caps.join(',') : input.caps,
    };
    const config = await configFromCLIOptions(cliOptions);
    const connectionList: Connection[] = [];
    setupExitWatchdog(connectionList);

    log.info('Actor is running in the STANDBY mode.');
    startExpressServer(PORT, config, connectionList).catch((e) => {
        log.error(`Failed to start Express server: ${e}`);
        process.exit(1);
    });
} else {
    const msg = `Actor is not designed to run in the NORMAL model (use this mode only for debugging purposes)`;
    log.error(msg);
    await Actor.fail(msg);
}

function setupExitWatchdog(connectionList: Connection[]) {
    const handleExit = async () => {
        setTimeout(() => process.exit(0), 15000);
        for (const connection of connectionList) await connection.close();
        process.exit(0);
    };

    process.stdin.on('close', handleExit);
    process.on('SIGINT', handleExit);
    process.on('SIGTERM', handleExit);
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
async function saveImagesFromMessage(message: unknown, sessionId: string): Promise<void> {
    try {
        // Parse the message if it's a string
        const messageObj = typeof message === 'string' ? JSON.parse(message) : message;

        // Check if the message contains image content
        const hasImageContent = messageObj?.result?.content?.some(
            (item: ImageContentItem) => item?.type === 'image' && item?.data,
        );
        const kv = await Actor.openKeyValueStore();
        if (hasImageContent) {
            log.info('Message contains image content. Saving to key-value store...');
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
                        log.info(`Saved image to key-value store with key: ${imageKey}`);
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

async function startExpressServer(port: number, config: Config, connectionList: Connection[]) {
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
            sessions.set(transportSSE.sessionId, transportSSE);
            const connection = await createConnection(config);
            await connection.connect(transportSSE);
            connectionList.push(connection);

            const originalSend = transportSSE.send.bind(transportSSE);
            transportSSE.send = async (message) => {
                log.info(`Sent SSE message to session ${transportSSE.sessionId}`);
                await Actor.pushData({ message });
                // Process message and extract/save any image content
                await saveImagesFromMessage(message, transportSSE.sessionId);
                return originalSend(message);
            };

            res.on('close', () => {
                sessions.delete(transportSSE.sessionId);
                connection.close().catch((e) => log.error(`Error closing connection: ${e}`));
            });
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
