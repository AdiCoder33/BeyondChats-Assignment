<?php

namespace App\Models;

use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;
use Illuminate\Database\Eloquent\Relations\HasMany;

class Article extends Model
{
    protected $fillable = [
        'original_article_id',
        'title',
        'slug',
        'source',
        'source_url',
        'version',
        'content_html',
        'content_text',
        'excerpt',
        'references',
        'published_at',
    ];

    protected $casts = [
        'references' => 'array',
        'published_at' => 'datetime',
    ];

    public function originalArticle(): BelongsTo
    {
        return $this->belongsTo(self::class, 'original_article_id');
    }

    public function updatedArticles(): HasMany
    {
        return $this->hasMany(self::class, 'original_article_id');
    }
}
