// Sync window script - handles the dedicated sync popup window
// This creates and manages the Kindle tab, injects content script, and handles sync

const progressBar = document.getElementById('progressBar');
const progressSection = document.getElementById('progressSection');
const booksProcessed = document.getElementById('booksProcessed');
const booksTotal = document.getElementById('booksTotal');
const highlightsAdded = document.getElementById('highlightsAdded');
const logList = document.getElementById('logList');
const completeSection = document.getElementById('completeSection');
const completeSummary = document.getElementById('completeSummary');
const syncBtn = document.getElementById('syncBtn');
const warningText = document.getElementById('warningText');
const openSettings = document.getElementById('openSettings');

let totalHighlights = 0;
let kindleTabId = null;
let isSyncing = false;

// Auto-start sync when window opens
startSync();

// Also allow manual restart via button
syncBtn.addEventListener('click', () => {
    if (isSyncing) return;
    startSync();
});

// Open settings
openSettings.addEventListener('click', (e) => {
    e.preventDefault();
    chrome.runtime.openOptionsPage();
});

async function startSync() {
    // Check settings first
    const settings = await chrome.storage.sync.get(['notionToken', 'databaseId']);
    if (!settings.notionToken || !settings.databaseId) {
        addLog('error', '設定が完了していません。下の「設定」からNotion TokenとDatabase IDを入力してください。');
        return;
    }

    isSyncing = true;
    syncBtn.disabled = true;
    syncBtn.textContent = '同期中...';
    warningText.classList.add('show');
    progressSection.classList.add('show');
    completeSection.classList.remove('show');

    // Reset stats
    totalHighlights = 0;
    progressBar.style.width = '0%';
    progressBar.textContent = '0%';
    booksProcessed.textContent = 0;
    booksTotal.textContent = 0;
    highlightsAdded.textContent = 0;

    // Clear old logs
    logList.innerHTML = '';

    addLog('info', 'Kindleページを開いています...');

    try {
        // Create a new tab with Kindle notebook
        const tab = await chrome.tabs.create({
            url: 'https://read.amazon.co.jp/notebook',
            active: true
        });
        kindleTabId = tab.id;
        addLog('success', 'Kindleタブを作成しました');

        // Wait for the tab to finish loading
        addLog('info', 'ページの読み込みを待機中...');
        await waitForTabLoad(kindleTabId);
        addLog('success', 'ページ読み込み完了');

        // Wait longer for the page content to render (Kindle is a slow SPA)
        addLog('info', 'ページのレンダリングを待機中... (10秒)');
        await new Promise(r => setTimeout(r, 10000));

        // Inject content script programmatically
        addLog('info', 'Content Scriptを注入中...');
        try {
            await chrome.scripting.executeScript({
                target: { tabId: kindleTabId },
                files: ['content.js']
            });
            addLog('success', 'Content Script注入完了');
        } catch (e) {
            addLog('error', `Script注入エラー: ${e.message}`);
            await finishSync();
            return;
        }

        // Wait for content script to initialize
        await new Promise(r => setTimeout(r, 2000));

        // Get book count
        addLog('info', '書籍数を取得中...');
        let countResponse;
        try {
            countResponse = await chrome.tabs.sendMessage(kindleTabId, {
                action: 'getBookCount'
            });
            addLog('info', `getBookCount結果: ${JSON.stringify(countResponse)}`);
        } catch (e) {
            addLog('error', `通信エラー: ${e.message}`);
            await finishSync();
            return;
        }

        if (!countResponse || countResponse.count === undefined) {
            addLog('error', '書籍数を取得できませんでした');
            addLog('info', 'Kindleページで書籍一覧が表示されているか確認してください');
            await finishSync();
            return;
        }

        booksTotal.textContent = countResponse.count;
        addLog('info', `${countResponse.count}冊の書籍を検出`);

        if (countResponse.count === 0) {
            addLog('warning', '書籍が見つかりません');
            addLog('info', 'Kindleタブでログインしているか確認してください');
            await finishSync();
            return;
        }

        // Get existing highlight counts from Notion (for cross-device smart diff)
        addLog('info', 'Notionから既存書籍のハイライト数を取得中...');
        let notionCounts = {};
        try {
            const notionResponse = await chrome.runtime.sendMessage({
                action: 'getNotionHighlightCounts'
            });
            if (notionResponse && notionResponse.counts) {
                notionCounts = notionResponse.counts;
                addLog('success', `Notionに${Object.keys(notionCounts).length}冊の書籍を確認`);
            }
        } catch (e) {
            addLog('warning', `Notionからの取得に失敗: ${e.message}`);
            addLog('info', '全書籍を処理します（ローカルキャッシュを使用）');
        }

        // Start extraction with Notion counts for smart diff
        addLog('info', '全書籍の抽出を開始します...');

        let response;
        try {
            response = await chrome.tabs.sendMessage(kindleTabId, {
                action: 'extractAllBooksAuto',
                notionCounts: notionCounts
            });
            addLog('info', `抽出結果: ${response ? response.books?.length + '冊' : 'null'}`);
        } catch (e) {
            addLog('error', `抽出エラー: ${e.message}`);
            await finishSync();
            return;
        }

        if (response && response.error) {
            addLog('error', response.error);
            await finishSync();
            return;
        }

        if (!response || !response.books || response.books.length === 0) {
            addLog('warning', '抽出された書籍がありません');
            addLog('info', 'キャッシュ済み、または変更なしの可能性があります');
            completeSection.classList.add('show');
            completeSummary.textContent = '同期する書籍がありませんでした';
            await finishSync();
            return;
        }

        addLog('success', `${response.books.length}冊の書籍を抽出完了`);

        // Count total highlights and log book data
        let extractedHighlights = 0;
        response.books.forEach((book, index) => {
            extractedHighlights += book.highlights.length;
            console.log(`[Sync Window] Book ${index + 1}:`, {
                title: book.title,
                author: book.author,
                amazonUrl: book.amazonUrl,
                coverUrl: book.coverUrl,
                highlightCount: book.highlights.length
            });
        });
        addLog('info', `合計 ${extractedHighlights} 件のハイライトを抽出`);

        // Now sync to Notion - reset progress bar for Notion phase
        addLog('info', 'Notionへの同期を開始...');
        console.log(`[Sync Window] Sending ${response.books.length} books to Notion...`);
        progressBar.style.width = '0%';
        progressBar.textContent = '0%';
        booksProcessed.textContent = 0;
        booksTotal.textContent = response.books.length;

        const syncResult = await chrome.runtime.sendMessage({
            action: 'syncToNotion',
            books: response.books
        });

        console.log(`[Sync Window] Notion sync result:`, syncResult);

        if (syncResult.error) {
            throw new Error(syncResult.error);
        }

        // Update final stats
        totalHighlights = syncResult.newHighlights;
        highlightsAdded.textContent = totalHighlights;
        booksProcessed.textContent = response.books.length;

        addLog('success', `同期完了: ${syncResult.newBooks}冊追加, ${syncResult.newHighlights}件のハイライト`);

        // Save stats
        const currentStats = await chrome.storage.local.get('totalBooks');
        await chrome.storage.local.set({
            lastSync: Date.now(),
            totalBooks: (currentStats.totalBooks || 0) + syncResult.newBooks
        });

        showComplete(response.books.length, syncResult.newBooks, syncResult.newHighlights);

    } catch (error) {
        addLog('error', `エラー: ${error.message}`);
        console.error('Sync error:', error);
    } finally {
        await finishSync();
    }
}

