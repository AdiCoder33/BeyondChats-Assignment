import 'dotenv/config';
import axios from 'axios';
import { load } from 'cheerio';
import { JSDOM } from 'jsdom';
import { Readability } from '@mozilla/readability';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

const API_BASE_URL = process.env.API_BASE_URL || 'http://localhost:8000/api';
const SEARCH_PROVIDER = (process.env.SEARCH_PROVIDER || 'serper').toLowerCase();
const SERPER_API_KEY = process.env.SERPER_API_KEY;
const SERPAPI_API_KEY = process.env.SERPAPI_API_KEY;
const HF_API_KEY = process.env.HF_API_KEY;
const HF_MODEL = process.env.HF_MODEL || 'HuggingFaceH4/zephyr-7b-beta';
const HF_BASE_URL =
  process.env.HF_BASE_URL || 'https://router.huggingface.co/v1/chat/completions';
const MAX_ORIGINALS = Number.parseInt(process.env.MAX_ORIGINALS || '5', 10);
const MAX_REFERENCE_CANDIDATES = Number.parseInt(
  process.env.MAX_REFERENCE_CANDIDATES || '6',
  10
);
const REQUEST_TIMEOUT_MS = Number.parseInt(process.env.REQUEST_TIMEOUT_MS || '20000', 10);
const SKIP_IF_UPDATED = (process.env.SKIP_IF_UPDATED || 'true') === 'true';
const AUTOMATION_STATUS_FILE = process.env.AUTOMATION_STATUS_FILE;

const http = axios.create({
  timeout: REQUEST_TIMEOUT_MS,
  headers: {
    'User-Agent':
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122 Safari/537.36',
  },
});

const automationState = {
  startedAt: null,
  updatedCount: 0,
  skippedCount: 0,
  totalCount: 0,
  currentIndex: 0,
  currentTitle: '',
  lastUpdatedAt: null,
};

async function writeAutomationStatus(status, extra = {}) {
  if (!AUTOMATION_STATUS_FILE) {
    return;
  }

  try {
    const now = new Date().toISOString();
    automationState.lastUpdatedAt = now;
    await mkdir(path.dirname(AUTOMATION_STATUS_FILE), { recursive: true });
    const payload = {
      status,
      started_at: automationState.startedAt,
      updated_count: automationState.updatedCount,
      skipped_count: automationState.skippedCount,
      total_count: automationState.totalCount,
      current_index: automationState.currentIndex,
      current_title: automationState.currentTitle,
      last_updated_at: automationState.lastUpdatedAt,
      ...extra,
    };
    await writeFile(AUTOMATION_STATUS_FILE, JSON.stringify(payload, null, 2), 'utf8');
  } catch (error) {
    console.error('Failed to write automation status:', error?.message || error);
  }
}

async function main() {
  automationState.startedAt = new Date().toISOString();
  await writeAutomationStatus('running', { message: 'Automation running.' });

  const originals = await fetchOriginalArticles();
  automationState.totalCount = Math.min(originals.length, MAX_ORIGINALS);
  await writeAutomationStatus('running', {
    message: `Fetched ${originals.length} originals.`,
  });

  for (const [index, original] of originals.slice(0, MAX_ORIGINALS).entries()) {
    automationState.currentIndex = index + 1;
    automationState.currentTitle = original.title || '';
    await writeAutomationStatus('running', {
      message: `Processing ${automationState.currentIndex}/${automationState.totalCount}: ${original.title}`,
    });

    if (SKIP_IF_UPDATED && (original.updated_articles || []).length > 0) {
      console.log(`Skipping "${original.title}" (already updated).`);
      automationState.skippedCount += 1;
      await writeAutomationStatus('running', {
        message: `Skipped ${automationState.currentIndex}/${automationState.totalCount}: ${original.title}`,
      });
      continue;
    }

    const searchQuery = buildSearchQuery(original.title);
    console.log(`Searching references for "${searchQuery}"...`);
    const references = await findReferenceLinks(searchQuery, MAX_REFERENCE_CANDIDATES);

    if (references.length < 2) {
      console.log(`Not enough references found for "${original.title}".`);
      await writeAutomationStatus('running', {
        message: `Not enough references for "${original.title}".`,
      });
      continue;
    }

    const referenceArticles = [];
    const usedReferences = [];

    for (const reference of references) {
      if (referenceArticles.length >= 2) {
        break;
      }

      const article = await scrapeReadableContent(reference.url);
      if (!article) {
        continue;
      }

      referenceArticles.push(article);
      usedReferences.push(reference);
    }

    if (referenceArticles.length < 2) {
      console.log(`Not enough reference content for "${original.title}".`);
      await writeAutomationStatus('running', {
        message: `Not enough reference content for "${original.title}".`,
      });
      continue;
    }

    const updatedHtml = await generateUpdatedArticle({
      original,
      referenceArticles,
    });

    const finalHtml = appendReferences(ensureArticleWrapper(updatedHtml), usedReferences);
    await publishUpdatedArticle(original, finalHtml, usedReferences);
    automationState.updatedCount += 1;
    await writeAutomationStatus('running', {
      message: `Published ${automationState.currentIndex}/${automationState.totalCount}: ${original.title}`,
    });

    await delay(1000);
  }

  await writeAutomationStatus('success', {
    finished_at: new Date().toISOString(),
    message: 'Automation completed.',
  });
}

