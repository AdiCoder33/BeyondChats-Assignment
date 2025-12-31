FROM php:8.2-cli

RUN apt-get update && apt-get install -y --no-install-recommends \
    git \
    curl \
    unzip \
    libpq-dev \
    ca-certificates \
  && docker-php-ext-install pdo_pgsql pgsql \
  && rm -rf /var/lib/apt/lists/*

RUN curl -fsSL https://deb.nodesource.com/setup_18.x | bash - \
  && apt-get install -y --no-install-recommends nodejs \
  && rm -rf /var/lib/apt/lists/*

COPY --from=composer:2 /usr/bin/composer /usr/bin/composer

WORKDIR /app

COPY backend ./backend
RUN mkdir -p /app/backend/bootstrap/cache /app/backend/storage/framework /app/backend/storage/logs \
  && chmod -R 775 /app/backend/bootstrap/cache /app/backend/storage
RUN composer install --no-dev --prefer-dist --no-interaction --working-dir=./backend

COPY automation/package*.json ./automation/
RUN npm --prefix ./automation install --omit=dev

COPY automation ./automation

WORKDIR /app/backend

RUN chmod -R 775 storage bootstrap/cache || true

ENV PORT=10000
CMD ["sh", "-c", "php -S 0.0.0.0:${PORT} -t public vendor/laravel/framework/src/Illuminate/Foundation/resources/server.php"]
