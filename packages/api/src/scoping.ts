import type { Pool } from '@codity/db';
import { getProject, queueOrganizationId, jobOrganizationId, type ProjectRow } from '@codity/core';
import { notFound } from './errors.js';

/**
 * Tenant-isolation guards. A resource outside the caller's organization is reported as
 * 404 (not 403) so we never reveal that an id exists in another tenant.
 */

export async function assertProject(pool: Pool, projectId: string, orgId: string): Promise<ProjectRow> {
  const project = await getProject(pool, projectId, orgId);
  if (!project) throw notFound('Project not found');
  return project;
}

export async function assertQueue(pool: Pool, queueId: string, orgId: string): Promise<void> {
  const owner = await queueOrganizationId(pool, queueId);
  if (owner !== orgId) throw notFound('Queue not found');
}

export async function assertJob(pool: Pool, jobId: string, orgId: string): Promise<void> {
  const owner = await jobOrganizationId(pool, jobId);
  if (owner !== orgId) throw notFound('Job not found');
}
