<?php

use Illuminate\Foundation\Inspiring;
use Illuminate\Support\Facades\Artisan;
use App\Services\BeyondChatsScraper;

Artisan::command('inspire', function () {
    $this->comment(Inspiring::quote());
})->purpose('Display an inspiring quote');

Artisan::command('articles:scrape {--limit=5} {--page=}', function (BeyondChatsScraper $scraper) {
    $limit = (int) $this->option('limit');
    $page = $this->option('page');

    $articles = $scraper->scrapeOldest($limit, $page ? (int) $page : null);

    $this->info('Stored ' . count($articles) . ' articles.');
})->purpose('Scrape the oldest BeyondChats blog articles.');
