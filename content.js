// Content script for Kindle Notebook page
// Extracts book and highlight information from the page

(function () {
    'use strict';

    // Listen for messages from popup or sync window
    chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
        if (request.action === 'extractHighlights') {
            try {
                const books = extractAllBooks();
                sendResponse({ books });
            } catch (error) {
                sendResponse({ error: error.message });
            }
        } else if (request.action === 'extractAllBooksAuto') {
            // Auto-extract all books by clicking through each one
            // Pass Notion highlight counts for cross-device diff sync
            extractAllBooksAuto(request.notionCounts || {})
                .then(books => sendResponse({ books }))
                .catch(error => sendResponse({ error: error.message }));
            return true; // Keep channel open for async
        } else if (request.action === 'getBookCount') {
            // Just return the number of books
            const bookContainers = document.querySelectorAll('.kp-notebook-library-each-book');
            sendResponse({ count: bookContainers.length });
        } else if (request.action === 'extractAllBooksAutoWithProgress') {
            // Auto-extract with progress updates to sync window
            extractAllBooksAutoWithProgress()
                .then(books => sendResponse({ books }))
                .catch(error => sendResponse({ error: error.message }));
            return true; // Keep channel open for async
        }
        return true; // Keep the message channel open for async response
    });

    /**
     * Auto-extract all books by clicking through each one
     * Uses smart diff check to only process books with changed highlight counts
     * @param {Object} notionCounts - Highlight counts from Notion for cross-device sync
     */
    // ★ テストモード: 処理する書籍数を制限 (0 = 無制限)
    let cachedTestBookLimit = null;

    async function getTestBookLimit() {
        if (cachedTestBookLimit !== null) {
            return cachedTestBookLimit;
        }
        try {
            const settings = await chrome.storage.sync.get(['testMode']);
            cachedTestBookLimit = settings.testMode ? 5 : 0;
        } catch (e) {
            cachedTestBookLimit = 0;
        }
        return cachedTestBookLimit;
    }

    async function extractAllBooksAuto(notionCounts = {}) {
        const allBooks = [];
        const bookContainers = document.querySelectorAll('.kp-notebook-library-each-book');

        console.log(`[Kindle2Notion] Starting smart auto-extraction of ${bookContainers.length} books...`);
        console.log(`[Kindle2Notion] Notion counts available for ${Object.keys(notionCounts).length} books`);

        if (bookContainers.length === 0) {
            // Single book view
            const singleBook = extractCurrentBook();
            if (singleBook) {
                allBooks.push(singleBook);
            }
            return allBooks;
        }

        // Use Notion counts for comparison (cross-device sync)
        // If Notion counts are available, use them; otherwise fall back to local cache
        const useNotionCounts = Object.keys(notionCounts).length > 0;
        let savedCounts = notionCounts;

        if (!useNotionCounts) {
            // Fallback to local storage if Notion counts not available
            const savedData = await chrome.storage.local.get('bookHighlightCounts');
            savedCounts = savedData.bookHighlightCounts || {};
            console.log(`[Kindle2Notion] Using local cache (${Object.keys(savedCounts).length} books)`);
        } else {
            console.log(`[Kindle2Notion] Using Notion counts for smart diff`);
            // Debug: show first 5 Notion titles
            const notionTitles = Object.keys(notionCounts).slice(0, 5);
            console.log(`[Kindle2Notion] Notion titles sample:`, notionTitles);
        }

        const newCounts = {};
        const isFirstSync = Object.keys(savedCounts).length === 0;

        let skippedBooks = 0;
        let processedBooks = 0;

        const testBookLimit = await getTestBookLimit();
        const testModeActive = testBookLimit > 0;

        // First pass: collect all books to process
        const booksToProcess = [];
        for (let i = 0; i < bookContainers.length; i++) {
            const container = bookContainers[i];
            const titleEl = container.querySelector('h2');
            const title = titleEl ? titleEl.textContent.trim() : `book_${i}`;

            // Extract highlight count from the container text
            const containerText = container.textContent || '';
            // Try multiple patterns for Japanese and English
            const highlightMatch = containerText.match(/(\d+)\s*(?:\u500b\u306e\u30cf\u30a4\u30e9\u30a4\u30c8|\u4ef6\u306e\u30cf\u30a4\u30e9\u30a4\u30c8|\u30cf\u30a4\u30e9\u30a4\u30c8|highlights?)/i);
            const currentHighlightCount = highlightMatch ? parseInt(highlightMatch[1], 10) : -1;

            // Create a unique key for this book (for local cache)
            const bookKey = title.substring(0, 50).replace(/[^a-zA-Z0-9぀-ゟ゠-ヿ一-鿿]/g, '_');
            if (currentHighlightCount > 0) {
                newCounts[bookKey] = currentHighlightCount;
            }

            // Check if we need to process this book
            // For Notion: check if title EXISTS (not just count comparison)
            // This handles cases where highlight count can't be extracted from list view
            const existsInNotion = useNotionCounts && notionCounts[title] !== undefined;
            const savedCount = useNotionCounts ? (notionCounts[title] || 0) : (savedCounts[bookKey] || 0);

            // Debug: show matching status
            if (useNotionCounts) {
                console.log(`[Kindle2Notion] Book "${title.substring(0, 30)}..." - In Notion: ${existsInNotion}, kindle: ${currentHighlightCount}, notion: ${savedCount}`);
            }

            // Decision logic:
            // 1. If book exists in Notion AND kindle highlight count unknown (-1) ? skip (already synced)
            // 2. If book exists in Notion AND kindle count > saved count ? process (new highlights)
            // 3. If book NOT in Notion ? process (new book)
            // 4. First sync (no saved counts) ? process all
            let shouldProcess = false;
            if (testModeActive) {
                shouldProcess = booksToProcess.length < testBookLimit;
            } else if (isFirstSync) {
                shouldProcess = true;
            } else if (existsInNotion) {
                // Book exists in Notion - only process if we KNOW there are more highlights
                if (currentHighlightCount > 0 && currentHighlightCount > savedCount) {
                    shouldProcess = true;
                    console.log(`[Kindle2Notion] More highlights detected: ${currentHighlightCount} > ${savedCount}`);
                } else {
                    console.log(`[Kindle2Notion] Skipping (already in Notion): "${title.substring(0, 40)}..."`);
                    skippedBooks++;
                }
            } else {
                // Book not in Notion - process it
                shouldProcess = true;
            }

            if (shouldProcess) {
                console.log(`[Kindle2Notion] Will process: "${title}" (kindle: ${currentHighlightCount}, saved: ${savedCount})`);
                booksToProcess.push({ index: i, container, title, highlightCount: currentHighlightCount, bookKey });
            }
        }

        // Apply test limit if set
        if (testBookLimit > 0 && booksToProcess.length > testBookLimit) {
            console.log(`[Kindle2Notion] TEST MODE: limiting to ${testBookLimit} books`);
            booksToProcess.length = testBookLimit;
        }

        if (testModeActive) {
            skippedBooks = Math.max(bookContainers.length - booksToProcess.length, 0);
        }

        console.log(`[Kindle2Notion] Processing ${booksToProcess.length} books, skipping ${skippedBooks} unchanged books`);

        // Send initial log to sync window
        sendLog('info', `${booksToProcess.length} books to process, ${skippedBooks} skipped`);
        let totalExtractedHighlights = 0;

        // Second pass: process only changed books
        for (const book of booksToProcess) {
            try {
                processedBooks++;
                console.log(`[Kindle2Notion] Processing book ${processedBooks}/${booksToProcess.length}: ${book.title}`);

                // Send progress to sync window (progress bar + stats update)
                sendProgress(processedBooks, booksToProcess.length, book.title, totalExtractedHighlights);
                sendLog('info', `[${processedBooks}/${booksToProcess.length}] ${book.title.substring(0, 35)}...`);

                clickBookContainer(book.container);

                // Wait for highlights to load
                let titleUpdated = await waitForTitleUpdate(book.title, book.container);
                if (!titleUpdated) {
                    // Retry once in case the click didn't register
                    clickBookContainer(book.container);
                    titleUpdated = await waitForTitleUpdate(book.title, book.container);
                }
                if (!titleUpdated) {
                    if (isBookSelected(book.container)) {
                        sendLog('warning', `Title not matched but selected, proceeding: ${book.title.substring(0, 30)}...`);
                    } else {
                        sendLog('warning', `Title not updated, skipping: ${book.title.substring(0, 30)}...`);
                        continue;
                    }
                }
                await delay(500);

                // Extract book info and highlights
                let highlights = extractHighlightsFromPage();

                if (highlights.length === 0) {
                    await delay(400);
                    highlights = extractHighlightsFromPage();
                }

                if (highlights.length > 0 || testModeActive) {
                    let bookData = extractCurrentBook();
                    if (!bookData) {
                        console.log(`[Kindle2Notion] extractCurrentBook() returned null, using extractBookInfoFromContainer`);
                        bookData = extractBookInfoFromContainer(book.container);
                    }
                    bookData.highlights = highlights;
                    totalExtractedHighlights += highlights.length;

                    console.log(`[Kindle2Notion] Book "${bookData.title}": ${highlights.length} highlights extracted`);
                    console.log(`[Kindle2Notion] Book data:`, { title: bookData.title, author: bookData.author, amazonUrl: bookData.amazonUrl, coverUrl: bookData.coverUrl, highlightCount: highlights.length });
                    sendLog('success', `${highlights.length} highlights`);
                    // Update highlight count in progress
                    sendProgress(processedBooks, booksToProcess.length, null, totalExtractedHighlights);
                    allBooks.push(bookData);
                } else {
                    sendLog('warning', 'No highlights');
                }

                // Small delay between books for stability
                await delay(150);

            } catch (error) {
                console.error(`[Kindle2Notion] Error processing book "${book.title}":`, error);
                sendLog('error', `Error: ${book.title.substring(0, 30)}`);
            }
        }

        // Save updated counts to local storage
        try {
            // Merge with existing counts (don't lose data for books not in current view)
            const mergedCounts = { ...savedCounts, ...newCounts };
            await chrome.storage.local.set({ bookHighlightCounts: mergedCounts });
            console.log(`[Kindle2Notion] Saved highlight counts for ${Object.keys(mergedCounts).length} books locally`);
        } catch (storageError) {
            console.warn('[Kindle2Notion] Could not save to local storage:', storageError);
        }

        console.log(`[Kindle2Notion] Smart extraction complete: ${allBooks.length} books processed, ${skippedBooks} skipped`);
        return allBooks;
    }

    /**
     * Auto-extract all books with progress notifications to sync window
     */
    async function extractAllBooksAutoWithProgress() {
        const allBooks = [];
        const bookContainers = document.querySelectorAll('.kp-notebook-library-each-book');

        // Send initial progress
        sendProgress(0, bookContainers.length, 'Scanning...');

        if (bookContainers.length === 0) {
            const singleBook = extractCurrentBook();
            if (singleBook) {
                allBooks.push(singleBook);
            }
            return allBooks;
        }

        // Get saved highlight counts from local storage
        const savedData = await chrome.storage.local.get('bookHighlightCounts');
        const savedCounts = savedData.bookHighlightCounts || {};
        const newCounts = {};
        const isFirstSync = Object.keys(savedCounts).length === 0;
        const testBookLimit = await getTestBookLimit();
        const testModeActive = testBookLimit > 0;

        if (isFirstSync) {
            sendLog('info', 'First sync: processing all books');
        }

        // First pass: identify books to process
        const booksToProcess = [];
        for (let i = 0; i < bookContainers.length; i++) {
            const container = bookContainers[i];
            const titleEl = container.querySelector('h2');
            const title = titleEl ? titleEl.textContent.trim() : `book_${i}`;

            const containerText = container.textContent || '';
            const highlightMatch = containerText.match(/(\d+)\s*(?:\u500b\u306e\u30cf\u30a4\u30e9\u30a4\u30c8|\u30cf\u30a4\u30e9\u30a4\u30c8|highlights?)/i);
            const currentHighlightCount = highlightMatch ? parseInt(highlightMatch[1], 10) : -1; // -1 means unknown

            const bookKey = title.substring(0, 50).replace(/[^a-zA-Z0-9぀-ゟ゠-ヿ一-鿿]/g, '_');
            if (currentHighlightCount > 0) {
                newCounts[bookKey] = currentHighlightCount;
            }

            const savedCount = savedCounts[bookKey] || 0;

            if (testModeActive) {
                if (booksToProcess.length < testBookLimit) {
                    booksToProcess.push({ index: i, container, title, highlightCount: currentHighlightCount, bookKey });
                }
            } else {
                // Process if: first sync OR highlight count changed OR count is unknown (will check by extracting)
                if (isFirstSync || currentHighlightCount !== savedCount || currentHighlightCount === -1) {
                    booksToProcess.push({ index: i, container, title, highlightCount: currentHighlightCount, bookKey });
                }
            }
        }

        // Apply test limit if set
        if (testBookLimit > 0 && booksToProcess.length > testBookLimit) {
            console.log(`[Kindle2Notion] TEST MODE: limiting to ${testBookLimit} books`);
            booksToProcess.length = testBookLimit;
        }

        sendLog('info', `${booksToProcess.length} changed (${bookContainers.length - booksToProcess.length} skipped)`);

        // Second pass: process changed books with progress
        for (let i = 0; i < booksToProcess.length; i++) {
            const book = booksToProcess[i];

            try {
                sendProgress(i + 1, booksToProcess.length, book.title);
                clickBookContainer(book.container);
                let titleUpdated = await waitForTitleUpdate(book.title, book.container);
                if (!titleUpdated) {
                    // Retry once in case the click didn't register
                    clickBookContainer(book.container);
                    titleUpdated = await waitForTitleUpdate(book.title, book.container);
                }
                if (!titleUpdated) {
                    if (isBookSelected(book.container)) {
                        sendLog('warning', `Title not matched but selected, proceeding: ${book.title.substring(0, 30)}...`);
                    } else {
                        sendLog('warning', `Title not updated, skipping: ${book.title.substring(0, 30)}...`);
                        continue;
                    }
                }
                await delay(500);

                let highlights = extractHighlightsFromPage();

                if (highlights.length === 0) {
                    await delay(400);
                    highlights = extractHighlightsFromPage();
                }

                if (highlights.length > 0 || testModeActive) {
                    let bookData = extractCurrentBook();
                    if (!bookData) {
                        console.log(`[Kindle2Notion] extractCurrentBook() returned null, using extractBookInfoFromContainer`);
                        bookData = extractBookInfoFromContainer(book.container);
                    }
                    bookData.highlights = highlights;
                    console.log(`[Kindle2Notion] Book data:`, { title: bookData.title, author: bookData.author, amazonUrl: bookData.amazonUrl, coverUrl: bookData.coverUrl, highlightCount: highlights.length });
                    allBooks.push(bookData);
                    sendLog('success', `${book.title.substring(0, 30)}... (${highlights.length} highlights)`);
                }

                await delay(150);

            } catch (error) {
                sendLog('error', `Error: ${book.title.substring(0, 30)}...`);
                console.error(`[Kindle2Notion] Error:`, error);
            }
        }

        // Save updated counts to local storage
        try {
            const mergedCounts = { ...savedCounts, ...newCounts };
            await chrome.storage.local.set({ bookHighlightCounts: mergedCounts });
        } catch (e) {
            console.warn('[Kindle2Notion] Could not save locally:', e);
        }

        return allBooks;
    }

    /**
     * Send progress update to sync window
     */
    function sendProgress(current, total, bookTitle, highlightsCount) {
        chrome.runtime.sendMessage({
            action: 'syncProgress',
            current,
            total,
            bookTitle,
            highlightsCount
        }).catch(() => { }); // Ignore errors if no listener
    }

    /**
     * Send log message to sync window
     */
    function sendLog(type, message) {
        chrome.runtime.sendMessage({
            action: 'syncLog',
            type,
            message
        }).catch(() => { }); // Ignore errors if no listener
    }

    /**
     * Extract book info from a library container element
     */
    function extractBookInfoFromContainer(container) {
        const titleEl = container.querySelector('h2');
        const title = titleEl ? titleEl.textContent.trim() : 'Unknown Title';

        console.log(`[Kindle2Notion] extractBookInfoFromContainer for: ${title}`);

        // Find author
        let author = '';
        const pElements = container.querySelectorAll('p');
        console.log(`[Kindle2Notion] Found ${pElements.length} <p> elements in container`);
        for (const p of pElements) {
            const text = p.textContent.trim();
            console.log(`[Kindle2Notion] <p> text: "${text}"`);
            if (text && !text.includes('ハイライト') && !text.includes('メモ') && !text.includes('highlights')) {
                const match = text.match(/著者[:：]\s*(.+)/) || [null, text];
                author = match[1].replace(/著者[:：]\s*/, '').trim();
                console.log(`[Kindle2Notion] Author extracted: "${author}"`);
                break;
            }
        }

        // Find Amazon URL
        let amazonUrl = '';
        let asin = '';

        // 0. Try to get ASIN directly from container ID or attributes
        // Kindle local library items often have ID containing ASIN (e.g. "B00ABC1234" or "kp-notebook-library-each-book-B00ABC1234")
        if (container.id) {
            const match = container.id.match(/([A-Z0-9]{10})/);
            if (match) asin = match[1];
        }
        if (!asin && container.dataset && container.dataset.asin) {
            asin = container.dataset.asin;
        }

        if (asin) {
            amazonUrl = `https://www.amazon.co.jp/dp/${asin}`;
            console.log(`[Kindle2Notion] Found ASIN from container: ${asin}`);
        } else {
            // 1. Strict container link (most reliable)
            const containerLink = container.querySelector('a[href*="/dp/"], a[href*="/product/"], a[href*="amazon"]');
            if (containerLink && containerLink.href) {
                amazonUrl = containerLink.href;
                // Try extract ASIN from this URL
                const match = amazonUrl.match(/\/(?:dp|product)\/([A-Z0-9]{10})/);
                if (match) asin = match[1];
            }
        }

        // 2. Fallback to global only if title matches current view
        if (!amazonUrl) {
            // Check if current right-panel title matches this book's title
            const rightPanelTitleEl = document.querySelector('.kp-notebook-metadata h3, h2.kp-notebook-searchable');
            const rightPanelTitle = rightPanelTitleEl ? rightPanelTitleEl.textContent.trim() : '';

            // Only use global/right-panel info if titles match
            if (rightPanelTitle && (rightPanelTitle === title || rightPanelTitle.includes(title) || title.includes(rightPanelTitle))) {
                const linkSelectors = [
                    '#kp-notebook-annotations a[href*="amazon"]',
                    '.kp-notebook-annotations-container a[href*="amazon"]'
                ];
                for (const sel of linkSelectors) {
                    const link = document.querySelector(sel);
                    if (link && link.href) {
                        amazonUrl = link.href;
                        break;
                    }
                }
            }
        }

        // Find cover image
        let coverUrl = '';
        // 1. Container image (most reliable)
        const containerImg = container.querySelector('img[src*="images-amazon"], img[src*="ssl-images-amazon"], img[src*="m.media-amazon"]');
        if (containerImg && containerImg.src) {
            coverUrl = getHighResCoverUrl(containerImg.src, amazonUrl);
        }

        // 2. Fallback to global only if title matches and we strictly need it
        if (!coverUrl) {
            const rightPanelTitleEl = document.querySelector('.kp-notebook-metadata h3, h2.kp-notebook-searchable');
            const rightPanelTitle = rightPanelTitleEl ? rightPanelTitleEl.textContent.trim() : '';

            if (rightPanelTitle && (rightPanelTitle === title || rightPanelTitle.includes(title) || title.includes(rightPanelTitle))) {
                const annotationImg = document.querySelector('#kp-notebook-annotations img[src*="images-amazon"], .kp-notebook-annotations-container img[src*="images-amazon"]');
                if (annotationImg && annotationImg.src) {
                    coverUrl = getHighResCoverUrl(annotationImg.src, amazonUrl);
                }
            }
        }

        return {
            title,
            author,
            amazonUrl,
            coverUrl,
            highlights: []
        };
    }

    /**
     * Get high resolution cover URL
     * 1. Try to generate URL from ASIN (if amazonUrl provided)
     * 2. Fallback to removing size parameters from image URL
     */
    function getHighResCoverUrl(imageUrl, amazonUrl) {
        // Try to extract ASIN from Amazon URL
        if (amazonUrl) {
            const asinMatch = amazonUrl.match(/\/(?:dp|product)\/([A-Z0-9]{10})/);
            if (asinMatch) {
                const asin = asinMatch[1];
                // Use Amazon's high-res image service
                return `https://images-na.ssl-images-amazon.com/images/P/${asin}.01.LZZZZZZZ.jpg`;
            }
        }

        if (!imageUrl) return '';
        // Fallback: Remove patterns like ._SY160_, ._SX98_
        return imageUrl.replace(/\._[A-Z]{2,}[0-9.,_]*_/, '');
    }

    /**
     * Click a book container reliably
     */
    function clickBookContainer(container) {
        if (!container) return false;
        const targets = [
            container.querySelector('a'),
            container.querySelector('h2'),
            container
        ].filter(Boolean);

        for (const target of targets) {
            try {
                target.scrollIntoView({ block: 'center' });
                // Click via events for reliability
                const eventInit = { bubbles: true, cancelable: true, view: window };
                target.dispatchEvent(new MouseEvent('mousedown', eventInit));
                target.dispatchEvent(new MouseEvent('mouseup', eventInit));
                target.dispatchEvent(new MouseEvent('click', eventInit));
                return true;
            } catch (e) {
                // Try next target
            }
        }
        return false;
    }

    /**
     * Check if a book container is selected
     */
    function isBookSelected(container) {
        if (!container) return false;
        if (container.classList.contains('kp-notebook-selected')) return true;
        const ariaSelected = container.getAttribute('aria-selected');
        if (ariaSelected === 'true') return true;
        const selectedChild = container.querySelector('[aria-selected="true"], .kp-notebook-selected');
        return !!selectedChild;
    }

    /**
     * Delay helper
     */
    function delay(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    /**
     * Wait for the right panel to update with the expected book title
     */
    async function waitForTitleUpdate(expectedTitle, container, timeout = 8000) {
        if (!expectedTitle) return true;

        const normalizeTitle = (title) => title
            .replace(/[\s\u3000\u002d\u2010-\u2015\u003a\uff1a\u30fb\u3001\u3002\uff01\uff1f\u0021\u003f\u002c\u002e\u0028\u0029\uff08\uff09\u3010\u3011\u005b\u005d]/g, '')
            .substring(0, 30);

        const splitTitle = (title) => title
            .split(/[\u3000\u003a\uff1a\u30fb\u2010-\u2015\u002d\u2013\u2014\u301c\u007c]/)
            .map(part => part.trim())
            .filter(Boolean);

        const expectedVariants = new Set();
        const expectedNorm = normalizeTitle(expectedTitle);
        expectedVariants.add(expectedNorm);
        for (const part of splitTitle(expectedTitle)) {
            expectedVariants.add(normalizeTitle(part));
        }
        if (expectedNorm.length > 10) {
            expectedVariants.add(expectedNorm.substring(0, 10));
        }
        if (expectedNorm.length > 15) {
            expectedVariants.add(expectedNorm.substring(0, 15));
        }

        const matchesExpected = (currentTitle) => {
            if (!currentTitle) return false;
            const norm = normalizeTitle(currentTitle);
            for (const variant of expectedVariants) {
                if (!variant) continue;
                if (norm.includes(variant) || variant.includes(norm)) {
                    return true;
                }
            }
            return false;
        };

        const titleSelectors = [
            '.kp-notebook-metadata h3',
            'h2.kp-notebook-searchable',
            'span.kp-notebook-searchable',
            '#kp-notebook-annotations h2',
            '.kp-notebook-annotations h2',
            '.kp-notebook-metadata h2'
        ];

        const readRightPanelTitle = () => {
            for (const selector of titleSelectors) {
                const el = document.querySelector(selector);
                if (el && el.textContent.trim()) {
                    return el.textContent.trim();
                }
            }
            return '';
        };

        const readHighlightSignature = () => {
            const annotationsRoot = document.querySelector(
                '#kp-notebook-annotations, .kp-notebook-annotations-container, [id*="annotations"]'
            );
            const searchRoot = annotationsRoot || document;
            const highlightSelectors = [
                '.kp-notebook-highlight',
                '[data-annotation-type="highlight"]',
                '[id^="annotationHighlight"]',
                '#highlight',
                '[id*="highlight"]'
            ];

            let highlightEls = [];
            for (const selector of highlightSelectors) {
                const els = Array.from(searchRoot.querySelectorAll(selector))
                    .filter(el => !el.closest('.kp-notebook-library, .kp-notebook-library-each-book'));
                if (els.length > 0) {
                    highlightEls = els;
                    break;
                }
            }

            if (highlightEls.length === 0) {
                return '';
            }

            const firstText = highlightEls[0].textContent.trim();
            return `${highlightEls.length}|${firstText.substring(0, 50)}`;
        };

        const initialSignature = readHighlightSignature();

        const isReady = () => {
            const currentTitle = readRightPanelTitle();
            if (matchesExpected(currentTitle)) {
                return true;
            }
            const currentSignature = readHighlightSignature();
            if (currentSignature && currentSignature !== initialSignature && isBookSelected(container)) {
                return true;
            }
            return false;
        };

        if (isReady()) return true;

        return await new Promise((resolve) => {
            let done = false;
            const finish = (ok) => {
                if (done) return;
                done = true;
                observer.disconnect();
                clearInterval(interval);
                clearTimeout(timer);
                resolve(ok);
            };

            const annotationsRoot = document.querySelector(
                '#kp-notebook-annotations, .kp-notebook-annotations-container, [id*="annotations"]'
            );
            const target = annotationsRoot || document.body || document.documentElement;

            const observer = new MutationObserver(() => {
                if (isReady()) finish(true);
            });

            if (target) {
                observer.observe(target, { childList: true, subtree: true, characterData: true });
            }

            const interval = setInterval(() => {
                if (isReady()) finish(true);
            }, 200);

            const timer = setTimeout(() => {
                finish(false);
            }, timeout);
        });
    }

    /**
     * Extract all books and their highlights from the Kindle notebook page
     */
    function extractAllBooks() {
        const books = [];

        console.log('[Kindle2Notion] Starting extraction...');
        console.log('[Kindle2Notion] Current URL:', window.location.href);

        // Try multiple selectors for book containers
        const bookContainerSelectors = [
            '.kp-notebook-library-each-book',
            '.kp-notebook-annotations-container',
            '[id^="kp-notebook-annotations"]',
            '.a-row.a-spacing-base'
        ];

        let bookContainers = null;
        for (const selector of bookContainerSelectors) {
            bookContainers = document.querySelectorAll(selector);
            console.log(`[Kindle2Notion] Selector "${selector}": found ${bookContainers.length} elements`);
            if (bookContainers.length > 0) break;
        }

        // Debug: Log page structure
        console.log('[Kindle2Notion] Page title:', document.title);
        console.log('[Kindle2Notion] Body classes:', document.body.className);

        // Try to find any elements with 'kp-notebook' in class name
        const kpElements = document.querySelectorAll('[class*="kp-notebook"]');
        console.log('[Kindle2Notion] Elements with kp-notebook class:', kpElements.length);
        if (kpElements.length > 0) {
            const classNames = [...new Set([...kpElements].map(el => el.className))];
            console.log('[Kindle2Notion] Found class names:', classNames.slice(0, 10));
        }

        if (!bookContainers || bookContainers.length === 0) {
            // Try alternative: current single book view
            console.log('[Kindle2Notion] No book containers found, trying single book view...');
            const singleBook = extractCurrentBook();
            if (singleBook) {
                console.log('[Kindle2Notion] Single book found:', singleBook.title, 'with', singleBook.highlights.length, 'highlights');
                books.push(singleBook);
            } else {
                console.log('[Kindle2Notion] No single book found either');
            }
        } else {
            // Library view - look for the currently selected book's highlights
            // In the Kindle notebook, clicking a book shows its highlights
            console.log('[Kindle2Notion] Library view detected with', bookContainers.length, 'books');

            // First, try to find highlights that are currently displayed
            const allHighlights = extractHighlightsFromPage();
            console.log('[Kindle2Notion] Found', allHighlights.length, 'highlights on page');

            if (allHighlights.length > 0) {
                // Find which book is currently selected/active
                const selectedBook = findSelectedBook(bookContainers);
                if (selectedBook) {
                    selectedBook.highlights = allHighlights;
                    console.log('[Kindle2Notion] Selected book:', selectedBook.title, 'with', selectedBook.highlights.length, 'highlights');
                    books.push(selectedBook);
                } else {
                    // If can't identify selected book, try extractCurrentBook
                    const currentBook = extractCurrentBook();
                    if (currentBook && currentBook.highlights.length > 0) {
                        books.push(currentBook);
                    }
                }
            } else {
                // No highlights visible - user needs to select a book first
                console.log('[Kindle2Notion] No highlights visible. User needs to click on a book first.');
            }
        }

        console.log('[Kindle2Notion] Total books extracted:', books.length);
        return books;
    }

    /**
     * Find the currently selected/active book in library view
     */
    function findSelectedBook(bookContainers) {
        console.log('[Kindle2Notion] Looking for selected book...');

        // In Kindle notebook, the annotation section shows the currently selected book
        // Look for the book title in the annotation area (right side)
        const annotationSection = document.querySelector('#kp-notebook-annotations, .kp-notebook-annotations-container, [id*="annotations"]');

        // Try to find book title from annotation header area
        const titleSelectors = [
            '#kp-notebook-annotations h2',
            '.kp-notebook-annotations h2',
            '#annotation-section h2',
            'h2.kp-notebook-searchable',
            '.a-row h2',
            // Look for the book title in the metadata section
            'span.kp-notebook-searchable',
            '.kp-notebook-metadata h3'
        ];

        let bookTitle = '';
        for (const selector of titleSelectors) {
            const el = document.querySelector(selector);
            if (el) {
                const text = el.textContent.trim();
                // Skip if it's the page header "メモとハイライト"
                if (text && text !== 'メモとハイライト' && text.length > 0) {
                    bookTitle = text;
                    console.log(`[Kindle2Notion] Book title found with "${selector}":`, bookTitle);
                    break;
                }
            }
        }

        // If still no title, try to find from the book list on left side
        if (!bookTitle) {
            // Look for book with some visual indicator of being selected
            const selectedIndicators = [
                '.kp-notebook-library-each-book.kp-notebook-selected',
                '.kp-notebook-library-each-book:focus',
                '.kp-notebook-library-each-book[style*="background"]'
            ];

            for (const selector of selectedIndicators) {
                const el = document.querySelector(selector);
                if (el) {
                    const titleEl = el.querySelector('h2');
                    if (titleEl) {
                        bookTitle = titleEl.textContent.trim();
                        console.log('[Kindle2Notion] Book title from selected indicator:', bookTitle);
                        break;
                    }
                }
            }
        }

        // Last resort: get the first book's title if only one book has visible highlights
        if (!bookTitle && bookContainers.length > 0) {
            // Just use the first book in the list
            const firstBookTitle = bookContainers[0].querySelector('h2');
            if (firstBookTitle) {
                bookTitle = firstBookTitle.textContent.trim();
                console.log('[Kindle2Notion] Using first book title:', bookTitle);
            }
        }

        if (!bookTitle) {
            console.log('[Kindle2Notion] Could not determine book title');
            return null;
        }

        // Now find author - try multiple approaches
        console.log('[Kindle2Notion] Looking for author...');

        const authorSelectors = [
            'p.a-spacing-none',
            '.kp-notebook-metadata p',
            'p[class*="author"]',
            'span[class*="author"]',
            '.a-row p',
            '.a-column p',
            'span.a-size-base'
        ];

        let author = '';

        // First, try to find "著者:" pattern
        for (const selector of authorSelectors) {
            const els = document.querySelectorAll(selector);
            for (const el of els) {
                const text = el.textContent.trim();
                // Try multiple patterns for author
                const patterns = [
                    /著者[:：]\s*(.+)/,
                    /作者[:：]\s*(.+)/,
                    /by\s+(.+)/i,
                    /Author[:：]?\s*(.+)/i
                ];

                for (const pattern of patterns) {
                    const match = text.match(pattern);
                    if (match) {
                        author = match[1].trim();
                        console.log('[Kindle2Notion] Author found with pattern:', author);
                        break;
                    }
                }
                if (author) break;
            }
            if (author) break;
        }

        // If still no author, try to find author from the book container in left panel
        if (!author) {
            // Try to find the book in the left panel that matches our title
            const bookContainers = document.querySelectorAll('.kp-notebook-library-each-book');
            for (const container of bookContainers) {
                const titleEl = container.querySelector('h2');
                if (titleEl && titleEl.textContent.trim() === bookTitle) {
                    // Found matching book, look for author
                    const authorEls = container.querySelectorAll('p');
                    for (const authorEl of authorEls) {
                        const text = authorEl.textContent.trim();
                        // Usually the second p tag contains the author
                        if (text && !text.includes('ハイライト') && !text.includes('メモ')) {
                            const match = text.match(/著者[:：]\s*(.+)/) ||
                                text.match(/(.+)/);  // Fallback: use whole text
                            if (match && match[1]) {
                                const potentialAuthor = match[1].replace(/著者[:：]\s*/, '').trim();
                                if (potentialAuthor && potentialAuthor.length < 100) {
                                    author = potentialAuthor;
                                    console.log('[Kindle2Notion] Author from book container:', author);
                                    break;
                                }
                            }
                        }
                    }
                    break;
                }
            }
        }

        if (!author) {
            console.log('[Kindle2Notion] Author not found');
        }

        // Find Amazon URL
        let amazonUrl = '';
        const linkSelectors = [
            'a.kp-notebook-printable[href*="amazon"]',
            'a[href*="amazon.co.jp/dp"]',
            'a[href*="amazon.com/dp"]',
            'a[href*="/dp/"]',
            'a[href*="/product/"]'
        ];
        for (const selector of linkSelectors) {
            const link = document.querySelector(selector);
            if (link && link.href) {
                amazonUrl = link.href;
                break;
            }
        }

        // Find cover image
        let coverUrl = '';
        const coverSelectors = [
            '.kp-notebook-cover-image img',
            'img.kp-notebook-cover-image',
            '.kp-notebook-cover img',
            'img[src*="images-amazon"]',
            'img[src*="ssl-images-amazon"]',
            'img[src*="m.media-amazon"]'
        ];
        for (const selector of coverSelectors) {
            const img = document.querySelector(selector);
            if (img && img.src) {
                coverUrl = img.src;
                break;
            }
        }

        return {
            title: bookTitle,
            author,
            amazonUrl,
            coverUrl,
            highlights: []
        };
    }

    /**
     * Extract book info from a library container
     */
    function extractBookFromContainer(container) {
        try {
            // Book title
            const titleEl = container.querySelector('h2, .kp-notebook-searchable');
            const title = titleEl ? titleEl.textContent.trim() : 'Unknown Title';

            // Author
            const authorEl = container.querySelector('.kp-notebook-metadata.a-spacing-none p');
            const author = authorEl ? authorEl.textContent.replace(/^著者[:：]\s*/, '').trim() : '';

            // Amazon URL
            const linkEl = container.querySelector('a[href*="/dp/"], a[href*="/product/"], a[href*="amazon"]');
            const amazonUrl = linkEl ? linkEl.href : '';

            // Cover image
            const imgEl = container.querySelector('img');
            const coverUrl = imgEl ? getHighResCoverUrl(imgEl.src, amazonUrl) : '';

            // Highlights
            const highlights = extractHighlightsFromContainer(container);

            return {
                title,
                author,
                amazonUrl,
                coverUrl,
                highlights
            };
        } catch (error) {
            console.error('Error extracting book:', error);
            return null;
        }
    }

    /**
     * Extract current single book view (when viewing one book's highlights)
     */
    function extractCurrentBook() {
        try {
            console.log('[Kindle2Notion] Trying to extract single book view...');

            // Book title - try multiple selectors
            const titleSelectors = [
                'h3.kp-notebook-metadata',
                '.kp-notebook-metadata h3',
                'h1.a-spacing-medium',
                '.kp-notebook-searchable',
                'h2.kp-notebook-searchable',
                '.aok-hidden + h2',
                'h2[id*="title"]',
                '.annotation-title',
                'h1', 'h2', 'h3' // Fallback
            ];

            let title = '';
            for (const selector of titleSelectors) {
                const el = document.querySelector(selector);
                if (el && el.textContent.trim()) {
                    title = el.textContent.trim();
                    console.log(`[Kindle2Notion] Title found with selector "${selector}":`, title);
                    break;
                }
            }

            if (!title) {
                console.log('[Kindle2Notion] No title found with any selector');
                // Try to get any text that looks like a title
                const h2Elements = document.querySelectorAll('h2');
                for (const h2 of h2Elements) {
                    const text = h2.textContent.trim();
                    if (text && text.length > 0 && text.length < 200) {
                        title = text;
                        console.log('[Kindle2Notion] Title found from h2 fallback:', title);
                        break;
                    }
                }
            }

            if (!title) {
                console.log('[Kindle2Notion] Still no title, returning null');
                return null;
            }

            // Author - try multiple selectors
            const authorSelectors = [
                '.kp-notebook-metadata.a-spacing-none',
                'p.a-spacing-none',
                '.author',
                '[class*="author"]'
            ];

            let author = '';
            for (const selector of authorSelectors) {
                const el = document.querySelector(selector);
                if (el) {
                    const authorText = el.textContent;
                    const match = authorText.match(/著者[:：]\s*(.+)/);
                    if (match) {
                        author = match[1].trim();
                        console.log(`[Kindle2Notion] Author found:`, author);
                        break;
                    }
                }
            }

            // Amazon URL and ASIN
            const linkSelectors = [
                '.kp-notebook-printable a',
                'a.kp-notebook-printable',
                'a[href*="/dp/"]',
                'a[href*="amazon"]'
            ];

            let amazonUrl = '';
            for (const selector of linkSelectors) {
                const el = document.querySelector(selector);
                if (el && el.href) {
                    amazonUrl = el.href;
                    break;
                }
            }

            // Cover image
            const imgSelectors = [
                '.kp-notebook-cover-image img',
                '.kp-notebook-printable img',
                'img[src*="amazon"]',
                'img[src*="images-amazon"]'
            ];

            let coverUrl = '';
            for (const selector of imgSelectors) {
                const el = document.querySelector(selector);
                if (el && el.src) {
                    coverUrl = getHighResCoverUrl(el.src, amazonUrl);
                    break;
                }
            }

            // Highlights
            const highlights = extractHighlightsFromPage();
            console.log(`[Kindle2Notion] Found ${highlights.length} highlights`);

            return {
                title,
                author,
                amazonUrl,
                coverUrl,
                highlights
            };
        } catch (error) {
            console.error('[Kindle2Notion] Error extracting current book:', error);
            return null;
        }
    }

    /**
     * Extract highlights from a book container
     */
    function extractHighlightsFromContainer(container) {
        const highlights = [];
        const highlightEls = container.querySelectorAll('.kp-notebook-highlight');

        highlightEls.forEach((el, index) => {
            const text = el.textContent.trim();
            if (text) {
                // Try to find location info
                const locationEl = el.closest('.kp-notebook-annotation')?.querySelector('#annotationHighlightHeader, .kp-notebook-metadata');
                let location = '';
                if (locationEl) {
                    const locMatch = locationEl.textContent.match(/位置(?:No\.?)?\s*[:：]?\s*(\d+)/);
                    location = locMatch ? locMatch[1] : '';
                }

                highlights.push({
                    text,
                    location,
                    index
                });
            }
        });

        return highlights;
    }

    /**
     * Extract highlights from the current page view
     */
    function extractHighlightsFromPage() {
        const highlights = [];
        // Prefer searching within the annotations panel to avoid left-side list elements
        const annotationsRoot = document.querySelector(
            '#kp-notebook-annotations, .kp-notebook-annotations-container, [id*="annotations"]'
        );
        const searchRoot = annotationsRoot || document;

        // Try multiple selectors for highlights (keep these reasonably specific)
        const highlightSelectors = [
            '.kp-notebook-highlight',
            '[data-annotation-type="highlight"]',
            '[id^="annotationHighlight"]',
            '#highlight',
            '[id*="highlight"]'
        ];

        let highlightEls = [];
        for (const selector of highlightSelectors) {
            const els = Array.from(searchRoot.querySelectorAll(selector))
                .filter(el => !el.closest('.kp-notebook-library, .kp-notebook-library-each-book'));
            console.log(`[Kindle2Notion] Highlight selector "${selector}": found ${els.length} elements`);
            if (els.length > 0) {
                highlightEls = els;
                break;
            }
        }

        // If still no highlights found, try looking for any text content in annotation containers
        if (highlightEls.length === 0) {
            console.log('[Kindle2Notion] No highlights found with standard selectors, trying annotation containers...');
            const containers = searchRoot.querySelectorAll('[class*="annotation"], [id*="annotation"]');
            console.log(`[Kindle2Notion] Found ${containers.length} annotation containers`);

            containers.forEach(container => {
                if (container.closest('.kp-notebook-library, .kp-notebook-library-each-book')) return;
                // Get text content that might be a highlight
                const textNodes = container.querySelectorAll('span, div');
                textNodes.forEach(node => {
                    const text = node.textContent.trim();
                    // Filter out short texts or location markers
                    if (text && text.length > 20 && !text.match(/^(Page|Location|Highlight|Note)\\b/i)) {
                        highlights.push({
                            text,
                            location: '',
                            index: highlights.length
                        });
                    }
                });
            });

            console.log(`[Kindle2Notion] Found ${highlights.length} highlights from annotation containers`);
            return highlights;
        }
        highlightEls.forEach((el, index) => {
            const text = el.textContent.trim();
            if (text) {
                // Try to find location info from the annotation container
                const annotationContainer = el.closest('.a-row, .kp-notebook-row-separator, [class*="annotation"]');
                let location = '';

                if (annotationContainer) {
                    const headerEl = annotationContainer.querySelector('#annotationHighlightHeader, .kp-notebook-annotation-container span, [id*="Header"]');
                    if (headerEl) {
                        const locMatch = headerEl.textContent.match(/位置(?:No\.?)?\s*[:：]?\s*(\d+)/);
                        location = locMatch ? locMatch[1] : '';
                    }
                }

                // Also try to find it nearby
                if (!location) {
                    const prevSibling = el.previousElementSibling;
                    if (prevSibling) {
                        const locMatch = prevSibling.textContent.match(/位置(?:No\.?)?\s*[:：]?\s*(\d+)/);
                        location = locMatch ? locMatch[1] : '';
                    }
                }

                highlights.push({
                    text,
                    location,
                    index
                });
            }
        });

        console.log(`[Kindle2Notion] Extracted ${highlights.length} highlights total`);
        return highlights;
    }
})();
