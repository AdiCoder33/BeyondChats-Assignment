<?php

namespace App\Http\Controllers\Api;

use App\Http\Controllers\Controller;
use App\Services\BeyondChatsScraper;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;

class ScrapeController extends Controller
{
    public function __invoke(Request $request, BeyondChatsScraper $scraper): JsonResponse
    {
        $limit = (int) $request->input('limit', 5);
        $page = $request->input('page');

        $articles = $scraper->scrapeOldest($limit, $page ? (int) $page : null);

        return response()->json([
            'count' => count($articles),
            'articles' => $articles,
        ]);
    }
}
