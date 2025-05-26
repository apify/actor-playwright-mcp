import type {ProxyConfigurationOptions} from 'apify';

export type ToolCapability = 'core' | 'tabs' | 'pdf' | 'history' | 'wait' | 'files' | 'install';

export type Input = {
    browser: | 'chrome' | 'firefox' | 'webkit' | 'msedge'
        | 'chrome-beta' | 'chrome-canary' | 'chrome-dev'
        | 'msedge-beta' | 'msedge-canary' | 'msedge-dev'
        | 'chromium';
    capabilities?: ToolCapability[];
    proxyConfiguration: ProxyConfigurationOptions;
    headless?: boolean;
    vision?: boolean;
};

// Define a type for image content items
export interface ImageContentItem {
    type?: string;
    data?: string;

    [key: string]: unknown;
}