async function fetchOriginalArticles() {
  const response = await http.get(`${API_BASE_URL}/articles`, {
    params: { type: 'original', withUpdated: true },
  });

  return response.data || [];
}

async function findReferenceLinks(query, limit = 2) {
  let results = [];
  try {
    results =
      SEARCH_PROVIDER === 'serpapi'
        ? await searchWithSerpApi(query)
        : SEARCH_PROVIDER === 'html'
          ? await searchWithHtml(query)
          : await searchWithSerper(query);
  } catch (error) {
    console.log(`Search failed for "${query}": ${error?.message || error}`);
    return [];
  }

  const filtered = [];

  for (const result of results) {
    if (!result.url || !isLikelyArticleUrl(result.url)) {
      continue;
    }

    if (!filtered.find((entry) => entry.url === result.url)) {
      filtered.push(result);
    }

    if (filtered.length >= limit) {
      break;
    }
  }

  return filtered;
}

async function searchWithSerper(query) {
  if (!SERPER_API_KEY) {
    console.log('SERPER_API_KEY not set, falling back to HTML search.');
    return searchWithHtml(query);
  }

  const response = await http.post(
    'https://google.serper.dev/search',
    { q: query },
    { headers: { 'X-API-KEY': SERPER_API_KEY } }
  );

  const organic = response.data?.organic || [];
  return organic.map((item) => ({ title: item.title, url: item.link }));
}

async function searchWithSerpApi(query) {
  if (!SERPAPI_API_KEY) {
    console.log('SERPAPI_API_KEY not set, falling back to HTML search.');
    return searchWithHtml(query);
  }

  const response = await http.get('https://serpapi.com/search.json', {
    params: {
      engine: 'google',
      q: query,
      api_key: SERPAPI_API_KEY,
    },
  });

  const organic = response.data?.organic_results || [];
  return organic.map((item) => ({ title: item.title, url: item.link }));
}

async function searchWithHtml(query) {
  const url = `https://r.jina.ai/http://www.google.com/search?q=${encodeURIComponent(query)}`;
  let html = '';

  try {
    html = await fetchSearchHtml(url, REQUEST_TIMEOUT_MS);
  } catch (error) {
    if (error?.code === 'ECONNABORTED') {
      console.log('HTML search timed out, retrying with a longer timeout...');
      html = await fetchSearchHtml(url, REQUEST_TIMEOUT_MS * 2);
    } else {
      throw error;
    }
  }

  const markdownUrls = extractMarkdownLinks(html);
  const rawUrls = extractRawUrls(html);
  const combined = [...markdownUrls, ...rawUrls];

  const deduped = [];
  for (const urlItem of combined) {
    const normalized = normalizeSearchUrl(urlItem);
    if (!normalized) {
      continue;
    }

    if (!deduped.includes(normalized)) {
      deduped.push(normalized);
    }
  }

  return deduped.map((urlItem) => ({ title: urlItem, url: urlItem }));
}

async function fetchSearchHtml(url, timeoutMs) {
  const response = await http.get(url, { timeout: timeoutMs });
  return response.data || '';
}

