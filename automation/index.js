import 'dotenv/config';
import axios from 'axios';
import cheerio from 'cheerio';
import { JSDOM } from 'jsdom';
import { Readability } from '@mozilla/readability';
import OpenAI from 'openai';

const API_BASE_URL = process.env.API_BASE_URL || 'http://localhost:8000/api';
const SEARCH_PROVIDER = (process.env.SEARCH_PROVIDER || 'serper').toLowerCase();
const SERPER_API_KEY = process.env.SERPER_API_KEY;
const SERPAPI_API_KEY = process.env.SERPAPI_API_KEY;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_MODEL = process.env.OPENAI_MODEL || 'gpt-4o-mini';
const HF_API_KEY = process.env.HF_API_KEY;
const HF_MODEL = process.env.HF_MODEL || 'HuggingFaceH4/zephyr-7b-beta';
const HF_BASE_URL = process.env.HF_BASE_URL || 'https://api-inference.huggingface.co/models';
const MAX_ORIGINALS = Number.parseInt(process.env.MAX_ORIGINALS || '5', 10);
const REQUEST_TIMEOUT_MS = Number.parseInt(process.env.REQUEST_TIMEOUT_MS || '20000', 10);
const SKIP_IF_UPDATED = (process.env.SKIP_IF_UPDATED || 'true') === 'true';

const http = axios.create({
  timeout: REQUEST_TIMEOUT_MS,
  headers: {
    'User-Agent':
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122 Safari/537.36',
  },
});

const openai = OPENAI_API_KEY ? new OpenAI({ apiKey: OPENAI_API_KEY }) : null;

async function main() {
  const originals = await fetchOriginalArticles();

  for (const original of originals.slice(0, MAX_ORIGINALS)) {
    if (SKIP_IF_UPDATED && (original.updated_articles || []).length > 0) {
      console.log(`Skipping "${original.title}" (already updated).`);
      continue;
    }

    console.log(`Searching references for "${original.title}"...`);
    const references = await findReferenceLinks(original.title);

    if (references.length < 2) {
      console.log(`Not enough references found for "${original.title}".`);
      continue;
    }

    const referenceArticles = await Promise.all(
      references.map((ref) => scrapeReadableContent(ref.url))
    );

    const updatedHtml = await generateUpdatedArticle({
      original,
      referenceArticles,
    });

    const finalHtml = appendReferences(ensureArticleWrapper(updatedHtml), references);
    await publishUpdatedArticle(original, finalHtml, references);

    await delay(1000);
  }
}

async function fetchOriginalArticles() {
  const response = await http.get(`${API_BASE_URL}/articles`, {
    params: { type: 'original', withUpdated: true },
  });

  return response.data || [];
}

async function findReferenceLinks(query) {
  const results =
    SEARCH_PROVIDER === 'serpapi'
      ? await searchWithSerpApi(query)
      : SEARCH_PROVIDER === 'html'
        ? await searchWithHtml(query)
        : await searchWithSerper(query);

  const filtered = [];

  for (const result of results) {
    if (!result.url || !isLikelyArticleUrl(result.url)) {
      continue;
    }

    if (!filtered.find((entry) => entry.url === result.url)) {
      filtered.push(result);
    }

    if (filtered.length >= 2) {
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
  const response = await http.get(url);
  const html = response.data || '';

  const urls = Array.from(new Set(html.match(/https?:\/\/[^\s"'<>]+/g) || []))
    .map((urlItem) => {
      try {
        const parsed = new URL(urlItem);
        if (parsed.hostname.endsWith('google.com') && parsed.pathname === '/url') {
          return parsed.searchParams.get('q') || urlItem;
        }
      } catch {
        return urlItem;
      }

      return urlItem;
    })
    .filter(Boolean);

  return urls.map((urlItem) => ({ title: urlItem, url: urlItem }));
}

function isLikelyArticleUrl(url) {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.replace(/^www\./, '');

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

  const fallbackHtml = await http.get(url);
  const $ = cheerio.load(fallbackHtml.data || '');
  const text = $('body').text();

  return {
    title: $('title').text() || url,
    content: '',
    text,
    url,
  };
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

  if (openai) {
    const response = await openai.chat.completions.create({
      model: OPENAI_MODEL,
      messages: [
        { role: 'system', content: 'You are a senior editor who writes clean, structured HTML.' },
        { role: 'user', content: prompt },
      ],
      temperature: 0.7,
    });

    return response.choices?.[0]?.message?.content?.trim() || '';
  }

  if (!HF_API_KEY) {
    throw new Error('Set OPENAI_API_KEY or HF_API_KEY to generate updated articles.');
  }

  const hfResponse = await postWithRetry(
    `${HF_BASE_URL}/${encodeURIComponent(HF_MODEL)}`,
    {
      inputs: prompt,
      parameters: {
        max_new_tokens: 1200,
        temperature: 0.7,
        return_full_text: false,
      },
    },
    {
      headers: {
        Authorization: `Bearer ${HF_API_KEY}`,
      },
    }
  );

  const data = hfResponse.data;
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
  const $ = cheerio.load(html);
  return $('body').text().replace(/\s+/g, ' ').trim();
}

function limitText(text, maxLength) {
  if (text.length <= maxLength) {
    return text;
  }
  return `${text.slice(0, maxLength)}...`;
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

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
