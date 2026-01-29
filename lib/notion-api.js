// Notion API helper module
// Handles all Notion API operations

const NOTION_API_BASE = 'https://api.notion.com/v1';
const NOTION_VERSION = '2022-06-28';

/**
 * Create Notion API client with the given token
 */
export function createNotionClient(token) {
    const headers = {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
        'Notion-Version': NOTION_VERSION
    };

    /**
     * Make a request to Notion API
     */
    async function request(endpoint, options = {}) {
        const url = `${NOTION_API_BASE}${endpoint}`;
        const response = await fetch(url, {
            ...options,
            headers: {
                ...headers,
                ...options.headers
            }
        });

        const data = await response.json();

        if (!response.ok) {
            throw new Error(data.message || `Notion API error: ${response.status}`);
        }

        return data;
    }

    /**
     * Get database info (for connection test)
     */
    async function getDatabase(databaseId) {
        return request(`/databases/${databaseId}`);
    }

    /**
     * Query database to find a book by title
     */
    async function findBookByTitle(databaseId, title) {
        const database = await getDatabase(databaseId);
        const dbProperties = database.properties;

        // Find the title property name
        let titlePropertyName = 'Name';
        for (const [propName, propConfig] of Object.entries(dbProperties)) {
            if (propConfig.type === 'title') {
                titlePropertyName = propName;
                break;
            }
        }

        if (title) {
            try {
                const response = await request(`/databases/${databaseId}/query`, {
                    method: 'POST',
                    body: JSON.stringify({
                        filter: {
                            property: titlePropertyName,
                            title: {
                                equals: title
                            }
                        }
                    })
                });

                if (response.results.length > 0) {
                    return response.results[0];
                }
            } catch (e) {
                console.log('[Notion API] Title search failed');
            }
        }

        return null;
    }

    /**
     * Create a new book page in the database
     */
    async function createBookPage(databaseId, bookData) {
        // First, get database schema to find the title property name
        const database = await getDatabase(databaseId);
        const dbProperties = database.properties;

        // Find the title property (the one with type "title")
        let titlePropertyName = 'Name'; // Default fallback
        for (const [propName, propConfig] of Object.entries(dbProperties)) {
            if (propConfig.type === 'title') {
                titlePropertyName = propName;
                break;
            }
        }

        console.log('[Notion API] Using title property:', titlePropertyName);
        console.log('[Notion API] Available properties:', Object.keys(dbProperties));

        // Build properties object with only the title (required)
        const properties = {
            [titlePropertyName]: {
                title: [
                    {
                        text: {
                            content: bookData.title
                        }
                    }
                ]
            }
        };

        // Helper function to check for property with multiple possible names
        const findProperty = (names) => {
            for (const name of names) {
                if (dbProperties[name]) {
                    return { name, config: dbProperties[name] };
                }
            }
            return null;
        };

        // Add Author property (多くの名前バリエーションに対応)
        const authorProp = findProperty(['Author', '著者', '著者名', 'author', '作者', 'Writer', 'writer']);
        console.log('[Notion API] Author property found:', authorProp ? authorProp.name : 'NOT FOUND');
        console.log('[Notion API] Book author value:', bookData.author);

        if (authorProp && bookData.author) {
            properties[authorProp.name] = {
                rich_text: [
                    {
                        text: {
                            content: bookData.author
                        }
                    }
                ]
            };
            console.log('[Notion API] Author property set to:', bookData.author);
        } else if (bookData.author && !authorProp) {
            console.log('[Notion API] WARNING: Author property not found in database. Available properties:', Object.keys(dbProperties).join(', '));
        }

        // Add Highlight Count property
        const highlightCountProp = findProperty(['Highlight Count', 'ハイライト数', 'highlight_count']);
        if (highlightCountProp) {
            properties[highlightCountProp.name] = {
                number: bookData.highlights.length
            };
        }

        // Add Last Synced property (more name variations)
        const lastSyncedProp = findProperty(['Last Synced', '最終同期日時', '最終同期日', '同期日時', '同期日', 'last_synced', 'LastSynced']);
        if (lastSyncedProp) {
            properties[lastSyncedProp.name] = {
                date: {
                    start: new Date().toISOString()
                }
            };
        }

        // Add Amazon URL if available
        const amazonUrlProp = findProperty(['Amazon URL', 'Amazon', 'URL', 'amazon_url']);
        if (amazonUrlProp && bookData.amazonUrl) {
            properties[amazonUrlProp.name] = {
                url: bookData.amazonUrl
            };
        }

        // Add Cover Image as a property (表紙) - supports files type
        const coverProp = findProperty(['表紙', 'Cover', 'cover', 'カバー']);
        if (coverProp && bookData.coverUrl) {
            if (coverProp.config.type === 'files') {
                // Files property type
                properties[coverProp.name] = {
                    files: [
                        {
                            type: 'external',
                            name: bookData.title.substring(0, 50) || 'cover',
                            external: {
                                url: bookData.coverUrl
                            }
                        }
                    ]
                };
            } else if (coverProp.config.type === 'url') {
                // URL property type
                properties[coverProp.name] = {
                    url: bookData.coverUrl
                };
            }
            console.log('[Notion API] Cover property set:', coverProp.name);
        }

        const pageData = {
            parent: {
                database_id: databaseId
            },
            properties
        };

        console.log('[Notion API] Creating page with data:', JSON.stringify(pageData, null, 2));

        const result = await request('/pages', {
            method: 'POST',
            body: JSON.stringify(pageData)
        });

        console.log('[Notion API] Page created successfully:', result.id);
        return result;
    }

    /**
     * Update an existing book page
     */
    async function updateBookPage(pageId, bookData, databaseId) {
        // Get database properties to check what exists
        const database = await getDatabase(databaseId);
        const dbProperties = database.properties;

        const properties = {};

        if (dbProperties['Highlight Count'] && bookData.highlightCount !== undefined) {
            properties['Highlight Count'] = {
                number: bookData.highlightCount
            };
        }

        if (dbProperties['Last Synced']) {
            properties['Last Synced'] = {
                date: {
                    start: new Date().toISOString()
                }
            };
        }

        // Only update if there are properties to update
        if (Object.keys(properties).length === 0) {
            return { id: pageId }; // Nothing to update
        }

        return request(`/pages/${pageId}`, {
            method: 'PATCH',
            body: JSON.stringify({ properties })
        });
    }

    /**
     * Get existing highlight blocks from a page
     */
    async function getExistingHighlights(pageId) {
        const highlights = [];
        let cursor = undefined;

        do {
            const params = cursor ? `?start_cursor=${cursor}` : '';
            const response = await request(`/blocks/${pageId}/children${params}`);

            for (const block of response.results) {
                // Check both quote and callout blocks for backwards compatibility
                if (block.type === 'quote') {
                    const text = block.quote.rich_text
                        .map(t => t.plain_text)
                        .join('');
                    highlights.push(text);
                } else if (block.type === 'callout') {
                    const text = block.callout.rich_text
                        .map(t => t.plain_text)
                        .join('');
                    highlights.push(text);
                }
            }

            cursor = response.has_more ? response.next_cursor : undefined;
        } while (cursor);

        return highlights;
    }

    /**
     * Add a highlight quote block to a page
     */
    async function addHighlightBlock(pageId, highlight) {
        const locationText = highlight.location
            ? `📍 位置No. ${highlight.location}`
            : '';

        const richText = [];

        // Add highlight text first
        richText.push({
            type: 'text',
            text: {
                content: highlight.text
            }
        });

        // Add location as italic text at the end if available
        if (locationText) {
            richText.push({
                type: 'text',
                text: {
                    content: '\n' + locationText
                },
                annotations: {
                    italic: true,
                    color: 'gray'
                }
            });
        }

        const block = {
            object: 'block',
            type: 'quote',
            quote: {
                rich_text: richText,
                color: 'default'
            }
        };

        return request(`/blocks/${pageId}/children`, {
            method: 'PATCH',
            body: JSON.stringify({
                children: [block]
            })
        });
    }

    /**
     * Add multiple highlight quote blocks to a page (batch)
     */
    async function addHighlightBlocks(pageId, highlights) {
        const children = highlights.map(highlight => {
            const locationText = highlight.location
                ? `📍 位置No. ${highlight.location}`
                : '';

            const richText = [];

            // Add highlight text first
            richText.push({
                type: 'text',
                text: {
                    content: highlight.text
                }
            });

            // Add location as italic text at the end if available
            if (locationText) {
                richText.push({
                    type: 'text',
                    text: {
                        content: '\n' + locationText
                    },
                    annotations: {
                        italic: true,
                        color: 'gray'
                    }
                });
            }

            return {
                object: 'block',
                type: 'quote',
                quote: {
                    rich_text: richText,
                    color: 'default'
                }
            };
        });

        // Notion API allows max 100 blocks per request
        const batchSize = 100;
        for (let i = 0; i < children.length; i += batchSize) {
            const batch = children.slice(i, i + batchSize);
            await request(`/blocks/${pageId}/children`, {
                method: 'PATCH',
                body: JSON.stringify({
                    children: batch
                })
            });

            // Rate limiting: wait a bit between batches
            if (i + batchSize < children.length) {
                await delay(350); // ~3 requests per second
            }
        }
    }
    /**
     * Get all books from database with their highlight counts
     * Used for cross-device smart diff sync
     */
    async function getAllBooksWithHighlightCount(databaseId) {
        const books = {};
        let hasMore = true;
        let startCursor = undefined;

        while (hasMore) {
            const response = await request(`/databases/${databaseId}/query`, {
                method: 'POST',
                body: JSON.stringify({
                    start_cursor: startCursor,
                    page_size: 100
                })
            });

            for (const page of response.results) {
                // Get title
                let title = '';
                for (const [propName, propValue] of Object.entries(page.properties)) {
                    if (propValue.type === 'title' && propValue.title.length > 0) {
                        title = propValue.title[0].plain_text;
                        break;
                    }
                }

                // Get highlight count
                let highlightCount = 0;
                const countProp = page.properties['Highlight Count'] || page.properties['ハイライト数'];
                if (countProp && countProp.type === 'number') {
                    highlightCount = countProp.number || 0;
                }

                if (title) {
                    books[title] = highlightCount;
                }
            }

            hasMore = response.has_more;
            startCursor = response.next_cursor;

            // Rate limiting
            if (hasMore) {
                await delay(350);
            }
        }

        return books;
    }

    return {
        getDatabase,
        findBookByTitle,
        createBookPage,
        updateBookPage,
        getExistingHighlights,
        addHighlightBlock,
        addHighlightBlocks,
        getAllBooksWithHighlightCount
    };
}

/**
 * Delay helper for rate limiting
 */
function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}