function isLikelyArticleUrl(url) {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.replace(/^www\./, '');
    const blockedHosts = [
      'google.com',
      'googleusercontent.com',
      'gstatic.com',
      'youtube.com',
      'youtu.be',
      'amazon.com',
      'amazon.in',
      'amazon.co.uk',
      'linkedin.com',
      'facebook.com',
      'instagram.com',
      'x.com',
      'twitter.com',
      'tiktok.com',
      'pinterest.com',
      'quora.com',
    ];

    if (host === 'localhost' || host === '127.0.0.1' || host === '0.0.0.0') {
      return false;
    }

    if (host.endsWith('google.com') || host.endsWith('googleusercontent.com')) {
      return false;
    }

    if (host === 'r.jina.ai') {
      return false;
    }

    if (host.includes('beyondchats.com')) {
      return false;
    }

    if (!parsed.pathname || parsed.pathname === '/') {
      return false;
    }

    if (blockedHosts.some((blocked) => host === blocked || host.endsWith(`.${blocked}`))) {
      return false;
    }

    if (/\.(png|jpe?g|gif|svg|webp|mp4|mov|pdf)$/i.test(parsed.pathname)) {
      return false;
    }

    return !/\/(tag|category|author|page|search|feed)\b/.test(parsed.pathname);
  } catch {
    return false;
  }
}

async function scrapeReadableContent(url) {
  try {
    const response = await http.get(url);
    const dom = new JSDOM(response.data, { url });
    const reader = new Readability(dom.window.document);
    const article = reader.parse();

    if (article?.content) {
      return {
        title: article.title || url,
        content: article.content,
        text: article.textContent || '',
        url,
      };
    }
  } catch (error) {
    console.log(`Readability failed for ${url}: ${error.message}`);
  }

  try {
    const fallbackHtml = await http.get(url);
    const $ = load(fallbackHtml.data || '');
    const text = $('body').text();

    return {
      title: $('title').text() || url,
      content: '',
      text,
      url,
    };
  } catch (error) {
    console.log(`Fallback scrape failed for ${url}: ${error.message}`);
  }

  const jinaText = await fetchJinaText(url);
  if (jinaText) {
    return {
      title: url,
      content: '',
      text: jinaText,
      url,
    };
  }

  return null;
}

async function generateUpdatedArticle({ original, referenceArticles }) {
  const originalText = limitText(stripHtml(original.content_html || ''), 3500);
  const referenceText = referenceArticles
    .map((ref, index) => {
      const snippet = limitText(ref.text || stripHtml(ref.content || ''), 2500);
      return `Reference ${index + 1} (${ref.title || ref.url}):\n${snippet}`;
    })
    .join('\n\n');

  const prompt = `
You are an expert editor. Rewrite the original article so its structure, tone, and formatting
match the reference articles. Keep the topic and key ideas, but improve clarity and flow.
Return valid HTML only (no Markdown, no code fences).

Original article title: ${original.title}
Original content:
${originalText}

${referenceText}
`.trim();

  if (!HF_API_KEY) {
    throw new Error('Set HF_API_KEY to generate updated articles.');
  }

  const hfResponse = await postWithRetry(
    HF_BASE_URL,
    {
      model: HF_MODEL,
      messages: [
        { role: 'system', content: 'You are a senior editor who writes clean, structured HTML.' },
        { role: 'user', content: prompt },
      ],
      max_tokens: 1200,
      temperature: 0.7,
    },
    {
      headers: {
        Authorization: `Bearer ${HF_API_KEY}`,
      },
    }
  );

  const data = hfResponse.data;
  const chatContent = data?.choices?.[0]?.message?.content?.trim();
  if (chatContent) {
    return chatContent;
  }

  if (Array.isArray(data)) {
    return data[0]?.generated_text?.trim() || '';
  }

  return data?.generated_text?.trim() || '';
}

async function publishUpdatedArticle(original, contentHtml, references) {
  const contentText = stripHtml(contentHtml);
  const payload = {
    title: `${original.title} (Updated)`,
    original_article_id: original.id,
    version: 'updated',
    source: 'llm',
    content_html: contentHtml,
    content_text: contentText,
    excerpt: contentText.slice(0, 200),
    references,
    published_at: new Date().toISOString(),
  };

  const response = await http.post(`${API_BASE_URL}/articles`, payload);
  console.log(`Published updated article: ${response.data?.id || 'unknown id'}`);
}

