/**
 * Serves as an Actor MCP server entry point supporting both streamable HTTP and SSE transports.
 * This file needs to be named `main.ts` to be recognized by the Apify platform.
 */

import { randomUUID } from 'node:crypto';

import { InMemoryEventStore } from '@modelcontextprotocol/sdk/examples/shared/inMemoryEventStore.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createConnection } from '@playwright/mcp';
import type { Config, ToolCapability } from '@playwright/mcp/config.js';
import { Actor } from 'apify';
import type { Request, Response } from 'express';
import express from 'express';

import log from '@apify/log';

import type { CLIOptions } from './config.js';
import { configFromCLIOptions, DEFAULT_CAPABILITIES } from './config.js';
import type { ImageContentItem, Input } from './types.js';

const HEADER_READINESS_PROBE = 'X-Readiness-Probe';

const STANDBY_MODE = Actor.getEnv().metaOrigin === 'STANDBY';

/**
 * Detects if the request is from a HTML browser based on Accept header
 * @param req - Express request object
 * @returns true if the request is from a HTML browser
 */
export function isHTMLBrowser(req: Request): boolean {
    return req.headers.accept?.includes('text/html') || false;
}

/**
 * Serves HTML page for browser requests
 * @param req - Express request object
 * @param res - Express response object
 */
function serveHTMLPage(req: Request, res: Response): void {
    const serverUrl = `${req.protocol}://${req.get('host')}`;
    const mcpUrl = `${serverUrl}/mcp`;
    const html = getHTMLPage(mcpUrl);
    res.setHeader('Content-Type', 'text/html');
    res.send(html);
}

/**
 * Generates simple HTML page with server URL and MCP client link
 * @param mcpUrl - The MCP endpoint URL
 * @returns HTML string
 */
