<?php

namespace App\Http\Controllers\Api;

use App\Http\Controllers\Controller;
use App\Models\Article;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Support\Str;

class ArticleController extends Controller
{
    public function index(Request $request): JsonResponse
    {
        $query = Article::query();
        $type = $request->query('type');

        if ($type === 'original') {
            $query->whereNull('original_article_id');
        } elseif ($type === 'updated') {
            $query->whereNotNull('original_article_id');
        }

        if ($request->boolean('withUpdated')) {
            $query->with('updatedArticles');
        }

        if ($request->boolean('withOriginal')) {
            $query->with('originalArticle');
        }

        $articles = $query->orderBy('published_at')->get();

        return response()->json($articles);
    }

    public function show(Article $article): JsonResponse
    {
        $article->load(['originalArticle', 'updatedArticles']);

        return response()->json($article);
    }

    public function store(Request $request): JsonResponse
    {
        $data = $this->validatePayload($request, false);

        $data['slug'] = $this->uniqueSlug($data['slug'] ?? $data['title']);
        $data['content_text'] = $data['content_text'] ?? $this->normalizeText(strip_tags($data['content_html']));
        $data['excerpt'] = $data['excerpt'] ?? Str::limit($data['content_text'], 200);
        $data['version'] = $data['version'] ?? ($data['original_article_id'] ? 'updated' : 'original');
        $data['source'] = $data['source'] ?? 'manual';

        $article = Article::create($data);

        return response()->json($article, 201);
    }

    public function update(Request $request, Article $article): JsonResponse
    {
        $data = $this->validatePayload($request, true);

        if (isset($data['slug'])) {
            $data['slug'] = $this->uniqueSlug($data['slug'], $article->id);
        }

        if (isset($data['content_html']) && !isset($data['content_text'])) {
            $data['content_text'] = $this->normalizeText(strip_tags($data['content_html']));
        }

        if (isset($data['content_text']) && !isset($data['excerpt'])) {
            $data['excerpt'] = Str::limit($data['content_text'], 200);
        }

        $article->update($data);

        return response()->json($article);
    }

    public function destroy(Article $article): JsonResponse
    {
        $article->delete();

        return response()->json(['deleted' => true]);
    }

    private function validatePayload(Request $request, bool $isUpdate): array
    {
        $required = $isUpdate ? 'sometimes' : 'required';

        return $request->validate([
            'original_article_id' => ['nullable', 'integer', 'exists:articles,id'],
            'title' => [$required, 'string', 'max:255'],
            'slug' => ['nullable', 'string', 'max:255'],
            'source' => ['nullable', 'string', 'max:50'],
            'source_url' => ['nullable', 'url'],
            'version' => ['nullable', 'string', 'max:50'],
            'content_html' => [$required, 'string'],
            'content_text' => ['nullable', 'string'],
            'excerpt' => ['nullable', 'string'],
            'references' => ['nullable', 'array'],
            'references.*.title' => ['nullable', 'string'],
            'references.*.url' => ['nullable', 'url'],
            'published_at' => ['nullable', 'date'],
        ]);
    }

    private function uniqueSlug(string $seed, ?int $ignoreId = null): string
    {
        $base = Str::slug($seed);
        $slug = $base;
        $suffix = 1;

        while (
            Article::where('slug', $slug)
                ->when($ignoreId, fn ($query) => $query->where('id', '!=', $ignoreId))
                ->exists()
        ) {
            $suffix += 1;
            $slug = $base . '-' . $suffix;
        }

        return $slug;
    }

    private function normalizeText(string $text): string
    {
        return trim(preg_replace('/\\s+/', ' ', $text) ?? '');
    }
}