function appendReferences(contentHtml, references) {
  const items = references
    .map((ref) => `<li><a href="${ref.url}" rel="noopener noreferrer">${ref.title}</a></li>`)
    .join('');

  return `${contentHtml}
<hr />
<section class="references">
  <h2>References</h2>
  <ul>${items}</ul>
</section>`;
}

function ensureArticleWrapper(html) {
  const trimmed = (html || '').trim();
  if (trimmed.startsWith('<article')) {
    return trimmed;
  }

  return `<article>${trimmed}</article>`;
}

function stripHtml(html) {
  if (!html) {
    return '';
  }
  const $ = load(html);
  return $('body').text().replace(/\s+/g, ' ').trim();
}

function limitText(text, maxLength) {
  if (text.length <= maxLength) {
    return text;
  }
  return `${text.slice(0, maxLength)}...`;
}

function buildSearchQuery(title) {
  return title
    .replace(/\s*-\s*Beyondchats/i, '')
    .replace(/\bBeyondchats\b/i, '')
    .trim();
}

function extractMarkdownLinks(content) {
  const links = [];
  const regex = /\[[^\]]+]\((https?:\/\/[^)\s]+)\)/g;
  let match = null;

  while ((match = regex.exec(content)) !== null) {
    const rawUrl = match[1];
    const normalized = normalizeSearchUrl(rawUrl);
    if (normalized && !links.includes(normalized)) {
      links.push(normalized);
    }
  }

  return links;
}

function extractRawUrls(content) {
  return Array.from(new Set(content.match(/https?:\/\/[^\s"'<>]+/g) || []));
}

function normalizeSearchUrl(urlItem) {
  try {
    const parsed = new URL(urlItem);
    if (parsed.hostname.endsWith('google.com') && parsed.pathname === '/url') {
      const target = parsed.searchParams.get('q') || parsed.searchParams.get('url');
      return target ? normalizeSearchUrl(target) : urlItem;
    }

    parsed.hash = '';
    return parsed.toString().replace(/[)\].,]+$/, '');
  } catch {
    return urlItem.replace(/[)\].,]+$/, '');
  }
}

async function fetchJinaText(url) {
  const jinaUrl = buildJinaUrl(url);

  try {
    const response = await http.get(jinaUrl);
    const content = stripJinaHeader(response.data || '');
    return content.trim() ? content : null;
  } catch (error) {
    console.log(`Jina fallback failed for ${url}: ${error.message}`);
    return null;
  }
}

function buildJinaUrl(url) {
  try {
    const parsed = new URL(url);
    const protocol = parsed.protocol.replace(':', '');
    return `https://r.jina.ai/${protocol}://${parsed.host}${parsed.pathname}${parsed.search}`;
  } catch {
    return `https://r.jina.ai/http://${url}`;
  }
}

function stripJinaHeader(markdown) {
  return markdown
    .replace(/^Title:[^\n]*\n+URL Source:[^\n]*\n+Markdown Content:\n+/i, '')
    .trim();
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function postWithRetry(url, payload, options, retries = 3) {
  let attempt = 0;
  let lastError;

  while (attempt < retries) {
    try {
      return await http.post(url, payload, options);
    } catch (error) {
      lastError = error;
      const status = error.response?.status;
      const estimated = error.response?.data?.estimated_time;

      if (status === 503 && estimated) {
        await delay((estimated + 1) * 1000);
        attempt += 1;
        continue;
      }

      throw error;
    }
  }

  throw lastError;
}

const handleFailure = async (error) => {
  await writeAutomationStatus('error', {
    finished_at: new Date().toISOString(),
    message: error?.message || 'Automation failed.',
  });
};

process.on('unhandledRejection', (error) => {
  handleFailure(error).finally(() => {
    console.error(error);
    process.exit(1);
  });
});

process.on('uncaughtException', (error) => {
  handleFailure(error).finally(() => {
    console.error(error);
    process.exit(1);
  });
});

main().catch((error) => {
  handleFailure(error).finally(() => {
    console.error(error);
    process.exit(1);
  });
});