function getHTMLPage(mcpUrl: string): string {
    const sseUrl = mcpUrl.replace('/mcp', '/sse');
    return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <title>Playwright MCP Server</title>
    <style>
        body { font-family: system-ui; max-width: 600px; margin: 50px auto; padding: 20px; }
        .url { background: #f0f0f0; padding: 10px; border-radius: 4px; font-family: monospace; word-break: break-all; margin: 10px 0; }
        .test-link { display: inline-block; background: #007bff; color: white; padding: 10px 20px; text-decoration: none; border-radius: 4px; margin: 10px 0; }
        .test-link:hover { background: #0056b3; }
        .recommended { background: #d4edda; border: 1px solid #c3e6cb; padding: 10px; border-radius: 4px; margin: 10px 0; }
        .legacy { background: #fff3cd; border: 1px solid #ffeaa7; padding: 10px; border-radius: 4px; margin: 10px 0; }
    </style>
</head>
<body>
    <h1>Playwright MCP Server</h1>
    <p>Model Context Protocol server for browser automation.</p>
    
    <div class="recommended">
        <p><strong>🚀 Recommended Endpoint (Streamable HTTP):</strong></p>
        <div class="url">${mcpUrl}</div>
        <p><small>Modern transport with better performance and reliability.</small></p>
    </div>
    
    <div class="legacy">
        <p><strong>⚠️ Legacy Endpoint (SSE):</strong></p>
        <div class="url">${sseUrl}</div>
        <p><small>Available for backward compatibility only.</small></p>
    </div>
    
    <h2>MCP Configuration</h2>
    <pre style="background: #f8f9fa; padding: 15px; border-radius: 4px; overflow-x: auto;">
{
  "mcpServers": {
    "playwright": {
      "url": "${mcpUrl}",
      "headers": {
        "Authorization": "Bearer YOUR_APIFY_TOKEN"
      }
    }
  }
}</pre>
</body>
</html>`;
}

await Actor.init();

const HOST = Actor.isAtHome() ? process.env.ACTOR_STANDBY_URL as string : 'http://localhost';
const PORT = Actor.isAtHome() ? Number(process.env.ACTOR_STANDBY_PORT) : 3001;

if (!process.env.APIFY_TOKEN) {
    log.error('APIFY_TOKEN is required but not set in the environment variables.');
    process.exit(1);
}

const input = (await Actor.getInput()) as Partial<Input> & { caps?: string | ToolCapability[] };
log.info(`Loaded input: ${JSON.stringify(input)} `);

if (STANDBY_MODE) {
    if (input.proxyConfiguration) {
        const proxy = await Actor.createProxyConfiguration(input.proxyConfiguration);
        input.proxyServer = await proxy?.newUrl();
    }
    // Ensure caps is always an array of ToolCapability
    if (typeof input.caps === 'string' && input.caps) {
        input.caps = input.caps.split(',').map((cap: string) => cap.trim()) as ToolCapability[];
    } else if (!input.caps) {
        input.caps = DEFAULT_CAPABILITIES;
    }
    const cliOptions: CLIOptions = {
        ...input as CLIOptions,
        caps: input.caps,
    };
    const config = await configFromCLIOptions(cliOptions);

    log.info(`Actor is running in the STANDBY mode with config ${JSON.stringify(config)}`);
    startExpressServer(PORT, config).catch((e) => {
        log.error(`Failed to start Express server: ${e}`);
        process.exit(1);
    });
} else {
    const msg = `Actor is not designed to run in the NORMAL mode. Use MCP server URL to connect to the server.`
        + `Connect to ${HOST}/mcp to establish a connection. Learn more at https://mcp.apify.com/ for more information.`;
    log.info(msg);
    await Actor.exit(msg);
}

function getHelpMessage(host: string): string {
    return `Connect to ${host}/mcp to establish a connection using the modern streamable HTTP transport.`;
}

function getActorRunData() {
    return {
        actorId: Actor.getEnv().actorId,
        actorRunId: Actor.getEnv().actorRunId,
        startedAt: new Date().toISOString(),
    };
}

/**
 * Processes an MCP message to detect and save image content to KV store
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

async function startExpressServer(port: number, config: Config) {
    const app = express();
    const transportsSse = new Map<string, SSEServerTransport>();
    const transportsStreamable = new Map<string, StreamableHTTPServerTransport>();
    const server = await createConnection(config);

    function respondWithError(req: Request, res: Response, error: unknown, logMessage: string, statusCode = 500) {
        log.error(`${logMessage}: ${error}`);
        if (!res.headersSent) {
            res.status(statusCode).json({
                jsonrpc: '2.0',
                error: {
                    code: statusCode === 500 ? -32603 : -32000,
                    message: statusCode === 500 ? 'Internal server error' : 'Bad Request',
                },
                id: req?.body?.id ?? null,
            });
        }
    }

    app.get('/', async (req: Request, res: Response) => {
        if (req.headers && req.get(HEADER_READINESS_PROBE) !== undefined) {
            log.debug('Received readiness probe');
            res.status(200).json({ message: 'Server is ready' }).end();
            return;
        }

        // Browser client logic
        // Check if the request is from a HTML browser
        if (isHTMLBrowser(req)) {
            serveHTMLPage(req, res);
            return;
        }

        try {
            log.info('MCP API (Root endpoint)', { mth: req.method, rt: '/', tr: 'info' });
            res.setHeader('Content-Type', 'text/event-stream');
            res.setHeader('Cache-Control', 'no-cache');
            res.setHeader('Connection', 'keep-alive');
            res.status(200).json({
                message: `Actor is using Model Context Protocol. ${getHelpMessage(HOST)}`,
                data: getActorRunData(),
            }).end();
        } catch (error) {
            respondWithError(req, res, error, 'Error in GET /');
        }
    });

    app.get('/sse', async (req: Request, res: Response) => {
        // Browser client logic
        // Check if the request is from a HTML browser
        if (isHTMLBrowser(req)) {
            serveHTMLPage(req, res);
            return;
        }

        try {
            log.info('MCP API (Legacy SSE)', { mth: req.method, rt: '/sse', tr: 'sse' });
            const transport = new SSEServerTransport('/message', res);
            transportsSse.set(transport.sessionId, transport);
            await server.connect(transport);

            const originalSend = transport.send.bind(transport);
            transport.send = async (message) => {
                log.info(`Sent SSE message to session ${transport.sessionId}`);
                await Actor.pushData({ message });
                // Process message and extract/save any image content
                await saveImagesFromMessage(message, transport.sessionId);
                return originalSend(message);
            };

            res.on('close', () => {
                transportsSse.delete(transport.sessionId);
                server.close().catch((error: Error) => log.error(`Error closing connection: ${error}`));
            });
        } catch (error) {
            respondWithError(req, res, error, 'Error in GET /sse');
        }
    });

    app.post('/message', async (req: Request, res: Response) => {
        try {
            log.info('MCP API (Legacy SSE)', { mth: req.method, rt: '/message', tr: 'sse' });
            const sessionId = new URL(req.url, `http://${req.headers.host}`).searchParams.get('sessionId');
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
            const transport = transportsSse.get(sessionId);
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
            respondWithError(req, res, error, 'Error in POST /message');
        }
    });

    // express.json() middleware to parse JSON bodies.
    // It must be used before the POST /mcp route but after the GET /sse route
    app.use(express.json());
    app.post('/mcp', async (req: Request, res: Response) => {
        log.info('MCP API (Streamable HTTP)', { mth: req.method, rt: '/mcp', tr: 'http' });
        log.info('MCP request body:', req.body);
        try {
            // Check for existing session ID
            const sessionId = req.headers['mcp-session-id'] as string | undefined;
            let transport: StreamableHTTPServerTransport;

            if (sessionId && transportsStreamable.has(sessionId)) {
                // Reuse existing transport
                transport = transportsStreamable.get(sessionId)!;
            } else if (!sessionId) {
                // New initialization request
                const eventStore = new InMemoryEventStore();
                transport = new StreamableHTTPServerTransport({
                    sessionIdGenerator: () => randomUUID(),
                    eventStore, // Enable resumability
                    onsessioninitialized: (_id: string) => {
                        // Store the transport by session ID when session is initialized
                        // This avoids race conditions where requests might come in before the session is stored
                        transportsStreamable.set(_id, transport);
                    },
                });

                await server.connect(transport);
                await transport.handleRequest(req, res, req.body);
            } else {
                // Invalid request - no session ID or not initialization request
                res.status(400).json({
                    jsonrpc: '2.0',
                    error: {
                        code: -32000,
                        message: 'Bad Request: No valid session ID provided',
                    },
                    id: req?.body?.id,
                });
                return;
            }
            // Handle the request with existing transport - no need to reconnect
            await transport.handleRequest(req, res, req.body);
        } catch (error) {
            respondWithError(req, res, error, 'Error handling MCP request');
        }
    });

    // Handle GET requests for streamable HTTP transport (using built-in support from StreamableHTTP)
    app.get('/mcp', async (req: Request, res: Response) => {
        // Browser client logic
        // Check if the request is from a HTML browser
        if (isHTMLBrowser(req)) {
            serveHTMLPage(req, res);
            return;
        }

        log.info('MCP API (Streamable HTTP)', { mth: req.method, rt: '/mcp', tr: 'http' });
        const sessionId = req.headers['mcp-session-id'] as string | undefined;
        if (!sessionId || !transportsStreamable.has(sessionId)) {
            res.status(400).json({
                jsonrpc: '2.0',
                error: {
                    code: -32000,
                    message: 'Bad Request: No valid session ID provided',
                },
                id: req?.body?.id,
            });
            return;
        }

        // Check for Last-Event-ID header for resumability
        const lastEventId = req.headers['last-event-id'] as string | undefined;
        if (lastEventId) {
            log.error(`Client reconnecting with Last-Event-ID: ${lastEventId}`);
        } else {
            log.error(`Establishing new streamable HTTP connection for session ${sessionId}`);
        }

        const transport = transportsStreamable.get(sessionId);
        await transport!.handleRequest(req, res);
    });

    // Handle DELETE requests for session termination (according to MCP spec)
    app.delete('/mcp', async (req: Request, res: Response) => {
        const sessionId = req.headers['mcp-session-id'] as string | undefined;
        if (!sessionId || !transportsStreamable.has(sessionId)) {
            res.status(400).json({
                jsonrpc: '2.0',
                error: {
                    code: -32000,
                    message: 'Bad Request: No valid session ID provided',
                },
                id: req?.body?.id,
            });
            return;
        }

        log.error(`Received session termination request for session ${sessionId}`);

        try {
            const transport = transportsStreamable.get(sessionId);
            await transport!.handleRequest(req, res);
        } catch (error) {
            log.exception(error as Error, 'Error handling session termination:');
            if (!res.headersSent) {
                res.status(500).json({
                    jsonrpc: '2.0',
                    error: {
                        code: -32603,
                        message: 'Error handling session termination',
                    },
                    id: req?.body?.id,
                });
            }
        }
    });

    app.listen(port, () => {
        const url = Actor.isAtHome() ? `${HOST}` : `http://localhost:${port}`;
        log.info(`Listening on ${url}`);
        log.info('Recommended client configuration (using modern streamable HTTP transport):');
        log.info(JSON.stringify({
            mcpServers: {
                playwright: {
                    url: `${url}/mcp`,
                    headers: {
                        Authorization: 'Bearer YOUR_APIFY_TOKEN',
                    },
                },
            },
        }, undefined, 2));
    });

    // Handle server shutdown
    process.on('SIGINT', async () => {
        log.error('Shutting down server...');
        // Close all active Streamable HTTP transports to properly clean up resources
        for (const [sessionId, transport] of transportsStreamable) {
            try {
                log.error(`Closing transport for session ${sessionId}`);
                await transport.close();
                transportsStreamable.delete(sessionId);
            } catch (error) {
                log.error(`Error closing transport for session ${sessionId}: ${error}`);
            }
        }
        log.error('Server shutdown complete');
        process.exit(0);
    });
}
