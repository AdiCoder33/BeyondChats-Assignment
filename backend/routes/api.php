<?php

use App\Http\Controllers\Api\ArticleController;
use App\Http\Controllers\Api\AutomationController;
use App\Http\Controllers\Api\ScrapeController;
use Illuminate\Support\Facades\Route;

Route::get('/health', fn () => ['status' => 'ok']);

Route::post('/articles/scrape', ScrapeController::class);
Route::post('/automation/run', [AutomationController::class, 'run']);
Route::get('/automation/status', [AutomationController::class, 'status']);
Route::apiResource('articles', ArticleController::class);
