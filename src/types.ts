import type { ProxyConfigurationOptions } from 'apify';
import type { ToolCapability } from '@playwright/mcp/config.js';

export type Input = {
    browser: | 'chrome' | 'firefox' | 'webkit' | 'msedge'
        | 'chrome-beta' | 'chrome-canary' | 'chrome-dev'
        | 'msedge-beta' | 'msedge-canary' | 'msedge-dev'
        | 'chromium';
    caps?: ToolCapability[];
    proxyConfiguration: ProxyConfigurationOptions;
    proxyServer?: string;
    headless?: boolean;
    vision?: boolean;
    imageResponses?: 'allow' | 'omit';

};

// Define a type for image content items
export interface ImageContentItem {
    type?: string;
    data?: string;

    [key: string]: unknown;
}
