import {createHash} from 'node:crypto';

export type MigrationCategory = 'metadata' | 'profiles';

export type MigrationChunkInput = {
  category: MigrationCategory;
  bytes: Buffer;
};

type MigrationChunk = MigrationChunkInput & {
  index: number;
  sha256: string;
};

type MigrationSession = {
  id: string;
  chunks?: Array<{
    category: string;
    chunk_index: number;
    size_bytes: number;
    sha256: string;
    status: string;
  }>;
};

type CloudResponse<T> = {success?: boolean; data?: T; message?: string};

export type MigrationTransport = {
  workspaceId: () => Promise<string | undefined>;
  request: <T>(
    method: 'get' | 'post',
    path: string,
    data?: unknown,
  ) => Promise<CloudResponse<T> | undefined>;
  uploadBinary: (path: string, bytes: Buffer, headers: Record<string, string>) => Promise<unknown>;
};

export type MigrationDraft = {
  sourceLocalWorkspaceId: string;
  idempotencyKey: string;
  chunks: MigrationChunkInput[];
};

function digest(value: Buffer | string) {
  return createHash('sha256').update(value).digest('hex');
}

function failure(message: string): never {
  throw new Error(message);
}

function preparedChunks(chunks: MigrationChunkInput[]) {
  if (!chunks.length) failure('Migration requires at least one chunk');
  const indexes = new Map<MigrationCategory, number>();
  return chunks.map(chunk => {
    if (chunk.category !== 'metadata' && chunk.category !== 'profiles')
      failure('Migration category is not supported');
    if (!Buffer.isBuffer(chunk.bytes) || !chunk.bytes.length)
      failure('Migration chunks must be non-empty buffers');
    const index = indexes.get(chunk.category) || 0;
    indexes.set(chunk.category, index + 1);
    return {...chunk, index, sha256: digest(chunk.bytes)};
  });
}

function manifestSha256(chunks: MigrationChunk[]) {
  return digest(
    JSON.stringify(
      chunks.map(chunk => ({
        category: chunk.category,
        chunk_index: chunk.index,
        size_bytes: chunk.bytes.length,
        sha256: chunk.sha256,
      })),
    ),
  );
}

function responseData<T>(response: CloudResponse<T> | undefined, action: string) {
  if (!response?.success || !response.data)
    failure(response?.message || `Migration ${action} failed`);
  return response.data;
}

function isVerified(session: MigrationSession, chunk: MigrationChunk) {
  return (
    session.chunks?.some(
      remote =>
        remote.category === chunk.category &&
        remote.chunk_index === chunk.index &&
        remote.status === 'verified' &&
        remote.size_bytes === chunk.bytes.length &&
        remote.sha256 === chunk.sha256,
    ) || false
  );
}

export class MigrationClient {
  constructor(private readonly transport: MigrationTransport) {}

  async migrate(draft: MigrationDraft) {
    if (!draft.sourceLocalWorkspaceId.trim() || !draft.idempotencyKey.trim())
      failure('Migration source workspace and idempotency key are required');
    const workspaceId = await this.transport.workspaceId();
    if (!workspaceId) failure('Cloud workspace is not configured');
    const chunks = preparedChunks(draft.chunks);
    const categories = [...new Set(chunks.map(chunk => chunk.category))];
    const manifest = manifestSha256(chunks);
    const root = `/workspaces/${encodeURIComponent(workspaceId)}/migrations`;
    const created = responseData(
      await this.transport.request<MigrationSession>('post', root, {
        source_local_workspace_id: draft.sourceLocalWorkspaceId,
        idempotency_key: draft.idempotencyKey,
        selected_categories: categories,
        expected_bytes: chunks.reduce((total, chunk) => total + chunk.bytes.length, 0),
        manifest_sha256: manifest,
      }),
      'start',
    );
    if ((created as MigrationSession & {status?: string}).status === 'completed') return created;
    const session = responseData(
      await this.transport.request<MigrationSession>(
        'get',
        `${root}/${encodeURIComponent(created.id)}`,
      ),
      'status',
    );
    for (const chunk of chunks) {
      if (isVerified(session, chunk)) continue;
      await this.transport.uploadBinary(
        `${root}/${encodeURIComponent(created.id)}/chunks/${chunk.category}/${chunk.index}`,
        chunk.bytes,
        {'X-Chunk-Sha256': chunk.sha256},
      );
    }
    return responseData(
      await this.transport.request<MigrationSession>(
        'post',
        `${root}/${encodeURIComponent(created.id)}/complete`,
        {
          manifest_sha256: manifest,
        },
      ),
      'complete',
    );
  }
}
