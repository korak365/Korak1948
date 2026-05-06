// Playwright-based Pinterest Visual Trend Scraper
import { Actor } from 'apify';
import { PlaywrightCrawler, Dataset, RequestList } from 'crawlee';

await Actor.init();

const input = (await Actor.getInput()) ?? {};
const {
    startUrls = ['https://www.pinterest.com/search/pins/?q=fashion'],
    maxRequestsPerCrawl = 200,
    scrollIterations = 8,
    authMethod = 'none',
    cookieString = '',
    downloadImages = true,
} = input;

// Proxy configuration (recommended)
const proxyConfiguration = await Actor.createProxyConfiguration();

// RequestList from startUrls
const requestList = await RequestList.open('start-urls', startUrls);

// Key-Value store for images and optional metadata
const kvStore = await Actor.openKeyValueStore();

const crawler = new PlaywrightCrawler({
    requestList,
    proxyConfiguration,
    maxRequestsPerCrawl,
    launchContext: {
        launchOptions: { headless: true },
    },
    async preNavigationHooks({ page, request, log }) {
        // Cookie-based auth placeholder
        if (authMethod === 'cookie' && cookieString) {
            log.info('Applying cookies for pinterest.com');
            try {
                const cookies = cookieString.split(';').map((c) => {
                    const [name, ...v] = c.trim().split('=');
                    return { name, value: v.join('='), domain: '.pinterest.com', path: '/' };
                });
                await page.context().addCookies(cookies);
            } catch (e) {
                log.warning('Failed to parse/apply cookie string', { error: e.message });
            }
        } else if (authMethod === 'credentials') {
            log.warning('authMethod=credentials selected but login flow is not implemented in this starter.');
        }
    },
    async requestHandler({ page, request, enqueueLinks, log }) {
        log.info('Visiting', { url: request.url });

        // Scroll to load pins
        for (let i = 0; i < scrollIterations; i++) {
            await page.evaluate(() => { window.scrollBy(0, window.innerHeight); });
            await page.waitForTimeout(800 + Math.random() * 1200);
        }

        // Enqueue pin pages (selectors may need tuning)
        await enqueueLinks({
            selector: 'a[href*="/pin/"], a[data-test-id="pin"]',
            globs: ['**/pin/**'],
            userData: { type: 'pin' },
        });

        // If current page looks like a pin page (URL contains /pin/), extract metadata
        const url = request.url;
        if (url.includes('/pin/')) {
            // Attempt extraction with fallbacks; Pinterest changes often
            const pinIdMatch = url.match(/\/pin\/(\d+)/);
            const pinId = pinIdMatch ? pinIdMatch[1] : `pin-${Date.now()}`;

            const title = (await page.$eval('meta[property="og:title"]', (el) => el.getAttribute('content')).catch(() => null)) ||
                (await page.$eval('h1', (el) => el.textContent.trim()).catch(() => null)) ||
                null;

            const description = (await page.$eval('meta[property="og:description"]', (el) => el.getAttribute('content')).catch(() => null)) ||
                (await page.$eval('[data-test-id="pin-description"]', (el) => el.textContent.trim()).catch(() => null)) ||
                null;

            const imageUrl = (await page.$eval('meta[property="og:image"]', (el) => el.getAttribute('content')).catch(() => null)) ||
                (await page.$eval('img[srcset]', (el) => el.getAttribute('src')).catch(() => null)) ||
                null;

            const sourceUrl = url;

            // Download image to Key-Value store if requested
            let imageKvKey = null;
            if (downloadImages && imageUrl) {
                try {
                    log.info('Downloading image', { imageUrl });
                    const res = await fetch(imageUrl);
                    if (res.ok) {
                        const ab = await res.arrayBuffer();
                        const buffer = Buffer.from(ab);
                        imageKvKey = `images/${pinId}.jpg`;
                        await kvStore.setValue(imageKvKey, buffer);
                        log.info('Saved image to Key-Value', { key: imageKvKey });
                    } else {
                        log.warning('Image fetch returned non-OK status', { status: res.status, url: imageUrl });
                    }
                } catch (e) {
                    log.warning('Failed to download/save image', { error: e.message, imageUrl });
                }
            }

            // Push metadata to Dataset
            await Dataset.pushData({
                pinId,
                title,
                description,
                imageUrl,
                imageKvKey,
                sourceUrl,
                crawledAt: new Date().toISOString(),
            });

            log.info('Pushed pin metadata', { pinId, title });
        }
    },
    failedRequestHandler: async ({ request, log }) => {
        log.error('Request failed', { url: request.url });
    },
});

await crawler.run();

// Done
await Actor.exit();