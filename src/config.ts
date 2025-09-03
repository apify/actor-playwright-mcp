/**
 * Copyright (c) Microsoft Corporation.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import os from 'node:os';
import path from 'node:path';

import type { Config, ToolCapability } from '@playwright/mcp/config.js';
import type { LaunchOptions } from 'playwright';

export type CLIOptions = {
    allowedOrigins?: string[];
    blockedOrigins?: string[];
    blockServiceWorkers?: boolean;
    browser?: string;
    caps?: string[] | string;
    cdpEndpoint?: string;
    config?: string;
    device?: string;
    executablePath?: string;
    headless?: boolean;
    host?: string;
    ignoreHttpsErrors?: boolean;
    isolated?: boolean;
    imageResponses?: 'allow' | 'omit';
    sandbox?: boolean;
    outputDir?: string;
    port?: number;
    proxyBypass?: string;
    proxyServer?: string;
    saveSession?: boolean;
    saveTrace?: boolean;
    storageState?: string;
    userAgent?: string;
    userDataDir?: string;
    viewportSize?: string;
};

export const DEFAULT_CAPABILITIES: ToolCapability[] = ['core'];

function sanitizeForFilePath(s: string) {
    // Avoid control characters in regex by listing only visible ASCII and reserved path characters
    const sanitize = (str: string) => str.replace(/[\\/:*?"<>|]+/g, '-');
    const separator = s.lastIndexOf('.');
    if (separator === -1) return sanitize(s);
    return `${sanitize(s.substring(0, separator))}.${sanitize(s.substring(separator + 1))}`;
}

function parseProxyUrl(proxyUrl: string): { server: string; username?: string; password?: string } {
    try {
        const url = new URL(proxyUrl);
        const auth = url.username ? {
            username: decodeURIComponent(url.username),
            password: decodeURIComponent(url.password),
        } : undefined;
        return {
            server: `${url.protocol}//${url.host}`,
            ...auth,
        };
    } catch {
        // If URL parsing fails, return the original URL as server
        return { server: proxyUrl };
    }
}

export async function configFromCLIOptions(cliOptions: CLIOptions): Promise<Config> {
    let browserName: 'chromium' | 'firefox' | 'webkit';
    let channel: string | undefined;
    switch (cliOptions.browser) {
        case 'chrome':
        case 'chrome-beta':
        case 'chrome-canary':
        case 'chrome-dev':
        case 'chromium':
        case 'msedge':
        case 'msedge-beta':
        case 'msedge-canary':
        case 'msedge-dev':
            browserName = 'chromium';
            channel = cliOptions.browser;
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

    // Launch options
    const launchOptions: LaunchOptions = {
        channel,
        headless: cliOptions.headless,
    };

    // we are running in a container, so we disable the sandbox
    launchOptions.chromiumSandbox = false;

    if (cliOptions.proxyServer) {
        launchOptions.proxy = parseProxyUrl(cliOptions.proxyServer);
    }

    return {
        browser: {
            browserName,
            launchOptions,
        },
        capabilities: DEFAULT_CAPABILITIES,
        outputDir: path.join(os.tmpdir(), 'playwright-mcp-output', sanitizeForFilePath(new Date().toISOString())),
        imageResponses: cliOptions.imageResponses,
    };
}
