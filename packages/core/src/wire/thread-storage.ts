/** Stored saver payload sizes, excluding database indexes and filesystem/page overhead. */
export interface ThreadStorage {
  thread_id: string;
  total_bytes: number;
  checkpoints: { count: number; bytes: number };
  channel_values: {
    count: number;
    bytes: number;
    by_channel: Record<string, { versions: number; bytes: number }>;
  };
  pending_writes: { count: number; bytes: number };
}
