<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        Schema::create('articles', function (Blueprint $table) {
            $table->id();
            $table->foreignId('original_article_id')
                ->nullable()
                ->constrained('articles')
                ->nullOnDelete();
            $table->string('title');
            $table->string('slug')->unique();
            $table->string('source')->default('beyondchats');
            $table->string('source_url')->nullable();
            $table->string('version')->default('original');
            $table->longText('content_html');
            $table->longText('content_text')->nullable();
            $table->text('excerpt')->nullable();
            $table->json('references')->nullable();
            $table->timestamp('published_at')->nullable();
            $table->timestamps();
        });
    }

    public function down(): void
    {
        Schema::dropIfExists('articles');
    }
};
