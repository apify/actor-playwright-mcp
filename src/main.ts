/**
 * Serves as an Actor MCP server entry point supporting both streamable HTTP and SSE transports.
 * This file needs to be named `main.ts` to be recognized by the Apify platform.
 */

import { randomUUID } from 'node:crypto';

import { InMemoryEventStore } from '@modelcontextprotocol/sdk/examples/shared/inMemoryEventStore.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createConnection } from '@playwright/mcp';
import type { Config, ToolCapability } from '@playwright/mcp/config.js';
import { Actor } from 'apify';
import type { Request, Response } from 'express';
import express from 'express';

import log from '@apify/log';

import type { CLIOptions } from './config.js';
import { configFromCLIOptions, DEFAULT_CAPABILITIES } from './config.js';
import type { Input } from './types.js';

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
    
    <div>
        <p><strong>Connect with MCP client to this URL:</strong></p>
        <div class="url">${mcpUrl}</div>
    </div>
    
    <h2>MCP client configuration (claude-desktop)</h2>
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
        + `Connect to https://jiri-spilka--playwright-mcp-server.apify.actor/mcp to establish a connection. Learn more at https://mcp.apify.com/ for more information.`;
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

async function startExpressServer(port: number, config: Config) {
    const app = express();
    const transportsStreamable = new Map<string, StreamableHTTPServerTransport>();
    const server = await createConnection(config);

    function respondWithServerError(req: Request, res: Response, error: unknown, message: string) {
        log.error(`${message}: ${error}`);
        if (!res.headersSent) {
            res.status(500).json({
                jsonrpc: '2.0',
                error: {
                    code: -32603,
                    message,
                },
                id: req?.body?.id ?? null,
            });
        }
    }

    function respondWithBadRequest(req: Request, res: Response, message: string) {
        res.status(400).json({
            jsonrpc: '2.0',
            error: {
                code: -32000,
                message,
            },
            id: req?.body?.id ?? null,
        });
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
            respondWithServerError(req, res, error, 'Error in GET /');
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
                // Handle the request with existing transport
                await transport.handleRequest(req, res, req.body);
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
                respondWithBadRequest(req, res, 'Bad Request: No valid session ID provided');
            }
        } catch (error) {
            respondWithServerError(req, res, error, 'Error handling MCP request');
        }
    });

    // Reusable handler for GET and DELETE requests
    const handleSessionRequest = async (req: Request, res: Response) => {
        const sessionId = req.headers['mcp-session-id'] as string | undefined;
        if (!sessionId || !transportsStreamable.has(sessionId)) {
            respondWithBadRequest(req, res, 'Bad Request: No valid session ID provided');
            return;
        }
        
        const transport = transportsStreamable.get(sessionId);
        await transport!.handleRequest(req, res);
    };

    // Handle GET requests for server-to-client notifications via SSE
    app.get('/mcp', async (req: Request, res: Response) => {
        // Browser client logic
        // Check if the request is from a HTML browser
        if (isHTMLBrowser(req)) {
            serveHTMLPage(req, res);
            return;
        }

        log.info('MCP API (Streamable HTTP)', { mth: req.method, rt: '/mcp', tr: 'http' });

        // Check for Last-Event-ID header for resumability
        const lastEventId = req.headers['last-event-id'] as string | undefined;
        const sessionId = req.headers['mcp-session-id'] as string | undefined;

        if (lastEventId) {
            log.info(`Client reconnecting with Last-Event-ID: ${lastEventId}`);
        } else if (sessionId) {
            log.info(`Establishing new streamable HTTP connection for session ${sessionId}`);
        }

        await handleSessionRequest(req, res);
    });

    // Handle DELETE requests for session termination (according to MCP spec)
    app.delete('/mcp', async (req: Request, res: Response) => {
        const sessionId = req.headers['mcp-session-id'] as string | undefined;
        log.info(`Received session termination request for session ${sessionId}`);

        try {
            await handleSessionRequest(req, res);
        } catch (error) {
            respondWithServerError(req, res, error, 'Error handling session termination');
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
