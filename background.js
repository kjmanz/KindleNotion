// Background service worker for Kindle to Notion Sync
// Handles API communication, sync logic, and scheduled tasks

import { createNotionClient } from './lib/notion-api.js';

// Message handlers
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    handleMessage(request, sender)
        .then(sendResponse)
        .catch(error => sendResponse({ error: error.message }));
    return true; // Keep message channel open for async response
});

/**
 * Handle incoming messages from popup or content scripts
 */
async function handleMessage(request, sender) {
    switch (request.action) {
        case 'testConnection':
            return testConnection(request.token, request.databaseId);

        case 'syncToNotion':
            return syncBooksToNotion(request.books);

        case 'getNotionHighlightCounts':
            return getNotionHighlightCounts();

        case 'setupAutoSync':
            return setupAutoSync(request.interval);

        case 'clearAutoSync':
            return clearAutoSync();

        case 'syncProgress':
        case 'syncLog':
            // Forward progress messages to all extension pages (sync-window)
            chrome.runtime.sendMessage(request).catch(() => { });
            return { forwarded: true };

        default:
            throw new Error(`Unknown action: ${request.action}`);
    }
}

/**
 * Test Notion API connection
 */
async function testConnection(token, databaseId) {
    try {
        const client = createNotionClient(token);
        const database = await client.getDatabase(databaseId);

        return {
            success: true,
            databaseTitle: database.title?.[0]?.plain_text || 'Untitled Database'
        };
    } catch (error) {
        return {
            success: false,
            error: error.message
        };
    }
}

/**
 * Get all books with highlight counts from Notion
 * Used for cross-device smart diff sync
 */
async function getNotionHighlightCounts() {
    const settings = await chrome.storage.sync.get(['notionToken', 'databaseId']);

    if (!settings.notionToken || !settings.databaseId) {
        throw new Error('Notion設定が完了していません');
    }

    const client = createNotionClient(settings.notionToken);
    const counts = await client.getAllBooksWithHighlightCount(settings.databaseId);

    return { counts };
}

/**
 * Sync books to Notion
 */
async function syncBooksToNotion(books) {
    const settings = await chrome.storage.sync.get(['notionToken', 'databaseId']);

    if (!settings.notionToken || !settings.databaseId) {
        throw new Error('Notion設定が完了していません');
    }

    const client = createNotionClient(settings.notionToken);
    const databaseId = settings.databaseId;

    let newBooks = 0;
    let newHighlights = 0;
    let updatedBooks = 0;

    for (let i = 0; i < books.length; i++) {
        const book = books[i];
        try {
            console.log(`[Notion Sync] Processing book ${i + 1}/${books.length}:`, book);

            // Send progress to sync window
            broadcastProgress(i + 1, books.length, book.title, newHighlights);
            broadcastLog('info', `[Notion ${i + 1}/${books.length}] ${book.title.substring(0, 35)}...`);

            // Check if book already exists by ASIN or title
            let page = null;

            if (book.title) {
                console.log(`[Notion Sync] Searching for book: "${book.title}"`);
                page = await client.findBookByTitle(databaseId, book.title);
                console.log(`[Notion Sync] Search result:`, page ? `Found (${page.id})` : 'Not found');
            }

            if (page) {
                // Book exists - check for new highlights
                console.log(`[Notion Sync] Book exists, checking for new highlights...`);
                const existingHighlights = await client.getExistingHighlights(page.id);
                console.log(`[Notion Sync] Existing highlights: ${existingHighlights.length}`);

                const newHighlightsList = book.highlights.filter(h =>
                    !existingHighlights.some(existing =>
                        existing.includes(h.text.substring(0, 50)) // Match by first 50 chars
                    )
                );
                console.log(`[Notion Sync] New highlights to add: ${newHighlightsList.length}`);

                if (newHighlightsList.length > 0) {
                    console.log(`[Notion Sync] Adding ${newHighlightsList.length} new highlights...`);
                    await client.addHighlightBlocks(page.id, newHighlightsList);
                    newHighlights += newHighlightsList.length;

                    // Update highlight count and last synced
                    await client.updateBookPage(page.id, {
                        highlightCount: existingHighlights.length + newHighlightsList.length
                    }, databaseId);
                    updatedBooks++;
                    broadcastLog('success', `✓ ${newHighlightsList.length}件の新規ハイライトを追加`);
                } else {
                    broadcastLog('info', `変更なし（既存ハイライトと同じ）`);
                }
            } else {
                // New book - create page and add highlights
                console.log(`[Notion Sync] Creating new book page...`);
                console.log(`[Notion Sync] Book data to create:`, {
                    title: book.title,
                    author: book.author,
                    amazonUrl: book.amazonUrl,
                    coverUrl: book.coverUrl,
                    highlightCount: book.highlights.length
                });

                page = await client.createBookPage(databaseId, book);
                console.log(`[Notion Sync] Book page created: ${page.id}`);
                newBooks++;

                if (book.highlights.length > 0) {
                    console.log(`[Notion Sync] Adding ${book.highlights.length} highlights to new page...`);
                    await client.addHighlightBlocks(page.id, book.highlights);
                    newHighlights += book.highlights.length;
                    console.log(`[Notion Sync] Highlights added successfully`);
                }
                broadcastLog('success', `✓ 新規書籍を追加 (${book.highlights.length}件のハイライト)`);
            }

            // Update highlight count in progress
            broadcastProgress(i + 1, books.length, null, newHighlights);

            // Rate limiting between books
            await delay(350);
        } catch (error) {
            console.error(`Error syncing book "${book.title}":`, error);
            broadcastLog('error', `✗ ${book.title.substring(0, 30)}: ${error.message}`);
            // Continue with next book
        }
    }

    return {
        success: true,
        newBooks,
        updatedBooks,
        newHighlights,
        totalProcessed: books.length
    };
}

