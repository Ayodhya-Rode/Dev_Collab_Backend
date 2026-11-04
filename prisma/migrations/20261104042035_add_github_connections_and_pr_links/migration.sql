-- CreateTable
CREATE TABLE "github_connections" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "project_id" TEXT NOT NULL,
    "repo_owner" TEXT NOT NULL,
    "repo_name" TEXT NOT NULL,
    "default_branch" TEXT NOT NULL,
    "connected_by" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "github_connections_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "task_pr_links" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "task_id" TEXT NOT NULL,
    "pr_number" INTEGER NOT NULL,
    "pr_url" TEXT NOT NULL,
    "linked_by" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "task_pr_links_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "github_connections_project_id_key" ON "github_connections"("project_id");

-- CreateIndex
CREATE INDEX "github_connections_organization_id_idx" ON "github_connections"("organization_id");

-- CreateIndex
CREATE INDEX "task_pr_links_organization_id_idx" ON "task_pr_links"("organization_id");

-- CreateIndex
CREATE UNIQUE INDEX "task_pr_links_task_id_pr_number_key" ON "task_pr_links"("task_id", "pr_number");

-- AddForeignKey
ALTER TABLE "github_connections" ADD CONSTRAINT "github_connections_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "github_connections" ADD CONSTRAINT "github_connections_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "github_connections" ADD CONSTRAINT "github_connections_connected_by_fkey" FOREIGN KEY ("connected_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "task_pr_links" ADD CONSTRAINT "task_pr_links_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "task_pr_links" ADD CONSTRAINT "task_pr_links_task_id_fkey" FOREIGN KEY ("task_id") REFERENCES "tasks"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "task_pr_links" ADD CONSTRAINT "task_pr_links_linked_by_fkey" FOREIGN KEY ("linked_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
