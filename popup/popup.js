// Popup script for Kindle to Notion Sync

document.addEventListener('DOMContentLoaded', async () => {
  const syncBtn = document.getElementById('syncBtn');
  const errorDiv = document.getElementById('error');
  const errorText = document.getElementById('errorText');
  const lastSyncEl = document.getElementById('lastSync');
  const bookCountEl = document.getElementById('bookCount');
  const openOptionsLink = document.getElementById('openOptions');

  // Load saved stats
  await loadStats();

  // Check if settings are configured
  const settings = await chrome.storage.sync.get(['notionToken', 'databaseId']);
  if (!settings.notionToken || !settings.databaseId) {
    showError('設定が完了していません。「設定」をクリックしてNotion TokenとDatabase IDを入力してください。');
    syncBtn.disabled = true;
  }

  // Main sync button - opens sync window
  syncBtn.addEventListener('click', async () => {
    hideError();

    const settings = await chrome.storage.sync.get(['notionToken', 'databaseId']);
    if (!settings.notionToken || !settings.databaseId) {
      showError('設定が完了していません。「設定」をクリックして必要な情報を入力してください。');
      return;
    }

    // Open sync window as popup
    chrome.windows.create({
      url: chrome.runtime.getURL('sync-window.html'),
      type: 'popup',
      width: 450,
      height: 650,
      focused: true
    });

    // Close the popup
    window.close();
  });

  // Open options page
  openOptionsLink.addEventListener('click', (e) => {
    e.preventDefault();
    chrome.runtime.openOptionsPage();
  });

  // Helper functions
  async function loadStats() {
    const stats = await chrome.storage.local.get(['lastSync', 'totalBooks']);

    if (stats.lastSync) {
      const date = new Date(stats.lastSync);
      lastSyncEl.textContent = formatDate(date);
    }

    if (stats.totalBooks !== undefined) {
      bookCountEl.textContent = `${stats.totalBooks}冊`;
    }
  }

  function formatDate(date) {
    const now = new Date();
    const diff = now - date;
    const minutes = Math.floor(diff / 60000);
    const hours = Math.floor(diff / 3600000);
    const days = Math.floor(diff / 86400000);

    if (minutes < 1) return 'たった今';
    if (minutes < 60) return `${minutes}分前`;
    if (hours < 24) return `${hours}時間前`;
    if (days < 7) return `${days}日前`;
    return `${date.getMonth() + 1}/${date.getDate()}`;
  }

  function showError(message) {
    errorDiv.classList.remove('hidden');
    errorText.textContent = message;
  }

  function hideError() {
    errorDiv.classList.add('hidden');
    errorText.textContent = '';
  }
});
