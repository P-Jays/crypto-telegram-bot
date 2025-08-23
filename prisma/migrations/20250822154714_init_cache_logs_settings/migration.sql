-- CREATE TABLE "QueryLog_backup" AS TABLE "QueryLog";
DROP TABLE IF EXISTS "QueryLog";

-- New tables
CREATE TABLE "ChatSetting" (
  "id" SERIAL PRIMARY KEY,
  "chatId" BIGINT NOT NULL UNIQUE,
  "defaultChain" TEXT,
  "provider" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE "QueryLog" (
  "id" BIGSERIAL PRIMARY KEY,
  "chatId" BIGINT NOT NULL,
  "type" TEXT NOT NULL,            -- "price" | "analyze" | "freeform" | "error"
  "input" TEXT NOT NULL,
  "outcome" TEXT,                  -- "ok" | "fail" | message
  "latencyMs" INTEGER,
  "provider" TEXT,
  "cacheKey" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE "PriceCache" (
  "key" TEXT PRIMARY KEY,
  "payload" JSONB NOT NULL,
  "ttlAt" TIMESTAMP(3) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE "DexCache" (
  "key" TEXT PRIMARY KEY,
  "payload" JSONB NOT NULL,
  "ttlAt" TIMESTAMP(3) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
