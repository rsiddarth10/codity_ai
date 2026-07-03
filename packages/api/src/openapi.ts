/**
 * Hand-written OpenAPI 3.0 spec. Served as JSON at /openapi.json and via Swagger UI at
 * /docs. Kept deliberately close to the zod route schemas; the shared response envelopes
 * (error, pagination) are defined once under components.
 */
export function buildOpenApiSpec(): Record<string, unknown> {
  const bearer = [{ bearerAuth: [] }];
  const paginationParams = [
    { name: 'page', in: 'query', schema: { type: 'integer', minimum: 1, default: 1 } },
    { name: 'pageSize', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 100, default: 20 } },
  ];
  const idParam = (name: string) => ({
    name,
    in: 'path',
    required: true,
    schema: { type: 'string', format: 'uuid' },
  });

  return {
    openapi: '3.0.3',
    info: {
      title: 'Codity API',
      version: '0.1.0',
      description:
        'Distributed job scheduling platform. All /api/v1 routes except auth require a Bearer access token. Resources are isolated per organization.',
    },
    servers: [{ url: '/api/v1' }],
    components: {
      securitySchemes: {
        bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' },
      },
      schemas: {
        Error: {
          type: 'object',
          properties: {
            error: {
              type: 'object',
              properties: {
                code: { type: 'string' },
                message: { type: 'string' },
                details: {},
                requestId: { type: 'string' },
              },
            },
          },
        },
        AuthTokens: {
          type: 'object',
          properties: {
            accessToken: { type: 'string' },
            refreshToken: { type: 'string' },
            user: {
              type: 'object',
              properties: {
                id: { type: 'string' },
                email: { type: 'string' },
                role: { type: 'string' },
                organizationId: { type: 'string' },
              },
            },
          },
        },
        Pagination: {
          type: 'object',
          properties: {
            page: { type: 'integer' },
            pageSize: { type: 'integer' },
            total: { type: 'integer' },
            totalPages: { type: 'integer' },
          },
        },
        Job: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            queue_id: { type: 'string' },
            status: { type: 'string' },
            priority: { type: 'integer' },
            payload: { type: 'object' },
            attempts: { type: 'integer' },
            max_attempts: { type: 'integer' },
            run_at: { type: 'string', format: 'date-time' },
          },
        },
        Queue: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            project_id: { type: 'string' },
            name: { type: 'string' },
            priority: { type: 'integer' },
            concurrency_limit: { type: 'integer' },
            is_paused: { type: 'boolean' },
          },
        },
      },
      responses: {
        Unauthorized: {
          description: 'Missing or invalid token',
          content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } },
        },
        NotFound: {
          description: 'Resource not found (or not in your organization)',
          content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } },
        },
      },
    },
    security: bearer,
    paths: {
      '/auth/signup': {
        post: {
          tags: ['Auth'],
          security: [],
          summary: 'Create an organization + owner user',
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['email', 'password', 'organizationName'],
                  properties: {
                    email: { type: 'string', format: 'email' },
                    password: { type: 'string', minLength: 8 },
                    organizationName: { type: 'string' },
                  },
                },
              },
            },
          },
          responses: {
            '201': { description: 'Created', content: { 'application/json': { schema: { $ref: '#/components/schemas/AuthTokens' } } } },
            '409': { description: 'Email already registered' },
          },
        },
      },
      '/auth/login': {
        post: {
          tags: ['Auth'],
          security: [],
          summary: 'Log in',
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['email', 'password'],
                  properties: { email: { type: 'string' }, password: { type: 'string' } },
                },
              },
            },
          },
          responses: {
            '200': { description: 'OK', content: { 'application/json': { schema: { $ref: '#/components/schemas/AuthTokens' } } } },
            '401': { $ref: '#/components/responses/Unauthorized' },
          },
        },
      },
      '/auth/refresh': {
        post: {
          tags: ['Auth'],
          security: [],
          summary: 'Rotate refresh token, get a new access token',
          requestBody: {
            required: true,
            content: { 'application/json': { schema: { type: 'object', required: ['refreshToken'], properties: { refreshToken: { type: 'string' } } } } },
          },
          responses: { '200': { description: 'OK', content: { 'application/json': { schema: { $ref: '#/components/schemas/AuthTokens' } } } } },
        },
      },
      '/me': {
        get: { tags: ['Auth'], summary: 'Current user', responses: { '200': { description: 'OK' } } },
      },
      '/projects': {
        get: {
          tags: ['Projects'],
          summary: 'List projects',
          parameters: paginationParams,
          responses: { '200': { description: 'Paginated projects' } },
        },
        post: {
          tags: ['Projects'],
          summary: 'Create a project',
          requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['name'], properties: { name: { type: 'string' } } } } } },
          responses: { '201': { description: 'Created' } },
        },
      },
      '/projects/{projectId}': {
        parameters: [idParam('projectId')],
        get: { tags: ['Projects'], summary: 'Get a project', responses: { '200': { description: 'OK' }, '404': { $ref: '#/components/responses/NotFound' } } },
        patch: { tags: ['Projects'], summary: 'Rename a project', responses: { '200': { description: 'OK' } } },
        delete: { tags: ['Projects'], summary: 'Delete a project (cascades)', responses: { '204': { description: 'Deleted' } } },
      },
      '/projects/{projectId}/retry-policies': {
        parameters: [idParam('projectId')],
        get: { tags: ['Retry Policies'], summary: 'List retry policies', responses: { '200': { description: 'OK' } } },
        post: { tags: ['Retry Policies'], summary: 'Create a retry policy', responses: { '201': { description: 'Created' } } },
      },
      '/projects/{projectId}/queues': {
        parameters: [idParam('projectId')],
        get: { tags: ['Queues'], summary: 'List queues in a project', responses: { '200': { description: 'OK' } } },
        post: {
          tags: ['Queues'],
          summary: 'Create a queue',
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['name'],
                  properties: {
                    name: { type: 'string' },
                    priority: { type: 'integer' },
                    concurrencyLimit: { type: 'integer', minimum: 1 },
                    retryPolicyId: { type: 'string', format: 'uuid', nullable: true },
                  },
                },
              },
            },
          },
          responses: { '201': { description: 'Created', content: { 'application/json': { schema: { $ref: '#/components/schemas/Queue' } } } } },
        },
      },
      '/queues/{queueId}': {
        parameters: [idParam('queueId')],
        get: { tags: ['Queues'], summary: 'Get a queue', responses: { '200': { description: 'OK' }, '404': { $ref: '#/components/responses/NotFound' } } },
        patch: { tags: ['Queues'], summary: 'Update queue config', responses: { '200': { description: 'OK' } } },
        delete: { tags: ['Queues'], summary: 'Delete a queue', responses: { '204': { description: 'Deleted' } } },
      },
      '/queues/{queueId}/pause': { parameters: [idParam('queueId')], post: { tags: ['Queues'], summary: 'Pause a queue', responses: { '200': { description: 'OK' } } } },
      '/queues/{queueId}/resume': { parameters: [idParam('queueId')], post: { tags: ['Queues'], summary: 'Resume a queue', responses: { '200': { description: 'OK' } } } },
      '/queues/{queueId}/stats': { parameters: [idParam('queueId')], get: { tags: ['Queues'], summary: 'Queue statistics', responses: { '200': { description: 'Counts + avg duration' } } } },
      '/queues/{queueId}/jobs': {
        parameters: [idParam('queueId')],
        get: {
          tags: ['Jobs'],
          summary: 'List jobs (filter by status, paginated)',
          parameters: [...paginationParams, { name: 'status', in: 'query', schema: { type: 'string' } }],
          responses: { '200': { description: 'Paginated jobs' } },
        },
        post: {
          tags: ['Jobs'],
          summary: 'Enqueue a job (immediate or delayed via runAt)',
          requestBody: {
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    payload: { type: 'object' },
                    priority: { type: 'integer' },
                    idempotencyKey: { type: 'string' },
                    runAt: { type: 'string', format: 'date-time' },
                  },
                },
              },
            },
          },
          responses: {
            '201': { description: 'Created', content: { 'application/json': { schema: { $ref: '#/components/schemas/Job' } } } },
            '200': { description: 'Existing job returned via idempotency key' },
          },
        },
      },
      '/jobs/{jobId}': { parameters: [idParam('jobId')], get: { tags: ['Jobs'], summary: 'Get a job', responses: { '200': { description: 'OK' }, '404': { $ref: '#/components/responses/NotFound' } } } },
      '/jobs/{jobId}/executions': { parameters: [idParam('jobId')], get: { tags: ['Jobs'], summary: 'Attempt/retry history', responses: { '200': { description: 'OK' } } } },
      '/jobs/{jobId}/logs': { parameters: [idParam('jobId')], get: { tags: ['Jobs'], summary: 'Job logs (paginated)', responses: { '200': { description: 'OK' } } } },
      '/jobs/{jobId}/transitions': { parameters: [idParam('jobId')], get: { tags: ['Jobs'], summary: 'Lifecycle timeline', responses: { '200': { description: 'OK' } } } },
      '/jobs/{jobId}/cancel': { parameters: [idParam('jobId')], post: { tags: ['Jobs'], summary: 'Cancel a queued/scheduled job', responses: { '200': { description: 'Cancelled' }, '409': { description: 'Not cancellable' } } } },
      '/jobs/{jobId}/retry': { parameters: [idParam('jobId')], post: { tags: ['Jobs'], summary: 'Retry a failed or dead-lettered job (DLQ retry resets attempts)', responses: { '200': { description: 'Requeued' }, '409': { description: 'Not retriable' } } } },
      '/queues/{queueId}/dead-letter': { parameters: [idParam('queueId'), ...paginationParams], get: { tags: ['Dead Letter Queue'], summary: 'List dead-lettered jobs for a queue', responses: { '200': { description: 'Paginated DLQ entries' } } } },
      '/workers': { get: { tags: ['Workers'], summary: 'List workers + current load', responses: { '200': { description: 'OK' } } } },
    },
  };
}
