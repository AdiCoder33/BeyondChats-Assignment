<?php

namespace App\Services;

use App\Models\Article;
use Carbon\Carbon;
use DOMDocument;
use DOMNode;
use DOMXPath;
use Illuminate\Support\Facades\Http;
use Illuminate\Support\Str;

class BeyondChatsScraper
{
    private const BASE_URL = 'https://beyondchats.com';

    public function scrapeOldest(int $limit = 5, ?int $page = null): array
    {
        $pageNumber = $page ?? $this->getLastPageNumber();
        $listUrl = self::BASE_URL . '/blogs/page/' . $pageNumber . '/';
        $listHtml = $this->fetchHtml($listUrl);

        $articleLinks = array_slice($this->extractArticleLinks($listHtml), 0, $limit);
        $articles = [];

        foreach ($articleLinks as $url) {
            $article = $this->scrapeArticle($url);
            if ($article) {
                $articles[] = $article;
            }
        }

        return $articles;
    }

    public function getLastPageNumber(): int
    {
        $html = $this->fetchHtml(self::BASE_URL . '/blogs/');
        preg_match_all('#/blogs/page/(\\d+)/#', $html, $matches);

        if (empty($matches[1])) {
            return 1;
        }

        return max(array_map('intval', $matches[1]));
    }

    private function scrapeArticle(string $url): ?Article
    {
        $html = $this->fetchHtml($url);
        $doc = $this->loadDom($html);
        $xpath = new DOMXPath($doc);

        $title = $this->getMetaProperty($xpath, 'og:title')
            ?? $this->getFirstNodeText($xpath, '//h1');

        if (!$title) {
            return null;
        }

        $publishedAt = null;
        $publishedRaw = $this->getMetaProperty($xpath, 'article:published_time');
        if ($publishedRaw) {
            $publishedAt = Carbon::parse($publishedRaw);
        }

        $contentHtml = $this->extractContentHtml($xpath);
        $contentText = $this->normalizeText(strip_tags($contentHtml));
        $excerpt = Str::limit($contentText, 200);
        $slug = $this->extractSlug($url);

        return Article::updateOrCreate(
            ['slug' => $slug, 'version' => 'original'],
            [
                'title' => html_entity_decode($title, ENT_QUOTES | ENT_HTML5),
                'source' => 'beyondchats',
                'source_url' => $url,
                'content_html' => $contentHtml,
                'content_text' => $contentText,
                'excerpt' => $excerpt,
                'published_at' => $publishedAt,
            ]
        );
    }

    private function extractArticleLinks(string $html): array
    {
        $doc = $this->loadDom($html);
        $links = [];

        foreach ($doc->getElementsByTagName('a') as $anchor) {
            $href = trim($anchor->getAttribute('href'));
            if ($href === '') {
                continue;
            }

            $href = strtok($href, '#');
            if (str_starts_with($href, '/')) {
                $href = self::BASE_URL . $href;
            }

            if (!str_starts_with($href, self::BASE_URL . '/blogs/')) {
                continue;
            }

            if (preg_match('#/blogs/(tag|category|page|author|feed)/#', $href)) {
                continue;
            }

            if (rtrim($href, '/') === self::BASE_URL . '/blogs') {
                continue;
            }

            if (!preg_match('#/blogs/[^/]+/?$#', $href)) {
                continue;
            }

            if (!in_array($href, $links, true)) {
                $links[] = $href;
            }
        }

        return $links;
    }

    private function extractContentHtml(DOMXPath $xpath): string
    {
        $selectors = [
            "//*[contains(concat(' ', normalize-space(@class), ' '), ' elementor-widget-theme-post-content ')]",
            "//*[contains(concat(' ', normalize-space(@class), ' '), ' elementor-widget-text-editor ')]",
            "//*[contains(concat(' ', normalize-space(@class), ' '), ' entry-content ')]",
            "//*[contains(concat(' ', normalize-space(@class), ' '), ' post-content ')]",
            "//article",
        ];

        foreach ($selectors as $selector) {
            $node = $xpath->query($selector)->item(0);
            if (!$node) {
                continue;
            }

            $container = $xpath->query(
                ".//*[contains(concat(' ', normalize-space(@class), ' '), ' elementor-widget-container ')]",
                $node
            )->item(0) ?? $node;

            $html = $this->getInnerHtml($container);
            if ($this->hasMeaningfulContent($html)) {
                return $html;
            }
        }

        $description = $this->getMetaProperty($xpath, 'og:description');
        return $description ? '<p>' . e($description) . '</p>' : '';
    }

    private function fetchHtml(string $url): string
    {
        $response = Http::retry(2, 500)
            ->withHeaders([
                'User-Agent' => 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122 Safari/537.36',
            ])
            ->get($url);

        if (!$response->ok()) {
            throw new \RuntimeException("Failed to fetch {$url}");
        }

        return $response->body();
    }

    private function extractSlug(string $url): string
    {
        $path = parse_url($url, PHP_URL_PATH);
        $segments = array_values(array_filter(explode('/', (string) $path)));

        return end($segments) ?: Str::slug($url);
    }

    private function loadDom(string $html): DOMDocument
    {
        $doc = new DOMDocument();
        libxml_use_internal_errors(true);
        $doc->loadHTML(mb_convert_encoding($html, 'HTML-ENTITIES', 'UTF-8'));
        libxml_clear_errors();

        return $doc;
    }

    private function getMetaProperty(DOMXPath $xpath, string $property): ?string
    {
        $node = $xpath->query("//meta[@property='{$property}']")->item(0)
            ?? $xpath->query("//meta[@name='{$property}']")->item(0);

        if (!$node) {
            return null;
        }

        $content = trim($node->getAttribute('content'));
        return $content !== '' ? $content : null;
    }

    private function getFirstNodeText(DOMXPath $xpath, string $selector): ?string
    {
        $node = $xpath->query($selector)->item(0);
        if (!$node) {
            return null;
        }

        return trim($node->textContent);
    }

    private function getInnerHtml(DOMNode $node): string
    {
        $html = '';
        foreach ($node->childNodes as $child) {
            $html .= $node->ownerDocument->saveHTML($child);
        }

        return trim($html);
    }

    private function hasMeaningfulContent(string $html): bool
    {
        return trim(strip_tags($html)) !== '';
    }

    private function normalizeText(string $text): string
    {
        return trim(preg_replace('/\\s+/', ' ', $text) ?? '');
    }
}
