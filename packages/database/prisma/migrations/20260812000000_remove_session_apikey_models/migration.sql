-- DropForeignKey
ALTER TABLE "ApiKey" DROP CONSTRAINT "ApiKey_providerId_fkey";

-- DropForeignKey
ALTER TABLE "Session" DROP CONSTRAINT "Session_providerId_fkey";

-- DropTable
DROP TABLE "ApiKey";

-- DropTable
DROP TABLE "Session";
