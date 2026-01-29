// Options page script for Kindle to Notion Sync

document.addEventListener('DOMContentLoaded', async () => {
    const notionTokenInput = document.getElementById('notionToken');
    const databaseIdInput = document.getElementById('databaseId');
    const autoSyncCheckbox = document.getElementById('autoSync');
    const syncIntervalSelect = document.getElementById('syncInterval');
    const intervalGroup = document.getElementById('intervalGroup');
    const testModeCheckbox = document.getElementById('testMode');
    const testConnectionBtn = document.getElementById('testConnection');
    const testResultDiv = document.getElementById('testResult');
    const saveBtn = document.getElementById('saveBtn');
    const saveResultDiv = document.getElementById('saveResult');

    // Load existing settings
    await loadSettings();

    // Toggle interval visibility based on auto sync checkbox
    autoSyncCheckbox.addEventListener('change', () => {
        intervalGroup.style.display = autoSyncCheckbox.checked ? 'block' : 'none';
    });

    // Test connection button
    testConnectionBtn.addEventListener('click', async () => {
        const token = notionTokenInput.value.trim();
        const databaseId = databaseIdInput.value.trim();

        if (!token || !databaseId) {
            showTestResult('TokenとDatabase IDを入力してください', false);
            return;
        }

        testConnectionBtn.disabled = true;
        testConnectionBtn.textContent = 'テスト中...';

        try {
            // Test the connection via background script
            const result = await chrome.runtime.sendMessage({
                action: 'testConnection',
                token,
                databaseId
            });

            if (result.success) {
                showTestResult(`接続成功！データベース: ${result.databaseTitle}`, true);
            } else {
                showTestResult(`接続失敗: ${result.error}`, false);
            }
        } catch (error) {
            showTestResult(`エラー: ${error.message}`, false);
        } finally {
            testConnectionBtn.disabled = false;
            testConnectionBtn.textContent = '🔗 接続テスト';
        }
    });

    // Save button
    saveBtn.addEventListener('click', async () => {
        const settings = {
            notionToken: notionTokenInput.value.trim(),
            databaseId: databaseIdInput.value.trim(),
            autoSync: autoSyncCheckbox.checked,
            syncInterval: parseInt(syncIntervalSelect.value, 10),
            testMode: testModeCheckbox.checked
        };

        if (!settings.notionToken || !settings.databaseId) {
            showSaveResult('TokenとDatabase IDは必須です', false);
            return;
        }

        try {
            await chrome.storage.sync.set(settings);

            // Update alarms if auto sync is enabled/disabled
            if (settings.autoSync) {
                await chrome.runtime.sendMessage({
                    action: 'setupAutoSync',
                    interval: settings.syncInterval
                });
            } else {
                await chrome.runtime.sendMessage({
                    action: 'clearAutoSync'
                });
            }

            showSaveResult('設定を保存しました', true);
        } catch (error) {
            showSaveResult(`保存エラー: ${error.message}`, false);
        }
    });

    // Helper functions
    async function loadSettings() {
        const settings = await chrome.storage.sync.get([
            'notionToken',
            'databaseId',
            'autoSync',
            'syncInterval',
            'testMode'
        ]);

        if (settings.notionToken) {
            notionTokenInput.value = settings.notionToken;
        }
        if (settings.databaseId) {
            databaseIdInput.value = settings.databaseId;
        }
        if (settings.autoSync !== undefined) {
            autoSyncCheckbox.checked = settings.autoSync;
        }
        if (settings.syncInterval) {
            syncIntervalSelect.value = settings.syncInterval.toString();
        }
        if (settings.testMode !== undefined) {
            testModeCheckbox.checked = settings.testMode;
        }

        // Set initial visibility of interval group
        intervalGroup.style.display = autoSyncCheckbox.checked ? 'block' : 'none';
    }

    function showTestResult(message, success) {
        testResultDiv.textContent = message;
        testResultDiv.className = `test-result ${success ? 'success' : 'error'}`;
        testResultDiv.classList.remove('hidden');
    }

    function showSaveResult(message, success) {
        saveResultDiv.textContent = message;
        saveResultDiv.className = `save-result ${success ? 'success' : 'error'}`;
        saveResultDiv.classList.remove('hidden');

        if (success) {
            setTimeout(() => {
                saveResultDiv.classList.add('hidden');
            }, 3000);
        }
    }
});