/**
 * Setup automatic sync with Chrome Alarms API
 */
async function setupAutoSync(intervalMinutes) {
    await chrome.alarms.clear('autoSync');

    chrome.alarms.create('autoSync', {
        periodInMinutes: intervalMinutes
    });

    return { success: true };
}

/**
 * Clear automatic sync alarm
 */
async function clearAutoSync() {
    await chrome.alarms.clear('autoSync');
    return { success: true };
}

// Handle alarm events
chrome.alarms.onAlarm.addListener(async (alarm) => {
    if (alarm.name === 'autoSync') {
        await performAutoSync();
    }
});

/**
 * Perform automatic sync
 */
async function performAutoSync() {
    try {
        // Find Kindle notebook tab
        const tabs = await chrome.tabs.query({
            url: 'https://read.amazon.co.jp/notebook*'
        });

        if (tabs.length === 0) {
            console.log('Auto sync: No Kindle notebook tab found');
            return;
        }

        // Extract highlights from the tab
        const response = await chrome.tabs.sendMessage(tabs[0].id, {
            action: 'extractHighlights'
        });

        if (response.error) {
            console.error('Auto sync extraction error:', response.error);
            return;
        }

        // Sync to Notion
        const result = await syncBooksToNotion(response.books);
        console.log('Auto sync completed:', result);

    } catch (error) {
        console.error('Auto sync error:', error);
    }
}

// Initialize alarm on startup if auto sync is enabled
chrome.runtime.onStartup.addListener(async () => {
    const settings = await chrome.storage.sync.get(['autoSync', 'syncInterval']);

    if (settings.autoSync && settings.syncInterval) {
        await setupAutoSync(settings.syncInterval);
    }
});

// Also check on install
chrome.runtime.onInstalled.addListener(async () => {
    const settings = await chrome.storage.sync.get(['autoSync', 'syncInterval']);

    if (settings.autoSync && settings.syncInterval) {
        await setupAutoSync(settings.syncInterval);
    }
});

/**
 * Broadcast progress update to sync window
 */
function broadcastProgress(current, total, bookTitle, highlightsCount) {
    chrome.runtime.sendMessage({
        action: 'syncProgress',
        current,
        total,
        bookTitle,
        highlightsCount
    }).catch(() => { });
}

/**
 * Broadcast log message to sync window
 */
function broadcastLog(type, message) {
    chrome.runtime.sendMessage({
        action: 'syncLog',
        type,
        message
    }).catch(() => { });
}

/**
 * Delay helper for rate limiting
 */
function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}
