-- CreateEnum
CREATE TYPE "DisputeCategory" AS ENUM ('RETAIL', 'TENANCY', 'EMPLOYMENT', 'B2B', 'FREELANCE', 'P2P_MARKETPLACE', 'PARTNERSHIP');

-- AlterEnum
BEGIN;
CREATE TYPE "GlobalRole_new" AS ENUM ('COMPLAINANT', 'RESPONDENT', 'CASE_MANAGER', 'ADMIN');
ALTER TABLE "User" ALTER COLUMN "globalRole" TYPE "GlobalRole_new" USING ("globalRole"::text::"GlobalRole_new");
ALTER TYPE "GlobalRole" RENAME TO "GlobalRole_old";
ALTER TYPE "GlobalRole_new" RENAME TO "GlobalRole";
DROP TYPE "public"."GlobalRole_old";
COMMIT;

-- DropForeignKey
ALTER TABLE "Case" DROP CONSTRAINT "Case_consumerId_fkey";

-- DropForeignKey
ALTER TABLE "Case" DROP CONSTRAINT "Case_retailerHandlerId_fkey";

-- AlterTable
ALTER TABLE "Case" DROP COLUMN "consumerId",
DROP COLUMN "retailerHandlerId",
ADD COLUMN     "category" "DisputeCategory" NOT NULL DEFAULT 'RETAIL',
ADD COLUMN     "complainantId" TEXT NOT NULL,
ADD COLUMN     "metadata" JSONB,
ADD COLUMN     "respondentId" TEXT NOT NULL;

-- AddForeignKey
ALTER TABLE "Case" ADD CONSTRAINT "Case_complainantId_fkey" FOREIGN KEY ("complainantId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Case" ADD CONSTRAINT "Case_respondentId_fkey" FOREIGN KEY ("respondentId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