async function finishSync() {
    isSyncing = false;
    syncBtn.disabled = false;
    syncBtn.textContent = '再同期';
    warningText.classList.remove('show');

    // Close Kindle tab based on settings
    const settings = await chrome.storage.sync.get(['autoCloseWindow']);
    const autoClose = settings.autoCloseWindow !== undefined ? settings.autoCloseWindow : true; // Default: true

    if (kindleTabId) {
        if (autoClose) {
            console.log('[Sync Window] Auto-closing Kindle tab...');
            chrome.tabs.remove(kindleTabId).catch(() => { });
        } else {
            console.log('[Sync Window] Keeping Kindle tab open (autoCloseWindow is disabled)');
        }
        kindleTabId = null;
    }
}

// Wait for tab to finish loading
function waitForTabLoad(tabId) {
    return new Promise((resolve) => {
        const checkTab = async () => {
            try {
                const tab = await chrome.tabs.get(tabId);
                if (tab.status === 'complete') {
                    resolve();
                } else {
                    setTimeout(checkTab, 500);
                }
            } catch (e) {
                resolve(); // Tab might be closed
            }
        };
        checkTab();
    });
}

// Listen for progress updates from content script
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.action === 'syncProgress') {
        updateProgress(message.current, message.total, message.bookTitle, message.highlightsCount);
    } else if (message.action === 'syncLog') {
        addLog(message.type || 'info', message.message);
    }
});

function updateProgress(current, total, bookTitle, highlightsCount) {
    if (total === 0) return;
    const percent = Math.round((current / total) * 100);
    progressBar.style.width = `${percent}%`;
    progressBar.textContent = `${percent}%`;
    booksProcessed.textContent = current;
    booksTotal.textContent = total;

    if (highlightsCount !== undefined && highlightsCount !== null) {
        totalHighlights = highlightsCount;
        highlightsAdded.textContent = totalHighlights;
    }

    if (bookTitle) {
        addLog('info', `処理中: ${bookTitle.substring(0, 40)}...`);
    }
}

function addLog(type, message) {
    const li = document.createElement('li');
    li.className = type;
    li.textContent = `${new Date().toLocaleTimeString()} - ${message}`;
    logList.insertBefore(li, logList.firstChild);

    // Keep only last 50 logs
    while (logList.children.length > 50) {
        logList.removeChild(logList.lastChild);
    }
}

async function showComplete(processed, newBooks, newHighlights) {
    progressBar.style.width = '100%';
    progressBar.textContent = '100%';
    completeSection.classList.add('show');
    completeSummary.textContent = `${processed}冊処理、${newBooks}冊追加、${newHighlights}件のハイライトを同期しました`;

    // Check if auto close is enabled
    const settings = await chrome.storage.sync.get(['autoCloseWindow']);
    const autoClose = settings.autoCloseWindow !== undefined ? settings.autoCloseWindow : true; // Default: true

    if (autoClose) {
        // Auto close after 5 seconds
        let countdown = 5;
        const countdownEl = document.createElement('p');
        countdownEl.style.marginTop = '10px';
        countdownEl.style.fontSize = '13px';
        countdownEl.style.color = '#9ca3af';
        completeSection.appendChild(countdownEl);

        const updateCountdown = () => {
            countdownEl.textContent = `このウィンドウは ${countdown} 秒後に自動で閉じます`;
            countdown--;
            if (countdown < 0) {
                window.close();
            } else {
                setTimeout(updateCountdown, 1000);
            }
        };
        updateCountdown();
    } else {
        // Show manual close message
        const messageEl = document.createElement('p');
        messageEl.style.marginTop = '10px';
        messageEl.style.fontSize = '13px';
        messageEl.style.color = '#9ca3af';
        messageEl.textContent = 'コンソールログを確認後、このウィンドウを手動で閉じてください';
        completeSection.appendChild(messageEl);
    }
}
